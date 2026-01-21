
import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { collection, deleteDoc, doc, getDoc, getDocFromServer, getDocs, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { deleteObject, ref, uploadBytes } from 'firebase/storage';
import { Agent, ReferenceMaterial, Submission, StringencyLevel } from '../types';
import { db, storage } from '../firebase';
import { improveCriterion } from '../services/geminiService';
import { EduTooltip } from './EduTooltip';

interface TeacherDashboardProps {
  agents: Agent[];
  submissions: Submission[];
  currentUserEmail: string;
  currentUserUid: string;
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

export const TeacherDashboard: React.FC<TeacherDashboardProps> = ({ agents, submissions, currentUserEmail, currentUserUid, onCreateAgent, onUpdateAgent, language }) => {
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
  const [minWords, setMinWords] = useState(300);
  const [maxWords, setMaxWords] = useState(600);
  const [passThreshold, setPassThreshold] = useState(80000);
  const [stringency, setStringency] = useState<StringencyLevel>('standard');
  const [accessCode, setAccessCode] = useState('');
  const [accessCodeError, setAccessCodeError] = useState<string | null>(null);
  const [accessCodes, setAccessCodes] = useState<Record<string, string>>({});
  const [showSubmissionPrompt, setShowSubmissionPrompt] = useState(true);
  const [showVerificationCode, setShowVerificationCode] = useState(true);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copiedAccessId, setCopiedAccessId] = useState<string | null>(null);
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
    uploadTooLarge: { sv: 'Filen är för stor (max 50 MB).', en: 'File is too large (max 50 MB).' },
    uploadUnsupported: { sv: 'Filtypen stöds inte.', en: 'File type is not supported.' },
    deleteConfirm: { sv: 'Radera agenten och allt referensmaterial?', en: 'Delete this agent and all reference material?' },
    studentOptions: { sv: 'Studentvy', en: 'Student View' },
    submissionPromptLabel: { sv: 'Visa inlämningsuppmaning', en: 'Show submission prompt' },
    submissionPromptHelp: { sv: 'Visas tillsammans med verifieringskoden.', en: 'Shown alongside the verification code.' },
    verificationCodeLabel: { sv: 'Visa verifieringskod', en: 'Show verification code' },
    verificationCodeHelp: { sv: 'Stäng av om du vill ha enbart formativ återkoppling.', en: 'Turn off for formative-only feedback.' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];

  const normalizeAccessCode = (value: string) =>
    value.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

  const generateAccessCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const length = 8;
    let result = '';
    for (let i = 0; i < length; i += 1) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
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
    setStringency('standard');
    setAccessCode('');
    setAccessCodeError(null);
    setShowSubmissionPrompt(true);
    setShowVerificationCode(true);
    setEditingCriterionIdx(null);
    setEditingCriterionValue('');
    setUploadError(null);
  };

  const ensureDraftAgent = async () => {
    if (editingAgentId) return editingAgentId;
    const draftRef = doc(collection(db, 'agents'));
    const draft: Agent = {
      id: draftRef.id,
      name: newName.trim() || (language === 'sv' ? 'Namnlös agent' : 'Untitled agent'),
      description: newDesc.trim() || '',
      criteria: criteriaList,
      wordCountLimit: { min: minWords, max: maxWords },
      passThreshold,
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
    return draftRef.id;
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

      try {
        await uploadBytes(storageRef, file, { contentType: file.type || 'application/octet-stream' });
        await setDoc(materialRef, {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          status: 'uploaded',
          gcsPath: storagePath,
          createdAt: serverTimestamp()
        });
      } catch (error: any) {
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
    } catch(e: any) {
      alert(e.message || "Kunde inte förbättra kriteriet.");
    } finally {
      setIsImproving(false);
    }
  };

  const handleAddCriterion = () => {
    if (currentCriterion.trim()) {
      setCriteriaList(prev => [...prev, currentCriterion.trim()]);
      setCurrentCriterion('');
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
    setStringency(agent.stringency || 'standard');
    setShowSubmissionPrompt(agent.showSubmissionPrompt ?? true);
    setShowVerificationCode(agent.showVerificationCode ?? true);
    setEditingCriterionIdx(null);
    setEditingCriterionValue('');
    setUploadError(null);
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
    if (!newName || !newDesc || criteriaList.length === 0) return;
    const normalizedCode = normalizeAccessCode(accessCode);
    if (!normalizedCode) {
      setAccessCodeError(t('accessCodeRequired'));
      return;
    }
    const agentData: Agent = {
      id: editingAgentId || `agent-${Date.now()}`,
      name: newName, description: newDesc, criteria: criteriaList,
      wordCountLimit: { min: minWords, max: maxWords }, passThreshold, stringency,
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
      setUploadError(null);
      return;
    }
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
    let totalScore = 0;

    agentSubmissions.forEach(s => {
      s.insights.common_errors.forEach(e => errors.add(e));
      s.insights.strengths.forEach(st => strengths.add(st));
      s.insights.teaching_actions.forEach(a => actions.add(a));
      totalScore += s.score;
    });

    return {
      errors: Array.from(errors).slice(0, 5),
      strengths: Array.from(strengths).slice(0, 5),
      actions: Array.from(actions).slice(0, 5),
      avgScore: Math.round(totalScore / agentSubmissions.length),
      count: agentSubmissions.length
    };
  }, [agentSubmissions]);

  const activeAgent = agents.find(a => a.id === activeInsightsId);

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-12">
      <header className="flex justify-between items-center bg-white p-10 rounded-[2.5rem] border border-slate-100 shadow-sm">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">{t('manageAgent')}</h1>
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">Skapa och redigera dina feedback-assistenter</p>
        </div>
        <button
          onClick={() => {
            resetDraftForm();
            setIsModalOpen(true);
          }}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-10 py-4 rounded-2xl font-black text-[11px] uppercase tracking-widest shadow-xl"
        >
          Ny Agent
        </button>
      </header>

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
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{agentSubmissions.length} Inlämningar analyserade</p>
                   </div>
                </div>
                <button onClick={() => setActiveInsightsId(null)} className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"><i className="fas fa-times text-xl"></i></button>
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
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                       <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
                          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2">Snittresultat</span>
                          <div className="flex items-baseline gap-2">
                             <span className="text-4xl font-black text-indigo-600">{(aggregatedInsights.avgScore / 1000).toFixed(1)}k</span>
                             <span className="text-slate-400 text-sm font-bold">/ 100k</span>
                          </div>
                          <div className="mt-4 w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                             <div className="h-full bg-indigo-600 transition-all duration-1000" style={{width: `${aggregatedInsights.avgScore / 1000}%`}}></div>
                          </div>
                       </div>
                       <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col justify-center">
                          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">Inlämningar</span>
                          <span className="text-4xl font-black text-slate-900">{aggregatedInsights.count}</span>
                       </div>
                       <div className="bg-indigo-600 p-8 rounded-[2.5rem] shadow-xl shadow-indigo-100 flex flex-col justify-center">
                          <span className="text-[9px] font-black text-indigo-200 uppercase tracking-widest block mb-1">Stringens</span>
                          <span className="text-4xl font-black text-white uppercase tracking-tight">{activeAgent.stringency}</span>
                       </div>
                    </div>

                    {/* Analys Kolumner */}
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

                    {/* Verifieringskoder Tabell */}
                    <div className="space-y-6">
                       <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest ml-2">{t('results')}</h3>
                       <div className="bg-white rounded-[2.5rem] border border-slate-100 overflow-hidden shadow-sm">
                          <table className="w-full text-left">
                             <thead>
                                <tr className="bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                                   <th className="px-8 py-5">Tid</th>
                                   <th className="px-8 py-5">Verifieringskod</th>
                                   <th className="px-8 py-5 text-right">Resultat</th>
                                </tr>
                             </thead>
                             <tbody className="divide-y divide-slate-100">
                                {agentSubmissions.map((s, i) => (
                                   <tr key={i} className="hover:bg-slate-50 transition-colors">
                                      <td className="px-8 py-5 text-[11px] font-bold text-slate-400">{new Date(s.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                                      <td className="px-8 py-5">
                                         <code className="bg-slate-100 text-slate-900 px-3 py-1 rounded-lg font-black text-sm">{s.verificationCode}</code>
                                      </td>
                                      <td className="px-8 py-5 text-right font-black text-indigo-600">{(s.score / 1000).toFixed(1)}k</td>
                                   </tr>
                                ))}
                             </tbody>
                          </table>
                       </div>
                    </div>
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
                  <button onClick={() => { const updated = [...criteriaList]; updated[editingCriterionIdx!] = editingCriterionValue.trim(); setCriteriaList(updated); setEditingCriterionIdx(null); }} className="px-14 py-4 rounded-2xl font-black text-white bg-indigo-600 text-[11px] uppercase tracking-widest">Spara matris</button>
                </div>
              </div>
            )}

            <div className="p-10 border-b border-slate-50 flex justify-between items-center bg-white shrink-0">
              <h2 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.3em]">{editingAgentId ? 'Redigera Agent' : 'Skapa Ny Agent'}</h2>
              <button onClick={() => void handleCloseModal()} className="w-12 h-12 rounded-full bg-slate-50 text-slate-400 hover:text-slate-900 transition-all flex items-center justify-center"><i className="fas fa-times text-xl"></i></button>
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
                      {editingAgentId && (
                        <button
                          type="button"
                          onClick={() => {
                            const generated = generateAccessCode();
                            setAccessCode(generated);
                            setAccessCodeError(null);
                          }}
                          className="px-4 py-3 rounded-2xl bg-white border border-slate-200 text-slate-700 text-[10px] font-black uppercase tracking-widest hover:text-indigo-600 transition-colors"
                        >
                          {t('accessCodeRotate')}
                        </button>
                      )}
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
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('passLabel')}</label>
                    <div className="flex items-center gap-6">
                      <input type="range" min="0" max="100000" step="5000" className="flex-1 accent-indigo-600" value={passThreshold} onChange={e => setPassThreshold(Number(e.target.value))} />
                      <span className="text-xl font-black text-indigo-600 w-20 text-right">{(passThreshold/1000).toFixed(0)}k</span>
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
                      {uploadError && <p className="text-[9px] font-black text-red-500 uppercase tracking-widest">{uploadError}</p>}
                      <div className="flex flex-wrap gap-2 justify-center">
                        {referenceMaterials.map((ref) => (
                          <div key={ref.id} className="bg-white px-4 py-2 rounded-full border border-slate-200 flex items-center gap-3">
                            <i className="fas fa-file-pdf text-red-500 text-[10px]"></i>
                            <span className="text-[9px] font-black text-slate-700 max-w-[120px] truncate">{ref.name}</span>
                            <span className={`text-[8px] font-black uppercase tracking-widest ${ref.status === 'ready' ? 'text-emerald-600' : ref.status === 'failed' ? 'text-red-500' : 'text-amber-500'}`}>
                              {ref.status}
                            </span>
                            <button type="button" onClick={() => handleRemoveMaterial(ref)} className="text-slate-300 hover:text-red-500"><i className="fas fa-times text-[10px]"></i></button>
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
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAddCriterion())}
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
                              <button type="button" onClick={() => setCriteriaList(prev => prev.filter((_, i) => i !== idx))} className="w-8 h-8 rounded-lg bg-white shadow-sm border border-slate-100 text-slate-400 hover:text-red-500"><i className="fas fa-trash-alt text-[10px]"></i></button>
                            </div>
                          </div>
                        );
                      })}
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
    </div>
  );
};
