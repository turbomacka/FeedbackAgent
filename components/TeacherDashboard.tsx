
import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { collection, deleteDoc, doc, getDoc, getDocFromServer, getDocs, onSnapshot, setDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { deleteObject, ref, uploadBytesResumable } from 'firebase/storage';
import { Agent, ReferenceMaterial, Submission, StringencyLevel } from '../types';
import { auth, db, storage } from '../firebase';
import { improveCriterion } from '../services/geminiService';
import { createPromoCode, disablePromoCode, listPromoCodes, PromoCodeEntry } from '../services/teacherAuthService';
import { EduTooltip } from './EduTooltip';
import { generateVerificationPrefix, getVerificationMinimum, getVerificationMaximum } from '../utils/security';

interface TeacherDashboardProps {
  agents: Agent[];
  submissions: Submission[];
  currentUserEmail: string;
  currentUserUid: string;
  isAdmin: boolean;
  showAdminPanel: boolean;
  onLanguageChange: (language: 'sv' | 'en') => void;
  onCreateAgent: (agent: Agent) => Promise<void>;
  onUpdateAgent: (agent: Agent) => Promise<void>;
  language: 'sv' | 'en';
}

const parseMatrixData = (markdown: string) => {
  if (!markdown) return null;
  const lines = markdown.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 3) return null;
  const header = lines[0].split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1).map(c => c.replace(/<br\s*\/?>/gi, '\n'));
  const body = lines.slice(2).map(line => line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1).map(c => c.replace(/<br\s*\/?>/gi, '\n')));
  return { header, body };
};

const serializeMatrix = (header: string[], body: string[][]) => {
  const safeHeader = header.map(h => h.replace(/\n/g, '<br>'));
  const safeBody = body.map(row => row.map(cell => cell.replace(/\n/g, '<br>')));
  return `| ${safeHeader.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${safeBody.map(row => `| ${row.join(' | ')} |`).join('\n')}`;
};

const MatrixCell: React.FC<{ value: string; onChange: (v: string) => void; isHeader?: boolean; isCriterion?: boolean; placeholder?: string; }> = ({ value, onChange, isHeader, isCriterion, placeholder }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (textareaRef.current && !isHeader) { textareaRef.current.style.height = 'auto'; textareaRef.current.style.height = `${Math.max(100, textareaRef.current.scrollHeight)}px`; } }, [value, isHeader]);
  if (isHeader) return <input className="w-full bg-transparent font-bold text-[11px] uppercase tracking-[0.15em] outline-none text-center text-white placeholder:text-white/30 py-2 border-none focus:ring-0" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
  return (
    <div className="relative group/cell h-full w-full">
      <textarea ref={textareaRef} className={`w-full h-full p-6 text-[14px] leading-relaxed transition-all bg-transparent outline-none border-none focus:ring-0 resize-y overflow-hidden custom-scrollbar ${isCriterion ? 'font-bold text-slate-900 bg-slate-50/40' : 'text-slate-700 font-medium'} placeholder:text-slate-300`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <div className="absolute inset-0 border-2 border-transparent group-hover/cell:border-indigo-500/10 pointer-events-none rounded-lg" />
    </div>
  );
};

const EditableMatrix = ({ value, onChange }: { value: string, onChange: (val: string) => void, language: 'sv' | 'en' }) => {
  const data = useMemo(() => parseMatrixData(value), [value]);
  const updateValue = useCallback((rowIndex: number | null, colIndex: number, newValue: string) => {
    const currentData = parseMatrixData(value);
    if (!currentData) return;
    let newHeader = [...currentData.header];
    let newBody = [...currentData.body];
    if (rowIndex === null) newHeader[colIndex] = newValue; else newBody[rowIndex][colIndex] = newValue;
    onChange(serializeMatrix(newHeader, newBody));
  }, [value, onChange]);
  if (!data) return <div className="p-20 text-center text-slate-400 text-[10px] font-black uppercase tracking-widest">Matris saknas</div>;
  return (
    <div className="w-full bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
      <div className="grid grid-cols-4 bg-indigo-950">{data.header.map((h, i) => <div key={i} className="p-3 border-r border-white/5"><MatrixCell isHeader value={h} onChange={(val) => updateValue(null, i, val)} /></div>)}</div>
      <div className="divide-y divide-slate-100">{data.body.map((row, ri) => <div key={ri} className="grid grid-cols-4 hover:bg-slate-50/30 transition-colors">{row.map((cell, ci) => <div key={ci} className="flex border-r last:border-r-0 border-slate-100"><MatrixCell value={cell} isCriterion={ci === 0} onChange={(val) => updateValue(ri, ci, val)} /></div>)}</div>)}</div>
    </div>
  );
};

const InfoPopover = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [title, ...bodyParts] = text.split('\n\n');
  const body = bodyParts.join('\n\n');

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="w-6 h-6 rounded-full border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 bg-white flex items-center justify-center transition-colors"
        aria-label="Info"
        aria-expanded={open}
      >
        <i className="fas fa-info text-[10px]"></i>
      </button>
      {open && (
        <div className="absolute z-50 w-80 max-w-[85vw] p-4 text-[12px] leading-relaxed text-slate-700 bg-white/95 backdrop-blur border border-slate-200 rounded-2xl shadow-2xl whitespace-pre-line right-0 mt-2">
          <div className="text-[11px] font-black text-slate-900 uppercase tracking-widest mb-2">{title}</div>
          <div className="font-medium text-slate-700">{body || title}</div>
        </div>
      )}
    </div>
  );
};

export const TeacherDashboard: React.FC<TeacherDashboardProps> = ({ agents, submissions, currentUserEmail, currentUserUid, isAdmin, showAdminPanel, onLanguageChange, onCreateAgent, onUpdateAgent, language }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeInsightsId, setActiveInsightsId] = useState<string | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [isImproving, setIsImproving] = useState(false);
  const [editingCriterionIdx, setEditingCriterionIdx] = useState<number | null>(null);
  const [editingCriterionValue, setEditingCriterionValue] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [criteriaList, setCriteriaList] = useState<string[]>([]);
  const [currentCriterion, setCurrentCriterion] = useState('');
  const [referenceMaterials, setReferenceMaterials] = useState<ReferenceMaterial[]>([]);
  const [pendingUploads, setPendingUploads] = useState<{ id: string; name: string; progress: number }[]>([]);
  const [minWords, setMinWords] = useState(300);
  const [maxWords, setMaxWords] = useState(600);
  const [passThreshold, setPassThreshold] = useState(80000);
  const [verificationPrefix, setVerificationPrefix] = useState<number | null>(null);
  const [stringency, setStringency] = useState<StringencyLevel>('standard');
  const [accessCode, setAccessCode] = useState('');
  const [accessCodeError, setAccessCodeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [accessCodes, setAccessCodes] = useState<Record<string, string>>({});
  const [showSubmissionPrompt, setShowSubmissionPrompt] = useState(true);
  const [showVerificationCode, setShowVerificationCode] = useState(true);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copiedAccessId, setCopiedAccessId] = useState<string | null>(null);
  const [promoCodes, setPromoCodes] = useState<PromoCodeEntry[]>([]);
  const [promoCodeInput, setPromoCodeInput] = useState('');
  const [promoMaxUses, setPromoMaxUses] = useState('0');
  const [promoOrgId, setPromoOrgId] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoCopiedId, setPromoCopiedId] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [showLmsInstructions, setShowLmsInstructions] = useState(false);
  const [lmsLanguage, setLmsLanguage] = useState<'sv' | 'en'>('sv');
  const [lmsCopyStatus, setLmsCopyStatus] = useState(false);
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [draftCreatedId, setDraftCreatedId] = useState<string | null>(null);

  const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
  const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/rtf'
  ];

  const translations = {
    manageAgent: { sv: 'Mina Agenter', en: 'My Agents' },
    newAgent: { sv: 'Ny Agent', en: 'New Agent' },
    agentName: { sv: 'Agentens Namn', en: 'Agent Name' },
    agentNamePlaceholder: { sv: 'Skriv agentens namn...', en: 'Enter agent name...' },
    taskDesc: { sv: 'Uppgiftsbeskrivning', en: 'Task Description' },
    taskDescPlaceholder: { sv: 'Beskriv uppgiften och vad eleven ska göra...', en: 'Describe the task and what the student should do...' },
    accessCodeLabel: { sv: 'Accesskod', en: 'Access Code' },
    accessCodePlaceholder: { sv: 'Skriv accesskod...', en: 'Enter access code...' },
    accessCodeHelp: { sv: 'Krävs för att studenter ska låsa upp agenten.', en: 'Required for students to unlock the agent.' },
    accessCodeGenerate: { sv: 'Generera', en: 'Generate' },
    accessCodeRotate: { sv: 'Rulla kod', en: 'Rotate code' },
    accessCodeRequired: { sv: 'Accesskod krävs.', en: 'Access code is required.' },
    accessCodeCopied: { sv: 'Kod kopierad!', en: 'Code copied!' },
    accessCodeBadge: { sv: 'Accesskod', en: 'Access code' },
    promoAdminTitle: { sv: 'Admin: Promo-koder', en: 'Admin: Promo codes' },
    promoAdminSubtitle: { sv: 'Skapa och hantera åtkomstkoder för lärare.', en: 'Create and manage teacher access codes.' },
    promoAdminBadge: { sv: 'Admin', en: 'Admin' },
    promoCodeField: { sv: 'Promo-kod', en: 'Promo code' },
    promoCodeFieldPlaceholder: { sv: 'Låt systemet generera…', en: 'Let the system generate…' },
    promoMaxUsesLabel: { sv: 'Max användningar', en: 'Max uses' },
    promoMaxUsesHelp: { sv: '0 = obegränsat', en: '0 = unlimited' },
    promoOrgLabel: { sv: 'Org-ID (valfritt)', en: 'Org ID (optional)' },
    promoGenerate: { sv: 'Generera kod', en: 'Generate code' },
    promoCreate: { sv: 'Skapa kod', en: 'Create code' },
    promoDisable: { sv: 'Inaktivera', en: 'Disable' },
    promoActive: { sv: 'Aktiv', en: 'Active' },
    promoInactive: { sv: 'Inaktiv', en: 'Inactive' },
    promoUses: { sv: 'Användningar', en: 'Uses' },
    promoCopy: { sv: 'Kopiera', en: 'Copy' },
    promoCopied: { sv: 'Kopierad!', en: 'Copied!' },
    promoEmpty: { sv: 'Inga promo-koder ännu.', en: 'No promo codes yet.' },
    passHelp: {
      sv: 'Godkänd-gräns\n\nDetta är ingen procent eller betyg, utan en intern skala (0–100 000) som används för att räkna ut lägsta godkända värde i LMS.',
      en: 'Pass threshold\n\nThis is not a percentage or grade, but an internal 0–100,000 scale used to compute the minimum accepted value in your LMS.'
    },
    verificationPrefixLabel: { sv: 'Verifieringsprefix (auto)', en: 'Verification prefix (auto)' },
    verificationPrefixHelp: {
      sv: 'Prefixet anger lägsta tillåtna kod och är alltid ≥ 200.',
      en: 'The prefix sets the minimum accepted code and is always ≥ 200.'
    },
    lmsIntervalLabel: { sv: 'LMS-intervall', en: 'LMS interval' },
    lmsIntervalHelp: {
      sv: 'Ange “Från” som minsta värde. Godkända får ett prefix som är lika med eller högre än min‑prefixet; underkända får ett lägre prefix.',
      en: 'Use “From” as the minimum value. Passed work gets a prefix at or above the minimum prefix; failed work gets a lower prefix.'
    },
    lmsFrom: { sv: 'Från', en: 'From' },
    lmsTo: { sv: 'Till', en: 'To' },
    manualTooltip: { sv: 'Gör såhär', en: 'How to' },
    manualClose: { sv: 'Stäng', en: 'Close' },
    lmsButton: { sv: 'Instruktioner för LMS', en: 'LMS instructions' },
    lmsTitle: { sv: 'Instruktioner till studenter', en: 'Student instructions' },
    lmsCopy: { sv: 'Kopiera text', en: 'Copy text' },
    lmsCopied: { sv: 'Kopierad!', en: 'Copied!' },
    criteriaLabel: { sv: 'Bedömningsstöd & Matriser', en: 'Criteria & Matrices' },
    criteriaPlaceholder: { sv: 'Namnge kriterium...', en: 'Name a criterion...' },
    aiMatrix: { sv: 'AI-matris', en: 'AI matrix' },
    aiMatrixHelp: { sv: 'Låt AI skapa en professionell matris med nivåer.', en: 'Let the AI generate a professional matrix with levels.' },
    ragInfo: {
      sv: 'Referensmaterial & Kunskapsbas\n\nHär laddar du upp de dokument som ska utgöra din AI-agents hjärna. Med RAG (Retrieval-Augmented Generation) prioriterar agenten information från dessa filer när den ger feedback.\n\nViktiga instruktioner:\n- Upphovsrätt & ansvar: Du ansvarar för att materialet följer upphovsrätt och lokala licensavtal (t.ex. Bonus Copyright Access). Ladda bara upp material du har rätt att dela i undervisningssyfte.\n- Inga personuppgifter: Dokumenten får inte innehålla känsliga personuppgifter, sekretessbelagd information eller opublicerad forskning. All text bearbetas av externa AI-modeller.\n- Format & kvalitet: Bäst är textbaserade PDF:er eller textdokument (.txt, .docx). Undvik skannade bilder utan läsbar text.\n- Pedagogiskt tips: Dela stora böcker i mindre, relevanta kapitel eller artiklar.\n\nHur det fungerar:\nNär en student skriver letar systemet upp relevanta stycken i dina filer och skickar dem som facit till AI-mentorn, vilket minskar risken för gissningar.',
      en: 'Reference Material & Knowledge Base\n\nUpload the documents that should form your AI agent\'s knowledge base. With RAG (Retrieval-Augmented Generation), the agent prioritizes information from these files when giving feedback.\n\nImportant:\n- Copyright & responsibility: You are responsible for ensuring the material complies with copyright and local licenses. Upload only content you have the right to share for teaching.\n- No personal data: Documents must not contain sensitive personal data, confidential information, or unpublished research. Text is processed by external AI models.\n- Format & quality: Best results with text-based PDFs or text documents (.txt, .docx). Avoid scanned images without readable text.\n- Teaching tip: Split large books into smaller, relevant chapters or articles.\n\nHow it works:\nWhen a student writes, the system retrieves relevant passages and sends them as evidence to the AI mentor, reducing guesswork.'
    },
    stringencyLabel: { sv: 'Bedömningens Stringens', en: 'Assessment Stringency' },
    refLabel: { sv: 'Referensmaterial (RAG)', en: 'Reference Material' },
    minWords: { sv: 'Min antal ord', en: 'Min Words' },
    maxWords: { sv: 'Max antal ord', en: 'Max Words' },
    passLabel: { sv: 'Godkänd-gräns (0-100k)', en: 'Pass Threshold' },
    gen: { sv: 'Generös', en: 'Generous' },
    std: { sv: 'Standard', en: 'Standard' },
    str: { sv: 'Strikt', en: 'Strict' },
    save: { sv: 'Spara', en: 'Save' },
    publish: { sv: 'Publicera', en: 'Publish' },
    copied: { sv: 'Kopierad!', en: 'Copied!' },
    copyEmbed: { sv: 'Kopiera Iframe', en: 'Copy Iframe' },
    embedTitle: { sv: 'LMS-inbäddning', en: 'LMS Embed' },
    studentPreview: { sv: 'Förhandsvisa studentvy', en: 'Preview student view' },
    studentPreviewHelp: { sv: 'Öppnar studentvyn i en ny flik.', en: 'Opens the student view in a new tab.' },
    insights: { sv: 'Lärarinsikter', en: 'Teacher Insights' },
    noSubmissions: { sv: 'Inga inlämningar än', en: 'No submissions yet' },
    commonErrors: { sv: 'Vanliga missförstånd', en: 'Common Misunderstandings' },
    strengths: { sv: 'Styrkor i gruppen', en: 'Group Strengths' },
    actions: { sv: 'Pedagogiska åtgärder', en: 'Teaching Actions' },
    results: { sv: 'Resultat & Koder', en: 'Results & Codes' },
    logDownload: { sv: 'Ladda ned logg (anonym)', en: 'Download log (anonymous)' },
    logCsv: { sv: 'CSV', en: 'CSV' },
    logJson: { sv: 'JSON', en: 'JSON' },
    logTxt: { sv: 'TXT', en: 'TXT' },
    logError: { sv: 'Kunde inte ladda ned logg.', en: 'Failed to download log.' },
    clearHistory: { sv: 'Rensa studenthistorik', en: 'Clear student history' },
    clearHistoryHelp: {
      sv: 'Tar bort tidigare studentinteraktioner så agenten kan användas för en ny grupp.',
      en: 'Removes past student interactions so the agent can be used for a new group.'
    },
    clearHistoryConfirm: {
      sv: 'Detta rensar all studenthistorik för den här agenten. Det går inte att ångra.',
      en: 'This clears all student history for this agent. This cannot be undone.'
    },
    submissionsAnalyzed: { sv: 'Inlämningar analyserade', en: 'Submissions analyzed' },
    submissionsLabel: { sv: 'Inlämningar', en: 'Submissions' },
    stringencyLabel: { sv: 'Stringens', en: 'Stringency' },
    avgRevisions: { sv: 'Revideringar / session', en: 'Revisions per session' },
    avgRevisionTime: { sv: 'Tid mellan revideringar', en: 'Time between revisions' },
    revisionHistogram: { sv: 'Revideringstid (sekunder)', en: 'Revision timing (seconds)' },
    minutes: { sv: 'min', en: 'min' },
    uploadTooLarge: { sv: 'Filen är för stor (max 50 MB).', en: 'File is too large (max 50 MB).' },
    uploadUnsupported: { sv: 'Filtypen stöds inte.', en: 'File type is not supported.' },
    uploadTip: {
      sv: 'Tips: Mindre filer och ren text ger bättre träffsäkerhet. Skannade PDF:er och väldigt långa dokument kan ge sämre återkoppling.',
      en: 'Tip: Smaller files and clean text improve accuracy. Scanned PDFs and very long documents can reduce feedback quality.'
    },
    uploadProgress: { sv: 'Laddar upp', en: 'Uploading' },
    materialNeedsReviewTitle: {
      sv: 'Dokumentet är för långt',
      en: 'Document is too long'
    },
    materialNeedsReviewBody: {
      sv: 'Less is more: det blir bäst om du manuellt väljer ut den viktigaste delen.',
      en: 'Less is more: best results come from manually selecting the most important parts.'
    },
    materialContinue: { sv: 'AI dela upp automatiskt', en: 'Auto-split with AI' },
    materialAbort: { sv: 'Avbryt och välj delar manuellt', en: 'Cancel and trim manually' },
    materialTokenLine: { sv: 'Token‑mängd', en: 'Token count' },
    statusUploaded: { sv: 'Uppladdad', en: 'Uploaded' },
    statusProcessing: { sv: 'Bearbetar', en: 'Processing' },
    statusReady: { sv: 'Klar', en: 'Ready' },
    statusFailed: { sv: 'Misslyckades', en: 'Failed' },
    statusNeedsReview: { sv: 'Behöver åtgärd', en: 'Needs review' },
    processingHint: { sv: 'Bearbetar dokumentet…', en: 'Processing document…' },
    deleteConfirm: { sv: 'Radera agenten och allt referensmaterial?', en: 'Delete this agent and all reference material?' },
    studentOptions: { sv: 'Studentvy', en: 'Student View' },
    submissionPromptLabel: { sv: 'Visa inlämningsuppmaning', en: 'Show submission prompt' },
    submissionPromptHelp: { sv: 'Visas tillsammans med verifieringskoden.', en: 'Shown alongside the verification code.' },
    verificationCodeLabel: { sv: 'Visa verifieringskod', en: 'Show verification code' },
    verificationCodeHelp: { sv: 'Stäng av om du vill ha enbart formativ återkoppling.', en: 'Turn off for formative-only feedback.' },
    criteriaRequired: { sv: 'Lägg till minst ett kriterium för att kunna spara.', en: 'Add at least one criterion to save.' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];
  const lmsMinimum = verificationPrefix ? getVerificationMinimum(verificationPrefix, passThreshold) : null;
  const lmsMaximum = verificationPrefix ? getVerificationMaximum() : null;

  const manualContent = {
    title: {
      sv: 'Guide: Så skapar och förvaltar du din AI-agent',
      en: 'Guide: How to build and manage your AI agent'
    },
    intro: {
      sv: 'Denna guide hjälper dig att sätta upp en professionell lärprocess i fem enkla steg – från första instruktion till pedagogisk uppföljning.',
      en: 'This guide helps you set up a professional learning flow in five clear steps — from first instructions to pedagogical follow-up.'
    },
    sections: [
      {
        title: language === 'sv' ? '1. Skapa din AI-agent 🏗️' : '1. Create your AI agent 🏗️',
        body: language === 'sv' ? [
          'Börja med att ge din agent ett namn och en tydlig uppgiftsbeskrivning.',
          'Instruktioner: Beskriv uppgiften så att studenten förstår målet med reflektionen.',
          'Kriterier: Definiera vad AI:n ska fokusera på i sin feedback. Vi rekommenderar att du använder AI-matrisen för att generera kvalitativa nivåer. Det säkerställer att återkopplingen blir nyanserad och direkt kopplad till kursens mål.'
        ] : [
          'Start by naming your agent and writing a clear task description.',
          'Instructions: Explain the assignment so students understand the goal of the reflection.',
          'Criteria: Define what the AI should focus on. We recommend using the AI matrix to generate qualitative levels so feedback is nuanced and aligned with course goals.'
        ]
      },
      {
        title: language === 'sv' ? '2. Addera referensmaterial (RAG) 📚' : '2. Add reference material (RAG) 📚',
        body: language === 'sv' ? [
          'Ladda upp det källmaterial som ska styra AI-agentens kunskap (Retrieval-Augmented Generation).',
          'Träffsäkerhet: Relevant material gör feedbacken mer exakt och kursnära.',
          'Kvalitet före kvantitet: Ladda endast upp material som är direkt nödvändigt för den specifika uppgiften. För mycket information kan göra AI:n mindre fokuserad och sänka relevansen i svaren.'
        ] : [
          'Upload the source material that should guide the agent’s knowledge (Retrieval-Augmented Generation).',
          'Accuracy: Relevant material makes feedback more precise and course-aligned.',
          'Quality over quantity: Upload only what is necessary for the specific task. Too much content can reduce focus and relevance.'
        ]
      },
      {
        title: language === 'sv' ? '3. Ställ in ramar och valideringslogik ⚙️' : '3. Set boundaries and validation logic ⚙️',
        body: language === 'sv' ? [
          'Här definierar du AI-agentens stringens och hur resultatet ska kommunicera med din lärplattform (t.ex. Canvas).',
          'Stringens: Välj hur strikt AI:n ska vara i sin bedömning. En hög stringens är nödvändig för att motverka att AI:n blir för generös i sin feedback.',
          'Valideringskod för LMS: Systemet genererar en unik kod till studenten efter avslutat arbete.',
          'Prefix: Systemet skapar ett automatiskt minimiprefix (≥ 200) som ligger till grund för lägsta godkända värde.',
          'LMS‑minvärde: Sätt “Från” till värdet som visas i panelen. Om LMS kräver intervall, använd “Till” = 999999999.',
          'I Canvas: Skapa ett “test” som använder minvärdet för automatisk översikt.',
          'Inlämning: Bocka för Inlämningsuppmaning om du vill att studentens slutgiltiga text ska bifogas tillsammans med valideringskoden.'
        ] : [
          'Define the agent’s strictness and how results should connect to your LMS (e.g., Canvas).',
          'Strictness: Choose how strict the AI should be. Higher strictness helps avoid overly generous feedback.',
          'LMS validation code: The system generates a unique code for the student after completion.',
          'Prefix: The system creates an automatic minimum prefix (≥ 200) that sets the lowest accepted value.',
          'LMS minimum: Set “From” to the value shown in the panel. If your LMS requires a range, use “To” = 999999999.',
          'In Canvas: Create a “quiz” that uses the minimum value for an automatic overview.',
          'Submission: Enable submission prompt if you want the student’s final text attached with the validation code.'
        ]
      },
      {
        title: language === 'sv' ? '4. Dela och publicera till studenter 🔗' : '4. Share and publish to students 🔗',
        body: language === 'sv' ? [
          'När du är nöjd med inställningarna är det dags att göra agenten tillgänglig.',
          'Inbäddning (i-frame): Varje agent har en unik inbäddningskod. Kopiera denna och klistra in den direkt på en sida i din kursmodul i Canvas eller annat LMS. Detta gör att studenterna kan arbeta i en bekant miljö utan externa hopp.',
          'Säkerhet med Accesskod: För att förhindra obehörig åtkomst och skydda din data krävs en accesskod för att starta chatten. Utan denna kod riskerar dina pedagogiska insikter att kontamineras av utomstående.',
          'Distribution av kod: Ett effektivt sätt är att skriva ut accesskoden i klartext i Canvas, precis ovanför den inbäddade agenten.',
          'Exempel: "Använd koden [DIN-KOD] för att låsa upp din AI-tutor nedan."'
        ] : [
          'When you are happy with the settings, it’s time to make the agent available.',
          'Embedding (i-frame): Each agent has a unique embed code. Paste it directly into a Canvas page or any LMS so students can work in a familiar environment.',
          'Access code security: An access code is required to start the chat. Without it, your insights can be contaminated by outsiders.',
          'Code distribution: A simple method is to display the access code in Canvas just above the embedded agent.',
          'Example: “Use the code [YOUR-CODE] to unlock the AI tutor below.”'
        ]
      },
      {
        title: language === 'sv' ? '5. Följ upp med pedagogiska insikter 📊' : '5. Follow up with pedagogical insights 📊',
        body: language === 'sv' ? [
          'Använd den insamlade datan för att utveckla undervisningen och identifiera behov i studentgruppen.',
          'Lärarpanelen: På agentens kort hittar du aggregerade insikter som sammanfattar klassens styrkor, vanliga missförstånd och förslag på nästa steg.',
          'Planering: Använd dessa insikter som underlag för att anpassa din nästa föreläsning eller lektion efter var studenterna faktiskt befinner sig i sin lärprocess.'
        ] : [
          'Use the collected data to improve teaching and identify student needs.',
          'Teacher panel: Each agent card shows aggregated insights on strengths, common misconceptions, and suggested next steps.',
          'Planning: Use these insights to adapt your next lecture or lesson to where students actually are in their learning process.'
        ]
      }
    ]
  };

  const buildLmsInstructions = (lang: 'sv' | 'en') => {
    const accessCode = lang === 'sv' ? '[KLISTRA IN DIN ACCESSKOD HÄR]' : '[PASTE YOUR ACCESS CODE HERE]';
    if (lang === 'sv') {
      return [
        'Syfte och funktion',
        'Syftet med verktyget är att erbjuda omedelbar formativ feedback. AI-tutorn utgår strikt från uppgiftens instruktioner, formaliakrav och de specifika bedömningskriterier som läraren har definierat. Genom att analysera ditt arbete utifrån dessa parametrar utmanar systemet dina slutsatser och föreslår områden för fördjupning. Målet är att stödja din kritiska reflektion och säkerställa att ditt arbete lever upp till de ställda kraven.',
        '',
        'Instruktioner för genomförande',
        `Åtkomst: Ange accesskoden ${accessCode} för att aktivera verktyget nedan.`,
        'Dialog och feedback: Presentera ditt utkast eller dina resonemang för tutorn. Systemet är programmerat att ge vägledande frågor och observationer baserat på lärarens kriterier snarare än att ge färdiga svar.',
        'Revidering: Använd den återkoppling du får för att bearbeta och förfina din text direkt i verktyget.',
        'Generering av valideringskod: När du har genomfört en tillräcklig bearbetning och systemet bedömer att arbetet möter uppgiftens krav, genereras en unik valideringskod.',
        'Inlämning: Kopiera koden och lämna in den i den angivna uppgiften i lärplattformen. Koden fungerar som bekräftelse på att du har genomgått den obligatoriska reflektionsprocessen.',
        '',
        'Integritet och datasäkerhet',
        'Anonymitet: Systemet hanterar dina uppgifter anonymt. Som lärare har jag endast tillgång till chattloggar och statistik på aggregerad nivå för att kunna identifiera generella behov i studentgruppen. Din identitet kopplas till din process först när du lämnar in din valideringskod i lärplattformen.',
        'Personuppgifter: Ange aldrig personuppgifter såsom namn, personnummer eller adress i chatten, då texterna bearbetas av en extern AI-tjänst.',
        'Kritiskt förhållningssätt: AI-tutorn är ett pedagogiskt hjälpmedel, inte ett facit. Det är din uppgift att kritiskt värdera den feedback du får och säkerställa att det slutgiltiga arbetet följer alla givna instruktioner och representerar din egen kunskap.'
      ].join('\n');
    }

    return [
      'Purpose and function',
      'The purpose of the tool is to provide immediate formative feedback. The AI tutor strictly follows the assignment instructions, formal requirements, and the specific assessment criteria defined by the teacher. By analysing your work against these parameters, the system challenges your conclusions and suggests areas for deeper reflection. The goal is to support your critical thinking and ensure your work meets the stated requirements.',
      '',
      'Instructions for completion',
      `Access: Enter the access code ${accessCode} to activate the tool below.`,
      'Dialogue and feedback: Present your draft or your reasoning to the tutor. The system is programmed to provide guiding questions and observations based on the teacher’s criteria rather than giving ready-made answers.',
      'Revision: Use the feedback you receive to revise and refine your text directly in the tool.',
      'Validation code generation: When you have completed sufficient revisions and the system assesses that your work meets the requirements, a unique validation code is generated.',
      'Submission: Copy the code and submit it in the specified assignment in the LMS. The code confirms that you have completed the required reflection process.',
      '',
      'Integrity and data security',
      'Anonymity: The system handles your work anonymously. As a teacher, I only have access to chat logs and aggregated statistics to identify general needs in the student group. Your identity is linked only when you submit your validation code in the LMS.',
      'Personal data: Never enter personal data such as name, social security number, or address in the chat, since the text is processed by an external AI service.',
      'Critical stance: The AI tutor is a pedagogical aid, not an answer key. It is your responsibility to critically evaluate the feedback and ensure the final work follows all instructions and represents your own knowledge.'
    ].join('\n');
  };

  const normalizeAccessCode = (value: string) =>
    value.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

  const resolveVerificationPrefix = (agentId: string, current?: number | null) => {
    if (typeof current === 'number' && current >= 200 && current <= 998) {
      return current;
    }
    return generateVerificationPrefix(agentId);
  };

  const generateAccessCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const length = 8;
    let result = '';
    for (let i = 0; i < length; i += 1) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  };

  const generatePromoCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 8; i += 1) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  };

  const refreshPromoCodes = useCallback(async () => {
    if (!isAdmin) return;
    setPromoError(null);
    setPromoBusy(true);
    try {
      const codes = await listPromoCodes();
      setPromoCodes(codes);
    } catch (err: any) {
      setPromoError(err?.message || (language === 'sv' ? 'Kunde inte hämta koder.' : 'Failed to load codes.'));
    } finally {
      setPromoBusy(false);
    }
  }, [isAdmin, language]);

  useEffect(() => {
    if (isAdmin) {
      void refreshPromoCodes();
    }
  }, [isAdmin, refreshPromoCodes]);

  const handleCreatePromoCode = async () => {
    setPromoError(null);
    setPromoBusy(true);
    try {
      const normalized = promoCodeInput.trim() ? normalizeAccessCode(promoCodeInput) : undefined;
      const maxUsesValue = Number(promoMaxUses);
      const payload: { code?: string; maxUses?: number; orgId?: string | null } = {};
      if (normalized) payload.code = normalized;
      if (Number.isFinite(maxUsesValue)) payload.maxUses = maxUsesValue;
      if (promoOrgId.trim()) payload.orgId = promoOrgId.trim();
      await createPromoCode(payload);
      setPromoCodeInput('');
      setPromoOrgId('');
      setPromoMaxUses('0');
      await refreshPromoCodes();
    } catch (err: any) {
      setPromoError(err?.message || (language === 'sv' ? 'Kunde inte skapa kod.' : 'Failed to create code.'));
    } finally {
      setPromoBusy(false);
    }
  };

  const handleDisablePromoCode = async (code: string) => {
    setPromoError(null);
    setPromoBusy(true);
    try {
      await disablePromoCode(code);
      await refreshPromoCodes();
    } catch (err: any) {
      setPromoError(err?.message || (language === 'sv' ? 'Kunde inte inaktivera.' : 'Failed to disable.'));
    } finally {
      setPromoBusy(false);
    }
  };

  const handleCopyPromoCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setPromoCopiedId(code);
    setTimeout(() => setPromoCopiedId(null), 1500);
  };

  const upsertAccessCode = async (agentId: string, code: string) => {
    const normalized = normalizeAccessCode(code);
    if (!normalized) return;
    await setDoc(
      doc(db, 'agentAccess', agentId),
      {
        code: normalized,
        ownerUid: currentUserUid,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      },
      { merge: true }
    );
    setAccessCodes(prev => ({ ...prev, [agentId]: normalized }));
  };

  const resetDraftForm = () => {
    setEditingAgentId(null);
    setDraftCreatedId(null);
    setNewName('');
    setNewDesc('');
    setCriteriaList([]);
    setCurrentCriterion('');
    setMinWords(300);
    setMaxWords(600);
    setPassThreshold(80000);
    setVerificationPrefix(null);
    setStringency('standard');
    setAccessCode('');
    setAccessCodeError(null);
    setFormError(null);
    setShowSubmissionPrompt(true);
    setShowVerificationCode(true);
    setEditingCriterionIdx(null);
    setEditingCriterionValue('');
    setUploadError(null);
  };

  const ensureDraftAgent = async () => {
    if (editingAgentId) return editingAgentId;
    const draftRef = doc(collection(db, 'agents'));
    const prefix = resolveVerificationPrefix(draftRef.id, verificationPrefix);
    const draft: Agent = {
      id: draftRef.id,
      name: newName.trim() || (language === 'sv' ? 'Namnlös agent' : 'Untitled agent'),
      description: newDesc.trim() || '',
      criteria: criteriaList,
      wordCountLimit: { min: minWords, max: maxWords },
      passThreshold,
      verificationPrefix: prefix,
      stringency,
      showSubmissionPrompt,
      showVerificationCode,
      ownerEmail: currentUserEmail,
      ownerUid: currentUserUid,
      sharedWithEmails: [],
      sharedWithUids: [],
      visibleTo: [currentUserUid],
      isPublic: true,
      isDraft: true
    };
    await setDoc(draftRef, {
      ...draft,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    try {
      await getDocFromServer(draftRef);
    } catch {
      // Ignore; Firestore may still propagate the write.
    }
    setEditingAgentId(draftRef.id);
    setDraftCreatedId(draftRef.id);
    setVerificationPrefix(prefix);
    return draftRef.id;
  };

  const persistCriteria = async (updatedCriteria: string[]) => {
    const agentId = await ensureDraftAgent();
    if (!agentId) return;
    await updateDoc(doc(db, 'agents', agentId), {
      criteria: updatedCriteria,
      updatedAt: serverTimestamp()
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const agentId = await ensureDraftAgent();
    if (!agentId) return;
    setUploadError(null);

    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setUploadError(t('uploadTooLarge'));
        continue;
      }
      if (file.type && !ALLOWED_MIME_TYPES.includes(file.type)) {
        setUploadError(t('uploadUnsupported'));
        continue;
      }

      const materialRef = doc(collection(db, 'agents', agentId, 'materials'));
      const storagePath = `agents/${agentId}/materials/${materialRef.id}/${file.name}`;
      const storageRef = ref(storage, storagePath);

      setPendingUploads(prev => [...prev, { id: materialRef.id, name: file.name, progress: 0 }]);
      try {
        await new Promise<void>((resolve, reject) => {
          const task = uploadBytesResumable(storageRef, file, { contentType: file.type || 'application/octet-stream' });
          task.on(
            'state_changed',
            (snapshot) => {
              const progress = snapshot.totalBytes
                ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
                : 0;
              setPendingUploads(prev =>
                prev.map(item => item.id === materialRef.id ? { ...item, progress } : item)
              );
            },
            (error) => reject(error),
            () => resolve()
          );
        });

        setPendingUploads(prev => prev.filter(item => item.id !== materialRef.id));
        await setDoc(materialRef, {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          status: 'uploaded',
          gcsPath: storagePath,
          createdAt: serverTimestamp()
        });
      } catch (error: any) {
        setPendingUploads(prev => prev.filter(item => item.id !== materialRef.id));
        setUploadError(error?.message || 'Upload failed. Try again.');
      }
    }
  };

  const handleRemoveMaterial = async (material: ReferenceMaterial) => {
    if (!editingAgentId) return;
    await deleteDoc(doc(db, 'agents', editingAgentId, 'materials', material.id));
    if (material.gcsPath) {
      await deleteObject(ref(storage, material.gcsPath));
    }
  };

  const handleContinueMaterial = async (material: ReferenceMaterial) => {
    if (!editingAgentId) return;
    await updateDoc(doc(db, 'agents', editingAgentId, 'materials', material.id), {
      status: 'uploaded',
      forceTrim: true,
      reprocessRequested: true,
      error: '',
      errorCode: '',
      updatedAt: serverTimestamp()
    });
  };

  const handleAbortMaterial = async (material: ReferenceMaterial) => {
    if (!editingAgentId) return;
    await updateDoc(doc(db, 'agents', editingAgentId, 'materials', material.id), {
      status: 'failed',
      error: language === 'sv' ? 'Avbrutet av lärare.' : 'Cancelled by teacher.',
      updatedAt: serverTimestamp()
    });
  };

  const handleImproveRequest = async (idx: number) => {
    const criterion = criteriaList[idx];
    if (!criterion || isImproving) return;
    setIsImproving(true);
    try {
      const agentId = await ensureDraftAgent();
      if (!agentId) return;
      const res = await improveCriterion(criterion, newDesc, agentId);
      const upd = [...criteriaList];
      upd[idx] = res;
      setCriteriaList(upd);
      await persistCriteria(upd);
    } catch(e: any) {
      alert(e.message || "Kunde inte förbättra kriteriet.");
    } finally {
      setIsImproving(false);
    }
  };

  const handleAddCriterion = async () => {
    if (currentCriterion.trim()) {
      const updated = [...criteriaList, currentCriterion.trim()];
      setCriteriaList(updated);
      setCurrentCriterion('');
      setFormError(null);
      await persistCriteria(updated);
    }
  };

  const openEditModal = (agent: Agent) => {
    setEditingAgentId(agent.id);
    setDraftCreatedId(null);
    setNewName(agent.name);
    setNewDesc(agent.description);
    setCriteriaList(agent.criteria);
    setCurrentCriterion('');
    setMinWords(agent.wordCountLimit.min);
    setMaxWords(agent.wordCountLimit.max);
    setPassThreshold(agent.passThreshold || 80000);
    setVerificationPrefix(resolveVerificationPrefix(agent.id, agent.verificationPrefix));
    setStringency(agent.stringency || 'standard');
    setShowSubmissionPrompt(agent.showSubmissionPrompt ?? true);
    setShowVerificationCode(agent.showVerificationCode ?? true);
    setEditingCriterionIdx(null);
    setEditingCriterionValue('');
    setUploadError(null);
    setFormError(null);
    setAccessCode(accessCodes[agent.id] || '');
    setAccessCodeError(null);
    setIsModalOpen(true);
    void (async () => {
      try {
        const accessSnap = await getDoc(doc(db, 'agentAccess', agent.id));
        if (accessSnap.exists()) {
          const code = accessSnap.data()?.code;
          if (typeof code === 'string') {
            setAccessCode(code);
            setAccessCodes(prev => ({ ...prev, [agent.id]: code }));
          }
        }
      } catch {
        // Ignore access code fetch failures; teacher can re-save.
      }
    })();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!newName || !newDesc || criteriaList.length === 0) {
      if (criteriaList.length === 0) {
        setFormError(t('criteriaRequired'));
      }
      return;
    }
    const normalizedCode = normalizeAccessCode(accessCode);
    if (!normalizedCode) {
      setAccessCodeError(t('accessCodeRequired'));
      return;
    }
    const agentId = editingAgentId || `agent-${Date.now()}`;
    const resolvedPrefix = resolveVerificationPrefix(agentId, verificationPrefix);
    const agentData: Agent = {
      id: agentId,
      name: newName, description: newDesc, criteria: criteriaList,
      wordCountLimit: { min: minWords, max: maxWords }, passThreshold, verificationPrefix: resolvedPrefix, stringency,
      showSubmissionPrompt,
      showVerificationCode,
      ownerEmail: currentUserEmail, ownerUid: currentUserUid, sharedWithEmails: [], sharedWithUids: [], visibleTo: [currentUserUid], isPublic: true, isDraft: false
    };
    if (editingAgentId) {
      await onUpdateAgent(agentData);
    } else {
      await onCreateAgent(agentData);
    }
    await upsertAccessCode(agentData.id, normalizedCode);
    setDraftCreatedId(null);
    setIsModalOpen(false);
  };

  const cleanupAgent = async (agentId: string) => {
    const materialsSnap = await getDocs(collection(db, 'agents', agentId, 'materials'));
    for (const docSnap of materialsSnap.docs) {
      const material = docSnap.data() as ReferenceMaterial;
      if (material.gcsPath) {
        await deleteObject(ref(storage, material.gcsPath));
      }
      await deleteDoc(docSnap.ref);
    }
    await deleteDoc(doc(db, 'agentAccess', agentId));
    await deleteDoc(doc(db, 'agents', agentId));
  };

  const handleCloseModal = async () => {
    if (draftCreatedId && editingAgentId === draftCreatedId) {
      await cleanupAgent(draftCreatedId);
      setDraftCreatedId(null);
      setEditingAgentId(null);
      setReferenceMaterials([]);
    }
    setIsModalOpen(false);
  };

  const handleDeleteAgent = async (agent: Agent, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!window.confirm(t('deleteConfirm'))) return;
    if (activeInsightsId === agent.id) {
      setActiveInsightsId(null);
    }
    if (editingAgentId === agent.id) {
      setIsModalOpen(false);
      setEditingAgentId(null);
      setDraftCreatedId(null);
      setReferenceMaterials([]);
    }
    await cleanupAgent(agent.id);
  };

  useEffect(() => {
    if (!editingAgentId) {
      setReferenceMaterials([]);
      setPendingUploads([]);
      setUploadError(null);
      return;
    }
    setPendingUploads([]);
    const materialsRef = collection(db, 'agents', editingAgentId, 'materials');
    const unsubscribe = onSnapshot(materialsRef, (snapshot) => {
      const materials = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<ReferenceMaterial, 'id'>)
      }));
      setReferenceMaterials(materials);
    });
    return () => unsubscribe();
  }, [editingAgentId]);

  useEffect(() => {
    if (agents.length === 0) {
      setAccessCodes({});
      return;
    }
    const unsubscribers = agents.map(agent =>
      onSnapshot(doc(db, 'agentAccess', agent.id), (snap) => {
        const code = snap.exists() ? snap.data()?.code : '';
        setAccessCodes(prev => ({ ...prev, [agent.id]: typeof code === 'string' ? code : '' }));
      })
    );
    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [agents]);

  const generateStudentUrl = (id: string) => `${window.location.origin}${window.location.pathname}?embed=1#/s/${id}`;
  const generateIframeCode = (id: string) => `<iframe src="${generateStudentUrl(id)}" width="100%" height="800px" style="border:none; border-radius:12px;"></iframe>`;
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
  const statusLabel = (status: ReferenceMaterial['status']) => {
    switch (status) {
      case 'uploaded':
        return t('statusUploaded');
      case 'processing':
        return t('statusProcessing');
      case 'ready':
        return t('statusReady');
      case 'failed':
        return t('statusFailed');
      case 'needs_review':
        return t('statusNeedsReview');
      default:
        return status;
    }
  };

  // Filter and aggregate insights for the active agent
  const agentSubmissions = useMemo(() => 
    submissions.filter(s => s.agentId === activeInsightsId), 
    [submissions, activeInsightsId]
  );

  const aggregatedInsights = useMemo(() => {
    if (agentSubmissions.length === 0) return null;
    const errors = new Set<string>();
    const strengths = new Set<string>();
    const actions = new Set<string>();

    agentSubmissions.forEach(s => {
      s.insights.common_errors.forEach(e => errors.add(e));
      s.insights.strengths.forEach(st => strengths.add(st));
      s.insights.teaching_actions.forEach(a => actions.add(a));
    });

    return {
      errors: Array.from(errors).slice(0, 5),
      strengths: Array.from(strengths).slice(0, 5),
      actions: Array.from(actions).slice(0, 5),
      count: agentSubmissions.length
    };
  }, [agentSubmissions]);

  const revisionStats = useMemo(() => {
    const sessions = new Map<string, Submission[]>();
    for (const submission of agentSubmissions) {
      if (!submission.sessionId) continue;
      const list = sessions.get(submission.sessionId) || [];
      list.push(submission);
      sessions.set(submission.sessionId, list);
    }

    const buckets = [
      { label: '0–20', min: 0, max: 20, count: 0 },
      { label: '21–60', min: 20, max: 60, count: 0 },
      { label: '61–120', min: 60, max: 120, count: 0 },
      { label: '120–240', min: 120, max: 240, count: 0 },
      { label: '240+', min: 240, max: Infinity, count: 0 }
    ];

    let totalRevisions = 0;
    let totalDelta = 0;
    let deltaCount = 0;

    for (const list of sessions.values()) {
      if (list.length === 0) continue;
      const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
      if (sorted.length > 1) {
        totalRevisions += sorted.length - 1;
      }
      for (let i = 1; i < sorted.length; i += 1) {
        const deltaSeconds = Math.max(0, (sorted[i].timestamp - sorted[i - 1].timestamp) / 1000);
        const deltaMinutes = deltaSeconds / 60;
        totalDelta += deltaMinutes;
        deltaCount += 1;
        const bucket = buckets.find(b => deltaSeconds >= b.min && deltaSeconds < b.max);
        if (bucket) bucket.count += 1;
      }
    }

    return {
      sessionCount: sessions.size,
      avgRevisionsPerSession: sessions.size ? totalRevisions / sessions.size : 0,
      avgMinutesBetween: deltaCount ? totalDelta / deltaCount : 0,
      buckets
    };
  }, [agentSubmissions]);

  const activeAgent = agents.find(a => a.id === activeInsightsId);

  const handleDownloadLog = async (format: 'csv' | 'json' | 'txt') => {
    if (!activeInsightsId) return;
    setLogError(null);
    setLogBusy(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated.');
      const params = new URLSearchParams({ agentId: activeInsightsId, format });
      const response = await fetch(`${API_BASE}/teacher/logs/export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `feedback-log-${activeInsightsId}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setLogError(err?.message || t('logError'));
    } finally {
      setLogBusy(false);
    }
  };

  const handleClearHistory = async () => {
    if (!activeInsightsId) return;
    const confirmed = window.confirm(t('clearHistoryConfirm'));
    if (!confirmed) return;
    setLogError(null);
    setLogBusy(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated.');
      const params = new URLSearchParams({ agentId: activeInsightsId });
      const response = await fetch(`${API_BASE}/teacher/logs/clear?${params.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
    } catch (err: any) {
      setLogError(err?.message || t('logError'));
    } finally {
      setLogBusy(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-12">
      <header className="flex flex-wrap justify-between items-center gap-6 bg-white p-10 rounded-[2.5rem] border border-slate-100 shadow-sm">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">{t('manageAgent')}</h1>
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">Skapa och redigera dina feedback-assistenter</p>
        </div>
        <div className="flex items-center gap-3">
          <EduTooltip text={t('manualTooltip')}>
            <button
              type="button"
              onClick={() => setShowManual(true)}
              className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center"
              aria-label={t('manualTooltip')}
            >
              <i className="fas fa-book-open text-lg"></i>
            </button>
          </EduTooltip>
          <EduTooltip text={t('lmsButton')}>
            <button
              type="button"
              onClick={() => {
                setLmsLanguage(language);
                setShowLmsInstructions(true);
                setLmsCopyStatus(false);
              }}
              className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center"
              aria-label={t('lmsButton')}
            >
              <i className="fas fa-file-alt text-lg"></i>
            </button>
          </EduTooltip>
          <button
            onClick={() => {
              resetDraftForm();
              setIsModalOpen(true);
            }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-10 py-4 rounded-2xl font-black text-[11px] uppercase tracking-widest shadow-xl"
          >
            Ny Agent
          </button>
        </div>
      </header>

      {isAdmin && showAdminPanel && (
        <section className="bg-white rounded-[2.5rem] p-10 border border-slate-100 shadow-sm space-y-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-black text-slate-900 tracking-tight">{t('promoAdminTitle')}</h2>
              <p className="text-slate-500 text-sm font-medium">{t('promoAdminSubtitle')}</p>
            </div>
            <span className="text-[9px] font-black uppercase tracking-widest text-indigo-600 bg-indigo-50 border border-indigo-100 px-3 py-1 rounded-full">
              {t('promoAdminBadge')}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">{t('promoCodeField')}</label>
              <input
                type="text"
                value={promoCodeInput}
                onChange={(e) => setPromoCodeInput(e.target.value)}
                placeholder={t('promoCodeFieldPlaceholder')}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 font-black uppercase tracking-widest text-sm placeholder:text-slate-300"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">{t('promoMaxUsesLabel')}</label>
              <input
                type="number"
                min={0}
                value={promoMaxUses}
                onChange={(e) => setPromoMaxUses(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 font-black text-sm"
              />
              <p className="text-[9px] text-slate-400 font-semibold uppercase tracking-widest">{t('promoMaxUsesHelp')}</p>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">{t('promoOrgLabel')}</label>
              <input
                type="text"
                value={promoOrgId}
                onChange={(e) => setPromoOrgId(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 font-black text-sm"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setPromoCodeInput(generatePromoCode())}
              className="px-5 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              {t('promoGenerate')}
            </button>
            <button
              type="button"
              onClick={handleCreatePromoCode}
              disabled={promoBusy}
              className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-white ${
                promoBusy ? 'bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              {t('promoCreate')}
            </button>
          </div>

          {promoError && (
            <p className="text-[10px] font-black uppercase tracking-widest text-red-500">{promoError}</p>
          )}

          <div className="space-y-3">
            {promoCodes.length === 0 ? (
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">{t('promoEmpty')}</div>
            ) : (
              promoCodes.map(code => (
                <div key={code.id} className="flex flex-wrap items-center justify-between gap-4 bg-slate-50/70 border border-slate-100 rounded-2xl px-5 py-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <code className="bg-white px-3 py-1 rounded-lg text-sm font-black tracking-widest">{code.code}</code>
                      <span className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-0.5 rounded-full border ${
                        code.active ? 'border-emerald-200 text-emerald-700 bg-emerald-50' : 'border-slate-200 text-slate-500 bg-slate-100'
                      }`}>
                        {code.active ? t('promoActive') : t('promoInactive')}
                      </span>
                    </div>
                    <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                      {t('promoUses')}: {code.currentUses}/{code.maxUses > 0 ? code.maxUses : '∞'}
                      {code.orgId ? ` • ${code.orgId}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => handleCopyPromoCode(code.code)}
                      className="text-[9px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800"
                    >
                      {promoCopiedId === code.code ? t('promoCopied') : t('promoCopy')}
                    </button>
                    <button
                      type="button"
                      disabled={!code.active || promoBusy}
                      onClick={() => handleDisablePromoCode(code.code)}
                      className={`text-[9px] font-black uppercase tracking-widest ${
                        !code.active || promoBusy ? 'text-slate-300' : 'text-red-500 hover:text-red-700'
                      }`}
                    >
                      {t('promoDisable')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
        {agents.map(agent => (
          <div key={agent.id} className="bg-white rounded-[3rem] border border-slate-100 shadow-sm hover:shadow-2xl transition-all flex flex-col group overflow-hidden">
            <div className="p-10 flex-1 space-y-4 cursor-pointer" onClick={() => openEditModal(agent)}>
              <div className="flex justify-between items-start">
                <h3 className="text-xl font-black text-slate-900 group-hover:text-indigo-600 truncate uppercase tracking-tight w-2/3">{agent.name}</h3>
                <span className={`text-[8px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${agent.stringency === 'strict' ? 'bg-red-50 text-red-600 border-red-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>{agent.stringency}</span>
              </div>
              <p className="text-[13px] text-slate-500 line-clamp-2 leading-relaxed">{agent.description}</p>
              <div className="flex gap-2">
                <span className="text-[8px] font-black uppercase tracking-widest px-3 py-1 bg-slate-50 border border-slate-100 rounded-full text-slate-400">{agent.criteria.length} Kriterier</span>
                {accessCodes[agent.id] ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(accessCodes[agent.id]);
                      setCopiedAccessId(agent.id);
                      setTimeout(() => setCopiedAccessId(null), 1500);
                    }}
                    className="text-[8px] font-black uppercase tracking-widest px-3 py-1 bg-white border border-slate-100 rounded-full text-slate-700 hover:text-indigo-600"
                  >
                    {copiedAccessId === agent.id ? t('accessCodeCopied') : `${t('accessCodeBadge')}: ${accessCodes[agent.id]}`}
                  </button>
                ) : (
                  <span className="text-[8px] font-black uppercase tracking-widest px-3 py-1 bg-slate-50 border border-slate-100 rounded-full text-slate-300">
                    {t('accessCodeBadge')}: —
                  </span>
                )}
              </div>
            </div>
            <div className="px-8 py-5 bg-slate-50/50 border-t border-slate-100 flex items-center justify-between">
              <button onClick={() => setActiveInsightsId(agent.id)} className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:text-indigo-800 transition-colors flex items-center gap-2">
                <i className="fas fa-chart-line"></i> {t('insights')}
              </button>
              <div className="flex gap-4">
                 <button onClick={(e) => { e.stopPropagation(); window.location.hash = `/s/${agent.id}`; }} className="text-slate-300 hover:text-slate-900 transition-colors" aria-label="Open agent"><i className="fas fa-external-link-alt"></i></button>
                 <button onClick={(e) => handleDeleteAgent(agent, e)} className="text-slate-300 hover:text-red-600 transition-colors" aria-label="Delete agent"><i className="fas fa-trash"></i></button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showManual && (
        <div className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-8 border-b border-slate-100 flex items-start justify-between gap-6">
              <div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">{manualContent.title[language]}</h3>
                <p className="text-sm text-slate-500 font-medium mt-2">{manualContent.intro[language]}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowManual(false)}
                className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"
              >
                <i className="fas fa-times text-xl"></i>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
              {manualContent.sections.map((section, idx) => (
                <div key={idx} className="space-y-3">
                  <h4 className="text-[11px] font-black uppercase tracking-widest text-indigo-700">{section.title}</h4>
                  <div className="space-y-2 text-sm text-slate-600 font-medium leading-relaxed">
                    {section.body.map((line, lineIdx) => (
                      <p key={lineIdx}>{line}</p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end">
              <button
                type="button"
                onClick={() => setShowManual(false)}
                className="px-6 py-3 rounded-xl bg-indigo-600 text-white font-black text-[10px] uppercase tracking-widest"
              >
                {t('manualClose')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLmsInstructions && (
        <div className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-8 border-b border-slate-100 flex items-start justify-between gap-6">
              <div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">{t('lmsTitle')}</h3>
                <p className="text-sm text-slate-500 font-medium mt-2">{t('lmsButton')}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setLmsLanguage('sv')}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${lmsLanguage === 'sv' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
                  >
                    SV
                  </button>
                  <button
                    type="button"
                    onClick={() => setLmsLanguage('en')}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${lmsLanguage === 'en' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
                  >
                    EN
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowLmsInstructions(false)}
                  className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"
                >
                  <i className="fas fa-times text-xl"></i>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-8">
              <pre className="whitespace-pre-wrap text-sm text-slate-700 font-medium leading-relaxed">
                {buildLmsInstructions(lmsLanguage)}
              </pre>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={() => {
                  const text = buildLmsInstructions(lmsLanguage);
                  navigator.clipboard.writeText(text);
                  setLmsCopyStatus(true);
                  setTimeout(() => setLmsCopyStatus(false), 1500);
                }}
                className="px-6 py-3 rounded-xl bg-indigo-600 text-white font-black text-[10px] uppercase tracking-widest"
              >
                {lmsCopyStatus ? t('lmsCopied') : t('lmsCopy')}
              </button>
              <button
                type="button"
                onClick={() => setShowLmsInstructions(false)}
                className="px-6 py-3 rounded-xl bg-white text-indigo-700 border border-indigo-200 font-black text-[10px] uppercase tracking-widest"
              >
                {t('manualClose')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INSIGHTS MODAL */}
      {activeInsightsId && activeAgent && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xl animate-in fade-in duration-300">
           <div className="bg-white rounded-[4rem] shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col animate-in slide-in-from-bottom-10 duration-500">
              <div className="p-10 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
                <div className="flex items-center gap-5">
                   <div className="w-14 h-14 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-xl shadow-indigo-100">
                      <i className="fas fa-brain text-xl"></i>
                   </div>
                   <div>
                      <h2 className="text-2xl font-black text-slate-900 tracking-tight uppercase">{activeAgent.name} - {t('insights')}</h2>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                        {agentSubmissions.length} {t('submissionsAnalyzed')}
                      </p>
                   </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
                    <button
                      type="button"
                      onClick={() => onLanguageChange('sv')}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'sv' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
                    >
                      SV
                    </button>
                    <button
                      type="button"
                      onClick={() => onLanguageChange('en')}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'en' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}
                    >
                      EN
                    </button>
                  </div>
                  <button onClick={() => setActiveInsightsId(null)} className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"><i className="fas fa-times text-xl"></i></button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-12 custom-scrollbar bg-slate-50/50">
                {!aggregatedInsights ? (
                  <div className="h-64 flex flex-col items-center justify-center text-slate-300 space-y-4">
                    <i className="fas fa-ghost text-4xl"></i>
                    <p className="text-[10px] font-black uppercase tracking-[0.3em]">{t('noSubmissions')}</p>
                  </div>
                ) : (
                  <div className="space-y-12">
                    {/* Statistik Header */}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-8">
                       <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col justify-center">
                          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">{t('avgRevisions')}</span>
                          <span className="text-4xl font-black text-indigo-600">
                            {revisionStats.sessionCount ? revisionStats.avgRevisionsPerSession.toFixed(1) : '—'}
                          </span>
                       </div>
                       <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col justify-center">
                          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">{t('avgRevisionTime')}</span>
                          <span className="text-4xl font-black text-slate-900">
                            {revisionStats.avgMinutesBetween ? `${Math.round(revisionStats.avgMinutesBetween)} ${t('minutes')}` : '—'}
                          </span>
                       </div>
                       <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col justify-center">
                          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">{t('submissionsLabel')}</span>
                          <span className="text-4xl font-black text-slate-900">{aggregatedInsights.count}</span>
                       </div>
                       <div className="bg-indigo-600 p-8 rounded-[2.5rem] shadow-xl shadow-indigo-100 flex flex-col justify-center">
                          <span className="text-[9px] font-black text-indigo-200 uppercase tracking-widest block mb-1">{t('stringencyLabel')}</span>
                          <span className="text-4xl font-black text-white uppercase tracking-tight">
                            {activeAgent.stringency === 'strict' ? t('str') : activeAgent.stringency === 'generous' ? t('gen') : t('std')}
                          </span>
                       </div>
                    </div>

                    {/* Analys Kolumner */}
                    <div className="space-y-4">
                      <div className="flex items-center gap-3 ml-2">
                        <i className="fas fa-clock text-indigo-500 text-xs"></i>
                        <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">{t('revisionHistogram')}</h3>
                      </div>
                      <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
                        <div className="space-y-3">
                          {revisionStats.buckets.map((bucket) => {
                            const maxCount = Math.max(...revisionStats.buckets.map(b => b.count), 1);
                            const width = `${Math.round((bucket.count / maxCount) * 100)}%`;
                            return (
                              <div key={bucket.label} className="flex items-center gap-3">
                                <div className="w-16 text-[9px] font-black text-slate-500 uppercase tracking-widest">{bucket.label}</div>
                                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-indigo-500" style={{ width }} />
                                </div>
                                <div className="w-10 text-right text-[9px] font-black text-slate-400">{bucket.count}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                      <div className="space-y-6">
                        <div className="flex items-center gap-3 ml-2">
                           <i className="fas fa-exclamation-triangle text-amber-500 text-xs"></i>
                           <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">{t('commonErrors')}</h3>
                        </div>
                        <div className="space-y-3">
                          {aggregatedInsights.errors.map((err, i) => (
                            <div key={i} className="bg-white p-5 rounded-2xl border-l-4 border-amber-400 shadow-sm text-[13px] font-medium text-slate-700 leading-relaxed">{err}</div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-6">
                        <div className="flex items-center gap-3 ml-2">
                           <i className="fas fa-award text-emerald-500 text-xs"></i>
                           <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">{t('strengths')}</h3>
                        </div>
                        <div className="space-y-3">
                          {aggregatedInsights.strengths.map((str, i) => (
                            <div key={i} className="bg-white p-5 rounded-2xl border-l-4 border-emerald-400 shadow-sm text-[13px] font-medium text-slate-700 leading-relaxed">{str}</div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-6">
                        <div className="flex items-center gap-3 ml-2">
                           <i className="fas fa-chalkboard-teacher text-indigo-600 text-xs"></i>
                           <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">{t('actions')}</h3>
                        </div>
                        <div className="space-y-3">
                          {aggregatedInsights.actions.map((act, i) => (
                            <div key={i} className="bg-indigo-950 p-5 rounded-2xl shadow-sm text-[13px] font-medium text-indigo-50 leading-relaxed">{act}</div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center gap-3 ml-2">
                        <i className="fas fa-download text-indigo-500 text-xs"></i>
                        <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">{t('logDownload')}</h3>
                      </div>
                      <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm space-y-4">
                        <div className="flex flex-wrap gap-3">
                          <button
                            type="button"
                            disabled={logBusy}
                            onClick={() => handleDownloadLog('csv')}
                            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest ${
                              logBusy ? 'bg-slate-200 text-slate-400' : 'bg-indigo-600 text-white hover:bg-indigo-700'
                            }`}
                          >
                            {t('logCsv')}
                          </button>
                          <button
                            type="button"
                            disabled={logBusy}
                            onClick={() => handleDownloadLog('json')}
                            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest ${
                              logBusy ? 'bg-slate-200 text-slate-400' : 'bg-white border border-slate-200 text-slate-700 hover:text-indigo-600'
                            }`}
                          >
                            {t('logJson')}
                          </button>
                          <button
                            type="button"
                            disabled={logBusy}
                            onClick={() => handleDownloadLog('txt')}
                            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest ${
                              logBusy ? 'bg-slate-200 text-slate-400' : 'bg-white border border-slate-200 text-slate-700 hover:text-indigo-600'
                            }`}
                          >
                            {t('logTxt')}
                          </button>
                        </div>
                        <div className="pt-2 border-t border-slate-100/80">
                          <button
                            type="button"
                            disabled={logBusy}
                            onClick={handleClearHistory}
                            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest ${
                              logBusy ? 'bg-slate-200 text-slate-400' : 'bg-rose-500 text-white hover:bg-rose-600'
                            }`}
                          >
                            {t('clearHistory')}
                          </button>
                          <p className="text-[9px] text-slate-500 font-semibold mt-2">{t('clearHistoryHelp')}</p>
                        </div>
                        {logError && <p className="text-[9px] font-black uppercase tracking-widest text-red-500">{logError}</p>}
                      </div>
                    </div>

                    {/* Results table removed by request */}
                  </div>
                )}
              </div>
           </div>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md">
          <div className="bg-white rounded-[3.5rem] shadow-2xl w-full max-w-6xl max-h-[95vh] overflow-hidden flex flex-col relative animate-in zoom-in-95 duration-500">
            
            {editingCriterionIdx !== null && (
              <div className="absolute inset-0 z-[100] bg-slate-50 flex flex-col animate-in slide-in-from-right-10 duration-700">
                <div className="p-10 border-b border-slate-100 bg-white flex justify-between items-center">
                  <h3 className="text-2xl font-black text-slate-900 tracking-tight">Redigera Bedömningsmatris</h3>
                  <button onClick={() => setEditingCriterionIdx(null)} className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"><i className="fas fa-times text-xl"></i></button>
                </div>
                <div className="flex-1 p-10 overflow-y-auto"><div className="max-w-[1200px] mx-auto"><EditableMatrix value={editingCriterionValue} onChange={setEditingCriterionValue} language={language} /></div></div>
                <div className="p-10 border-t border-slate-100 bg-white flex gap-6 justify-end">
                  <button onClick={() => setEditingCriterionIdx(null)} className="px-10 py-4 font-black text-slate-400 text-[11px] uppercase tracking-widest">Avbryt</button>
                  <button onClick={() => { const updated = [...criteriaList]; updated[editingCriterionIdx!] = editingCriterionValue.trim(); setCriteriaList(updated); setEditingCriterionIdx(null); void persistCriteria(updated); }} className="px-14 py-4 rounded-2xl font-black text-white bg-indigo-600 text-[11px] uppercase tracking-widest">Spara matris</button>
                </div>
              </div>
            )}


            <div className="p-10 border-b border-slate-50 flex justify-between items-center bg-white shrink-0">
              <h2 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.3em]">{editingAgentId ? 'Redigera Agent' : 'Skapa Ny Agent'}</h2>
              <div className="flex items-center gap-3">
                <EduTooltip text={t('manualTooltip')}>
                  <button
                    type="button"
                    onClick={() => setShowManual(true)}
                    className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center"
                    aria-label={t('manualTooltip')}
                  >
                    <i className="fas fa-book-open text-lg"></i>
                  </button>
                </EduTooltip>
                <EduTooltip text={t('lmsButton')}>
                  <button
                    type="button"
                    onClick={() => {
                      setLmsLanguage(language);
                      setShowLmsInstructions(true);
                      setLmsCopyStatus(false);
                    }}
                    className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center"
                    aria-label={t('lmsButton')}
                  >
                    <i className="fas fa-file-alt text-lg"></i>
                  </button>
                </EduTooltip>
                <button onClick={() => void handleCloseModal()} className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"><i className="fas fa-times text-xl"></i></button>
              </div>
            </div>
            
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-14 space-y-16 custom-scrollbar">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-20">
                <div className="space-y-12">
                  <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('agentName')}</label>
                    <input
                      required
                      type="text"
                      className="w-full px-8 py-5 rounded-[1.5rem] border border-slate-100 text-xl font-black shadow-inner bg-slate-50 outline-none placeholder:text-slate-300"
                      placeholder={t('agentNamePlaceholder')}
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('taskDesc')}</label>
                    <textarea
                      required
                      rows={4}
                      className="w-full px-8 py-5 rounded-[1.5rem] border border-slate-100 text-[15px] font-medium shadow-inner bg-slate-50 outline-none placeholder:text-slate-300"
                      placeholder={t('taskDescPlaceholder')}
                      value={newDesc}
                      onChange={e => setNewDesc(e.target.value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                      {t('accessCodeLabel')}
                      <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">{t('accessCodeHelp')}</span>
                    </label>
                    <div className="flex gap-3 items-center">
                      <input
                        required
                        type="text"
                        className="flex-1 px-6 py-4 rounded-2xl border border-slate-100 bg-slate-50 font-black text-slate-900 uppercase tracking-widest placeholder:text-slate-300"
                        placeholder={t('accessCodePlaceholder')}
                        value={accessCode}
                        onChange={e => {
                          setAccessCode(e.target.value);
                          setAccessCodeError(null);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const generated = generateAccessCode();
                          setAccessCode(generated);
                          setAccessCodeError(null);
                        }}
                        className="px-4 py-3 rounded-2xl bg-slate-900 text-white text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600 transition-colors"
                      >
                        {t('accessCodeGenerate')}
                      </button>
                    </div>
                    {accessCodeError && (
                      <p className="text-[10px] font-black text-red-500 uppercase tracking-widest">{accessCodeError}</p>
                    )}
                  </div>

                  <div className="space-y-5">
                    <label className="text-[10px] font-black text-indigo-700 uppercase tracking-widest block ml-1">{t('stringencyLabel')}</label>
                    <div className="grid grid-cols-3 gap-5">
                      {(['generous', 'standard', 'strict'] as StringencyLevel[]).map(lvl => (
                        <button key={lvl} type="button" onClick={() => setStringency(lvl)} className={`p-5 rounded-2xl border-2 transition-all text-left group ${stringency === lvl ? 'border-indigo-600 bg-indigo-50/40' : 'border-slate-50 bg-slate-50'}`}>
                          <span className={`text-[9px] font-black uppercase tracking-[0.2em] block mb-1 ${stringency === lvl ? 'text-indigo-700' : 'text-slate-400'}`}>{t(lvl === 'strict' ? 'str' : lvl === 'generous' ? 'gen' : 'std')}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('minWords')}</label>
                      <input
                        type="number"
                        max={2000}
                        className="w-full px-6 py-4 rounded-2xl border border-slate-100 bg-slate-50 font-black text-slate-900"
                        value={minWords}
                        onChange={e => setMinWords(Math.min(2000, Number(e.target.value)))}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('maxWords')}</label>
                      <input
                        type="number"
                        max={2000}
                        className="w-full px-6 py-4 rounded-2xl border border-slate-100 bg-slate-50 font-black text-slate-900"
                        value={maxWords}
                        onChange={e => setMaxWords(Math.min(2000, Number(e.target.value)))}
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('studentOptions')}</label>
                    <div className="space-y-3">
                      <label className="flex items-start gap-4 bg-slate-50 border border-slate-100 rounded-2xl px-6 py-4">
                        <input
                          type="checkbox"
                          className="mt-1 accent-indigo-600"
                          checked={showVerificationCode}
                          onChange={(e) => {
                            const nextValue = e.target.checked;
                            setShowVerificationCode(nextValue);
                            if (!nextValue) {
                              setShowSubmissionPrompt(false);
                            }
                          }}
                        />
                        <div>
                          <p className="text-[11px] font-black text-slate-900 uppercase tracking-widest">{t('verificationCodeLabel')}</p>
                          <p className="text-[11px] font-semibold text-slate-500">{t('verificationCodeHelp')}</p>
                        </div>
                      </label>
                      {showVerificationCode && verificationPrefix && lmsMinimum !== null && lmsMaximum !== null && (
                        <div className="ml-4 bg-slate-50 border border-slate-100 rounded-2xl p-5 space-y-4">
                          <div className="flex items-center gap-4">
                            <div className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-black tracking-widest">
                              {verificationPrefix}
                            </div>
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-700">{t('verificationPrefixLabel')}</p>
                              <p className="text-[11px] font-semibold text-slate-500">{t('verificationPrefixHelp')}</p>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-700">{t('lmsIntervalLabel')}</p>
                            <div className="grid grid-cols-2 gap-4">
                              <div className="bg-white border border-slate-100 rounded-xl px-4 py-3">
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{t('lmsFrom')}</p>
                                <p className="text-sm font-black text-slate-900">{lmsMinimum}</p>
                              </div>
                              <div className="bg-white border border-slate-100 rounded-xl px-4 py-3">
                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{t('lmsTo')}</p>
                                <p className="text-sm font-black text-slate-900">{lmsMaximum}</p>
                              </div>
                            </div>
                            <p className="text-[11px] font-semibold text-slate-500">{t('lmsIntervalHelp')}</p>
                          </div>
                        </div>
                      )}
                      <label className={`flex items-start gap-4 border rounded-2xl px-6 py-4 ${showVerificationCode ? 'bg-slate-50 border-slate-100' : 'bg-slate-50/40 border-slate-100 opacity-50'}`}>
                        <input
                          type="checkbox"
                          className="mt-1 accent-indigo-600"
                          checked={showSubmissionPrompt}
                          onChange={(e) => setShowSubmissionPrompt(e.target.checked)}
                          disabled={!showVerificationCode}
                        />
                        <div>
                          <p className="text-[11px] font-black text-slate-900 uppercase tracking-widest">{t('submissionPromptLabel')}</p>
                          <p className="text-[11px] font-semibold text-slate-500">{t('submissionPromptHelp')}</p>
                        </div>
                      </label>
                    </div>
                  </div>

                  {editingAgentId && (
                    <div className="p-8 bg-indigo-50 rounded-[2.5rem] border border-indigo-100 space-y-4">
                      <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-900 flex items-center gap-2"><i className="fas fa-code"></i> {t('embedTitle')}</h3>
                      <code className="text-[9px] font-mono break-all text-indigo-800 bg-white/50 p-4 rounded-xl block leading-normal border border-indigo-100">{generateIframeCode(editingAgentId)}</code>
                      <button type="button" onClick={() => { navigator.clipboard.writeText(generateIframeCode(editingAgentId)); setCopyStatus('embed'); setTimeout(() => setCopyStatus(null), 2000); }} className="w-full py-3 rounded-xl bg-indigo-900 text-white font-black text-[9px] uppercase tracking-widest">{copyStatus === 'embed' ? t('copied') : t('copyEmbed')}</button>
                      <div className="pt-2 border-t border-indigo-100/70">
                        <button
                          type="button"
                          onClick={() => window.open(generateStudentUrl(editingAgentId), '_blank', 'noopener,noreferrer')}
                          className="w-full py-3 rounded-xl bg-white text-indigo-900 font-black text-[9px] uppercase tracking-widest border border-indigo-200 hover:bg-indigo-50 transition-colors"
                        >
                          {t('studentPreview')}
                        </button>
                        <p className="text-[9px] text-indigo-700 font-semibold mt-2">{t('studentPreviewHelp')}</p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-12">
                  <div className="space-y-5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                      {t('refLabel')}
                      <InfoPopover text={t('ragInfo')} />
                    </label>
                    <div className="p-6 bg-slate-50 border-2 border-dashed border-slate-200 rounded-[2rem] text-center space-y-4">
                      <input type="file" multiple id="ref-upload" className="hidden" onChange={handleFileUpload} />
                      <label htmlFor="ref-upload" className="cursor-pointer text-[10px] font-black text-indigo-600 uppercase tracking-widest bg-white px-8 py-3 rounded-xl shadow-sm border border-slate-100 inline-block">Välj filer</label>
                      <p className="text-[10px] font-semibold text-slate-400">{t('uploadTip')}</p>
                      {uploadError && <p className="text-[9px] font-black text-red-500 uppercase tracking-widest">{uploadError}</p>}
                      <div className="flex flex-wrap gap-3 justify-center">
                        {pendingUploads.map((upload) => (
                          <div key={upload.id} className="bg-white px-4 py-3 rounded-2xl border border-slate-200 flex flex-col gap-2 min-w-[220px]">
                            <div className="flex items-center gap-3">
                              <i className="fas fa-cloud-upload-alt text-indigo-500 text-[10px]"></i>
                              <span className="text-[9px] font-black text-slate-700 max-w-[120px] truncate">{upload.name}</span>
                              <span className="ml-auto text-[8px] font-black uppercase tracking-widest text-indigo-600">
                                {t('uploadProgress')} {upload.progress}%
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-indigo-500 transition-all duration-300"
                                style={{ width: `${upload.progress}%` }}
                              />
                            </div>
                          </div>
                        ))}
                        {referenceMaterials.map((ref) => (
                          <div key={ref.id} className="bg-white px-4 py-3 rounded-2xl border border-slate-200 flex flex-col gap-2 min-w-[220px]">
                            <div className="flex items-center gap-3">
                              <i className="fas fa-file-pdf text-red-500 text-[10px]"></i>
                              <span className="text-[9px] font-black text-slate-700 max-w-[120px] truncate">{ref.name}</span>
                              <span className={`ml-auto text-[8px] font-black uppercase tracking-widest ${ref.status === 'ready' ? 'text-emerald-600' : ref.status === 'failed' ? 'text-red-500' : ref.status === 'needs_review' ? 'text-amber-600' : 'text-amber-500'}`}>
                                {statusLabel(ref.status)}
                              </span>
                              <button type="button" onClick={() => handleRemoveMaterial(ref)} className="text-slate-300 hover:text-red-500"><i className="fas fa-times text-[10px]"></i></button>
                            </div>
                            {(ref.status === 'uploaded' || ref.status === 'processing') && (
                              <div className="space-y-2">
                                <div className="w-full h-1.5 bg-slate-100 rounded-full processing-bar" />
                                <p className="text-[9px] font-semibold text-slate-400">{t('processingHint')}</p>
                              </div>
                            )}
                            {ref.status === 'needs_review' && (
                              <div className="text-[9px] text-slate-500 font-semibold space-y-2">
                                <p className="font-black text-amber-700 uppercase tracking-widest">{t('materialNeedsReviewTitle')}</p>
                                <p>{t('materialNeedsReviewBody')}</p>
                                {(ref.tokenCount || ref.tokenLimit) && (
                                  <p className="text-[9px] text-slate-400">
                                    {t('materialTokenLine')}: {ref.tokenCount ?? '—'} / {ref.tokenLimit ?? '—'}
                                  </p>
                                )}
                                <div className="flex gap-2 pt-1">
                                  <button
                                    type="button"
                                    onClick={() => handleContinueMaterial(ref)}
                                    className="px-3 py-2 rounded-xl bg-slate-200 text-slate-700 font-black text-[8px] uppercase tracking-widest hover:bg-slate-300"
                                  >
                                    {t('materialContinue')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleAbortMaterial(ref)}
                                    className="px-3 py-2 rounded-xl bg-emerald-500 text-white font-black text-[8px] uppercase tracking-widest hover:bg-emerald-600"
                                  >
                                    {t('materialAbort')}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('criteriaLabel')}</label>
                    <div className="flex gap-4">
                      <input
                        type="text"
                        className="flex-1 px-8 py-4 rounded-[1.5rem] border border-slate-100 text-[12px] font-black outline-none bg-slate-50 uppercase tracking-widest placeholder:text-slate-300"
                        placeholder={t('criteriaPlaceholder')}
                        value={currentCriterion}
                        onChange={e => setCurrentCriterion(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), void handleAddCriterion())}
                      />
                      <button type="button" onClick={handleAddCriterion} className="w-14 h-14 bg-indigo-600 text-white rounded-2xl shadow-lg flex items-center justify-center"><i className="fas fa-plus"></i></button>
                    </div>
                    <div className="space-y-4 max-h-[400px] overflow-y-auto pr-3 custom-scrollbar">
                      {criteriaList.map((criterion, idx) => {
                        const matrix = parseMatrixData(criterion);
                        const displayTitle = matrix ? (matrix.body[0]?.[0] || matrix.header[0]) : criterion;
                        return (
                          <div key={idx} className={`p-5 rounded-[2rem] border flex items-center justify-between group transition-all ${matrix ? 'bg-indigo-50/30 border-indigo-100' : 'bg-white border-slate-100'}`}>
                            <div className="flex gap-4 items-center">
                              <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-sm ${matrix ? 'bg-indigo-900 text-white' : 'bg-slate-100 text-slate-400'}`}><i className={matrix ? "fas fa-table-cells" : "fas fa-font"}></i></div>
                              <div>
                                <h4 className="text-[11px] font-black text-slate-900 uppercase tracking-widest truncate max-w-[200px]">{displayTitle}</h4>
                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">{matrix ? 'Professionell matris' : 'Utkast / Text'}</p>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button type="button" onClick={() => { setEditingCriterionIdx(idx); setEditingCriterionValue(criteriaList[idx]); }} className="w-8 h-8 rounded-lg bg-white shadow-sm border border-slate-100 text-slate-400 hover:text-indigo-600"><i className="fas fa-pen text-[10px]"></i></button>
                              {!matrix && (
                                <EduTooltip text={t('aiMatrixHelp')}>
                                  <button
                                    type="button"
                                    disabled={isImproving}
                                    onClick={() => handleImproveRequest(idx)}
                                    className="px-3 h-8 rounded-full bg-amber-50 shadow-sm border border-amber-100 text-amber-700 hover:text-amber-800 hover:bg-amber-100 flex items-center gap-2 disabled:opacity-60"
                                  >
                                    <i className={`fas ${isImproving ? 'fa-spinner fa-spin' : 'fa-sparkles'} text-[10px]`}></i>
                                    <span className="text-[9px] font-black uppercase tracking-widest">{t('aiMatrix')}</span>
                                  </button>
                                </EduTooltip>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = criteriaList.filter((_, i) => i !== idx);
                                  setCriteriaList(updated);
                                  void persistCriteria(updated);
                                }}
                                className="w-8 h-8 rounded-lg bg-white shadow-sm border border-slate-100 text-slate-400 hover:text-red-500"
                              >
                                <i className="fas fa-trash-alt text-[10px]"></i>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {formError && (
                      <p className="text-[10px] font-black text-red-500 uppercase tracking-widest">{formError}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="pt-16 border-t border-slate-50 flex gap-6">
                <button type="button" onClick={() => void handleCloseModal()} className="px-12 py-5 rounded-2xl font-black text-slate-400 text-[11px] uppercase tracking-widest hover:bg-slate-50 transition-all">Avbryt</button>
                <button type="submit" className="flex-1 py-5 rounded-2xl font-black text-white bg-slate-900 hover:bg-indigo-600 transition-all text-[12px] uppercase tracking-[0.3em] shadow-2xl shadow-slate-200">{editingAgentId ? t('save') : t('publish')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
