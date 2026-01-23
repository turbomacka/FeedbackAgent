
import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { collection, deleteDoc, doc, getDoc, getDocFromServer, getDocs, onSnapshot, setDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { deleteObject, ref, uploadBytesResumable } from 'firebase/storage';
import { Agent, CriterionMatrixItem, ReferenceMaterial, Submission, StringencyLevel } from '../types';
import { auth, db, storage } from '../firebase';
import { analyzeCriterion, translateContent, askSupport } from '../services/geminiService';
import { createPromoCode, disablePromoCode, listPromoCodes, PromoCodeEntry } from '../services/teacherAuthService';
import {
  getAdminModelConfig,
  syncModelProvider,
  updateAdminModelConfig,
  updateModelProvider,
  ModelProvider,
  ModelRoutingConfig,
  ModelTaskConfig
} from '../services/adminModelService';
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

const BLOOM_LEVELS = [
  { index: 1, sv: 'Minns', en: 'Remember', badge: 'bg-slate-100 text-slate-700 border-slate-200' },
  { index: 2, sv: 'Förstå', en: 'Understand', badge: 'bg-sky-100 text-sky-700 border-sky-200' },
  { index: 3, sv: 'Tillämpa', en: 'Apply', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { index: 4, sv: 'Analysera', en: 'Analyze', badge: 'bg-amber-100 text-amber-700 border-amber-200' },
  { index: 5, sv: 'Värdera', en: 'Evaluate', badge: 'bg-rose-100 text-rose-700 border-rose-200' },
  { index: 6, sv: 'Skapa', en: 'Create', badge: 'bg-indigo-100 text-indigo-700 border-indigo-200' }
];

const MODEL_TASKS = [
  { id: 'assessment', labelKey: 'modelTaskAssessment' },
  { id: 'feedback', labelKey: 'modelTaskFeedback' },
  { id: 'criterionAnalyze', labelKey: 'modelTaskCriterionAnalyze' },
  { id: 'criterionImprove', labelKey: 'modelTaskCriterionImprove' },
  { id: 'support', labelKey: 'modelTaskSupport' },
  { id: 'translate', labelKey: 'modelTaskTranslate' }
];


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

const AdminFieldLabel = ({ label, help }: { label: string; help?: string }) => (
  <div className="flex items-center gap-2">
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    {help && (
      <EduTooltip text={help}>
        <span className="w-5 h-5 rounded-full border border-slate-200 text-slate-500 flex items-center justify-center text-[9px] font-black uppercase tracking-widest bg-white">
          i
        </span>
      </EduTooltip>
    )}
  </div>
);

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
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [criteriaMatrix, setCriteriaMatrix] = useState<CriterionMatrixItem[]>([]);
  const [criteriaLanguage, setCriteriaLanguage] = useState<'sv' | 'en'>(language);
  const [legacyCriteria, setLegacyCriteria] = useState<string[]>([]);
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
  const [modelProviders, setModelProviders] = useState<ModelProvider[]>([]);
  const [modelRouting, setModelRouting] = useState<ModelRoutingConfig | null>(null);
  const [providerAllowlist, setProviderAllowlist] = useState<string[]>([]);
  const [modelAdminBusy, setModelAdminBusy] = useState(false);
  const [modelAdminError, setModelAdminError] = useState<string | null>(null);
  const [modelAdminSaved, setModelAdminSaved] = useState(false);
  const modelConfigLoadedRef = useRef(false);
  const [providerManualInput, setProviderManualInput] = useState<Record<string, string>>({});
  const matrixSaveTimeout = useRef<number | null>(null);
  const matrixTranslateInFlight = useRef(false);
  const [showManual, setShowManual] = useState(false);
  const [showLmsInstructions, setShowLmsInstructions] = useState(false);
  const [lmsLanguage, setLmsLanguage] = useState<'sv' | 'en'>('sv');
  const [lmsCopyStatus, setLmsCopyStatus] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [supportMessages, setSupportMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [supportInput, setSupportInput] = useState('');
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [draftCreatedId, setDraftCreatedId] = useState<string | null>(null);
  const [showMatrixEditor, setShowMatrixEditor] = useState(false);
  const [isRefreshingMatrix, setIsRefreshingMatrix] = useState(false);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [hiddenAgentIds, setHiddenAgentIds] = useState<Record<string, boolean>>({});
  const [removingAgentIds, setRemovingAgentIds] = useState<Record<string, boolean>>({});
  const removalTimers = useRef<Record<string, number>>({});

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
    modelAdminTitle: { sv: 'Admin: Modellstyrning', en: 'Admin: Model routing' },
    modelAdminSubtitle: { sv: 'Globala inställningar för vilka modeller som används.', en: 'Global settings for which models are used.' },
    modelAdminBadge: { sv: 'Admin', en: 'Admin' },
    modelAdminTooltip: {
      sv: 'API-administration: här styr du globala providers, modeller, routing och priser. Steg-för-steg finns under Gör så här.',
      en: 'API administration: configure global providers, models, routing and pricing. Step-by-step is in How to.'
    },
    modelProvidersTitle: { sv: 'Aktiva providers', en: 'Active providers' },
    modelProvidersHelp: {
      sv: 'Synka modeller för att uppdatera rullistorna. API-nycklar hanteras via secrets.',
      en: 'Sync models to refresh dropdowns. API keys are handled via secrets.'
    },
    modelProviderLabel: { sv: 'Provider', en: 'Provider' },
    modelProviderEnabled: { sv: 'Aktiv', en: 'Enabled' },
    modelProviderSecret: { sv: 'Secret‑namn', en: 'Secret name' },
    modelProviderSecretHelp: {
      sv: 'Namnet på secret i Firebase Secret Manager. Värdet är API‑nyckeln.',
      en: 'Name of the secret in Firebase Secret Manager. The value is the API key.'
    },
    modelProviderLocation: { sv: 'Region', en: 'Region' },
    modelProviderLocationHelp: {
      sv: 'Endast för Google/Vertex embeddings. Exempel: europe‑west4.',
      en: 'Only for Google/Vertex embeddings. Example: europe-west4.'
    },
    modelProviderBaseUrl: { sv: 'Base URL', en: 'Base URL' },
    modelProviderBaseUrlHelp: {
      sv: 'Bas‑URL för API‑anrop. Måste vara https och finnas i allowlist.',
      en: 'Base URL for API calls. Must use https and be listed in the allowlist.'
    },
    modelProviderCapabilities: { sv: 'Kapabiliteter', en: 'Capabilities' },
    modelProviderCapabilitiesHelp: {
      sv: 'Talar om vilka endpoints leverantören stöder.',
      en: 'Defines which endpoints the provider supports.'
    },
    modelProviderChat: { sv: 'Chat', en: 'Chat' },
    modelProviderChatHelp: {
      sv: 'Aktivera om /chat/completions stöds.',
      en: 'Enable if /chat/completions is supported.'
    },
    modelProviderEmbeddings: { sv: 'Embeddings', en: 'Embeddings' },
    modelProviderEmbeddingsHelp: {
      sv: 'Aktivera om /embeddings stöds.',
      en: 'Enable if /embeddings is supported.'
    },
    modelProviderJson: { sv: 'JSON‑läge', en: 'JSON mode' },
    modelProviderJsonHelp: {
      sv: 'Aktivera om response_format: json_object stöds.',
      en: 'Enable if response_format: json_object is supported.'
    },
    modelProviderFilter: { sv: 'Filter (regex)', en: 'Filter (regex)' },
    modelProviderFilterHelp: {
      sv: 'Filtrerar synkade modeller. Exempel: ^gpt-4',
      en: 'Filters synced models. Example: ^gpt-4'
    },
    modelProviderManual: { sv: 'Manuella modeller', en: 'Manual models' },
    modelProviderManualHelp: {
      sv: 'Använd om /models saknas eller är fel. Anges exakt som leverantörens modell‑ID.',
      en: 'Use when /models is missing or incomplete. Enter the exact provider model ID.'
    },
    modelProviderManualAdd: { sv: 'Lägg till modell‑ID', en: 'Add model ID' },
    modelProviderManualAddHelp: {
      sv: 'Skriv in modell‑ID och klicka + för att spara.',
      en: 'Enter a model ID and click + to save.'
    },
    modelProviderSync: { sv: 'Synka modeller', en: 'Sync models' },
    modelProviderSyncHelp: {
      sv: 'Hämtar modeller från /models och uppdaterar listan.',
      en: 'Fetches models from /models and refreshes the list.'
    },
    modelProviderSynced: { sv: 'Senast synkad', en: 'Last synced' },
    modelRoutingTitle: { sv: 'Modellval per funktion', en: 'Model per task' },
    modelRoutingHelp: {
      sv: 'Välj provider och modell för varje del av systemet. Pris anges manuellt per modell.',
      en: 'Choose provider and model per task. Price is entered manually per model.'
    },
    modelTaskAssessment: { sv: 'Bedömning (Score)', en: 'Assessment (Score)' },
    modelTaskFeedback: { sv: 'Återkoppling (Feedback)', en: 'Feedback response' },
    modelTaskCriterionAnalyze: { sv: 'AI‑analys av kriterium', en: 'Criterion analysis' },
    modelTaskCriterionImprove: { sv: 'AI‑matris (Smart‑fill)', en: 'AI rubric (Smart fill)' },
    modelTaskSupport: { sv: 'Supportchatt', en: 'Support chat' },
    modelTaskTranslate: { sv: 'Översättning', en: 'Translation' },
    modelTaskEmbeddings: { sv: 'Embeddings (RAG)', en: 'Embeddings (RAG)' },
    modelSelectProvider: { sv: 'Välj provider', en: 'Select provider' },
    modelSelectModel: { sv: 'Välj modell', en: 'Select model' },
    modelTaskLabel: { sv: 'Funktion', en: 'Task' },
    modelModelLabel: { sv: 'Modell', en: 'Model' },
    modelPriceLabel: { sv: 'Pris / 1M tokens', en: 'Price / 1M tokens' },
    modelPricePlaceholder: { sv: 't.ex. $0.30', en: 'e.g. $0.30' },
    modelPriceInputLabel: { sv: 'Input', en: 'Input' },
    modelPriceOutputLabel: { sv: 'Output', en: 'Output' },
    modelCurrencyLabel: { sv: 'Valuta', en: 'Currency' },
    modelCurrencyPlaceholder: { sv: 't.ex. USD', en: 'e.g. USD' },
    modelSafeLabel: { sv: 'Safe Model för bedömning', en: 'Safe model for assessment' },
    modelAllowlistTitle: { sv: 'Allowlist för providers', en: 'Provider allowlist' },
    modelAllowlistHelp: {
      sv: 'Endast dessa domäner får användas som Base URL.',
      en: 'Only these domains can be used as Base URL.'
    },
    modelAllowlistPlaceholder: { sv: 'En domän per rad', en: 'One domain per line' },
    modelSaveRouting: { sv: 'Spara modellval', en: 'Save model routing' },
    modelSaved: { sv: 'Sparat', en: 'Saved' },
    modelLoadError: { sv: 'Kunde inte ladda modellinställningar.', en: 'Failed to load model settings.' },
    modelSaveError: { sv: 'Kunde inte spara modellval.', en: 'Failed to save model routing.' },
    passHelp: {
      sv: 'Godkänd-gräns\n\nDetta är ingen procent eller betyg, utan en intern skala (0–100 000) som används för att räkna ut lägsta godkända värde i LMS.',
      en: 'Pass threshold\n\nThis is not a percentage or grade, but an internal 0–100,000 scale used to compute the minimum accepted value in your LMS.'
    },
    verificationPrefixLabel: { sv: 'Verifieringsprefix (auto)', en: 'Verification prefix (auto)' },
    lmsIntervalLabel: {
      sv: 'Ställ in intervallet för automatisk bedömning i Canvas',
      en: 'Set the interval for automatic grading in Canvas'
    },
    lmsFrom: { sv: 'Från', en: 'From' },
    lmsTo: { sv: 'Till', en: 'To' },
    manualTooltip: { sv: 'Gör så här', en: 'How to' },
    manualClose: { sv: 'Stäng', en: 'Close' },
    lmsButton: { sv: 'Instruktioner till studenter', en: 'Student instructions' },
    supportTooltip: { sv: 'Support', en: 'Support' },
    supportTitle: { sv: 'Supportchatt', en: 'Support chat' },
    supportSubtitle: {
      sv: 'Ställ frågor om hur systemet fungerar. Du får korta, praktiska svar.',
      en: 'Ask how the system works. You will get short, practical answers.'
    },
    supportIntro: {
      sv: 'Hej! Ställ din fråga om FeedbackAgent så hjälper jag dig.',
      en: 'Hi! Ask your question about FeedbackAgent and I will help you.'
    },
    supportPlaceholder: { sv: 'Skriv din fråga…', en: 'Type your question…' },
    supportSend: { sv: 'Skicka', en: 'Send' },
    supportError: { sv: 'Kunde inte hämta supportsvar.', en: 'Failed to fetch support answer.' },
    lmsTitle: { sv: 'Instruktioner till studenter', en: 'Student instructions' },
    lmsCopy: { sv: 'Kopiera text', en: 'Copy text' },
    lmsCopied: { sv: 'Kopierad!', en: 'Copied!' },
    criteriaLabel: { sv: 'Bedömningsstöd & Matriser', en: 'Criteria & Matrices' },
    criteriaPlaceholder: { sv: 'Namnge kriterium...', en: 'Name a criterion...' },
    aiMatrix: { sv: 'AI-matris', en: 'AI matrix' },
    aiMatrixHelp: { sv: 'Låt AI skapa en professionell matris med nivåer.', en: 'Let the AI generate a professional matrix with levels.' },
    matrixAddRow: { sv: 'Lägg till kriterium', en: 'Add criterion' },
    matrixOpen: { sv: 'Öppna matrisen', en: 'Open matrix' },
    matrixOpenHint: { sv: 'Redigera kriterier i en fokuserad popup.', en: 'Edit criteria in a focused pop-up.' },
    matrixSummaryCount: { sv: 'Kriterier', en: 'Criteria' },
    matrixSummaryCoverage: { sv: 'Bloom-täckning', en: 'Bloom coverage' },
    matrixSummaryReliability: { sv: 'Tydlighet', en: 'Clarity' },
    matrixModalTitle: { sv: 'Taxonomibaserad matris', en: 'Taxonomy matrix' },
    matrixModalSubtitle: { sv: 'Finjustera kriterierna med full överblick.', en: 'Fine-tune criteria with full overview.' },
    matrixModalClose: { sv: 'Spara och stäng', en: 'Save & close' },
    matrixRefresh: { sv: 'Uppdatera', en: 'Update' },
    matrixName: { sv: 'Kriterium', en: 'Criterion' },
    matrixNameHelp: { sv: 'Kort rubrik för vad som bedöms.', en: 'Short headline for what is assessed.' },
    matrixDescription: { sv: 'Beskrivning', en: 'Description' },
    matrixDescriptionHelp: {
      sv: 'Pedagogisk beskrivning av förmågan – vad studenten ska visa.',
      en: 'Pedagogical description of the ability – what the student should demonstrate.'
    },
    matrixIndicator: { sv: 'Indikator för AI‑agentens bedömning', en: 'Indicator for AI assessment' },
    matrixIndicatorHelp: {
      sv: 'Mätbar formulering som AI:n använder för att avgöra om kriteriet är uppfyllt.',
      en: 'Measurable wording the AI uses to decide if the criterion is met.'
    },
    matrixIndicatorPlaceholder: { sv: 'Indikator genereras av AI.', en: 'Indicator is generated by AI.' },
    matrixIndicatorNeeds: { sv: 'Indikator saknas — kör Uppdatera.', en: 'Indicator missing — run Update.' },
    matrixIndicatorCannot: { sv: 'Kan ej operationaliseras. Revidera kriteriet.', en: 'Cannot be operationalized. Revise the criterion.' },
    matrixIndicatorUnclear: { sv: 'Otydlig', en: 'Unclear' },
    matrixIndicatorsMissing: {
      sv: 'Indikatorer måste genereras av AI innan du kan spara.',
      en: 'Indicators must be AI-generated before you can save.'
    },
    matrixBloom: { sv: 'Bloom-nivå (AI)', en: 'Bloom level (AI)' },
    matrixBloomHelp: {
      sv: 'AI:n identifierar nivån utifrån beskrivning och indikator. Vill du styra nivån, skriv det tydligt i beskrivningen (t.ex. “jämför”, “värdera”, “skapa”).',
      en: 'The AI infers the level from description and indicator. To steer it, write it explicitly in the description (e.g. “compare”, “evaluate”, “create”).'
    },
    matrixReliability: { sv: 'Tydlighet', en: 'Clarity' },
    matrixClarityHelp: {
      sv: 'Hur konkret indikatorn är. Hög tydlighet = lätt att bedöma objektivt.',
      en: 'How concrete the indicator is. High clarity = easier to assess objectively.'
    },
    matrixClarityLow: { sv: 'Låg', en: 'Low' },
    matrixClarityMedium: { sv: 'Mellan', en: 'Medium' },
    matrixClarityHigh: { sv: 'Hög', en: 'High' },
    matrixBloomPending: { sv: 'Analys saknas', en: 'Awaiting analysis' },
    matrixWeight: { sv: 'Vikt', en: 'Weight' },
    matrixWeightHelp: {
      sv: 'Vikten påverkar hur mycket kriteriet vägs in i bedömningen.',
      en: 'Weight controls how much the criterion influences the assessment.'
    },
    matrixActions: { sv: 'Åtgärder', en: 'Actions' },
    matrixActionsHelp: { sv: 'Förbättra eller ta bort raden.', en: 'Refine or remove the row.' },
    matrixSmartFill: { sv: 'Smart Fill', en: 'Smart Fill' },
    matrixSmartFillHelp: {
      sv: 'AI fyller i det som saknas och skapar tydliga, mätbara indikatorer baserat på kriterium, uppgift och källor.',
      en: 'The AI fills in what’s missing and generates clear, measurable indicators based on the criterion, task, and sources.'
    },
    matrixConvert: { sv: 'Konvertera kriterier', en: 'Convert criteria' },
    matrixConvertHelp: { sv: 'Gamla kriterier hittades. Konvertera dem till matris.', en: 'Legacy criteria detected. Convert them to the matrix.' },
    matrixEmpty: { sv: 'Inga kriterier ännu. Lägg till första raden.', en: 'No criteria yet. Add the first row.' },
    ragInfo: {
      sv: 'Referensmaterial & Kunskapsbas\n\nHär laddar du upp de dokument som ska utgöra din AI-agents hjärna. Med RAG (Retrieval-Augmented Generation) prioriterar agenten information från dessa filer när den ger feedback.\n\nViktiga instruktioner:\n- Upphovsrätt & ansvar: Du ansvarar för att materialet följer upphovsrätt och lokala licensavtal (t.ex. Bonus Copyright Access). Ladda bara upp material du har rätt att dela i undervisningssyfte.\n- Inga personuppgifter: Dokumenten får inte innehålla känsliga personuppgifter, sekretessbelagd information eller opublicerad forskning. All text bearbetas av externa AI-modeller.\n- Format & kvalitet: Bäst är textbaserade PDF:er eller textdokument (.txt, .docx). Undvik skannade bilder utan läsbar text.\n- Pedagogiskt tips: Dela stora böcker i mindre, relevanta kapitel eller artiklar.\n\nHur det fungerar:\nNär en student skriver letar systemet upp relevanta stycken i dina filer och skickar dem som facit till AI-mentorn, vilket minskar risken för gissningar.',
      en: 'Reference Material & Knowledge Base\n\nUpload the documents that should form your AI agent\'s knowledge base. With RAG (Retrieval-Augmented Generation), the agent prioritizes information from these files when giving feedback.\n\nImportant:\n- Copyright & responsibility: You are responsible for ensuring the material complies with copyright and local licenses. Upload only content you have the right to share for teaching.\n- No personal data: Documents must not contain sensitive personal data, confidential information, or unpublished research. Text is processed by external AI models.\n- Format & quality: Best results with text-based PDFs or text documents (.txt, .docx). Avoid scanned images without readable text.\n- Teaching tip: Split large books into smaller, relevant chapters or articles.\n\nHow it works:\nWhen a student writes, the system retrieves relevant passages and sends them as evidence to the AI mentor, reducing guesswork.'
    },
    stringencyLabel: { sv: 'Bedömningens Stringens', en: 'Assessment Stringency' },
    stringencySummary: { sv: 'Stringens', en: 'Stringency' },
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
    deleteNotOwner: { sv: 'Du kan bara radera agenter som du äger.', en: 'You can only delete agents you own.' },
    studentOptions: { sv: 'Studentvy', en: 'Student View' },
    submissionPromptLabel: { sv: 'Visa inlämningsuppmaning', en: 'Show submission prompt' },
    submissionPromptHelp: { sv: 'Visas tillsammans med verifieringskoden.', en: 'Shown alongside the verification code.' },
    verificationCodeLabel: { sv: 'Visa verifieringskod', en: 'Show verification code' },
    verificationCodeHelp: { sv: 'Stäng av om du vill ha enbart formativ återkoppling.', en: 'Turn off for formative-only feedback.' },
    criteriaRequired: {
      sv: 'Lägg till minst ett kriterium i matrisen eller konvertera befintliga kriterier.',
      en: 'Add at least one matrix criterion or convert existing criteria.'
    }
  };

  const t = useCallback((key: keyof typeof translations) => translations[key][language], [language]);
  const bloomLabel = (entry: typeof BLOOM_LEVELS[number]) => language === 'sv' ? entry.sv : entry.en;
  const resolveBloomEntry = (index?: number) => BLOOM_LEVELS.find(level => level.index === index) || BLOOM_LEVELS[1];
  const getBloomDisplay = (index?: number) => {
    const entry = BLOOM_LEVELS.find(level => level.index === index);
    if (!entry) {
      return {
        label: t('matrixBloomPending'),
        badge: 'bg-slate-100 text-slate-500 border-slate-200'
      };
    }
    return {
      label: bloomLabel(entry),
      badge: entry.badge
    };
  };
  const getClarityDisplay = (value?: number, label?: CriterionMatrixItem['clarity_label']) => {
    if (label === 'OTYDLIG') return { label: t('matrixClarityLow'), color: 'text-rose-500' };
    if (label === 'MELLAN') return { label: t('matrixClarityMedium'), color: 'text-amber-500' };
    if (label === 'TYDLIG') return { label: t('matrixClarityHigh'), color: 'text-emerald-600' };
    if (!Number.isFinite(value)) {
      return { label: '—', color: 'text-slate-400' };
    }
    const score = value as number;
    if (score < 0.45) {
      return { label: t('matrixClarityLow'), color: 'text-rose-500' };
    }
    if (score < 0.7) {
      return { label: t('matrixClarityMedium'), color: 'text-amber-500' };
    }
    return { label: t('matrixClarityHigh'), color: 'text-emerald-600' };
  };
  const getMatrixText = (row: CriterionMatrixItem, field: 'name' | 'description' | 'indicator') => {
    if (language === criteriaLanguage) {
      return (row[field] || '') as string;
    }
    const translated = row.translations?.[language]?.[field];
    return (translated || row[field] || '') as string;
  };
  const buildCriterionId = () => (crypto?.randomUUID ? crypto.randomUUID() : `crit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);

  const createBlankCriterion = (): CriterionMatrixItem => {
    return {
      id: buildCriterionId(),
      name: '',
      description: '',
      indicator: '',
      indicator_status: 'needs_generation',
      bloom_level: '',
      bloom_index: 0,
      reliability_score: Number.NaN,
      weight: 1
    };
  };

  const deriveLegacyCriteria = (matrix: CriterionMatrixItem[]) =>
    matrix.map(row => row.indicator || row.description || row.name).filter(Boolean);
  const lmsMinimum = verificationPrefix ? getVerificationMinimum(verificationPrefix, passThreshold) : null;
  const lmsMaximum = verificationPrefix ? getVerificationMaximum() : null;
  const matrixCoverage = useMemo(() => {
    const levels = new Set(criteriaMatrix.map(row => row.bloom_index).filter(level => level > 0));
    return levels.size;
  }, [criteriaMatrix]);
  const matrixReliabilityAvg = useMemo(() => {
    const values = criteriaMatrix
      .map(row => row.reliability_score)
      .filter(value => Number.isFinite(value)) as number[];
    if (values.length === 0) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  }, [criteriaMatrix]);
  const matrixClaritySummary = useMemo(
    () => getClarityDisplay(matrixReliabilityAvg ?? undefined, undefined),
    [matrixReliabilityAvg, language]
  );
  const canOpenMatrix = newDesc.trim().length > 0;

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
      },
    ]
  };

  const adminApiManual = {
    title: {
      sv: 'Superadmin: API‑administration',
      en: 'Super admin: API administration'
    },
    intro: {
      sv: 'Detta styr globala modellval för hela systemet. Alla agenter påverkas.',
      en: 'This controls global model selection for the entire system. All agents are affected.'
    },
    steps: {
      sv: [
        '1) Skapa API‑nyckeln i Firebase Secret Manager. Namnet måste matcha fältet “Secret‑namn” exakt (t.ex. MISTRAL_API_KEY).',
        '2) Lägg till/uppdatera provider‑dokumentet i Firestore (collection: modelProviders/{id}). Fält som krävs: label, type (native-google/openai-compatible), baseUrl, secretName, enabled, capabilities.',
        '3) Lägg in domänen i Allowlist (t.ex. api.mistral.ai). Utan detta blockas anropet.',
        '4) Synka modeller via “Synka modeller”. Om /models saknas: lägg in modell‑ID manuellt.',
        '5) Välj routing: provider + modell för varje funktion samt embeddings. Sätt Safe Model som fallback.',
        '6) Ange pris per 1M tokens (input/output) för kostnadsuppföljning.',
        '7) Klicka “Spara modellval”.',
        'Fältförklaring:',
        'Base URL: API‑adress till leverantören (måste vara https).',
        'Kapabiliteter: Chat = /chat/completions, Embeddings = /embeddings, JSON‑läge = response_format: json_object.',
        'Secret‑namn: namnet på API‑nyckeln i Firebase Secret Manager.',
        'Region: används bara för Google/Vertex embeddings (t.ex. europe‑west4).',
        'Filter (regex): filtrerar synkade modeller (ex. ^gpt-4).',
        'Manuella modeller: används om /models saknas eller är fel.',
        'Lägg till modell‑ID: skriv ID och klicka +.',
        'Synka modeller: hämtar lista från /models och uppdaterar rullistor.'
      ],
      en: [
        '1) Create the API key in Firebase Secret Manager. The name must match “Secret name” exactly (e.g. MISTRAL_API_KEY).',
        '2) Add/update the provider document in Firestore (collection: modelProviders/{id}). Required fields: label, type (native-google/openai-compatible), baseUrl, secretName, enabled, capabilities.',
        '3) Add the domain to the allowlist (e.g. api.mistral.ai). Requests are blocked otherwise.',
        '4) Sync models using “Sync models”. If /models is missing: add the model ID manually.',
        '5) Set routing: provider + model per task and for embeddings. Set a Safe Model fallback.',
        '6) Enter price per 1M tokens (input/output) for cost tracking.',
        '7) Click “Save model routing”.',
        'Field definitions:',
        'Base URL: API address for the provider (must be https).',
        'Capabilities: Chat = /chat/completions, Embeddings = /embeddings, JSON mode = response_format: json_object.',
        'Secret name: name of the API key in Firebase Secret Manager.',
        'Region: only for Google/Vertex embeddings (e.g. europe-west4).',
        'Filter (regex): filters synced models (e.g. ^gpt-4).',
        'Manual models: use when /models is missing or incorrect.',
        'Add model ID: type the ID and click +.',
        'Sync models: fetches the /models list and refreshes dropdowns.'
      ]
    }
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

  const refreshModelConfig = useCallback(async () => {
    if (!isAdmin) return;
    setModelAdminError(null);
    setModelAdminBusy(true);
    try {
      const data = await getAdminModelConfig();
      setModelProviders(data.providers || []);
      setModelRouting(data.routing || null);
      setProviderAllowlist(data.allowlist || []);
    } catch (err: any) {
      setModelAdminError(err?.message || t('modelLoadError'));
    } finally {
      setModelAdminBusy(false);
    }
  }, [isAdmin, t]);

  useEffect(() => {
    if (!showAdminPanel) {
      modelConfigLoadedRef.current = false;
    }
  }, [showAdminPanel]);

  useEffect(() => {
    if (!isAdmin || !showAdminPanel) return;
    if (modelConfigLoadedRef.current) return;
    modelConfigLoadedRef.current = true;
    void refreshModelConfig();
  }, [isAdmin, showAdminPanel, refreshModelConfig]);

  const handleProviderUpdate = async (providerId: string, updates: Partial<ModelProvider>) => {
    setModelAdminError(null);
    setModelAdminBusy(true);
    try {
      const { provider } = await updateModelProvider(providerId, updates);
      setModelProviders(prev => prev.map(item => (item.id === provider.id ? provider : item)));
    } catch (err: any) {
      setModelAdminError(err?.message || t('modelSaveError'));
    } finally {
      setModelAdminBusy(false);
    }
  };

  const handleProviderSync = async (providerId: string) => {
    setModelAdminError(null);
    setModelAdminBusy(true);
    try {
      const { provider } = await syncModelProvider(providerId);
      setModelProviders(prev => prev.map(item => (item.id === provider.id ? provider : item)));
    } catch (err: any) {
      setModelAdminError(err?.message || t('modelSaveError'));
    } finally {
      setModelAdminBusy(false);
    }
  };

  const handleManualModelAdd = (providerId: string) => {
    const value = (providerManualInput[providerId] || '').trim();
    if (!value) return;
    const provider = modelProviders.find(item => item.id === providerId);
    const manual = Array.isArray(provider?.manualModelIds) ? provider?.manualModelIds : [];
    const nextManual = manual.includes(value) ? manual : [...manual, value];
    setModelProviders(prev => prev.map(item => (item.id === providerId ? { ...item, manualModelIds: nextManual } : item)));
    setProviderManualInput(prev => ({ ...prev, [providerId]: '' }));
    void handleProviderUpdate(providerId, { manualModelIds: nextManual });
  };

  const handleManualModelRemove = (providerId: string, modelId: string) => {
    const provider = modelProviders.find(item => item.id === providerId);
    const manual = Array.isArray(provider?.manualModelIds) ? provider?.manualModelIds : [];
    const nextManual = manual.filter(id => id !== modelId);
    setModelProviders(prev => prev.map(item => (item.id === providerId ? { ...item, manualModelIds: nextManual } : item)));
    void handleProviderUpdate(providerId, { manualModelIds: nextManual });
  };

  const handleRoutingChange = (taskId: string, field: keyof ModelTaskConfig, value: string) => {
    setModelAdminSaved(false);
    setModelRouting(prev => {
      if (!prev) return prev;
      const nextTasks = { ...prev.tasks };
      const existing = nextTasks[taskId] || { providerId: '', model: '' };
      nextTasks[taskId] = { ...existing, [field]: value };
      return { ...prev, tasks: nextTasks };
    });
  };

  const handleEmbeddingChange = (field: keyof ModelTaskConfig, value: string) => {
    setModelAdminSaved(false);
    setModelRouting(prev => {
      if (!prev) return prev;
      return { ...prev, embeddings: { ...prev.embeddings, [field]: value } };
    });
  };

  const handleSafeAssessmentChange = (field: keyof ModelTaskConfig, value: string) => {
    setModelAdminSaved(false);
    setModelRouting(prev => {
      if (!prev) return prev;
      return { ...prev, safeAssessment: { ...prev.safeAssessment, [field]: value } };
    });
  };

  const handleCurrencyChange = (value: string) => {
    setModelAdminSaved(false);
    setModelRouting(prev => {
      if (!prev) return prev;
      return { ...prev, pricingCurrency: value };
    });
  };

  const handleSaveRouting = async () => {
    if (!modelRouting) return;
    setModelAdminError(null);
    setModelAdminBusy(true);
    try {
      const { routing } = await updateAdminModelConfig(modelRouting, providerAllowlist);
      setModelRouting(routing);
      setModelAdminSaved(true);
      setTimeout(() => setModelAdminSaved(false), 1500);
    } catch (err: any) {
      setModelAdminError(err?.message || t('modelSaveError'));
    } finally {
      setModelAdminBusy(false);
    }
  };

  const getTaskProviders = (taskId: string) =>
    modelProviders.filter(provider => {
      if (!provider.enabled) return false;
      if (taskId === 'embeddings') {
        return Boolean(provider.capabilities?.embeddings);
      }
      return Boolean(provider.capabilities?.chat);
    });

  const getProviderModels = (providerId: string) => {
    const provider = modelProviders.find(item => item.id === providerId);
    if (!provider) return [];
    const manual = Array.isArray(provider.manualModelIds)
      ? provider.manualModelIds.map(id => ({ id, label: id }))
      : [];
    const synced = Array.isArray(provider.syncedModels) ? provider.syncedModels : [];
    const combined = [...manual, ...synced];
    const seen = new Set<string>();
    return combined.filter(model => {
      if (!model?.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  };

  const formatTimestamp = (value: any) => {
    if (!value) return '';
    if (typeof value === 'number') return new Date(value).toLocaleString();
    if (typeof value?.toMillis === 'function') return new Date(value.toMillis()).toLocaleString();
    if (typeof value?.seconds === 'number') return new Date(value.seconds * 1000).toLocaleString();
    return '';
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
    setCriteriaMatrix([]);
    setCriteriaLanguage(language);
    setLegacyCriteria([]);
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
      criteria_matrix: criteriaMatrix,
      criteria: deriveLegacyCriteria(criteriaMatrix),
      criteriaLanguage,
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

  const persistCriteriaMatrix = async (updatedMatrix: CriterionMatrixItem[]) => {
    const agentId = await ensureDraftAgent();
    if (!agentId) return;
    const legacyCriteria = deriveLegacyCriteria(updatedMatrix);
    await updateDoc(doc(db, 'agents', agentId), {
      criteria_matrix: updatedMatrix,
      criteria: legacyCriteria,
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
      try {
        await deleteObject(ref(storage, material.gcsPath));
      } catch (error: any) {
        if (error?.code !== 'storage/object-not-found') {
          throw error;
        }
      }
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

  const scheduleMatrixSave = (updatedMatrix: CriterionMatrixItem[]) => {
    setCriteriaMatrix(updatedMatrix);
    setFormError(null);
    if (matrixSaveTimeout.current) {
      window.clearTimeout(matrixSaveTimeout.current);
    }
    matrixSaveTimeout.current = window.setTimeout(() => {
      void persistCriteriaMatrix(updatedMatrix);
    }, 2000);
  };

  const handleRefreshMatrix = async () => {
    if (!editingAgentId || isRefreshingMatrix) return;
    setIsRefreshingMatrix(true);
    let nextMatrix = [...criteriaMatrix];
    for (const row of criteriaMatrix) {
      const hasContent = [row.name, row.description, row.indicator].some(value =>
        typeof value === 'string' && value.trim()
      );
      if (!hasContent) continue;
      try {
        const res = await analyzeCriterion({
          agentId: editingAgentId,
          name: row.name,
          description: row.description,
          indicator: row.indicator,
          bloom_level: row.bloom_level,
          bloom_index: row.bloom_index,
          weight: row.weight,
          taskDescription: newDesc
        });
        nextMatrix = nextMatrix.map(item =>
          item.id === row.id
            ? {
                ...item,
                ...res
              }
            : item
        );
        scheduleMatrixSave(nextMatrix);
      } catch {
        // Ignore per-row errors to keep batch moving.
      }
    }
    setIsRefreshingMatrix(false);
  };

  const handleCloseMatrixEditor = async () => {
    setShowMatrixEditor(false);
    if (matrixSaveTimeout.current) {
      window.clearTimeout(matrixSaveTimeout.current);
      matrixSaveTimeout.current = null;
    }
    if (criteriaMatrix.length > 0) {
      persistCriteriaMatrix(criteriaMatrix).catch(() => {
        setFormError(language === 'sv' ? 'Kunde inte spara matrisen.' : 'Failed to save the matrix.');
      });
    }
  };

  const handleAddMatrixRow = () => {
    const updated = [...criteriaMatrix, createBlankCriterion()];
    scheduleMatrixSave(updated);
  };

  const handleRemoveMatrixRow = (id: string) => {
    const updated = criteriaMatrix.filter(row => row.id !== id);
    scheduleMatrixSave(updated);
  };

  const handleMatrixFieldChange = (id: string, field: keyof CriterionMatrixItem, value: string | number) => {
    const updated = criteriaMatrix.map(row => {
      if (row.id !== id) return row;
      const isTextField = field === 'name' || field === 'description' || field === 'indicator';
      if (isTextField && language !== criteriaLanguage) {
        const langKey = language;
        const prevTranslations = row.translations || {};
        const nextLang = { ...(prevTranslations[langKey] || {}) };
        if (field === 'name' || field === 'description' || field === 'indicator') {
          nextLang[field] = String(value);
        }
        return {
          ...row,
          translations: {
            ...prevTranslations,
            [langKey]: nextLang
          }
        };
      }
      const nextRow = { ...row, [field]: value } as CriterionMatrixItem;
      if (isTextField) {
        nextRow.bloom_index = 0;
        nextRow.bloom_level = '';
        nextRow.reliability_score = Number.NaN;
        nextRow.clarity_label = undefined;
        nextRow.clarity_debug = undefined;
        nextRow.indicator_status = 'needs_generation';
        nextRow.indicator_actor = undefined;
        nextRow.indicator_verb = undefined;
        nextRow.indicator_object = undefined;
        nextRow.indicator_artifact = undefined;
        nextRow.indicator_evidence_min = undefined;
        nextRow.indicator_quality = undefined;
        nextRow.indicator_source_trace = undefined;
      }
      return nextRow;
    });
    scheduleMatrixSave(updated);
  };

  const handleChangeBloom = (id: string, index: number) => {
    const entry = resolveBloomEntry(index);
    const updated = criteriaMatrix.map(row => row.id === id ? { ...row, bloom_index: entry.index, bloom_level: entry.sv } : row);
    scheduleMatrixSave(updated);
  };

  const handleSmartFillRow = async (id: string) => {
    const row = criteriaMatrix.find(item => item.id === id);
    if (!row || isImproving) return;
    setIsImproving(true);
    try {
      const agentId = await ensureDraftAgent();
      if (!agentId) return;
      const res = await analyzeCriterion({
        agentId,
        name: row.name,
        description: row.description,
        indicator: row.indicator,
        bloom_level: row.bloom_level,
        bloom_index: row.bloom_index,
        weight: row.weight,
        taskDescription: newDesc
      });
      const updated = criteriaMatrix.map(item => item.id === id ? { ...item, ...res } : item);
      scheduleMatrixSave(updated);
    } catch (e: any) {
      alert(e.message || (language === 'sv' ? 'Kunde inte fylla i kriteriet.' : 'Could not fill criterion.'));
    } finally {
      setIsImproving(false);
    }
  };

  useEffect(() => {
    if (!showMatrixEditor) return;
    if (language === criteriaLanguage) return;
    if (criteriaMatrix.length === 0) return;
    if (matrixTranslateInFlight.current) return;

    const missingRows = criteriaMatrix.filter(row => {
      if (!row.name?.trim() || !row.description?.trim()) return false;
      const translation = row.translations?.[language];
      return !translation?.name || !translation?.description || !translation?.indicator;
    });
    if (missingRows.length === 0) return;

    matrixTranslateInFlight.current = true;
    const translateRows = async () => {
      let updated = [...criteriaMatrix];
      for (const row of missingRows) {
        try {
          const res = await translateContent(row.name, row.description, language, row.indicator);
          updated = updated.map(item => {
            if (item.id !== row.id) return item;
            const prevTranslations = item.translations || {};
            return {
              ...item,
              translations: {
                ...prevTranslations,
                [language]: {
                  name: res.name,
                  description: res.description,
                  indicator: res.indicator ?? item.indicator
                }
              }
            };
          });
        } catch {
          // Ignore per-row translation failures.
        }
      }
      setCriteriaMatrix(updated);
      scheduleMatrixSave(updated);
      matrixTranslateInFlight.current = false;
    };

    void translateRows();
  }, [criteriaMatrix, criteriaLanguage, language, showMatrixEditor]);

  const handleConvertLegacy = async () => {
    if (legacyCriteria.length === 0) return;
    setIsImproving(true);
    try {
      const agentId = await ensureDraftAgent();
      if (!agentId) return;
      const converted: CriterionMatrixItem[] = [];
      for (const label of legacyCriteria) {
        const base = { ...createBlankCriterion(), name: label };
        try {
          const res = await analyzeCriterion({
            agentId,
            name: base.name,
            description: base.description,
            indicator: base.indicator,
            bloom_level: base.bloom_level,
            bloom_index: base.bloom_index,
            weight: base.weight,
            taskDescription: newDesc
          });
          converted.push({ ...base, ...res });
        } catch {
          converted.push(base);
        }
      }
      await persistCriteriaMatrix(converted);
      setCriteriaMatrix(converted);
      setLegacyCriteria([]);
    } finally {
      setIsImproving(false);
    }
  };

  const openEditModal = (agent: Agent) => {
    setEditingAgentId(agent.id);
    setDraftCreatedId(null);
    setNewName(agent.name);
    setNewDesc(agent.description);
    setCriteriaLanguage(agent.criteriaLanguage || 'sv');
    const loadedMatrix = Array.isArray(agent.criteria_matrix) ? agent.criteria_matrix : [];
    const normalizedMatrix = loadedMatrix.map(row => {
      if (row.indicator_status) return row;
      return {
        ...row,
        indicator_status: 'needs_generation',
        reliability_score: Number.NaN,
        clarity_label: undefined,
        clarity_debug: undefined
      };
    });
    setCriteriaMatrix(normalizedMatrix);
    setLegacyCriteria(Array.isArray(agent.criteria) ? agent.criteria : []);
    setMinWords(agent.wordCountLimit.min);
    setMaxWords(agent.wordCountLimit.max);
    setPassThreshold(agent.passThreshold || 80000);
    setVerificationPrefix(resolveVerificationPrefix(agent.id, agent.verificationPrefix));
    setStringency(agent.stringency || 'standard');
    setShowSubmissionPrompt(agent.showSubmissionPrompt ?? true);
    setShowVerificationCode(agent.showVerificationCode ?? true);
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

  const saveAgent = async (closeAfterSave: boolean) => {
    setFormError(null);
    if (!newName || !newDesc || criteriaMatrix.length === 0) {
      if (criteriaMatrix.length === 0) {
        setFormError(t('criteriaRequired'));
      }
      return null;
    }
    const missingIndicators = criteriaMatrix.some(row => row.indicator_status !== 'ok');
    if (missingIndicators) {
      setFormError(t('matrixIndicatorsMissing'));
      return null;
    }
    const normalizedCode = normalizeAccessCode(accessCode);
    if (!normalizedCode) {
      setAccessCodeError(t('accessCodeRequired'));
      return null;
    }
    const agentId = editingAgentId || `agent-${Date.now()}`;
    const resolvedPrefix = resolveVerificationPrefix(agentId, verificationPrefix);
    const agentData: Agent = {
      id: agentId,
      name: newName,
      description: newDesc,
      criteria_matrix: criteriaMatrix,
      criteria: deriveLegacyCriteria(criteriaMatrix),
      criteriaLanguage,
      wordCountLimit: { min: minWords, max: maxWords },
      passThreshold,
      verificationPrefix: resolvedPrefix,
      stringency,
      showSubmissionPrompt,
      showVerificationCode,
      ownerEmail: currentUserEmail, ownerUid: currentUserUid, sharedWithEmails: [], sharedWithUids: [], visibleTo: [currentUserUid], isPublic: true, isDraft: false
    };
    if (editingAgentId) {
      await onUpdateAgent(agentData);
    } else {
      await onCreateAgent(agentData);
      setEditingAgentId(agentData.id);
    }
    await upsertAccessCode(agentData.id, normalizedCode);
    setDraftCreatedId(null);
    if (closeAfterSave) {
      setIsModalOpen(false);
    }
    return agentData.id;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveAgent(true);
  };

  const handlePreviewStudent = async () => {
    const agentId = await saveAgent(false);
    if (!agentId) return;
    window.open(generateStudentUrl(agentId), '_blank', 'noopener,noreferrer');
  };

  const handleOpenSupport = () => {
    setShowSupport(true);
    setSupportError(null);
    if (supportMessages.length === 0) {
      setSupportMessages([{ role: 'assistant', content: t('supportIntro') }]);
    }
  };

  const handleSendSupport = async () => {
    const question = supportInput.trim();
    if (!question || supportBusy) return;
    setSupportInput('');
    setSupportError(null);
    setSupportBusy(true);
    setSupportMessages(prev => [...prev, { role: 'user', content: question }]);
    try {
      const res = await askSupport(question, language);
      setSupportMessages(prev => [...prev, { role: 'assistant', content: res.answer }]);
    } catch {
      setSupportError(t('supportError'));
    } finally {
      setSupportBusy(false);
    }
  };

  const cleanupAgent = async (agentId: string) => {
    const errors: string[] = [];
    try {
      await deleteDoc(doc(db, 'agentAccess', agentId));
    } catch (error: any) {
      errors.push(error?.message || 'access');
    }
    try {
      await deleteDoc(doc(db, 'agents', agentId));
    } catch (error: any) {
      const message = error?.message || 'agent';
      throw new Error(message);
    }
    return errors;
  };

  const handleCloseModal = async () => {
    if (matrixSaveTimeout.current) {
      window.clearTimeout(matrixSaveTimeout.current);
      matrixSaveTimeout.current = null;
    }
    if (draftCreatedId && editingAgentId === draftCreatedId) {
      await cleanupAgent(draftCreatedId);
      setDraftCreatedId(null);
      setEditingAgentId(null);
      setReferenceMaterials([]);
    }
    setShowMatrixEditor(false);
    setIsModalOpen(false);
  };

  const handleDeleteAgent = (agent: Agent, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (agent.ownerUid && agent.ownerUid !== currentUserUid) {
      setDeleteError(t('deleteNotOwner'));
      return;
    }
    if (!window.confirm(t('deleteConfirm'))) return;
    setDeleteError(null);
    setDeletingAgentId(agent.id);
    setRemovingAgentIds(prev => ({ ...prev, [agent.id]: true }));
    if (removalTimers.current[agent.id]) {
      window.clearTimeout(removalTimers.current[agent.id]);
    }
    removalTimers.current[agent.id] = window.setTimeout(() => {
      setHiddenAgentIds(prev => ({ ...prev, [agent.id]: true }));
    }, 320);
    if (activeInsightsId === agent.id) {
      setActiveInsightsId(null);
    }
    if (editingAgentId === agent.id) {
      setIsModalOpen(false);
      setEditingAgentId(null);
      setDraftCreatedId(null);
      setReferenceMaterials([]);
    }
    const performDelete = async () => {
      try {
        const errors = await cleanupAgent(agent.id);
        if (errors.length > 0) {
          setDeleteError(language === 'sv'
            ? 'Agenten togs bort men viss bakgrundsstädning misslyckades.'
            : 'Agent deleted, but some background cleanup failed.'
          );
        }
      } catch (error: any) {
        if (removalTimers.current[agent.id]) {
          window.clearTimeout(removalTimers.current[agent.id]);
          delete removalTimers.current[agent.id];
        }
        setHiddenAgentIds(prev => {
          const next = { ...prev };
          delete next[agent.id];
          return next;
        });
        setRemovingAgentIds(prev => {
          const next = { ...prev };
          delete next[agent.id];
          return next;
        });
        setDeleteError(error?.message || (language === 'sv' ? 'Kunde inte radera agent.' : 'Failed to delete agent.'));
      } finally {
        setDeletingAgentId(null);
      }
    };
    void performDelete();
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
    const ownedAgents = agents.filter(agent => agent.ownerUid === currentUserUid);
    const unsubscribers = ownedAgents.map(agent =>
      onSnapshot(doc(db, 'agentAccess', agent.id), (snap) => {
        const code = snap.exists() ? snap.data()?.code : '';
        setAccessCodes(prev => ({ ...prev, [agent.id]: typeof code === 'string' ? code : '' }));
      })
    );
    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [agents, currentUserUid]);

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
          <EduTooltip text={t('supportTooltip')}>
            <button
              type="button"
              onClick={handleOpenSupport}
              className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-indigo-600 transition-all flex items-center justify-center"
              aria-label={t('supportTooltip')}
            >
              <i className="fas fa-comments text-lg"></i>
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

          <div className="pt-10 border-t border-slate-100 space-y-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-black text-slate-900 tracking-tight">{t('modelAdminTitle')}</h3>
                  <EduTooltip text={t('modelAdminTooltip')}>
                    <span className="w-7 h-7 rounded-full border border-slate-200 text-slate-500 flex items-center justify-center text-[10px] font-black uppercase tracking-widest bg-white">
                      i
                    </span>
                  </EduTooltip>
                </div>
                <p className="text-slate-500 text-sm font-medium">{t('modelAdminSubtitle')}</p>
              </div>
              <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600 bg-emerald-50 border border-emerald-100 px-3 py-1 rounded-full">
                {t('modelAdminBadge')}
              </span>
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-black text-slate-900">{t('modelProvidersTitle')}</h4>
                <p className="text-xs text-slate-500 font-medium">{t('modelProvidersHelp')}</p>
              </div>
              <div className="bg-slate-50/80 border border-slate-100 rounded-2xl p-5 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg">
                    <i className="fas fa-cog text-sm"></i>
                  </div>
                  <div>
                    <h5 className="text-sm font-black text-slate-900">{adminApiManual.title[language]}</h5>
                    <p className="text-xs text-slate-500 font-medium">{adminApiManual.intro[language]}</p>
                  </div>
                </div>
                <div className="grid gap-2 text-xs text-slate-600 font-medium leading-relaxed">
                  {adminApiManual.steps[language].map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {modelProviders.map(provider => {
                  const syncedAt = formatTimestamp(provider.lastSyncedAt);
                  return (
                  <div key={provider.id} className="bg-slate-50/80 border border-slate-100 rounded-2xl p-4 space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-black text-slate-900">{provider.label}</div>
                        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">{provider.type}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleProviderUpdate(provider.id, { enabled: !provider.enabled })}
                        disabled={modelAdminBusy}
                        className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border ${
                          provider.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-slate-100 text-slate-500 border-slate-200'
                        }`}
                      >
                        {provider.enabled ? t('modelProviderEnabled') : t('promoInactive')}
                      </button>
                    </div>

                    {provider.type === 'openai-compatible' && (
                      <div className="space-y-2">
                        <AdminFieldLabel label={t('modelProviderBaseUrl')} help={t('modelProviderBaseUrlHelp')} />
                        <input
                          type="text"
                          value={provider.baseUrl || ''}
                          onChange={(e) => {
                            const value = e.target.value;
                            setModelProviders(prev => prev.map(item => (item.id === provider.id ? { ...item, baseUrl: value } : item)));
                          }}
                          onBlur={(e) => handleProviderUpdate(provider.id, { baseUrl: e.target.value })}
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <AdminFieldLabel label={t('modelProviderCapabilities')} help={t('modelProviderCapabilitiesHelp')} />
                      <div className="flex flex-wrap gap-2">
                        {(['chat', 'embeddings', 'jsonMode'] as const).map(cap => (
                          <EduTooltip
                            key={cap}
                            text={
                              cap === 'chat'
                                ? t('modelProviderChatHelp')
                                : cap === 'embeddings'
                                  ? t('modelProviderEmbeddingsHelp')
                                  : t('modelProviderJsonHelp')
                            }
                          >
                            <button
                              type="button"
                              onClick={() => {
                                const next = {
                                  ...(provider.capabilities || {}),
                                  [cap]: !provider.capabilities?.[cap]
                                };
                                setModelProviders(prev => prev.map(item => (item.id === provider.id ? { ...item, capabilities: next } : item)));
                                void handleProviderUpdate(provider.id, { capabilities: next });
                              }}
                              className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border ${
                                provider.capabilities?.[cap]
                                  ? 'bg-indigo-50 text-indigo-700 border-indigo-100'
                                  : 'bg-slate-100 text-slate-500 border-slate-200'
                              }`}
                            >
                              {cap === 'chat' ? t('modelProviderChat') : cap === 'embeddings' ? t('modelProviderEmbeddings') : t('modelProviderJson')}
                            </button>
                          </EduTooltip>
                        ))}
                      </div>
                    </div>

                    {provider.secretName !== undefined && (
                      <div className="space-y-2">
                        <AdminFieldLabel label={t('modelProviderSecret')} help={t('modelProviderSecretHelp')} />
                        <input
                          type="text"
                          value={provider.secretName || ''}
                          onChange={(e) => {
                            const value = e.target.value;
                            setModelProviders(prev => prev.map(item => (item.id === provider.id ? { ...item, secretName: value } : item)));
                          }}
                          onBlur={(e) => handleProviderUpdate(provider.id, { secretName: e.target.value })}
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                        />
                      </div>
                    )}

                    {(provider.location !== undefined || provider.capabilities?.embeddings) && (
                      <div className="space-y-2">
                        <AdminFieldLabel label={t('modelProviderLocation')} help={t('modelProviderLocationHelp')} />
                        <input
                          type="text"
                          value={provider.location || ''}
                          onChange={(e) => {
                            const value = e.target.value;
                            setModelProviders(prev => prev.map(item => (item.id === provider.id ? { ...item, location: value } : item)));
                          }}
                          onBlur={(e) => handleProviderUpdate(provider.id, { location: e.target.value })}
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <AdminFieldLabel label={t('modelProviderFilter')} help={t('modelProviderFilterHelp')} />
                      <input
                        type="text"
                        value={provider.filterRegex || ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          setModelProviders(prev => prev.map(item => (item.id === provider.id ? { ...item, filterRegex: value } : item)));
                        }}
                        onBlur={(e) => handleProviderUpdate(provider.id, { filterRegex: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                      />
                    </div>

                    <div className="space-y-2">
                      <AdminFieldLabel label={t('modelProviderManual')} help={t('modelProviderManualHelp')} />
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{t('modelProviderManualAdd')}</span>
                        <EduTooltip text={t('modelProviderManualAddHelp')}>
                          <span className="w-5 h-5 rounded-full border border-slate-200 text-slate-500 flex items-center justify-center text-[9px] font-black uppercase tracking-widest bg-white">
                            i
                          </span>
                        </EduTooltip>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={providerManualInput[provider.id] || ''}
                          onChange={(e) => setProviderManualInput(prev => ({ ...prev, [provider.id]: e.target.value }))}
                          placeholder={t('modelProviderManualAdd')}
                          className="flex-1 px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                        />
                        <EduTooltip text={t('modelProviderManualAddHelp')}>
                          <button
                            type="button"
                            onClick={() => handleManualModelAdd(provider.id)}
                            className="px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest bg-indigo-600 text-white"
                          >
                            +
                          </button>
                        </EduTooltip>
                      </div>
                      {Array.isArray(provider.manualModelIds) && provider.manualModelIds.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {provider.manualModelIds.map(modelId => (
                            <span key={modelId} className="text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full bg-white border border-slate-200 text-slate-600 flex items-center gap-2">
                              {modelId}
                              <button
                                type="button"
                                onClick={() => handleManualModelRemove(provider.id, modelId)}
                                className="text-slate-400 hover:text-red-500"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between">
                      <EduTooltip text={t('modelProviderSyncHelp')}>
                        <button
                          type="button"
                          onClick={() => handleProviderSync(provider.id)}
                          disabled={modelAdminBusy}
                          className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800"
                        >
                          {t('modelProviderSync')}
                        </button>
                      </EduTooltip>
                      {syncedAt && (
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                          {t('modelProviderSynced')}: {syncedAt}
                        </span>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-black text-slate-900">{t('modelAllowlistTitle')}</h4>
                <p className="text-xs text-slate-500 font-medium">{t('modelAllowlistHelp')}</p>
              </div>
              <textarea
                rows={3}
                value={providerAllowlist.join('\n')}
                onChange={(e) => setProviderAllowlist(e.target.value.split('\n').map(line => line.trim()).filter(Boolean))}
                placeholder={t('modelAllowlistPlaceholder')}
                className="w-full px-4 py-3 rounded-2xl border border-slate-200 bg-slate-50 text-xs font-semibold"
              />
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-black text-slate-900">{t('modelCurrencyLabel')}</h4>
              </div>
              <input
                type="text"
                value={modelRouting?.pricingCurrency || ''}
                onChange={(e) => handleCurrencyChange(e.target.value)}
                placeholder={t('modelCurrencyPlaceholder')}
                className="w-full max-w-[160px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold"
              />
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-black text-slate-900">{t('modelRoutingTitle')}</h4>
                <p className="text-xs text-slate-500 font-medium">{t('modelRoutingHelp')}</p>
              </div>
              <div className="space-y-3">
                <div className="hidden lg:grid grid-cols-[220px_1fr_1fr_140px_140px] gap-3 px-4 text-[10px] font-black uppercase tracking-widest text-slate-400">
                  <span>{t('modelTaskLabel')}</span>
                  <span>{t('modelProviderLabel')}</span>
                  <span>{t('modelModelLabel')}</span>
                  <span>{t('modelPriceInputLabel')}</span>
                  <span>{t('modelPriceOutputLabel')}</span>
                </div>
                {MODEL_TASKS.map(task => {
                  const taskConfig = modelRouting?.tasks?.[task.id] || { providerId: '', model: '', priceInput1M: '', priceOutput1M: '' };
                  const providers = getTaskProviders(task.id);
                  const models = getProviderModels(taskConfig.providerId);
                  return (
                    <div key={task.id} className="grid grid-cols-1 lg:grid-cols-[220px_1fr_1fr_140px_140px] gap-3 items-center bg-slate-50/70 border border-slate-100 rounded-2xl px-4 py-3">
                      <div className="text-xs font-black text-slate-700">{t(task.labelKey as any)}</div>
                      <select
                        value={taskConfig.providerId || ''}
                        onChange={(e) => handleRoutingChange(task.id, 'providerId', e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                      >
                        <option value="">{t('modelSelectProvider')}</option>
                        {providers.map(provider => (
                          <option key={provider.id} value={provider.id}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={taskConfig.model || ''}
                        onChange={(e) => handleRoutingChange(task.id, 'model', e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                      >
                        <option value="">{t('modelSelectModel')}</option>
                        {models.map(model => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={taskConfig.priceInput1M || ''}
                        onChange={(e) => handleRoutingChange(task.id, 'priceInput1M', e.target.value)}
                        placeholder={t('modelPricePlaceholder')}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                      />
                      <input
                        type="text"
                        value={taskConfig.priceOutput1M || ''}
                        onChange={(e) => handleRoutingChange(task.id, 'priceOutput1M', e.target.value)}
                        placeholder={t('modelPricePlaceholder')}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                      />
                    </div>
                  );
                })}

                <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_1fr_140px_140px] gap-3 items-center bg-slate-50/70 border border-slate-100 rounded-2xl px-4 py-3">
                  <div className="text-xs font-black text-slate-700">{t('modelTaskEmbeddings')}</div>
                  <select
                    value={modelRouting?.embeddings?.providerId || ''}
                    onChange={(e) => handleEmbeddingChange('providerId', e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  >
                    {getTaskProviders('embeddings').map(provider => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={modelRouting?.embeddings?.model || ''}
                    onChange={(e) => handleEmbeddingChange('model', e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  >
                    {getProviderModels(modelRouting?.embeddings?.providerId || '').map(model => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={modelRouting?.embeddings?.priceInput1M || ''}
                    onChange={(e) => handleEmbeddingChange('priceInput1M', e.target.value)}
                    placeholder={t('modelPricePlaceholder')}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  />
                  <input
                    type="text"
                    value={modelRouting?.embeddings?.priceOutput1M || ''}
                    onChange={(e) => handleEmbeddingChange('priceOutput1M', e.target.value)}
                    placeholder={t('modelPricePlaceholder')}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_1fr_140px_140px] gap-3 items-center bg-slate-50/70 border border-slate-100 rounded-2xl px-4 py-3">
                  <div className="text-xs font-black text-slate-700">{t('modelSafeLabel')}</div>
                  <select
                    value={modelRouting?.safeAssessment?.providerId || ''}
                    onChange={(e) => handleSafeAssessmentChange('providerId', e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  >
                    <option value="">{t('modelSelectProvider')}</option>
                    {getTaskProviders('assessment').map(provider => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={modelRouting?.safeAssessment?.model || ''}
                    onChange={(e) => handleSafeAssessmentChange('model', e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  >
                    <option value="">{t('modelSelectModel')}</option>
                    {getProviderModels(modelRouting?.safeAssessment?.providerId || '').map(model => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={modelRouting?.safeAssessment?.priceInput1M || ''}
                    onChange={(e) => handleSafeAssessmentChange('priceInput1M', e.target.value)}
                    placeholder={t('modelPricePlaceholder')}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  />
                  <input
                    type="text"
                    value={modelRouting?.safeAssessment?.priceOutput1M || ''}
                    onChange={(e) => handleSafeAssessmentChange('priceOutput1M', e.target.value)}
                    placeholder={t('modelPricePlaceholder')}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSaveRouting}
                  disabled={modelAdminBusy || !modelRouting}
                  className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-white ${
                    modelAdminBusy ? 'bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'
                  }`}
                >
                  {t('modelSaveRouting')}
                </button>
                {modelAdminSaved && (
                  <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600">{t('modelSaved')}</span>
                )}
              </div>
            </div>

            {modelAdminError && (
              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">{modelAdminError}</p>
            )}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
        {agents.filter(agent => !hiddenAgentIds[agent.id]).map(agent => {
          const isRemoving = Boolean(removingAgentIds[agent.id]);
          return (
          <div
            key={agent.id}
            className={`bg-white rounded-[3rem] border border-slate-100 shadow-sm hover:shadow-2xl transition-all duration-300 ease-out flex flex-col group overflow-hidden ${
              isRemoving ? 'opacity-0 scale-[0.98] translate-y-2 blur-[1px]' : 'opacity-100'
            }`}
          >
            <div className="p-10 flex-1 space-y-4 cursor-pointer" onClick={() => openEditModal(agent)}>
              <div className="flex justify-between items-start">
                <h3 className="text-xl font-black text-slate-900 group-hover:text-indigo-600 truncate uppercase tracking-tight w-2/3">{agent.name}</h3>
                <span className={`text-[8px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${agent.stringency === 'strict' ? 'bg-red-50 text-red-600 border-red-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>{agent.stringency}</span>
              </div>
              <p className="text-[13px] text-slate-500 line-clamp-2 leading-relaxed">{agent.description}</p>
              <div className="flex gap-2">
                <span className="text-[8px] font-black uppercase tracking-widest px-3 py-1 bg-slate-50 border border-slate-100 rounded-full text-slate-400">
                  {(agent.criteria_matrix?.length || agent.criteria?.length || 0)} Kriterier
                </span>
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
                 <button
                   onClick={(e) => handleDeleteAgent(agent, e)}
                   className={`transition-colors ${deletingAgentId === agent.id ? 'text-slate-300' : 'text-slate-300 hover:text-red-600'}`}
                   aria-label="Delete agent"
                   disabled={deletingAgentId === agent.id}
                 >
                   <i className={`fas ${deletingAgentId === agent.id ? 'fa-spinner fa-spin' : 'fa-trash'}`}></i>
                 </button>
              </div>
            </div>
          </div>
        );
        })}
      </div>
      {deleteError && (
        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-6 py-4 text-[11px] font-semibold text-amber-700">
          {deleteError}
        </div>
      )}

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

      {showSupport && (
        <div className="fixed inset-0 z-[95] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="p-8 border-b border-slate-100 flex items-start justify-between gap-6">
              <div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">{t('supportTitle')}</h3>
                <p className="text-sm text-slate-500 font-medium mt-2">{t('supportSubtitle')}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowSupport(false)}
                className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"
              >
                <i className="fas fa-times text-xl"></i>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-4 custom-scrollbar bg-slate-50/60">
              {supportMessages.map((msg, idx) => (
                <div
                  key={`${msg.role}-${idx}`}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-5 py-4 text-sm font-medium leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200/40'
                        : 'bg-white text-slate-700 border border-slate-100 shadow-sm'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {supportBusy && (
                <div className="flex justify-start">
                  <div className="bg-white text-slate-500 border border-slate-100 rounded-2xl px-5 py-3 text-sm font-medium">
                    …
                  </div>
                </div>
              )}
              {supportError && (
                <div className="text-[10px] font-black uppercase tracking-widest text-red-500">{supportError}</div>
              )}
            </div>

            <div className="p-6 border-t border-slate-100 bg-white">
              <div className="flex gap-3">
                <textarea
                  rows={2}
                  value={supportInput}
                  onChange={(e) => setSupportInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendSupport();
                    }
                  }}
                  placeholder={t('supportPlaceholder')}
                  className="flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium outline-none focus:border-indigo-400"
                />
                <button
                  type="button"
                  onClick={() => void handleSendSupport()}
                  disabled={supportBusy || supportInput.trim().length === 0}
                  className={`px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest ${
                    supportBusy || supportInput.trim().length === 0
                      ? 'bg-slate-200 text-slate-400'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700'
                  }`}
                >
                  {t('supportSend')}
                </button>
              </div>
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
                          <span className="text-[9px] font-black text-indigo-200 uppercase tracking-widest block mb-1">{t('stringencySummary')}</span>
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
                          onClick={() => void handlePreviewStudent()}
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
                    <div className="rounded-[2.5rem] border border-slate-100 bg-gradient-to-br from-white via-slate-50 to-indigo-50 px-6 py-6 shadow-xl shadow-slate-100/70">
                      <div className="flex flex-col gap-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-indigo-400">{t('matrixModalTitle')}</p>
                            <p className="text-lg font-black text-slate-900">{t('matrixOpenHint')}</p>
                            <p className="text-[11px] text-slate-500 font-medium max-w-xl">{t('matrixModalSubtitle')}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {legacyCriteria.length > 0 && criteriaMatrix.length === 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (!canOpenMatrix) return;
                                  void handleConvertLegacy();
                                  setShowMatrixEditor(true);
                                }}
                                disabled={!canOpenMatrix}
                                className={`px-4 py-2 rounded-xl font-black text-[9px] uppercase tracking-widest ${
                                  canOpenMatrix
                                    ? 'bg-amber-500 text-white'
                                    : 'bg-slate-200 text-slate-400'
                                }`}
                              >
                                {t('matrixConvert')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                if (!canOpenMatrix) return;
                                setShowMatrixEditor(true);
                              }}
                              disabled={!canOpenMatrix}
                              className={`px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-[0.25em] shadow-lg ${
                                canOpenMatrix
                                  ? 'bg-slate-900 text-white shadow-slate-200'
                                  : 'bg-slate-200 text-slate-400 shadow-none'
                              }`}
                            >
                              {t('matrixOpen')}
                            </button>
                          </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <div className="rounded-2xl bg-white/80 border border-white px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-slate-400">{t('matrixSummaryCount')}</p>
                            <p className="text-2xl font-black text-slate-900">{criteriaMatrix.length}</p>
                          </div>
                          <div className="rounded-2xl bg-white/80 border border-white px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-slate-400">{t('matrixSummaryCoverage')}</p>
                            <p className="text-2xl font-black text-slate-900">{matrixCoverage} / 6</p>
                          </div>
                          <div className="rounded-2xl bg-white/80 border border-white px-4 py-3">
                            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-slate-400">{t('matrixSummaryReliability')}</p>
                            <p className={`text-2xl font-black ${matrixClaritySummary.color}`}>{matrixClaritySummary.label}</p>
                          </div>
                        </div>
                        {formError && (
                          <p className="text-[10px] font-black text-red-500 uppercase tracking-widest">{formError}</p>
                        )}
                        {!canOpenMatrix && (
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                            {language === 'sv'
                              ? 'Lägg till en uppgiftsbeskrivning för att låsa upp matrisen.'
                              : 'Add a task description to unlock the matrix.'}
                          </p>
                        )}
                      </div>
                    </div>
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

      {isModalOpen && showMatrixEditor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 md:p-10">
          <div
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-[12px]"
            onClick={() => void handleCloseMatrixEditor()}
          />
          <div className="relative w-full max-w-6xl overflow-hidden rounded-[2.5rem] bg-white shadow-2xl shadow-slate-900/25">
            <div className="px-8 py-6 bg-gradient-to-r from-indigo-50 via-white to-slate-50 border-b border-slate-100 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-indigo-400">{t('criteriaLabel')}</p>
                <h3 className="text-2xl font-black text-slate-900">{t('matrixModalTitle')}</h3>
                <p className="text-[12px] text-slate-500 font-medium">{t('matrixModalSubtitle')}</p>
              </div>
              <button
                type="button"
                onClick={() => void handleCloseMatrixEditor()}
                className="w-12 h-12 rounded-full border border-slate-200 text-slate-400 hover:text-slate-900 flex items-center justify-center"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>

            <div className="px-8 py-6 max-h-[70vh] overflow-y-auto space-y-4">
              {legacyCriteria.length > 0 && criteriaMatrix.length === 0 && (
                <div className="bg-amber-50 border border-amber-100 rounded-2xl px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[11px] font-semibold text-amber-700">{t('matrixConvertHelp')}</p>
                  <button
                    type="button"
                    onClick={() => void handleConvertLegacy()}
                    className="px-4 py-2 rounded-xl bg-amber-600 text-white font-black text-[9px] uppercase tracking-widest"
                  >
                    {t('matrixConvert')}
                  </button>
                </div>
              )}

              <div className="overflow-x-auto overflow-y-visible border border-slate-100 rounded-[2rem] bg-white">
                <div className="min-w-[960px]">
                  <div className="grid grid-cols-[1.1fr_1.6fr_1.6fr_0.8fr_0.5fr_0.4fr_0.4fr] gap-3 px-6 py-3 bg-slate-50 text-[9px] font-black uppercase tracking-widest text-slate-500">
                    <div className="flex items-center gap-1">
                      {t('matrixName')}
                      <EduTooltip text={t('matrixNameHelp')}>
                        <i className="fas fa-circle-info text-[9px] text-slate-400"></i>
                      </EduTooltip>
                    </div>
                    <div className="flex items-center gap-1">
                      {t('matrixDescription')}
                      <EduTooltip text={t('matrixDescriptionHelp')}>
                        <i className="fas fa-circle-info text-[9px] text-slate-400"></i>
                      </EduTooltip>
                    </div>
                    <div className="flex items-center gap-1">
                      {t('matrixIndicator')}
                      <EduTooltip text={t('matrixIndicatorHelp')}>
                        <i className="fas fa-circle-info text-[9px] text-slate-400"></i>
                      </EduTooltip>
                    </div>
                    <div className="flex items-center gap-1">
                      {t('matrixBloom')}
                      <EduTooltip text={t('matrixBloomHelp')}>
                        <i className="fas fa-circle-info text-[9px] text-slate-400"></i>
                      </EduTooltip>
                    </div>
                    <div className="flex items-center gap-1">
                      {t('matrixReliability')}
                      <EduTooltip text={t('matrixClarityHelp')}>
                        <i className="fas fa-circle-info text-[9px] text-slate-400"></i>
                      </EduTooltip>
                    </div>
                    <div className="flex items-center gap-1">
                      {t('matrixWeight')}
                      <EduTooltip text={t('matrixWeightHelp')}>
                        <i className="fas fa-circle-info text-[9px] text-slate-400"></i>
                      </EduTooltip>
                    </div>
                    <div className="text-right flex items-center justify-end gap-1">
                      {t('matrixActions')}
                      <EduTooltip text={t('matrixActionsHelp')}>
                        <i className="fas fa-circle-info text-[9px] text-slate-400"></i>
                      </EduTooltip>
                    </div>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {criteriaMatrix.length === 0 ? (
                      <div className="px-6 py-6 text-[11px] text-slate-400 font-semibold">{t('matrixEmpty')}</div>
                    ) : (
                      criteriaMatrix.map((row) => {
                        const bloomDisplay = getBloomDisplay(row.bloom_index);
                        const hasClaritySignal = [row.indicator, row.description].some(
                          value => typeof value === 'string' && value.trim()
                        );
                        const clarityDisplay = hasClaritySignal
                          ? getClarityDisplay(row.reliability_score, row.clarity_label)
                          : { label: '—', color: 'text-slate-400' };
                        const indicatorText = getMatrixText(row, 'indicator').trim();
                        const indicatorStatus = row.indicator_status || (indicatorText ? 'ok' : 'needs_generation');
                        const indicatorMessage = indicatorStatus === 'cannot_operationalize'
                          ? t('matrixIndicatorCannot')
                          : indicatorStatus === 'needs_generation'
                            ? t('matrixIndicatorNeeds')
                            : indicatorText || t('matrixIndicatorPlaceholder');
                        return (
                          <div key={row.id} className="grid grid-cols-[1.1fr_1.6fr_1.6fr_0.8fr_0.5fr_0.4fr_0.4fr] gap-3 px-6 py-4 items-start">
                            <input
                              className="w-full px-3 py-2 rounded-xl border border-slate-100 bg-slate-50 text-[11px] font-semibold"
                              value={getMatrixText(row, 'name')}
                              placeholder={t('matrixName')}
                              onChange={(e) => handleMatrixFieldChange(row.id, 'name', e.target.value)}
                            />
                            <textarea
                              rows={3}
                              className="w-full px-3 py-2 rounded-xl border border-slate-100 bg-slate-50 text-[11px] font-medium"
                              value={getMatrixText(row, 'description')}
                              placeholder={t('matrixDescription')}
                              onChange={(e) => handleMatrixFieldChange(row.id, 'description', e.target.value)}
                            />
                            <div className={`w-full px-3 py-2 rounded-xl border text-[11px] font-medium whitespace-pre-wrap ${
                              indicatorStatus === 'cannot_operationalize'
                                ? 'border-rose-200 bg-rose-50 text-rose-600'
                                : indicatorStatus === 'needs_generation'
                                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                                  : 'border-slate-100 bg-slate-50 text-slate-700'
                            }`}>
                              <div className="flex items-center justify-between gap-3">
                                <span>{indicatorMessage}</span>
                                {indicatorStatus === 'cannot_operationalize' && (
                                  <span className="px-2 py-1 rounded-full text-[8px] font-black uppercase tracking-widest bg-rose-100 text-rose-600">
                                    {t('matrixIndicatorUnclear')}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <span className={`inline-flex px-3 py-1 rounded-full border text-[9px] font-black uppercase tracking-widest ${bloomDisplay.badge}`}>
                                {bloomDisplay.label}
                              </span>
                            </div>
                            <div className={`text-[11px] font-black ${clarityDisplay.color}`}>
                              {clarityDisplay.label}
                            </div>
                            <input
                              type="number"
                              min={0}
                              step={0.1}
                              className="w-full px-3 py-2 rounded-xl border border-slate-100 bg-slate-50 text-[11px] font-semibold"
                              value={row.weight}
                              onChange={(e) => handleMatrixFieldChange(row.id, 'weight', Number(e.target.value))}
                            />
                            <div className="flex items-center justify-end gap-2">
                              <EduTooltip text={t('matrixSmartFillHelp')}>
                                <button
                                  type="button"
                                  disabled={isImproving}
                                  onClick={() => void handleSmartFillRow(row.id)}
                                  className="w-9 h-9 rounded-full border border-amber-200 bg-amber-50 text-amber-700 flex items-center justify-center disabled:opacity-60"
                                >
                                  <i className={`fas ${isImproving ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'} text-[10px]`}></i>
                                </button>
                              </EduTooltip>
                              <button
                                type="button"
                                onClick={() => handleRemoveMatrixRow(row.id)}
                                className="w-9 h-9 rounded-full border border-slate-100 text-slate-400 hover:text-red-500 flex items-center justify-center"
                              >
                                <i className="fas fa-trash text-[10px]"></i>
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="px-8 py-5 border-t border-slate-100 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => void handleCloseMatrixEditor()}
                className="px-5 py-3 rounded-2xl border border-slate-200 text-slate-500 font-black text-[10px] uppercase tracking-widest hover:bg-slate-50"
              >
                {t('matrixModalClose')}
              </button>
              <div className="flex items-center gap-3">
                {formError && (
                  <p className="text-[10px] font-black text-red-500 uppercase tracking-widest">{formError}</p>
                )}
                <button
                  type="button"
                  onClick={() => void handleRefreshMatrix()}
                  disabled={isRefreshingMatrix || criteriaMatrix.length === 0}
                  className={`px-5 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest ${
                    isRefreshingMatrix || criteriaMatrix.length === 0
                      ? 'bg-slate-100 text-slate-400'
                      : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                  }`}
                >
                  {isRefreshingMatrix ? '...' : t('matrixRefresh')}
                </button>
                <button
                  type="button"
                  onClick={handleAddMatrixRow}
                  className="px-5 py-3 rounded-2xl bg-indigo-600 text-white font-black text-[10px] uppercase tracking-widest"
                >
                  {t('matrixAddRow')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
