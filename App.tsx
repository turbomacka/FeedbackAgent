
import React, { useState, useEffect, useMemo } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { arrayUnion, collection, doc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { Agent, Submission } from './types';
import { TeacherDashboard } from './components/TeacherDashboard';
import { StudentView } from './components/StudentView';
import { LoginPortal } from './components/LoginPortal';
import { auth, db, googleProvider } from './firebase';

const App: React.FC = () => {
  const [view, setView] = useState<'teacher' | 'student'>('teacher');
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [language, setLanguage] = useState<'sv' | 'en'>('sv');
  
  // Auth state
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const translations = {
    teacherPortal: { sv: 'Lärarportal', en: 'Teacher Portal' },
    logout: { sv: 'Logga ut', en: 'Log out' },
    notFound: { sv: 'Agent hittades inte', en: 'Agent not found' },
    back: { sv: 'Tillbaka', en: 'Back' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];
  const userLabel = user?.displayName || user?.email || '';
  const userInitials = userLabel
    ? userLabel.split(' ').map(part => part[0]).join('').toUpperCase()
    : 'U';

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setIsLoggedIn(Boolean(nextUser));
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;

      if (hash.startsWith('#/s/')) {
        const id = hash.replace('#/s/', '');
        setActiveAgentId(id);
        setView('student');
      } else if (hash.startsWith('#/share/')) {
        const id = hash.replace('#/share/', '');
        if (isLoggedIn && user) {
          const agentRef = doc(db, 'agents', id);
          const updates: Record<string, unknown> = {
            sharedWithUids: arrayUnion(user.uid),
            visibleTo: arrayUnion(user.uid),
            updatedAt: serverTimestamp()
          };
          if (user.email) {
            updates.sharedWithEmails = arrayUnion(user.email);
          }
          void updateDoc(agentRef, updates);
          window.location.hash = '';
        } else {
          setView('teacher');
          setActiveAgentId(null);
        }
      } else {
        setView('teacher');
        setActiveAgentId(null);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [isLoggedIn, user]);

  useEffect(() => {
    if (!user) {
      setAgents([]);
      setSubmissions([]);
      return;
    }

    const agentsQuery = query(
      collection(db, 'agents'),
      where('visibleTo', 'array-contains', user.uid)
    );
    const unsubAgents = onSnapshot(agentsQuery, (snapshot) => {
      const data = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<Agent, 'id'>)
      }));
      setAgents(data);
    });

    const submissionsQuery = query(
      collection(db, 'submissions'),
      where('visibleTo', 'array-contains', user.uid)
    );
    const unsubSubmissions = onSnapshot(submissionsQuery, (snapshot) => {
      const data = snapshot.docs.map(docSnap => ({
        ...(docSnap.data() as Submission)
      }));
      setSubmissions(data);
    });

    return () => {
      unsubAgents();
      unsubSubmissions();
    };
  }, [user]);

  useEffect(() => {
    if (!activeAgentId) {
      setActiveAgent(null);
      return;
    }
    const agentRef = doc(db, 'agents', activeAgentId);
    const unsubscribe = onSnapshot(agentRef, (snapshot) => {
      if (!snapshot.exists()) {
        setActiveAgent(null);
        return;
      }
      setActiveAgent({
        id: snapshot.id,
        ...(snapshot.data() as Omit<Agent, 'id'>)
      });
    });
    return () => unsubscribe();
  }, [activeAgentId]);

  useEffect(() => {
    if (!user) return;
    const profileRef = doc(db, 'users', user.uid);
    void setDoc(profileRef, {
      email: user.email || '',
      displayName: user.displayName || '',
      role: 'teacher',
      updatedAt: serverTimestamp()
    }, { merge: true });
  }, [user]);

  const handleUpdateAgent = async (updatedAgent: Agent) => {
    if (!user) return;
    const existing = agents.find(a => a.id === updatedAgent.id);
    const sharedWithUids = existing?.sharedWithUids || [];
    const sharedWithEmails = existing?.sharedWithEmails || [];
    const visibleTo = existing?.visibleTo || [user.uid, ...sharedWithUids];
    const isPublic = typeof existing?.isPublic === 'boolean' ? existing.isPublic : true;
    const isDraft = typeof updatedAgent.isDraft === 'boolean'
      ? updatedAgent.isDraft
      : (typeof existing?.isDraft === 'boolean' ? existing.isDraft : false);

    const payload = {
      name: updatedAgent.name,
      description: updatedAgent.description,
      criteria: updatedAgent.criteria,
      wordCountLimit: updatedAgent.wordCountLimit,
      passThreshold: updatedAgent.passThreshold,
      stringency: updatedAgent.stringency,
      ownerEmail: existing?.ownerEmail || user.email || '',
      ownerUid: existing?.ownerUid || user.uid,
      sharedWithEmails,
      sharedWithUids,
      visibleTo,
      isPublic,
      isDraft,
      updatedAt: serverTimestamp()
    };
    await updateDoc(doc(db, 'agents', updatedAgent.id), payload);
  };

  const handleCreateAgent = async (newAgent: Agent) => {
    if (!user) return;
    const payload = {
      name: newAgent.name,
      description: newAgent.description,
      criteria: newAgent.criteria,
      wordCountLimit: newAgent.wordCountLimit,
      passThreshold: newAgent.passThreshold,
      stringency: newAgent.stringency,
      ownerEmail: user.email || '',
      ownerUid: user.uid,
      sharedWithEmails: [],
      sharedWithUids: [],
      visibleTo: [user.uid],
      isPublic: true,
      isDraft: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    await setDoc(doc(db, 'agents', newAgent.id), payload);
  };

  const handleLogin = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      setAuthError(err?.message || 'Login failed.');
    }
  };

  const visibleAgents = useMemo(() => agents, [agents]);
  const isEmbedded = (() => {
    const params = new URLSearchParams(window.location.search);
    const embedParam = params.get('embed');
    const queryFlag = embedParam === '1' || embedParam === 'true' || embedParam === 'yes';
    let iframe = false;
    try {
      iframe = window.self !== window.top;
    } catch {
      iframe = true;
    }
    return queryFlag || iframe;
  })();

  return (
    <div className={view === 'student' && isEmbedded ? 'min-h-screen bg-white' : 'min-h-screen pb-12 bg-gray-50'}>
      {!(view === 'student' && isEmbedded) && (
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-40 backdrop-blur-md bg-white/90 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-20">
            <div className="flex items-center gap-4 cursor-pointer" onClick={() => window.location.hash = ''}>
              <div className="relative w-12 h-12 bg-[#4338ca] rounded-xl flex items-center justify-center shadow-lg overflow-hidden">
                <svg viewBox="0 0 100 100" className="w-8 h-8 text-white stroke-[6] fill-none" stroke="currentColor">
                  <path d="M 50 20 A 30 30 0 1 1 50 80" strokeLinecap="round" />
                  <path d="M 50 80 L 50 35 M 40 45 L 50 35 L 60 45" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="20" cy="80" r="4" fill="white" stroke="none" className="animate-pulse" />
                </svg>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold text-[#111827] tracking-tight">Feedback</span>
                <span className="text-2xl font-bold text-[#4338ca] tracking-tight">Agent</span>
              </div>
            </div>
            
            <div className="flex items-center gap-6">
              {isLoggedIn && user && view === 'teacher' && (
                <div className="hidden md:flex items-center gap-3 px-4 py-2 bg-slate-50 rounded-xl border border-slate-100">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-black text-[10px]">{userInitials}</div>
                  <div className="flex flex-col">
                    <span className="text-[9px] font-black text-slate-900 uppercase tracking-tight">{user.displayName || user.email}</span>
                    <button onClick={() => void signOut(auth)} className="text-[8px] font-black text-red-500 uppercase tracking-widest text-left hover:text-red-700 transition-colors">{t('logout')}</button>
                  </div>
                </div>
              )}
              
              <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl border border-gray-200">
                <button onClick={() => setLanguage('sv')} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'sv' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}>SV</button>
                <button onClick={() => setLanguage('en')} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'en' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}>EN</button>
              </div>
              {view === 'teacher' && (
                <button onClick={() => { window.location.hash = ''; }} className="text-[10px] font-black px-5 py-2.5 rounded-xl transition-all uppercase tracking-widest bg-indigo-50 text-indigo-800 border border-indigo-100">{t('teacherPortal')}</button>
              )}
            </div>
          </div>
        </div>
      </nav>
      )}

      <main className={view === 'student' && isEmbedded ? 'mt-0' : 'mt-8'}>
        {view === 'teacher' ? (
          isLoggedIn && user ? (
            <TeacherDashboard
              agents={visibleAgents}
              currentUserEmail={user.email || ''}
              currentUserUid={user.uid}
              submissions={submissions}
              onCreateAgent={handleCreateAgent}
              onUpdateAgent={handleUpdateAgent}
              language={language}
            />
          ) : (
            <LoginPortal onLogin={handleLogin} language={language} error={authError} />
          )
        ) : activeAgent ? (
          <StudentView agent={activeAgent} language={language} />
        ) : (
          <div className="max-w-md mx-auto mt-24 text-center space-y-4">
            <h2 className="text-2xl font-black text-gray-900 uppercase tracking-tight">{t('notFound')}</h2>
            <button onClick={() => window.location.hash = ''} className="px-6 py-2 bg-indigo-600 text-white font-black rounded-lg uppercase tracking-widest text-[10px]">{t('back')}</button>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
