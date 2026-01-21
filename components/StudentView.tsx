
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Agent, FeedbackResult } from '../types';
import { runAssessment, translateContent, validateAccessCode, acceptAccessSession } from '../services/geminiService';
import { validateWordCount } from '../utils/security';

interface StudentViewProps {
  agent: Agent;
  language: 'sv' | 'en';
  onLanguageChange: (lang: 'sv' | 'en') => void;
}

export const StudentView: React.FC<StudentViewProps> = ({ agent, language, onLanguageChange }) => {
  const [text, setText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [results, setResults] = useState<FeedbackResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState(false);
  const sessionSuffix = useMemo(() => Math.floor(1000 + Math.random() * 9000), []);
  const [displayTitle, setDisplayTitle] = useState(agent.name);
  const [displayDescription, setDisplayDescription] = useState(agent.description);
  const [accessToken, setAccessToken] = useState<string | null>(() => sessionStorage.getItem(`accessToken:${agent.id}`));
  const [accessAccepted, setAccessAccepted] = useState(() => sessionStorage.getItem(`accessAccepted:${agent.id}`) === '1');
  const [accessCodeInput, setAccessCodeInput] = useState('');
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [accessStatus, setAccessStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const accessInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const wordCountStatus = useMemo(
    () => validateWordCount(text, agent.wordCountLimit.min, agent.wordCountLimit.max),
    [text, agent.wordCountLimit.min, agent.wordCountLimit.max]
  );
  const shouldShowVerification = agent.showVerificationCode !== false;
  const shouldShowSubmissionPrompt = shouldShowVerification && agent.showSubmissionPrompt !== false;

  useEffect(() => {
    if (!accessAccepted) {
      setDisplayTitle(agent.name);
      setDisplayDescription(agent.description);
      return;
    }
    const performTranslation = async () => {
      setIsTranslating(true);
      try {
        const translated = await translateContent(agent.name, agent.description, language);
        setDisplayTitle(translated.name);
        setDisplayDescription(translated.description);
      } catch (err) {
        setDisplayTitle(agent.name); setDisplayDescription(agent.description);
      } finally { setIsTranslating(false); }
    };
    performTranslation();
  }, [accessAccepted, language, agent.name, agent.description]);

  useEffect(() => {
    const stored = sessionStorage.getItem(`accessToken:${agent.id}`);
    setAccessToken(stored);
    setAccessAccepted(sessionStorage.getItem(`accessAccepted:${agent.id}`) === '1');
    if (stored && !sessionStorage.getItem(`accessAccepted:${agent.id}`)) {
      setAccessStatus('valid');
    }
  }, [agent.id]);

  useEffect(() => {
    if (!accessCodeInput.trim()) {
      setAccessStatus('idle');
      setAccessError(null);
      return;
    }
    if (accessCodeInput.trim().length < 4) {
      setAccessStatus('idle');
      return;
    }
    const handle = setTimeout(async () => {
      setAccessStatus('checking');
      try {
        const { accessToken: token } = await validateAccessCode(agent.id, accessCodeInput.trim());
        sessionStorage.setItem(`accessToken:${agent.id}`, token);
        setAccessToken(token);
        setAccessStatus('valid');
        setAccessError(null);
      } catch (err: any) {
        setAccessStatus('invalid');
        setAccessError(err?.message || (language === 'sv' ? 'Felaktig accesskod.' : 'Invalid access code.'));
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [accessCodeInput, agent.id, language]);

  const handleStart = async () => {
    setAccessError(null);
    if (!accessToken) {
      setAccessError(language === 'sv' ? 'Accesskod krävs.' : 'Access code is required.');
      return;
    }
    setAccessBusy(true);
    try {
      setUnlocking(true);
      await acceptAccessSession(agent.id, accessToken);
      sessionStorage.setItem(`accessAccepted:${agent.id}`, '1');
      setTimeout(() => {
        setAccessAccepted(true);
        setAccessCodeInput('');
        setUnlocking(false);
      }, 300);
    } catch (err: any) {
      setAccessError(err?.message || (language === 'sv' ? 'Felaktig accesskod.' : 'Invalid access code.'));
    } finally {
      setAccessBusy(false);
    }
  };

  const handleSubmit = async () => {
    setError(null);
    if (!accessToken || !accessAccepted) {
      setError(language === 'sv' ? 'Du behöver en giltig accesskod.' : 'A valid access code is required.');
      return;
    }
    const { ok, count } = validateWordCount(text, agent.wordCountLimit.min, agent.wordCountLimit.max);
    if (!ok) {
      setError(language === 'sv' 
        ? `Din text har ${count} ord. Den måste vara mellan ${agent.wordCountLimit.min} och ${agent.wordCountLimit.max}.`
        : `Your text has ${count} words. It must be between ${agent.wordCountLimit.min} and ${agent.wordCountLimit.max}.`
      );
      return;
    }

    setIsProcessing(true);
    try {
      const { assessment, feedback, verificationCode } = await runAssessment(agent.id, text, language, accessToken);
      const score = assessment.final_metrics.score_100k;
      const newResult: FeedbackResult = {
        studentText: text, pedagogicalFeedback: feedback, assessment, verificationCode, timestamp: Date.now(), language,
        stringencyUsed: agent.stringency || 'standard'
      };
      
      setResults(prev => [newResult, ...prev]);

      setTimeout(() => { document.getElementById('latest-feedback')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
    } catch (err: any) {
      setError(language === 'sv' ? "Ett fel uppstod vid analysen." : "An error occurred during assessment.");
    } finally { setIsProcessing(false); }
  };

  const latestResult = results[0];
  const renderMarkdown = (content: string) => {
    return content.split('\n').map((line, i) => {
      if (line.startsWith('###')) return <h3 key={i} className="text-xl font-black text-indigo-950 mt-6 mb-3 border-b border-indigo-100 pb-1">{line.replace('###', '').trim()}</h3>;
      if (line.startsWith('-') || line.startsWith('*')) return <li key={i} className="ml-4 mb-2 text-gray-950 font-medium leading-relaxed">{line.substring(1).trim()}</li>;
      return <p key={i} className="mb-3 text-gray-900 font-medium leading-relaxed">{line}</p>;
    });
  };

  const translations = {
    iterations: { sv: 'Iterationer', en: 'Iterations' },
    analyzing: { sv: "Analyserar utkast...", en: "Analyzing draft..." },
    resubmit: { sv: 'Skicka in revidering', en: 'Re-submit for Feedback' },
    getFeedback: { sv: 'Hämta AI-återkoppling', en: 'Get AI Feedback' },
    processingNote: { sv: 'Bearbetar din text... brukar ta 10–30 sek.', en: 'Processing your text... usually 10–30 seconds.' },
    iteration: { sv: 'Iteration', en: 'Iteration' },
    allMet: { sv: 'Samtliga kriterier uppfyllda', en: 'All criteria met' },
    developing: { sv: 'Under utveckling', en: 'Developing' },
    revise: { sv: 'Revidera Texten', en: 'Revise Text' },
    verification: { sv: 'Verifieringskod för Canvas', en: 'Canvas Verification Code' },
    copyHint: { sv: 'Kopiera koden från din bästa iteration.', en: 'Copy the code from your best iteration.' },
    codeCopied: { sv: 'Kod kopierad!', en: 'Code copied!' },
    placeholder: { sv: 'Börja skriva...', en: 'Start writing...' },
    wordCount: { sv: 'Ord', en: 'Words' },
    copyCode: { sv: 'Kopiera kod', en: 'Copy code' },
    submissionPrompt: {
      sv: 'När du är nöjd – lämna in din senaste version av texten till läraren för bedömning.',
      en: 'When you are satisfied, submit your latest version of the text to your teacher for assessment.'
    },
    accessTitle: { sv: 'Lås upp din AI-tutor', en: 'Unlock your AI tutor' },
    accessInstruction: { sv: 'Ange accesskoden du fått av din lärare.', en: 'Enter the access code from your teacher.' },
    accessPlaceholder: { sv: 'Accesskod', en: 'Access code' },
    accessUnlock: { sv: 'Starta lärprocessen', en: 'Start the learning process' },
    accessHeading: { sv: 'Viktigt innan du börjar', en: 'Important before you start' },
    accessPoint1Title: { sv: 'Ditt tänkande i fokus', en: 'Your thinking in focus' },
    accessPoint1Body: { sv: 'Syftet är att du ska utveckla din förståelse genom reflektion. Använd min feedback för att fundera en gång till – jag ger tips och stöd, men du äger ditt eget lärande.', en: 'The goal is to develop your understanding through reflection. Use my feedback to think again — I provide tips and support, but you own your learning.' },
    accessPoint2Title: { sv: 'Total anonymitet', en: 'Full anonymity' },
    accessPoint2Body: { sv: 'Du är anonym i systemet. Din chatt sparas under ett dolt ID och kan bara kopplas till dig om du själv lämnar in din valideringskod.', en: 'You are anonymous in the system. Your chat is stored under a hidden ID and can only be linked to you if you choose to submit your validation code.' },
    accessPoint3Title: { sv: 'Data & säkerhet', en: 'Data & safety' },
    accessPoint3Body: { sv: 'Din lärare ser statistik på gruppnivå. Skriv aldrig in namn eller personnummer eftersom all text bearbetas av extern AI.', en: 'Your teacher sees group-level statistics. Never enter names or personal IDs, since all text is processed by external AI.' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];

  useEffect(() => {
    if (!accessAccepted) {
      setTimeout(() => accessInputRef.current?.focus(), 50);
    }
  }, [accessAccepted]);

  const lockedVisual = !accessAccepted && !unlocking ? 'blur-[12px]' : 'blur-0';
  const lockedClass = `${lockedVisual} ${!accessAccepted ? 'pointer-events-none select-none' : ''}`;

  return (
    <div className="max-w-4xl mx-auto space-y-8 p-4 relative">
      {!accessAccepted && (
        <div className={`absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-300 ${unlocking ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
          <div className="absolute inset-0 bg-white/40 backdrop-blur-[12px] rounded-3xl border border-white/50" />
          <div className="relative z-10 bg-white/85 border border-white/70 shadow-2xl rounded-3xl p-8 w-full max-w-xl text-left">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center">
                <i className="fas fa-lock"></i>
              </div>
              <div>
                <h2 className="text-xl font-black text-gray-900">{t('accessTitle')}</h2>
                <p className="text-sm font-semibold text-gray-600">{t('accessInstruction')}</p>
              </div>
            </div>
            <div className="absolute right-6 top-6 flex items-center gap-1 bg-gray-100/80 p-1 rounded-xl border border-gray-200">
              <button onClick={() => onLanguageChange('sv')} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'sv' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}>SV</button>
              <button onClick={() => onLanguageChange('en')} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'en' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}>EN</button>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 mt-6">
              <input
                ref={accessInputRef}
                type="text"
                value={accessCodeInput}
                onChange={e => {
                  if (accessStatus === 'valid') {
                    sessionStorage.removeItem(`accessToken:${agent.id}`);
                    sessionStorage.removeItem(`accessAccepted:${agent.id}`);
                    setAccessToken(null);
                    setAccessAccepted(false);
                    setAccessStatus('idle');
                  }
                  setAccessCodeInput(e.target.value);
                }}
                placeholder={t('accessPlaceholder')}
                className="flex-1 px-5 py-3 rounded-xl border border-gray-200 bg-gray-50 font-black uppercase tracking-widest text-gray-900 placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={handleStart}
                disabled={accessBusy || accessStatus !== 'valid'}
                className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-xs text-white ${accessBusy || accessStatus !== 'valid' ? 'bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'}`}
              >
                {t('accessUnlock')}
              </button>
            </div>
            {accessStatus === 'checking' && (
              <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mt-3">Kontrollerar kod...</p>
            )}
            {accessStatus === 'valid' && (
              <p className="text-[11px] font-black text-emerald-600 uppercase tracking-widest mt-3">Kod godkänd</p>
            )}
            {accessError && <p className="text-[11px] font-black text-red-500 uppercase tracking-widest mt-3">{accessError}</p>}

            <div className="mt-6 border-t border-slate-200 pt-6 space-y-4">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">{t('accessHeading')}</h3>
              <div className="space-y-3 text-sm text-slate-700 font-medium">
                <div>
                  <p className="font-black text-slate-900 uppercase tracking-widest text-[10px]">{t('accessPoint1Title')}</p>
                  <p className="mt-1">{t('accessPoint1Body')}</p>
                </div>
                <div>
                  <p className="font-black text-slate-900 uppercase tracking-widest text-[10px]">{t('accessPoint2Title')}</p>
                  <p className="mt-1">{t('accessPoint2Body')}</p>
                </div>
                <div>
                  <p className="font-black text-slate-900 uppercase tracking-widest text-[10px]">{t('accessPoint3Title')}</p>
                  <p className="mt-1">{t('accessPoint3Body')}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className={`space-y-8 transition-all duration-500 ${lockedClass}`}>
        <header className="text-center space-y-4 relative">
          <div className="absolute left-0 top-0 hidden md:block">
             {results.length > 0 && <span className="bg-indigo-100 text-indigo-800 text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-wider">{results.length} {t('iterations')}</span>}
          </div>
          <div className="absolute right-0 top-0 hidden md:flex items-center gap-1 bg-gray-100 p-1 rounded-xl border border-gray-200">
            <button onClick={() => onLanguageChange('sv')} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'sv' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}>SV</button>
            <button onClick={() => onLanguageChange('en')} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${language === 'en' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'}`}>EN</button>
          </div>
          <div className="space-y-2">
            <h1 className={`text-3xl font-black text-gray-900 transition-opacity ${isTranslating ? 'opacity-50' : ''}`}>{displayTitle}</h1>
            <p className={`text-gray-800 font-medium text-lg max-w-2xl mx-auto transition-opacity ${isTranslating ? 'opacity-50' : ''}`}>{displayDescription}</p>
          </div>
        </header>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl font-bold flex items-center gap-3 animate-bounce"><i className="fas fa-exclamation-circle"></i>{error}</div>}

        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-6 space-y-6">
          <textarea
            ref={editorRef}
            className="w-full h-80 p-5 border border-gray-300 rounded-xl outline-none text-gray-950 font-medium leading-relaxed shadow-inner bg-gray-50/50"
            placeholder={t('placeholder')} value={text} onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest">
            <span className="text-slate-400">{t('wordCount')}</span>
            <span className={`${wordCountStatus.ok ? 'text-emerald-600' : 'text-amber-600'} transition-colors`}>
              {wordCountStatus.count} / {agent.wordCountLimit.min}-{agent.wordCountLimit.max}
            </span>
          </div>
          <button
            onClick={handleSubmit} disabled={isProcessing || !text.trim()}
            className={`w-full py-4 rounded-xl font-black text-white transition-all transform active:scale-[0.99] flex items-center justify-center gap-3 shadow-lg uppercase tracking-widest text-xs ${isProcessing || !text.trim() ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}`}
          >
            {isProcessing ? t('analyzing') : results.length > 0 ? t('resubmit') : t('getFeedback')}
          </button>
          {isProcessing && (
            <div className="flex items-center justify-center gap-2 text-[11px] font-semibold text-slate-500">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-60"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
              </span>
              <span>{t('processingNote')}</span>
            </div>
          )}
        </div>

      {results.length > 0 && (
        <div id="latest-feedback" className="space-y-12 animate-in fade-in slide-in-from-bottom-6 duration-700 transition-all">
          <section className="space-y-6">
            <div className="bg-white rounded-2xl shadow-2xl border border-indigo-100 overflow-hidden ring-1 ring-indigo-50">
              <div className="bg-indigo-700 p-5 flex items-center justify-between text-white">
                <h2 className="text-lg font-black leading-none">{`${t('iteration')} #${results.length}`}</h2>
                <span className="text-[10px] font-black font-mono bg-indigo-900/50 px-2 py-1 rounded border border-indigo-500/30">S-ID: {sessionSuffix}</span>
              </div>
              <div className="p-8 lg:p-10 bg-white">
                <div className="max-w-none">{renderMarkdown(latestResult.pedagogicalFeedback)}</div>
              </div>
              <div className="bg-gray-50 p-6 flex flex-col sm:flex-row items-center justify-between gap-6 border-t border-gray-200">
                 <div className="flex items-center gap-6">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-gray-600 font-black uppercase tracking-widest">STATUS</span>
                      <span className={`font-black text-xl uppercase tracking-tight ${latestResult.assessment.final_metrics.score_100k >= (agent.passThreshold || 80000) ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {latestResult.assessment.final_metrics.score_100k >= (agent.passThreshold || 80000) ? t('allMet') : t('developing')}
                      </span>
                    </div>
                 </div>
                 <button onClick={() => editorRef.current?.focus()} className="bg-indigo-600 text-white px-8 py-3 rounded-full font-black hover:bg-indigo-700 shadow-lg uppercase tracking-widest text-[10px]">{t('revise')}</button>
              </div>
            </div>
            {shouldShowVerification && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
                <div className="space-y-2 text-center md:text-left">
                  <h3 className="text-emerald-900 font-black flex items-center gap-2 justify-center md:justify-start text-lg uppercase tracking-tight"><i className="fas fa-check-circle"></i>{t('verification')}</h3>
                  <p className="text-emerald-800 text-sm font-bold">{t('copyHint')}</p>
                  {shouldShowSubmissionPrompt && (
                    <p className="text-emerald-900 text-sm font-semibold">{t('submissionPrompt')}</p>
                  )}
                </div>
                <div className="flex flex-col items-center gap-3">
                  <div className="bg-white px-8 py-4 rounded-xl border-2 border-dashed border-emerald-400 text-3xl font-mono font-black text-emerald-800 select-all shadow-inner">
                    {latestResult.verificationCode}
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(latestResult.verificationCode);
                      setCopyNotice(true);
                      setTimeout(() => setCopyNotice(false), 1500);
                    }}
                    className="bg-emerald-600 text-white px-6 py-2 rounded-full font-black uppercase tracking-widest text-[10px] hover:bg-emerald-700 transition-colors"
                  >
                    {copyNotice ? t('codeCopied') : t('copyCode')}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
    </div>
  );
};
