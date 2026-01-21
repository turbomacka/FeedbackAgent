import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Type } from '@google/genai';
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { Storage } from '@google-cloud/storage';
import * as aiplatform from '@google-cloud/aiplatform';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import crypto from 'crypto';

admin.initializeApp();

const REGION = 'europe-north1';
const FUNCTION_SECRETS = [
  'GEMINI_API_KEY',
  'DOC_AI_PROCESSOR_ID',
  'DOC_AI_LOCATION',
  'VERTEX_LOCATION',
  'EMBEDDING_LOCATION',
  'VECTOR_INDEX_ID',
  'VECTOR_INDEX_ENDPOINT_ID',
  'VECTOR_DEPLOYED_INDEX_ID',
  'EMBEDDING_MODEL'
];
const firebaseConfig = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : {};
const PROJECT_ID = admin.app().options.projectId || firebaseConfig.projectId || process.env.GCLOUD_PROJECT || '';
const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ||
  admin.app().options.storageBucket ||
  firebaseConfig.storageBucket ||
  (PROJECT_ID ? `${PROJECT_ID}.appspot.com` : '');
const DOC_AI_LOCATION = process.env.DOC_AI_LOCATION || 'eu';
const DOC_AI_PROCESSOR_ID = process.env.DOC_AI_PROCESSOR_ID || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || REGION;
const EMBEDDING_LOCATION = process.env.EMBEDDING_LOCATION || VERTEX_LOCATION;
const VECTOR_INDEX_ID = process.env.VECTOR_INDEX_ID || '';
const VECTOR_INDEX_ENDPOINT_ID = process.env.VECTOR_INDEX_ENDPOINT_ID || '';
const VECTOR_DEPLOYED_INDEX_ID = process.env.VECTOR_DEPLOYED_INDEX_ID || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-004';
const EMBEDDING_TASK_TYPE = process.env.EMBEDDING_TASK_TYPE || '';
const EMBEDDING_OUTPUT_DIM = Number.parseInt(process.env.EMBEDDING_OUTPUT_DIM || '', 10);
const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_BATCH_TOKEN_LIMIT = 18000;
const DOC_AI_PAGE_LIMIT = 30;
const ACCESS_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const db = admin.firestore();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
const storage = new Storage();
const visionClient = new ImageAnnotatorClient();
const documentAiClient = new DocumentProcessorServiceClient({
  apiEndpoint: `${DOC_AI_LOCATION}-documentai.googleapis.com`
});
const embeddingClient = new aiplatform.v1.PredictionServiceClient({
  apiEndpoint: `${EMBEDDING_LOCATION}-aiplatform.googleapis.com`,
});
const indexClient = new aiplatform.v1.IndexServiceClient({
  apiEndpoint: `${VERTEX_LOCATION}-aiplatform.googleapis.com`,
});
const indexEndpointClient = new aiplatform.v1.IndexEndpointServiceClient({
  apiEndpoint: `${VERTEX_LOCATION}-aiplatform.googleapis.com`,
});

if (!process.env.GEMINI_API_KEY) {
  logger.warn('GEMINI_API_KEY is not set. Gemini requests will fail.');
}
if (!PROJECT_ID) {
  logger.warn('PROJECT_ID is not set. RAG services may fail.');
}
if (!DOC_AI_PROCESSOR_ID) {
  logger.warn('DOC_AI_PROCESSOR_ID is not set. PDF/image extraction will be limited.');
}
if (!VECTOR_INDEX_ID || !VECTOR_INDEX_ENDPOINT_ID || !VECTOR_DEPLOYED_INDEX_ID) {
  logger.warn('Vector Search configuration is missing. RAG retrieval will fallback to raw documents.');
}

const STRINGENCY_MODULES = {
  generous: `
STRINGENS-MODUL: GENEROS (Low stringency)
Focus: Formative grading and encouragement.
Logic: Apply a generous interpretation. If the student shows a clear attempt at understanding, mark the criterion as met.`, 

  standard: `
STRINGENS-MODUL: STANDARD (Normal stringency)
Focus: Summative grading and normal practice.
Logic: Follow criteria literally with balanced evidence.`, 

  strict: `
STRINGENS-MODUL: STRICT (High stringency)
Focus: Validity and higher education prep.
Logic: Play devil's advocate. No credit for implied knowledge; require explicit proof.`
};

const PROMPT_B_SYSTEM = (stringency: 'generous' | 'standard' | 'strict') => `Role: Objective academic grading engine. Output: JSON only.
Task: Evaluate the student text against provided criteria and reference material.
Calculate a high-precision normalized score from 0 to 100,000 based on how well they met the requirements.

${STRINGENCY_MODULES[stringency]}

In the teacher_insights section, provide specific:
1. common_errors: Theoretical or factual misunderstandings found in the text.
2. strengths: What the student mastered well.
3. teaching_actions: Concrete recommendations for the teacher on how to address the identified gaps in the next lesson.`;

const PROMPT_A_SYSTEM = `Role: Expert university tutor. Provide high-quality formative feedback.
CRITICAL LANGUAGE INSTRUCTION: You MUST detect the language of the STUDENT TEXT and respond in that SAME LANGUAGE.
If the student writes in Swedish, respond in Swedish. If English, respond in English.

Formatting Instructions:
1. Use clear Markdown headers (###).
2. Use bullet points for lists.
3. Use **bold text** for emphasis on key pedagogical concepts.
4. Structure exactly as (translated to the student's language):
   ### What works well
   ### Areas for development
   ### Actionable steps to improve
   ### Reflective question

CRITICAL: Use the provided REFERENCE MATERIAL (RAG) to ground all suggestions and cite specific parts. Do NOT mention numerical scores.`;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).send('GEMINI_API_KEY is not configured.');
  }
  return next();
});
const apiRouter = express.Router();

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html'
]);

const ZIP_XML_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet'
]);

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif'
]);

const PDF_MIME_TYPES = new Set(['application/pdf']);
const RTF_MIME_TYPES = new Set(['application/rtf']);

const MAX_PREVIEW_CHARS = 20000;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;

function generateVerificationCode(score: number, sessionSuffix: number): string {
  const cleanScore = Math.min(100000, Math.max(0, Math.round(score)));
  const cleanSuffix = Math.min(9999, Math.max(0, Math.round(sessionSuffix)));
  const numericCode = (cleanScore * 10000) + cleanSuffix;
  return numericCode.toString();
}

async function logAudit(event: string, details: Record<string, unknown>) {
  await db.collection('auditLogs').add({
    event,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...details
  });
}

async function getAccessSession(agentId: string, accessToken: string) {
  if (!accessToken) return null;
  const sessionSnap = await db.collection('accessSessions').doc(accessToken).get();
  if (!sessionSnap.exists) return null;
  const data = sessionSnap.data() || {};
  if (data.agentId !== agentId) return null;
  const expiresAt = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : data.expiresAt;
  if (!expiresAt || Date.now() > expiresAt) return null;
  return { ref: sessionSnap.ref, data };
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeAccessCode(value: string) {
  return value.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function decodeEntities(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(text: string) {
  return decodeEntities(text.replace(/<[^>]+>/g, ' '));
}

function stripRtf(text: string) {
  return text
    .replace(/\\par[d]?/g, ' ')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-zA-Z]+[0-9]?/g, ' ')
    .replace(/[{}]/g, ' ');
}

async function processDocumentAi(buffer: Buffer, mimeType: string) {
  const name = documentAiClient.processorPath(PROJECT_ID, DOC_AI_LOCATION, DOC_AI_PROCESSOR_ID);
  const [result] = await documentAiClient.processDocument({
    name,
    imagelessMode: true,
    rawDocument: {
      content: buffer.toString('base64'),
      mimeType
    }
  });
  return result.document?.text || '';
}

async function splitPdf(buffer: Buffer, maxPages: number) {
  const pdf = await PDFDocument.load(buffer);
  const totalPages = pdf.getPageCount();
  if (totalPages <= maxPages) {
    return { totalPages, chunks: [buffer] };
  }

  const chunks: Buffer[] = [];
  for (let start = 0; start < totalPages; start += maxPages) {
    const end = Math.min(start + maxPages, totalPages);
    const doc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, idx) => start + idx);
    const pages = await doc.copyPages(pdf, indices);
    pages.forEach(page => doc.addPage(page));
    const bytes = await doc.save();
    chunks.push(Buffer.from(bytes));
  }

  return { totalPages, chunks };
}

async function extractTextFromDocumentAi(buffer: Buffer, mimeType: string) {
  if (!DOC_AI_PROCESSOR_ID) {
    return '';
  }

  if (PDF_MIME_TYPES.has(mimeType)) {
    const { totalPages, chunks } = await splitPdf(buffer, DOC_AI_PAGE_LIMIT);
    if (totalPages > DOC_AI_PAGE_LIMIT) {
      const parts: string[] = [];
      for (const chunk of chunks) {
        const text = await processDocumentAi(chunk, mimeType);
        if (text) {
          parts.push(text);
        }
      }
      return parts.join('\n');
    }
  }

  return processDocumentAi(buffer, mimeType);
}

async function extractTextFromVision(buffer: Buffer) {
  const [result] = await visionClient.textDetection({
    image: { content: buffer }
  });
  return result.fullTextAnnotation?.text || '';
}

async function extractTextFromZip(buffer: Buffer, mimeType: string) {
  const zip = await JSZip.loadAsync(buffer);
  const fileNames = Object.keys(zip.files);
  const xmlTargets: string[] = [];

  if (mimeType.includes('wordprocessingml')) {
    xmlTargets.push('word/document.xml');
    xmlTargets.push(...fileNames.filter(name => name.startsWith('word/header')));
    xmlTargets.push(...fileNames.filter(name => name.startsWith('word/footer')));
  } else if (mimeType.includes('presentationml')) {
    xmlTargets.push(...fileNames.filter(name => name.startsWith('ppt/slides/slide')));
    xmlTargets.push(...fileNames.filter(name => name.startsWith('ppt/notesSlides/notesSlide')));
  } else if (mimeType.includes('spreadsheetml')) {
    xmlTargets.push('xl/sharedStrings.xml');
    xmlTargets.push(...fileNames.filter(name => name.startsWith('xl/worksheets/sheet')));
  } else if (mimeType.includes('oasis.opendocument')) {
    xmlTargets.push('content.xml');
  }

  const parts: string[] = [];
  for (const target of xmlTargets) {
    const file = zip.file(target);
    if (!file) continue;
    const xml = await file.async('string');
    parts.push(stripHtml(xml));
  }

  return parts.join(' ');
}

async function extractText(buffer: Buffer, mimeType: string) {
  if (TEXT_MIME_TYPES.has(mimeType)) {
    const raw = buffer.toString('utf8');
    return mimeType === 'text/html' ? stripHtml(raw) : raw;
  }
  if (RTF_MIME_TYPES.has(mimeType)) {
    return stripRtf(buffer.toString('utf8'));
  }
  if (PDF_MIME_TYPES.has(mimeType)) {
    return extractTextFromDocumentAi(buffer, mimeType);
  }
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    const docText = await extractTextFromDocumentAi(buffer, mimeType);
    if (docText) return docText;
    return extractTextFromVision(buffer);
  }
  if (ZIP_XML_TYPES.has(mimeType)) {
    return extractTextFromZip(buffer, mimeType);
  }
  return '';
}

function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const cleaned = normalizeText(text);
  if (!cleaned) return [];
  const chunks: string[] = [];
  let index = 0;
  while (index < cleaned.length) {
    const slice = cleaned.slice(index, index + chunkSize);
    chunks.push(slice);
    if (index + chunkSize >= cleaned.length) break;
    index += chunkSize - overlap;
  }
  return chunks;
}

function dedupeRepeated(value: string) {
  if (value.length % 2 !== 0) return value;
  const half = value.slice(0, value.length / 2);
  return value === half + half ? half : value;
}

function buildEmbeddingEndpoint(modelValue: string) {
  const trimmed = dedupeRepeated(modelValue.trim());
  if (!PROJECT_ID || !trimmed) {
    return '';
  }
  if (trimmed.startsWith('projects/')) {
    return trimmed;
  }
  if (trimmed.startsWith('publishers/') || trimmed.includes('/publishers/')) {
    return `projects/${PROJECT_ID}/locations/${EMBEDDING_LOCATION}/${trimmed.replace(/^\/+/, '')}`;
  }
  return `projects/${PROJECT_ID}/locations/${EMBEDDING_LOCATION}/publishers/google/models/${trimmed}`;
}

function extractEmbeddingValues(prediction: unknown): number[] {
  if (prediction && typeof prediction === 'object') {
    const direct = prediction as any;
    if (Array.isArray(direct.values)) return direct.values as number[];
    if (Array.isArray(direct.embedding?.values)) return direct.embedding.values as number[];
    if (Array.isArray(direct.embeddings?.values)) return direct.embeddings.values as number[];
  }
  const decoded = aiplatform.helpers.fromValue(prediction as any) as any;
  if (!decoded) return [];
  if (Array.isArray(decoded)) return decoded as number[];
  if (Array.isArray(decoded.values)) return decoded.values as number[];
  if (Array.isArray(decoded.embedding?.values)) return decoded.embedding.values as number[];
  if (Array.isArray(decoded.embeddings?.values)) return decoded.embeddings.values as number[];
  return [];
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function embedTexts(texts: string[]) {
  const endpoint = buildEmbeddingEndpoint(EMBEDDING_MODEL);
  if (!endpoint) return [];
  const cleaned = texts.map(text => text.trim());
  if (cleaned.some(text => !text)) {
    throw new Error('Embedding input contains empty chunks.');
  }

  const vectors: number[][] = [];
  const parametersPayload: Record<string, unknown> = {};
  if (EMBEDDING_TASK_TYPE) {
    parametersPayload.task_type = EMBEDDING_TASK_TYPE;
  }
  if (Number.isFinite(EMBEDDING_OUTPUT_DIM) && EMBEDDING_OUTPUT_DIM > 0) {
    parametersPayload.output_dimensionality = EMBEDDING_OUTPUT_DIM;
  }
  const parameters = Object.keys(parametersPayload).length
    ? aiplatform.helpers.toValue(parametersPayload)
    : undefined;

  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentTokens = 0;

  for (const text of cleaned) {
    const tokenEstimate = estimateTokens(text);
    if (tokenEstimate > EMBEDDING_BATCH_TOKEN_LIMIT) {
      const maxChars = EMBEDDING_BATCH_TOKEN_LIMIT * 4;
      const truncated = text.slice(0, maxChars);
      logger.warn('Embedding input too large, truncating chunk for model limits.');
      if (currentBatch.length) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([truncated]);
      continue;
    }

    if (
      currentBatch.length >= EMBEDDING_BATCH_SIZE ||
      currentTokens + tokenEstimate > EMBEDDING_BATCH_TOKEN_LIMIT
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(text);
    currentTokens += tokenEstimate;
  }

  if (currentBatch.length) {
    batches.push(currentBatch);
  }

  for (const batch of batches) {
    const instances = batch.map(text => aiplatform.helpers.toValue({ content: text }));
    try {
      const [response] = await (embeddingClient as any).predict({ endpoint, instances, parameters } as any);
      const predictions = response?.predictions || [];
      for (const prediction of predictions) {
        vectors.push(extractEmbeddingValues(prediction));
      }
    } catch (error: any) {
      const message = error?.message || 'Request contains an invalid argument.';
      throw new Error(`Vertex AI embedding failed. Details: ${message}. Endpoint: ${endpoint}`);
    }
  }

  return vectors;
}

async function upsertDatapoints(agentId: string, materialId: string, vectors: number[][]) {
  if (!VECTOR_INDEX_ID || !PROJECT_ID) return;
  const index = `projects/${PROJECT_ID}/locations/${VERTEX_LOCATION}/indexes/${VECTOR_INDEX_ID}`;
  const datapoints = vectors.map((vector, idx) => ({
    datapointId: `${materialId}-${idx}`,
    featureVector: vector,
    restricts: [
      { namespace: 'agentId', allowList: [agentId] }
    ]
  }));

  for (let i = 0; i < datapoints.length; i += 50) {
    const slice = datapoints.slice(i, i + 50);
    await indexClient.upsertDatapoints({ index, datapoints: slice });
  }
}

async function writeChunks(agentId: string, materialId: string, chunks: string[]) {
  let batch = db.batch();
  let batchCount = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const docId = `${materialId}-${i}`;
    const ref = db.collection('ragChunks').doc(docId);
    batch.set(ref, {
      agentId,
      materialId,
      text: chunks[i],
      chunkIndex: i,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    batchCount += 1;

    if (batchCount >= 400) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }
}

async function clearChunks(materialId: string) {
  const snapshot = await db.collection('ragChunks').where('materialId', '==', materialId).get();
  if (snapshot.empty) return;
  const docs = snapshot.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach(docSnap => batch.delete(docSnap.ref));
    await batch.commit();
  }
}

async function fallbackReferenceContext(agentId: string) {
  const materialsSnap = await db
    .collection('agents')
    .doc(agentId)
    .collection('materials')
    .where('status', '==', 'ready')
    .limit(6)
    .get();

  const parts: string[] = [];
  for (const docSnap of materialsSnap.docs) {
    const data = docSnap.data();
    if (typeof data.extractedText === 'string' && data.extractedText.trim()) {
      parts.push(`--- DOKUMENT: ${data.name || docSnap.id} ---
${data.extractedText}
--- SLUT DOKUMENT ---`);
    }
  }

  return parts.join('\n\n');
}

async function getReferenceContext(agentId: string, queryText: string) {
  if (!VECTOR_INDEX_ENDPOINT_ID || !VECTOR_DEPLOYED_INDEX_ID || !VECTOR_INDEX_ID) {
    return fallbackReferenceContext(agentId);
  }
  if (!queryText.trim()) {
    return fallbackReferenceContext(agentId);
  }

  try {
    const [queryVector] = await embedTexts([queryText]);
    if (!queryVector || queryVector.length === 0) {
      return fallbackReferenceContext(agentId);
    }

    const request: any = {
      indexEndpoint: `projects/${PROJECT_ID}/locations/${VERTEX_LOCATION}/indexEndpoints/${VECTOR_INDEX_ENDPOINT_ID}`,
      deployedIndexId: VECTOR_DEPLOYED_INDEX_ID,
      queries: [
        {
          datapoint: { datapointId: 'query', featureVector: queryVector },
          neighborCount: 6,
          restricts: [{ namespace: 'agentId', allowList: [agentId] }]
        }
      ],
      returnFullDatapoint: true
    };

    const [response] = await (indexEndpointClient as any).findNeighbors(request);
    const neighbors = response.nearestNeighbors?.[0]?.neighbors || [];
    const ids = neighbors
      .map((neighbor: any) => neighbor.datapoint?.datapointId)
      .filter((id: unknown): id is string => Boolean(id));

    if (ids.length === 0) {
      return fallbackReferenceContext(agentId);
    }

    const docRefs = ids.map((id: string) => db.collection('ragChunks').doc(id));
    const docs = await db.getAll(...docRefs);
    const parts = docs
      .map(docSnap => docSnap.data()?.text)
      .filter((text): text is string => Boolean(text))
      .map((text, idx) => `--- KALLA ${idx + 1} ---
${text}
--- SLUT KALLA ---`);

    return parts.join('\n\n');
  } catch (error) {
    logger.error('Vector search failed, falling back to raw docs.', error);
    return fallbackReferenceContext(agentId);
  }
}

export const processMaterial = onDocumentCreated(
  {
    document: 'agents/{agentId}/materials/{materialId}',
    region: REGION,
    secrets: FUNCTION_SECRETS,
    memory: '2GiB',
    timeoutSeconds: 540
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const { agentId, materialId } = event.params;
    const material = snapshot.data();
    if (!material) return;

    if (material.status === 'processing' || material.status === 'ready') {
      return;
    }

    if (!material.gcsPath) {
      await snapshot.ref.update({
        status: 'failed',
        error: 'Missing storage path.',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }

    if (!STORAGE_BUCKET) {
      await snapshot.ref.update({
        status: 'failed',
        error: 'Storage bucket is not configured.',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }

    const bucket = storage.bucket(STORAGE_BUCKET);

    try {
      await snapshot.ref.update({
        status: 'processing',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const [buffer] = await bucket.file(material.gcsPath).download();
      const rawText = await extractText(buffer, material.mimeType || '');
      const normalized = normalizeText(rawText);

      if (!normalized) {
        await snapshot.ref.update({
          status: 'failed',
          error: 'No text could be extracted.',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return;
      }

      const chunks = chunkText(normalized);
      if (chunks.length === 0) {
        await snapshot.ref.update({
          status: 'failed',
          error: 'Chunking produced no output.',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return;
      }

      await clearChunks(materialId);
      const vectors = await embedTexts(chunks);

      await writeChunks(agentId, materialId, chunks);
      if (vectors.length === chunks.length) {
        await upsertDatapoints(agentId, materialId, vectors);
      }

      await snapshot.ref.update({
        status: 'ready',
        extractedText: normalized.slice(0, MAX_PREVIEW_CHARS),
        chunkCount: chunks.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await logAudit('material_processed', { agentId, materialId, chunkCount: chunks.length });
    } catch (error: any) {
      logger.error('Material processing failed', error);
      await snapshot.ref.update({
        status: 'failed',
        error: error.message || 'Processing failed.',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
);

export const cleanupMaterial = onDocumentDeleted(
  {
    document: 'agents/{agentId}/materials/{materialId}',
    region: REGION,
    secrets: FUNCTION_SECRETS,
    memory: '1GiB',
    timeoutSeconds: 300
  },
  async (event: any) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const { materialId } = event.params;

    const chunkSnap = await db.collection('ragChunks').where('materialId', '==', materialId).get();
    if (chunkSnap.empty) return;

    const chunkIds = chunkSnap.docs.map(docSnap => docSnap.id);

    if (VECTOR_INDEX_ID && PROJECT_ID && chunkIds.length > 0) {
      const index = `projects/${PROJECT_ID}/locations/${VERTEX_LOCATION}/indexes/${VECTOR_INDEX_ID}`;
      try {
        await (indexClient as any).removeDatapoints({ index, datapointIds: chunkIds });
      } catch (error) {
        logger.warn('Failed to remove datapoints from Vector Search.', error);
      }
    }

    for (let i = 0; i < chunkSnap.docs.length; i += 400) {
      const batch = db.batch();
      chunkSnap.docs.slice(i, i + 400).forEach(docSnap => batch.delete(docSnap.ref));
      await batch.commit();
    }
  }
);

apiRouter.post('/access/validate', async (req, res) => {
  try {
    const { agentId, accessCode } = req.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).send('Missing agentId.');
    }
    if (!accessCode || typeof accessCode !== 'string') {
      return res.status(400).send('Missing accessCode.');
    }

    const accessSnap = await db.collection('agentAccess').doc(agentId).get();
    if (!accessSnap.exists) {
      return res.status(404).send('Access code not configured.');
    }

    const storedCode = typeof accessSnap.data()?.code === 'string' ? accessSnap.data()?.code : '';
    const normalizedInput = normalizeAccessCode(accessCode);
    if (!storedCode || normalizeAccessCode(storedCode) !== normalizedInput) {
      return res.status(403).send('Invalid access code.');
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(now + ACCESS_SESSION_TTL_MS);

    await db.collection('accessSessions').doc(token).set({
      agentId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt
    });

    await logAudit('access_granted', { agentId });
    return res.json({ accessToken: token });
  } catch (error: any) {
    logger.error('Access validation error', error);
    return res.status(500).send(error.message || 'Failed to validate access.');
  }
});

apiRouter.post('/access/accept', async (req, res) => {
  try {
    const { agentId, accessToken } = req.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).send('Missing agentId.');
    }
    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(400).send('Missing accessToken.');
    }

    const session = await getAccessSession(agentId, accessToken);
    if (!session) {
      return res.status(403).send('Invalid or expired access token.');
    }

    await session.ref.set(
      {
        acceptedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    await logAudit('access_session_started', { agentId });
    return res.json({ ok: true });
  } catch (error: any) {
    logger.error('Access accept error', error);
    return res.status(500).send(error.message || 'Failed to accept access.');
  }
});

apiRouter.post('/assessment', async (req, res) => {
  try {
    const { agentId, studentText, accessToken } = req.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).send('Missing agentId.');
    }
    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(403).send('Missing access token.');
    }
    if (!studentText || typeof studentText !== 'string') {
      return res.status(400).send('Missing studentText.');
    }
    if (studentText.length > 20000) {
      return res.status(400).send('Student text is too long.');
    }

    const session = await getAccessSession(agentId, accessToken);
    if (!session || !session.data?.acceptedAt) {
      return res.status(403).send('Invalid or expired access token.');
    }

    const agentSnap = await db.collection('agents').doc(agentId).get();
    if (!agentSnap.exists) {
      return res.status(404).send('Agent not found.');
    }

    const agent = agentSnap.data() || {};
    const criteria = Array.isArray(agent.criteria) ? agent.criteria : [];
    const description = typeof agent.description === 'string' ? agent.description : '';
    const stringency = (agent.stringency || 'standard') as 'generous' | 'standard' | 'strict';
    const referenceContext = await getReferenceContext(agentId, studentText);

    const studentPart = { text: `STUDENT TEXT FOR EVALUATION:\n${studentText}` };
    const contextPart = { text: `ASSIGNMENT CONTEXT:\n${description}\n\nCRITERIA:\n${criteria.join(', ')}` };
    const referencePart = referenceContext
      ? { text: `REFERENCE MATERIAL (RAG):\n${referenceContext}` }
      : { text: 'REFERENCE MATERIAL (RAG): None provided.' };

    const gradingResponse = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: { parts: [referencePart, contextPart, studentPart] },
      config: {
        systemInstruction: PROMPT_B_SYSTEM(stringency),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            formalia: {
              type: Type.OBJECT,
              properties: {
                status: { type: Type.STRING },
                word_count: { type: Type.NUMBER },
                ref_check: { type: Type.STRING }
              },
              required: ['status', 'word_count', 'ref_check']
            },
            criteria_scores: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  level: { type: Type.STRING },
                  score: { type: Type.NUMBER }
                },
                required: ['id', 'level', 'score']
              }
            },
            final_metrics: {
              type: Type.OBJECT,
              properties: { score_100k: { type: Type.NUMBER } },
              required: ['score_100k']
            },
            teacher_insights: {
              type: Type.OBJECT,
              properties: {
                common_errors: { type: Type.ARRAY, items: { type: Type.STRING } },
                strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
                teaching_actions: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ['common_errors', 'strengths', 'teaching_actions']
            }
          },
          required: ['formalia', 'criteria_scores', 'final_metrics', 'teacher_insights']
        }
      }
    });

    const assessmentText = gradingResponse.text || '{}';
    const assessment = JSON.parse(assessmentText);

    const feedbackResponse = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          referencePart,
          { text: `ANALYTICAL ASSESSMENT DATA: ${JSON.stringify(assessment)}` },
          contextPart,
          studentPart
        ]
      },
      config: { systemInstruction: PROMPT_A_SYSTEM }
    });

    const score = assessment?.final_metrics?.score_100k || 0;
    const sessionSuffix = Math.floor(1000 + Math.random() * 9000);
    const verificationCode = generateVerificationCode(score, sessionSuffix);

    const visibleTo = Array.isArray(agent.visibleTo) ? agent.visibleTo : [agent.ownerUid].filter(Boolean);
    await db.collection('submissions').add({
      agentId,
      verificationCode,
      score,
      timestamp: Date.now(),
      stringency,
      insights: assessment.teacher_insights || { common_errors: [], strengths: [], teaching_actions: [] },
      visibleTo
    });

    await logAudit('assessment', { agentId, score });

    return res.json({
      assessment,
      feedback: feedbackResponse.text || 'Feedback generation failed.',
      verificationCode
    });
  } catch (error: any) {
    logger.error('Assessment error', error);
    return res.status(500).send(error.message || 'Failed to process assessment.');
  }
});

apiRouter.post('/criterion/improve', async (req, res) => {
  try {
    const { agentId, sketch, taskDescription } = req.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).send('Missing agentId.');
    }
    if (!sketch || typeof sketch !== 'string') {
      return res.status(400).send('Missing sketch.');
    }

    const queryText = `${taskDescription || ''}\n${sketch}`;
    const referenceContext = await getReferenceContext(agentId, queryText);
    const systemPrompt = `Role: Expert on pedagogical assessment matrix design.
Transform the sketch into a professional rubric with 3 levels.
Include an (AI-indicator) at the end of each level description.
Format as a Markdown table:| Criterion | Level 1 | Level 2 | Level 3 |\n|---|---|---|---|`;

    const prompt = `REFERENCE MATERIAL (RAG):\n${referenceContext || 'No reference material.'}\n\nTASK DESCRIPTION:\n${taskDescription || ''}\n\nUSER SKETCH:\n${sketch}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.1
      }
    });

    const text = (response.text || '').replace(/```markdown/gi, '').replace(/```/gi, '').trim();
    await logAudit('improve_criterion', { agentId });
    return res.json({ text });
  } catch (error: any) {
    logger.error('Improve criterion error', error);
    return res.status(500).send(error.message || 'Failed to improve criterion.');
  }
});

apiRouter.post('/translate', async (req, res) => {
  try {
    const { name, description, targetLang } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).send('Missing name.');
    }
    if (!description || typeof description !== 'string') {
      return res.status(400).send('Missing description.');
    }

    const prompt = `Translate to ${targetLang === 'sv' ? 'Swedish' : 'English'}. Return ONLY JSON with "name" and "description".\n\nNAME: ${name}\nDESCRIPTION: ${description}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            description: { type: Type.STRING }
          },
          required: ['name', 'description']
        }
      }
    });

    const payload = JSON.parse(response.text || '{}');
    await logAudit('translate', {});
    return res.json({
      name: payload.name || name,
      description: payload.description || description
    });
  } catch (error: any) {
    logger.error('Translate error', error);
    return res.status(500).send(error.message || 'Failed to translate content.');
  }
});

app.use('/api', apiRouter);
app.use('/', apiRouter);

export const api = onRequest(
  {
    region: REGION,
    cors: true,
    secrets: FUNCTION_SECRETS,
    memory: '1GiB',
    timeoutSeconds: 120
  },
  app
);
