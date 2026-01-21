# FeedbackAgent

AI-driven formative feedback platform for teachers and students. Teachers build task-specific agents and rubrics; students submit drafts and get instant, structured feedback with a verification code.

## Key Features
- Teacher dashboard: create/edit agents, rubrics, stringency, and RAG reference material.
- Student view: distraction-free writing space, iterative feedback loop, verification code.
- RAG pipeline: Document AI + chunking + embeddings + Vector Search retrieval.
- Insights: aggregated classroom strengths, misconceptions, and suggested actions.
- LMS embed mode: student view can run cleanly inside an iframe.

## Tech Stack
- Frontend: Vite + React
- Auth: Firebase Auth (Google)
- Data: Firestore + Cloud Storage
- Backend: Firebase Functions (Node 20)
- AI: Gemini (feedback), Document AI (OCR), Vertex AI (embeddings + Vector Search)

## Local Development
**Prerequisites:** Node.js, Firebase CLI

1) Install dependencies:
```
npm install
```

2) Create `.env.local` (do not commit):
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_API_BASE_URL=/api
```

3) Install Functions dependencies:
```
npm install --prefix functions
```

4) Set Functions secrets (run per project):
```
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set DOC_AI_PROCESSOR_ID
firebase functions:secrets:set DOC_AI_LOCATION
firebase functions:secrets:set VERTEX_LOCATION
firebase functions:secrets:set VECTOR_INDEX_ID
firebase functions:secrets:set VECTOR_INDEX_ENDPOINT_ID
firebase functions:secrets:set VECTOR_DEPLOYED_INDEX_ID
firebase functions:secrets:set EMBEDDING_MODEL
firebase functions:secrets:set EMBEDDING_LOCATION
```

Recommended values:
- `DOC_AI_LOCATION=eu`
- `VERTEX_LOCATION=europe-west4`
- `EMBEDDING_LOCATION=europe-west4`
- `EMBEDDING_MODEL=text-embedding-004`

Optional (only if needed):
- `EMBEDDING_TASK_TYPE=RETRIEVAL_DOCUMENT`
- `EMBEDDING_OUTPUT_DIM=768`

5) Run the app:
```
npm run dev
```

## Deploy
```
npm run build
firebase deploy --only functions --project <project-id>
firebase deploy --only hosting --project <project-id>
firebase deploy --only firestore,storage --project <project-id>
```

## Embed Mode (Student View)
The student view hides top navigation when embedded:
```
https://<your-host>/ ?embed=1#/s/AGENT_ID
```

## RAG Pipeline Notes
- Max file size: 50 MB.
- Supported types: PDF, JPG/PNG/WEBP/HEIC, TXT/MD/CSV/HTML, DOCX/PPTX/XLSX, ODT/ODP/ODS, RTF.
- PDF + images use Document AI (imageless mode), fallback to Vision OCR for images.
- Office/OpenDocument types are parsed directly from zip/XML.
- Embedding batches are capped to stay under model token limits.

## Security Note
Verification codes are deterministic and not cryptographically secure in this version.
