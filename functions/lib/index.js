"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = exports.cleanupMaterial = exports.processMaterial = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-functions/v2/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const admin = __importStar(require("firebase-admin"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const genai_1 = require("@google/genai");
const documentai_1 = require("@google-cloud/documentai");
const vision_1 = require("@google-cloud/vision");
const storage_1 = require("@google-cloud/storage");
const aiplatform = __importStar(require("@google-cloud/aiplatform"));
const jszip_1 = __importDefault(require("jszip"));
const pdf_lib_1 = require("pdf-lib");
const crypto_1 = __importDefault(require("crypto"));
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
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET ||
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
const TRIM_TOKEN_BUDGET = 9000;
const DOC_AI_PAGE_LIMIT = 30;
const ACCESS_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const TOS_VERSION = 'v1-2026-01';
const PROMO_CODE_LENGTH = 8;
const db = admin.firestore();
const ai = new genai_1.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
const storage = new storage_1.Storage();
const visionClient = new vision_1.ImageAnnotatorClient();
const documentAiClient = new documentai_1.DocumentProcessorServiceClient({
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
const PROMPT_B_SYSTEM = (stringency) => `Role: Objective academic grading engine. Output: JSON only.
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
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true }));
app.use(express_1.default.json({ limit: '2mb' }));
app.use((req, res, next) => {
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).send('GEMINI_API_KEY is not configured.');
    }
    return next();
});
const apiRouter = express_1.default.Router();
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
const PREFIX_MIN = 200;
const PREFIX_MAX = 998;
const SCORE_BUCKET_DIVISOR = 100;
const SCORE_BUCKET_MULTIPLIER = 1000;
const clampNumber = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));
const hashSeed = (seed) => {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = (hash * 31 + seed.charCodeAt(i)) % 2147483647;
    }
    return hash;
};
const normalizeVerificationPrefix = (prefix) => {
    if (typeof prefix !== 'number' || Number.isNaN(prefix))
        return null;
    const rounded = Math.round(prefix);
    if (rounded < PREFIX_MIN || rounded > PREFIX_MAX)
        return null;
    return rounded;
};
const generateVerificationPrefix = (seed) => {
    const range = PREFIX_MAX - PREFIX_MIN + 1;
    return PREFIX_MIN + (hashSeed(seed) % range);
};
function generateVerificationCode(score, sessionSuffix, prefix) {
    const cleanScore = clampNumber(score, 0, 100000);
    const bucket = Math.min(999, Math.floor(cleanScore / SCORE_BUCKET_DIVISOR));
    const cleanSuffix = clampNumber(sessionSuffix, 0, 999);
    const cleanPrefix = normalizeVerificationPrefix(prefix) ?? PREFIX_MIN;
    const numericCode = (cleanPrefix * 1000000) + (bucket * SCORE_BUCKET_MULTIPLIER) + cleanSuffix;
    return numericCode.toString();
}
const getScoreBucket = (score) => Math.min(999, Math.floor(clampNumber(score, 0, 100000) / SCORE_BUCKET_DIVISOR));
const randomPrefixInRange = (minPrefix) => {
    const minValue = Math.min(PREFIX_MAX, Math.max(PREFIX_MIN, minPrefix));
    const range = PREFIX_MAX - minValue + 1;
    return minValue + Math.floor(Math.random() * range);
};
const randomPrefixBelow = (minPrefix) => {
    const minValue = Math.min(PREFIX_MAX, Math.max(PREFIX_MIN, minPrefix));
    if (minValue <= PREFIX_MIN) {
        return PREFIX_MIN;
    }
    const maxValue = minValue - 1;
    const range = maxValue - PREFIX_MIN + 1;
    return PREFIX_MIN + Math.floor(Math.random() * range);
};
async function logAudit(event, details) {
    await db.collection('auditLogs').add({
        event,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        ...details
    });
}
async function requireAuth(req, res) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        res.status(401).send('Missing auth token.');
        return null;
    }
    const token = header.slice('Bearer '.length);
    try {
        return await admin.auth().verifyIdToken(token);
    }
    catch {
        res.status(401).send('Invalid auth token.');
        return null;
    }
}
async function requireAdmin(req, res) {
    const authUser = await requireAuth(req, res);
    if (!authUser)
        return null;
    const userSnap = await db.collection('users').doc(authUser.uid).get();
    if (!userSnap.exists || userSnap.data()?.role !== 'admin') {
        res.status(403).send('Admin access required.');
        return null;
    }
    return authUser;
}
async function getAccessSession(agentId, accessToken) {
    if (!accessToken)
        return null;
    const sessionSnap = await db.collection('accessSessions').doc(accessToken).get();
    if (!sessionSnap.exists)
        return null;
    const data = sessionSnap.data() || {};
    if (data.agentId !== agentId)
        return null;
    const expiresAt = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : data.expiresAt;
    if (!expiresAt || Date.now() > expiresAt)
        return null;
    return { ref: sessionSnap.ref, data };
}
function normalizeText(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function normalizeAccessCode(value) {
    return value.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
function generatePromoCode(length = PROMO_CODE_LENGTH) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < length; i += 1) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}
function decodeEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
function stripHtml(text) {
    return decodeEntities(text.replace(/<[^>]+>/g, ' '));
}
function stripRtf(text) {
    return text
        .replace(/\\par[d]?/g, ' ')
        .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
        .replace(/\\[a-zA-Z]+[0-9]?/g, ' ')
        .replace(/[{}]/g, ' ');
}
async function processDocumentAi(buffer, mimeType) {
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
async function splitPdf(buffer, maxPages) {
    const pdf = await pdf_lib_1.PDFDocument.load(buffer);
    const totalPages = pdf.getPageCount();
    if (totalPages <= maxPages) {
        return { totalPages, chunks: [buffer] };
    }
    const chunks = [];
    for (let start = 0; start < totalPages; start += maxPages) {
        const end = Math.min(start + maxPages, totalPages);
        const doc = await pdf_lib_1.PDFDocument.create();
        const indices = Array.from({ length: end - start }, (_, idx) => start + idx);
        const pages = await doc.copyPages(pdf, indices);
        pages.forEach(page => doc.addPage(page));
        const bytes = await doc.save();
        chunks.push(Buffer.from(bytes));
    }
    return { totalPages, chunks };
}
async function extractTextFromDocumentAi(buffer, mimeType) {
    if (!DOC_AI_PROCESSOR_ID) {
        return '';
    }
    if (PDF_MIME_TYPES.has(mimeType)) {
        const { totalPages, chunks } = await splitPdf(buffer, DOC_AI_PAGE_LIMIT);
        if (totalPages > DOC_AI_PAGE_LIMIT) {
            const parts = [];
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
async function extractTextFromVision(buffer) {
    const [result] = await visionClient.textDetection({
        image: { content: buffer }
    });
    return result.fullTextAnnotation?.text || '';
}
async function extractTextFromZip(buffer, mimeType) {
    const zip = await jszip_1.default.loadAsync(buffer);
    const fileNames = Object.keys(zip.files);
    const xmlTargets = [];
    if (mimeType.includes('wordprocessingml')) {
        xmlTargets.push('word/document.xml');
        xmlTargets.push(...fileNames.filter(name => name.startsWith('word/header')));
        xmlTargets.push(...fileNames.filter(name => name.startsWith('word/footer')));
    }
    else if (mimeType.includes('presentationml')) {
        xmlTargets.push(...fileNames.filter(name => name.startsWith('ppt/slides/slide')));
        xmlTargets.push(...fileNames.filter(name => name.startsWith('ppt/notesSlides/notesSlide')));
    }
    else if (mimeType.includes('spreadsheetml')) {
        xmlTargets.push('xl/sharedStrings.xml');
        xmlTargets.push(...fileNames.filter(name => name.startsWith('xl/worksheets/sheet')));
    }
    else if (mimeType.includes('oasis.opendocument')) {
        xmlTargets.push('content.xml');
    }
    const parts = [];
    for (const target of xmlTargets) {
        const file = zip.file(target);
        if (!file)
            continue;
        const xml = await file.async('string');
        parts.push(stripHtml(xml));
    }
    return parts.join(' ');
}
async function extractText(buffer, mimeType) {
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
        if (docText)
            return docText;
        return extractTextFromVision(buffer);
    }
    if (ZIP_XML_TYPES.has(mimeType)) {
        return extractTextFromZip(buffer, mimeType);
    }
    return '';
}
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const cleaned = normalizeText(text);
    if (!cleaned)
        return [];
    const chunks = [];
    let index = 0;
    while (index < cleaned.length) {
        const slice = cleaned.slice(index, index + chunkSize);
        chunks.push(slice);
        if (index + chunkSize >= cleaned.length)
            break;
        index += chunkSize - overlap;
    }
    return chunks;
}
function limitChunksByTokenBudget(chunks, budget) {
    const limited = [];
    let total = 0;
    for (const chunk of chunks) {
        const tokens = estimateTokens(chunk);
        if (total + tokens > budget)
            break;
        limited.push(chunk);
        total += tokens;
    }
    return limited;
}
function dedupeRepeated(value) {
    if (value.length % 2 !== 0)
        return value;
    const half = value.slice(0, value.length / 2);
    return value === half + half ? half : value;
}
function buildEmbeddingEndpoint(modelValue) {
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
function extractEmbeddingValues(prediction) {
    if (prediction && typeof prediction === 'object') {
        const direct = prediction;
        if (Array.isArray(direct.values))
            return direct.values;
        if (Array.isArray(direct.embedding?.values))
            return direct.embedding.values;
        if (Array.isArray(direct.embeddings?.values))
            return direct.embeddings.values;
    }
    const decoded = aiplatform.helpers.fromValue(prediction);
    if (!decoded)
        return [];
    if (Array.isArray(decoded))
        return decoded;
    if (Array.isArray(decoded.values))
        return decoded.values;
    if (Array.isArray(decoded.embedding?.values))
        return decoded.embedding.values;
    if (Array.isArray(decoded.embeddings?.values))
        return decoded.embeddings.values;
    return [];
}
function estimateTokens(text) {
    return Math.max(1, Math.ceil(text.length / 3));
}
async function embedTexts(texts) {
    const endpoint = buildEmbeddingEndpoint(EMBEDDING_MODEL);
    if (!endpoint)
        return [];
    const cleaned = texts.map(text => text.trim());
    if (cleaned.some(text => !text)) {
        throw new Error('Embedding input contains empty chunks.');
    }
    const vectors = [];
    const parametersPayload = {};
    if (EMBEDDING_TASK_TYPE) {
        parametersPayload.task_type = EMBEDDING_TASK_TYPE;
    }
    if (Number.isFinite(EMBEDDING_OUTPUT_DIM) && EMBEDDING_OUTPUT_DIM > 0) {
        parametersPayload.output_dimensionality = EMBEDDING_OUTPUT_DIM;
    }
    const parameters = Object.keys(parametersPayload).length
        ? aiplatform.helpers.toValue(parametersPayload)
        : undefined;
    const batches = [];
    let currentBatch = [];
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
        if (currentBatch.length >= EMBEDDING_BATCH_SIZE ||
            currentTokens + tokenEstimate > EMBEDDING_BATCH_TOKEN_LIMIT) {
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
            const [response] = await embeddingClient.predict({ endpoint, instances, parameters });
            const predictions = response?.predictions || [];
            for (const prediction of predictions) {
                vectors.push(extractEmbeddingValues(prediction));
            }
        }
        catch (error) {
            const message = error?.message || 'Request contains an invalid argument.';
            if (/input token count/i.test(message) && /supports up to/i.test(message)) {
                const match = message.match(/input token count is (\d+).*supports up to (\d+)/i);
                const tokenCount = match ? Number(match[1]) : undefined;
                const tokenLimit = match ? Number(match[2]) : undefined;
                const tokenError = new Error(message);
                tokenError.code = 'TOKEN_LIMIT';
                tokenError.tokenCount = tokenCount;
                tokenError.tokenLimit = tokenLimit;
                throw tokenError;
            }
            throw new Error(`Vertex AI embedding failed. Details: ${message}. Endpoint: ${endpoint}`);
        }
    }
    return vectors;
}
async function upsertDatapoints(agentId, materialId, vectors) {
    if (!VECTOR_INDEX_ID || !PROJECT_ID)
        return;
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
async function writeChunks(agentId, materialId, chunks) {
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
async function clearChunks(materialId) {
    const snapshot = await db.collection('ragChunks').where('materialId', '==', materialId).get();
    if (snapshot.empty)
        return;
    const docs = snapshot.docs;
    for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        docs.slice(i, i + 400).forEach(docSnap => batch.delete(docSnap.ref));
        await batch.commit();
    }
}
async function fallbackReferenceContext(agentId) {
    const materialsSnap = await db
        .collection('agents')
        .doc(agentId)
        .collection('materials')
        .where('status', '==', 'ready')
        .limit(6)
        .get();
    const parts = [];
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
async function getReferenceContext(agentId, queryText) {
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
        const request = {
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
        const [response] = await indexEndpointClient.findNeighbors(request);
        const neighbors = response.nearestNeighbors?.[0]?.neighbors || [];
        const ids = neighbors
            .map((neighbor) => neighbor.datapoint?.datapointId)
            .filter((id) => Boolean(id));
        if (ids.length === 0) {
            return fallbackReferenceContext(agentId);
        }
        const docRefs = ids.map((id) => db.collection('ragChunks').doc(id));
        const docs = await db.getAll(...docRefs);
        const parts = docs
            .map(docSnap => docSnap.data()?.text)
            .filter((text) => Boolean(text))
            .map((text, idx) => `--- KALLA ${idx + 1} ---
${text}
--- SLUT KALLA ---`);
        return parts.join('\n\n');
    }
    catch (error) {
        logger.error('Vector search failed, falling back to raw docs.', error);
        return fallbackReferenceContext(agentId);
    }
}
exports.processMaterial = (0, firestore_1.onDocumentWritten)({
    document: 'agents/{agentId}/materials/{materialId}',
    region: REGION,
    secrets: FUNCTION_SECRETS,
    memory: '2GiB',
    timeoutSeconds: 540
}, async (event) => {
    const snapshot = event.data?.after;
    const beforeSnapshot = event.data?.before;
    if (!snapshot)
        return;
    const { agentId, materialId } = event.params;
    const material = snapshot.data();
    if (!material)
        return;
    const currentStatus = material.status || 'uploaded';
    const previousStatus = beforeSnapshot?.exists ? beforeSnapshot.data()?.status : null;
    const reprocessRequested = material.reprocessRequested === true;
    if (currentStatus === 'processing' || currentStatus === 'ready') {
        return;
    }
    if (currentStatus !== 'uploaded') {
        return;
    }
    if (previousStatus === 'uploaded' && !reprocessRequested) {
        return;
    }
    if (reprocessRequested) {
        await snapshot.ref.set({ reprocessRequested: admin.firestore.FieldValue.delete() }, { merge: true });
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
        const totalTokenEstimate = chunks.reduce((sum, chunk) => sum + estimateTokens(chunk), 0);
        const trimmedChunks = material.forceTrim
            ? limitChunksByTokenBudget(chunks, TRIM_TOKEN_BUDGET)
            : chunks;
        if (material.forceTrim && trimmedChunks.length === 0) {
            await snapshot.ref.update({
                status: 'failed',
                error: 'Trimmed content is empty.',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
        }
        const vectors = await embedTexts(trimmedChunks);
        await writeChunks(agentId, materialId, trimmedChunks);
        if (vectors.length === trimmedChunks.length) {
            await upsertDatapoints(agentId, materialId, vectors);
        }
        await snapshot.ref.update({
            status: 'ready',
            extractedText: normalized.slice(0, MAX_PREVIEW_CHARS),
            chunkCount: trimmedChunks.length,
            originalChunkCount: chunks.length,
            tokenEstimate: totalTokenEstimate,
            trimmed: material.forceTrim === true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await logAudit('material_processed', { agentId, materialId, chunkCount: trimmedChunks.length });
    }
    catch (error) {
        logger.error('Material processing failed', error);
        if (error?.code === 'TOKEN_LIMIT') {
            await snapshot.ref.update({
                status: 'needs_review',
                errorCode: 'TOKEN_LIMIT',
                error: error.message || 'Token limit exceeded.',
                tokenCount: error.tokenCount || null,
                tokenLimit: error.tokenLimit || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
        }
        await snapshot.ref.update({
            status: 'failed',
            error: error.message || 'Processing failed.',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
});
exports.cleanupMaterial = (0, firestore_1.onDocumentDeleted)({
    document: 'agents/{agentId}/materials/{materialId}',
    region: REGION,
    secrets: FUNCTION_SECRETS,
    memory: '1GiB',
    timeoutSeconds: 300
}, async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const { materialId } = event.params;
    const chunkSnap = await db.collection('ragChunks').where('materialId', '==', materialId).get();
    if (chunkSnap.empty)
        return;
    const chunkIds = chunkSnap.docs.map(docSnap => docSnap.id);
    if (VECTOR_INDEX_ID && PROJECT_ID && chunkIds.length > 0) {
        const index = `projects/${PROJECT_ID}/locations/${VERTEX_LOCATION}/indexes/${VECTOR_INDEX_ID}`;
        try {
            await indexClient.removeDatapoints({ index, datapointIds: chunkIds });
        }
        catch (error) {
            logger.warn('Failed to remove datapoints from Vector Search.', error);
        }
    }
    for (let i = 0; i < chunkSnap.docs.length; i += 400) {
        const batch = db.batch();
        chunkSnap.docs.slice(i, i + 400).forEach(docSnap => batch.delete(docSnap.ref));
        await batch.commit();
    }
});
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
        const token = crypto_1.default.randomBytes(24).toString('base64url');
        const now = Date.now();
        const expiresAt = admin.firestore.Timestamp.fromMillis(now + ACCESS_SESSION_TTL_MS);
        await db.collection('accessSessions').doc(token).set({
            agentId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt
        });
        await logAudit('access_granted', { agentId });
        return res.json({ accessToken: token });
    }
    catch (error) {
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
        await session.ref.set({
            acceptedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await logAudit('access_session_started', { agentId });
        return res.json({ ok: true });
    }
    catch (error) {
        logger.error('Access accept error', error);
        return res.status(500).send(error.message || 'Failed to accept access.');
    }
});
apiRouter.get('/teacher/promo-codes', async (req, res) => {
    try {
        const authUser = await requireAdmin(req, res);
        if (!authUser)
            return;
        const limitParam = Number(req.query.limit || 25);
        const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 25;
        const snapshot = await db
            .collection('promoCodes')
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();
        const codes = snapshot.docs.map(docSnap => {
            const data = docSnap.data() || {};
            return {
                id: docSnap.id,
                code: typeof data.code === 'string' ? data.code : docSnap.id,
                active: data.active !== false,
                maxUses: Number(data.maxUses ?? 0),
                currentUses: Number(data.currentUses ?? 0),
                orgId: data.orgId || null,
                createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null
            };
        });
        return res.json({ codes });
    }
    catch (error) {
        logger.error('Promo code list error', error);
        return res.status(500).send(error.message || 'Failed to list promo codes.');
    }
});
apiRouter.post('/teacher/promo-codes', async (req, res) => {
    try {
        const authUser = await requireAdmin(req, res);
        if (!authUser)
            return;
        const { code, maxUses, orgId } = req.body || {};
        const normalized = code ? normalizeAccessCode(String(code)) : generatePromoCode();
        if (!normalized) {
            return res.status(400).send('Invalid promo code.');
        }
        const maxUsesValue = Number.isFinite(Number(maxUses)) ? Math.max(0, Math.floor(Number(maxUses))) : 0;
        const promoRef = db.collection('promoCodes').doc(normalized);
        const existing = await promoRef.get();
        if (existing.exists) {
            return res.status(409).send('Promo code already exists.');
        }
        await promoRef.set({
            code: normalized,
            active: true,
            maxUses: maxUsesValue,
            currentUses: 0,
            orgId: orgId || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: authUser.uid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await logAudit('promo_code_created', { uid: authUser.uid, promoCode: normalized });
        return res.json({ code: normalized });
    }
    catch (error) {
        logger.error('Promo code create error', error);
        return res.status(500).send(error.message || 'Failed to create promo code.');
    }
});
apiRouter.post('/teacher/promo-codes/disable', async (req, res) => {
    try {
        const authUser = await requireAdmin(req, res);
        if (!authUser)
            return;
        const { code } = req.body || {};
        const normalized = code ? normalizeAccessCode(String(code)) : '';
        if (!normalized) {
            return res.status(400).send('Missing promo code.');
        }
        const promoRef = db.collection('promoCodes').doc(normalized);
        const promoSnap = await promoRef.get();
        if (!promoSnap.exists) {
            return res.status(404).send('Promo code not found.');
        }
        await promoRef.set({ active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await logAudit('promo_code_disabled', { uid: authUser.uid, promoCode: normalized });
        return res.json({ ok: true });
    }
    catch (error) {
        logger.error('Promo code disable error', error);
        return res.status(500).send(error.message || 'Failed to disable promo code.');
    }
});
apiRouter.post('/teacher/authorize', async (req, res) => {
    try {
        const authUser = await requireAuth(req, res);
        if (!authUser)
            return;
        const { promoCode } = req.body || {};
        if (!promoCode || typeof promoCode !== 'string') {
            return res.status(400).send('Missing promoCode.');
        }
        const normalized = normalizeAccessCode(promoCode);
        if (!normalized) {
            return res.status(400).send('Invalid promoCode.');
        }
        const promoRef = db.collection('promoCodes').doc(normalized);
        const userRef = db.collection('users').doc(authUser.uid);
        await db.runTransaction(async (tx) => {
            const promoSnap = await tx.get(promoRef);
            if (!promoSnap.exists) {
                throw new Error('Invalid promo code.');
            }
            const promo = promoSnap.data() || {};
            const active = promo.active !== false;
            const maxUses = Number(promo.maxUses ?? 0);
            const currentUses = Number(promo.currentUses ?? 0);
            const userSnap = await tx.get(userRef);
            const alreadyAuthorized = userSnap.exists && userSnap.data()?.isAuthorized === true;
            if (!active) {
                throw new Error('Promo code inactive.');
            }
            if (!alreadyAuthorized && maxUses > 0 && currentUses >= maxUses) {
                throw new Error('Promo code exhausted.');
            }
            if (!alreadyAuthorized) {
                tx.set(promoRef, {
                    currentUses: admin.firestore.FieldValue.increment(1),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }
            tx.set(userRef, {
                email: authUser.email || '',
                isAuthorized: true,
                promoCodeId: promoRef.id,
                orgId: promo.orgId || null,
                authorizedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
        await logAudit('teacher_authorized', { uid: authUser.uid, promoCode: normalized });
        return res.json({ ok: true });
    }
    catch (error) {
        logger.error('Teacher authorize error', error);
        return res.status(403).send(error.message || 'Failed to authorize.');
    }
});
apiRouter.post('/teacher/accept-tos', async (req, res) => {
    try {
        const authUser = await requireAuth(req, res);
        if (!authUser)
            return;
        const { tosVersion } = req.body || {};
        if (!tosVersion || typeof tosVersion !== 'string') {
            return res.status(400).send('Missing tosVersion.');
        }
        const userRef = db.collection('users').doc(authUser.uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists || userSnap.data()?.isAuthorized !== true) {
            return res.status(403).send('Not authorized.');
        }
        await userRef.set({
            hasAcceptedTos: true,
            tosVersion,
            tosAcceptedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await logAudit('teacher_tos_accepted', { uid: authUser.uid, tosVersion });
        return res.json({ ok: true, tosVersion: TOS_VERSION });
    }
    catch (error) {
        logger.error('Teacher TOS accept error', error);
        return res.status(500).send(error.message || 'Failed to accept TOS.');
    }
});
apiRouter.get('/teacher/logs/export', async (req, res) => {
    try {
        const authUser = await requireAuth(req, res);
        if (!authUser)
            return;
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
        if (!agentId) {
            return res.status(400).send('Missing agentId.');
        }
        const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'csv';
        const from = req.query.from ? Number(req.query.from) : undefined;
        const to = req.query.to ? Number(req.query.to) : undefined;
        const agentSnap = await db.collection('agents').doc(agentId).get();
        if (!agentSnap.exists) {
            return res.status(404).send('Agent not found.');
        }
        const agent = agentSnap.data() || {};
        const visibleTo = Array.isArray(agent.visibleTo) ? agent.visibleTo : [];
        if (agent.ownerUid !== authUser.uid && !visibleTo.includes(authUser.uid)) {
            return res.status(403).send('Not authorized.');
        }
        let query = db.collection('submissions').where('agentId', '==', agentId);
        if (Number.isFinite(from)) {
            query = query.where('timestamp', '>=', from);
        }
        if (Number.isFinite(to)) {
            query = query.where('timestamp', '<=', to);
        }
        const snapshot = await query.get();
        const rows = snapshot.docs.map(docSnap => docSnap.data());
        rows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        if (format === 'json') {
            const records = rows.map((row) => ({
                timestamp: row.timestamp || 0,
                session_id: row.sessionId || '',
                score_100k: row.score || 0,
                stringency: row.stringency || '',
                common_errors: row.insights?.common_errors || [],
                strengths: row.insights?.strengths || [],
                teaching_actions: row.insights?.teaching_actions || []
            }));
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="feedback-log-${agentId}.json"`);
            return res.send(JSON.stringify({ agentId, count: records.length, records }, null, 2));
        }
        if (format === 'txt') {
            const lines = [];
            lines.push(`agent_id: ${agentId}`);
            lines.push(`records: ${rows.length}`);
            lines.push('');
            for (const row of rows) {
                lines.push(`timestamp: ${row.timestamp || 0}`);
                lines.push(`session_id: ${row.sessionId || ''}`);
                lines.push(`score_100k: ${row.score || 0}`);
                lines.push(`stringency: ${row.stringency || ''}`);
                lines.push(`common_errors: ${(row.insights?.common_errors || []).join(' | ')}`);
                lines.push(`strengths: ${(row.insights?.strengths || []).join(' | ')}`);
                lines.push(`teaching_actions: ${(row.insights?.teaching_actions || []).join(' | ')}`);
                lines.push('---');
            }
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="feedback-log-${agentId}.txt"`);
            return res.send(lines.join('\n'));
        }
        const header = ['timestamp', 'session_id', 'score_100k', 'stringency', 'common_errors', 'strengths', 'teaching_actions'];
        const lines = [header.join(',')];
        for (const row of rows) {
            const values = [
                row.timestamp || 0,
                row.sessionId || '',
                row.score || 0,
                row.stringency || '',
                (row.insights?.common_errors || []).join(' | '),
                (row.insights?.strengths || []).join(' | '),
                (row.insights?.teaching_actions || []).join(' | ')
            ].map((value) => {
                const str = String(value ?? '');
                return `"${str.replace(/"/g, '""')}"`;
            });
            lines.push(values.join(','));
        }
        const csv = lines.join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="feedback-log-${agentId}.csv"`);
        return res.send(csv);
    }
    catch (error) {
        logger.error('Log export error', error);
        return res.status(500).send(error.message || 'Failed to export logs.');
    }
});
apiRouter.post('/teacher/logs/clear', async (req, res) => {
    try {
        const authUser = await requireAuth(req, res);
        if (!authUser)
            return;
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
        if (!agentId) {
            return res.status(400).send('Missing agentId.');
        }
        const agentSnap = await db.collection('agents').doc(agentId).get();
        if (!agentSnap.exists) {
            return res.status(404).send('Agent not found.');
        }
        const agent = agentSnap.data() || {};
        const visibleTo = Array.isArray(agent.visibleTo) ? agent.visibleTo : [];
        if (agent.ownerUid !== authUser.uid && !visibleTo.includes(authUser.uid)) {
            return res.status(403).send('Not authorized.');
        }
        const submissionsSnap = await db.collection('submissions').where('agentId', '==', agentId).get();
        if (submissionsSnap.empty) {
            return res.json({ ok: true, deleted: 0 });
        }
        let deleted = 0;
        for (let i = 0; i < submissionsSnap.docs.length; i += 400) {
            const batch = db.batch();
            submissionsSnap.docs.slice(i, i + 400).forEach(docSnap => {
                batch.delete(docSnap.ref);
            });
            await batch.commit();
            deleted += Math.min(400, submissionsSnap.docs.length - i);
        }
        await logAudit('log_cleared', { agentId, deleted });
        return res.json({ ok: true, deleted });
    }
    catch (error) {
        logger.error('Log clear error', error);
        return res.status(500).send(error.message || 'Failed to clear logs.');
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
        const agentRef = db.collection('agents').doc(agentId);
        const agentSnap = await agentRef.get();
        if (!agentSnap.exists) {
            return res.status(404).send('Agent not found.');
        }
        const agent = agentSnap.data() || {};
        const criteria = Array.isArray(agent.criteria) ? agent.criteria : [];
        const description = typeof agent.description === 'string' ? agent.description : '';
        const stringency = (agent.stringency || 'standard');
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
                    type: genai_1.Type.OBJECT,
                    properties: {
                        formalia: {
                            type: genai_1.Type.OBJECT,
                            properties: {
                                status: { type: genai_1.Type.STRING },
                                word_count: { type: genai_1.Type.NUMBER },
                                ref_check: { type: genai_1.Type.STRING }
                            },
                            required: ['status', 'word_count', 'ref_check']
                        },
                        criteria_scores: {
                            type: genai_1.Type.ARRAY,
                            items: {
                                type: genai_1.Type.OBJECT,
                                properties: {
                                    id: { type: genai_1.Type.STRING },
                                    level: { type: genai_1.Type.STRING },
                                    score: { type: genai_1.Type.NUMBER }
                                },
                                required: ['id', 'level', 'score']
                            }
                        },
                        final_metrics: {
                            type: genai_1.Type.OBJECT,
                            properties: { score_100k: { type: genai_1.Type.NUMBER } },
                            required: ['score_100k']
                        },
                        teacher_insights: {
                            type: genai_1.Type.OBJECT,
                            properties: {
                                common_errors: { type: genai_1.Type.ARRAY, items: { type: genai_1.Type.STRING } },
                                strengths: { type: genai_1.Type.ARRAY, items: { type: genai_1.Type.STRING } },
                                teaching_actions: { type: genai_1.Type.ARRAY, items: { type: genai_1.Type.STRING } }
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
        let minPrefix = normalizeVerificationPrefix(agent.verificationPrefix);
        if (!minPrefix) {
            minPrefix = generateVerificationPrefix(agentId);
            await agentRef.set({ verificationPrefix: minPrefix }, { merge: true });
        }
        const score = assessment?.final_metrics?.score_100k || 0;
        const passThreshold = typeof agent.passThreshold === 'number' ? agent.passThreshold : 80000;
        const passBucket = getScoreBucket(passThreshold);
        const scoreBucket = getScoreBucket(score);
        const isPassed = scoreBucket >= passBucket;
        const codePrefix = isPassed ? randomPrefixInRange(minPrefix) : randomPrefixBelow(minPrefix);
        const sessionSuffix = Math.floor(Math.random() * 1000);
        const verificationCode = generateVerificationCode(score, sessionSuffix, codePrefix);
        const visibleTo = Array.isArray(agent.visibleTo) ? agent.visibleTo : [agent.ownerUid].filter(Boolean);
        const sessionId = crypto_1.default.createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
        await db.collection('submissions').add({
            agentId,
            verificationCode,
            score,
            timestamp: Date.now(),
            sessionId,
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
    }
    catch (error) {
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
    }
    catch (error) {
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
                    type: genai_1.Type.OBJECT,
                    properties: {
                        name: { type: genai_1.Type.STRING },
                        description: { type: genai_1.Type.STRING }
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
    }
    catch (error) {
        logger.error('Translate error', error);
        return res.status(500).send(error.message || 'Failed to translate content.');
    }
});
app.use('/api', apiRouter);
app.use('/', apiRouter);
exports.api = (0, https_1.onRequest)({
    region: REGION,
    cors: true,
    secrets: FUNCTION_SECRETS,
    memory: '1GiB',
    timeoutSeconds: 120
}, app);
