
import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { collection, deleteDoc, doc, getDocFromServer, getDocs, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { deleteObject, ref, uploadBytes } from 'firebase/storage';
import { Agent, ReferenceMaterial, Submission, StringencyLevel } from '../types';
import { db, storage } from '../firebase';
import { improveCriterion } from '../services/geminiService';

interface TeacherDashboardProps {
  agents: Agent[];
  submissions: Submission[];
  currentUserEmail: string;
  currentUserUid: string;
  onCreateAgent: (agent: Agent) => void;
  onUpdateAgent: (agent: Agent) => void;
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
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
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
    taskDesc: { sv: 'Uppgiftsbeskrivning', en: 'Task Description' },
    criteriaLabel: { sv: 'Bedömningsstöd & Matriser', en: 'Criteria & Matrices' },
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
    insights: { sv: 'Lärarinsikter', en: 'Teacher Insights' },
    noSubmissions: { sv: 'Inga inlämningar än', en: 'No submissions yet' },
    commonErrors: { sv: 'Vanliga missförstånd', en: 'Common Misunderstandings' },
    strengths: { sv: 'Styrkor i gruppen', en: 'Group Strengths' },
    actions: { sv: 'Pedagogiska åtgärder', en: 'Teaching Actions' },
    results: { sv: 'Resultat & Koder', en: 'Results & Codes' },
    uploadTooLarge: { sv: 'Filen är för stor (max 50 MB).', en: 'File is too large (max 50 MB).' },
    uploadUnsupported: { sv: 'Filtypen stöds inte.', en: 'File type is not supported.' },
    deleteConfirm: { sv: 'Radera agenten och allt referensmaterial?', en: 'Delete this agent and all reference material?' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];

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
    setMinWords(agent.wordCountLimit.min);
    setMaxWords(agent.wordCountLimit.max);
    setPassThreshold(agent.passThreshold || 80000);
    setStringency(agent.stringency || 'standard');
    setIsModalOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newDesc || criteriaList.length === 0) return;
    const agentData: Agent = {
      id: editingAgentId || `agent-${Date.now()}`,
      name: newName, description: newDesc, criteria: criteriaList,
      wordCountLimit: { min: minWords, max: maxWords }, passThreshold, stringency,
      ownerEmail: currentUserEmail, ownerUid: currentUserUid, sharedWithEmails: [], sharedWithUids: [], visibleTo: [currentUserUid], isPublic: true, isDraft: false
    };
    if (editingAgentId) onUpdateAgent(agentData); else onCreateAgent(agentData);
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

  const generateIframeCode = (id: string) => `<iframe src="${window.location.origin}${window.location.pathname}#/s/${id}" width="100%" height="800px" style="border:none; border-radius:12px;"></iframe>`;

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
        <button onClick={() => { setEditingAgentId(null); setDraftCreatedId(null); setIsModalOpen(true); }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-10 py-4 rounded-2xl font-black text-[11px] uppercase tracking-widest shadow-xl">Ny Agent</button>
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
              </div>
            </div>
            <div className="px-8 py-5 bg-slate-50/50 border-t border-slate-100 flex items-center justify-between">
              <button onClick={() => setActiveInsightsId(agent.id)} className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:text-indigo-800 transition-colors flex items-center gap-2">
                <i className="fas fa-chart-line"></i> {t('insights')}
              </button>
              <div className="flex gap-4">
                 <button onClick={(e) => { e.stopPropagation(); openEditModal(agent); }} className="text-slate-300 hover:text-slate-900 transition-colors" aria-label="Edit agent"><i className="fas fa-cog"></i></button>
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
                    <input required type="text" className="w-full px-8 py-5 rounded-[1.5rem] border border-slate-100 text-xl font-black shadow-inner bg-slate-50 outline-none" value={newName} onChange={e => setNewName(e.target.value)} />
                  </div>
                  <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('taskDesc')}</label>
                    <textarea required rows={4} className="w-full px-8 py-5 rounded-[1.5rem] border border-slate-100 text-[15px] font-medium shadow-inner bg-slate-50 outline-none" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
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
                      <input type="number" className="w-full px-6 py-4 rounded-2xl border border-slate-100 bg-slate-50 font-black text-slate-900" value={minWords} onChange={e => setMinWords(Number(e.target.value))} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('maxWords')}</label>
                      <input type="number" className="w-full px-6 py-4 rounded-2xl border border-slate-100 bg-slate-50 font-black text-slate-900" value={maxWords} onChange={e => setMaxWords(Number(e.target.value))} />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('passLabel')}</label>
                    <div className="flex items-center gap-6">
                      <input type="range" min="0" max="100000" step="5000" className="flex-1 accent-indigo-600" value={passThreshold} onChange={e => setPassThreshold(Number(e.target.value))} />
                      <span className="text-xl font-black text-indigo-600 w-20 text-right">{(passThreshold/1000).toFixed(0)}k</span>
                    </div>
                  </div>

                  {editingAgentId && (
                    <div className="p-8 bg-indigo-50 rounded-[2.5rem] border border-indigo-100 space-y-4">
                      <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-900 flex items-center gap-2"><i className="fas fa-code"></i> {t('embedTitle')}</h3>
                      <code className="text-[9px] font-mono break-all text-indigo-800 bg-white/50 p-4 rounded-xl block leading-normal border border-indigo-100">{generateIframeCode(editingAgentId)}</code>
                      <button type="button" onClick={() => { navigator.clipboard.writeText(generateIframeCode(editingAgentId)); setCopyStatus('embed'); setTimeout(() => setCopyStatus(null), 2000); }} className="w-full py-3 rounded-xl bg-indigo-900 text-white font-black text-[9px] uppercase tracking-widest">{copyStatus === 'embed' ? t('copied') : t('copyEmbed')}</button>
                    </div>
                  )}
                </div>

                <div className="space-y-12">
                  <div className="space-y-5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{t('refLabel')}</label>
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
                      <input type="text" className="flex-1 px-8 py-4 rounded-[1.5rem] border border-slate-100 text-[12px] font-black outline-none bg-slate-50 uppercase tracking-widest" placeholder="Namnge kriterium..." value={currentCriterion} onChange={e => setCurrentCriterion(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAddCriterion())} />
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
                            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button type="button" onClick={() => { setEditingCriterionIdx(idx); setEditingCriterionValue(criteriaList[idx]); }} className="w-8 h-8 rounded-lg bg-white shadow-sm border border-slate-100 text-slate-400 hover:text-indigo-600"><i className="fas fa-pen text-[10px]"></i></button>
                              {!matrix && <button type="button" disabled={isImproving} onClick={() => handleImproveRequest(idx)} className="w-8 h-8 rounded-lg bg-white shadow-sm border border-slate-100 text-slate-400 hover:text-amber-500"><i className={`fas ${isImproving ? 'fa-spinner fa-spin' : 'fa-sparkles'} text-[10px]`}></i></button>}
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
