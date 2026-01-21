<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/13Rn10tWI1kitJT-V8dBxf_xsCW2XBdWj

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Create `.env.local` with Firebase config:
   ```
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   VITE_API_BASE_URL=/api
   ```
   If you deploy, keep `.env.production` local-only (do not commit it).
3. Install Functions dependencies:
   `npm install --prefix functions`
4. Set the Gemini key for Functions:
   `firebase functions:secrets:set GEMINI_API_KEY`
5. Configure RAG services for Functions (env/secrets):
   ```
   firebase functions:secrets:set DOC_AI_PROCESSOR_ID
   firebase functions:secrets:set DOC_AI_LOCATION
   firebase functions:secrets:set VERTEX_LOCATION
   firebase functions:secrets:set VECTOR_INDEX_ID
   firebase functions:secrets:set VECTOR_INDEX_ENDPOINT_ID
   firebase functions:secrets:set VECTOR_DEPLOYED_INDEX_ID
   firebase functions:secrets:set EMBEDDING_MODEL
   ```
   Recommended values:
   - `DOC_AI_LOCATION=eu`
   - `VERTEX_LOCATION=europe-north1`
   - `EMBEDDING_MODEL=textembedding-gecko@latest`
6. Run the app:
   `npm run dev`

## RAG pipeline notes
- Max file size: 50 MB.
- Supported types: PDF, JPG/PNG/WEBP/HEIC, TXT/MD/CSV/HTML, DOCX/PPTX/XLSX, ODT/ODP/ODS, RTF.
- PDF + images use Document AI (fallback to Vision OCR for images).
- Office/OpenDocument types are parsed directly from the zip/XML contents.
