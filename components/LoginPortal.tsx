
import React from 'react';

interface LoginPortalProps {
  onLogin: () => void;
  language: 'sv' | 'en';
  error?: string | null;
}

export const LoginPortal: React.FC<LoginPortalProps> = ({ onLogin, language, error }) => {

  const translations = {
    title: { sv: 'Lärarlogin', en: 'Teacher Login' },
    subtitle: { sv: 'Logga in med din Google Workspace för att hantera agenter och se studentinsikter.', en: 'Sign in with Google Workspace to manage agents and view student insights.' },
    googleBtn: { sv: 'Fortsätt med Google', en: 'Continue with Google' },
    securityNote: { sv: 'Endast behöriga lärare har tillgång till portalen.', en: 'Only authorized teachers have access to the portal.' }
  };

  const t = (key: keyof typeof translations) => translations[key][language];

  return (
    <div className="max-w-md mx-auto mt-20 animate-in fade-in zoom-in-95 duration-500">
      <div className="bg-white rounded-[3rem] p-12 shadow-2xl border border-gray-100 text-center space-y-8">
        <div className="flex justify-center">
          <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center shadow-xl shadow-indigo-100 rotate-3">
            <i className="fas fa-lock text-3xl text-white"></i>
          </div>
        </div>
        
        <div className="space-y-2">
          <h2 className="text-3xl font-black text-gray-900 uppercase tracking-tight">{t('title')}</h2>
          <p className="text-gray-500 font-medium text-sm leading-relaxed">{t('subtitle')}</p>
        </div>

        <button 
          onClick={() => onLogin()}
          className="w-full flex items-center justify-center gap-4 bg-indigo-600 border-2 border-indigo-600 py-4 px-6 rounded-2xl font-black text-white hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 group"
        >
          <span className="uppercase tracking-widest text-[11px]">{t('googleBtn')}</span>
        </button>

        {error && (
          <p className="text-[10px] text-red-600 font-bold uppercase tracking-widest">{error}</p>
        )}

        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest pt-4">
          <i className="fas fa-shield-alt mr-2"></i> {t('securityNote')}
        </p>
      </div>
    </div>
  );
};
