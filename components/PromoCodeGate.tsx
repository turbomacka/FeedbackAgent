import React, { useEffect, useRef, useState } from 'react';

interface PromoCodeGateProps {
  language: 'sv' | 'en';
  onSubmit: (code: string) => Promise<void>;
  error?: string | null;
  loading?: boolean;
}

export const PromoCodeGate: React.FC<PromoCodeGateProps> = ({ language, onSubmit, error, loading }) => {
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const translations = {
    title: {
      sv: 'Auktorisering krävs',
      en: 'Authorization required'
    },
    subtitle: {
      sv: 'Ange promo-kod för att aktivera ditt konto.',
      en: 'Enter promo code to activate your account.'
    },
    placeholder: {
      sv: 'Promo-kod',
      en: 'Promo code'
    },
    action: {
      sv: 'Aktivera konto',
      en: 'Activate account'
    }
  };

  const t = (key: keyof typeof translations) => translations[key][language];

  return (
    <div className="max-w-md mx-auto mt-20 animate-in fade-in zoom-in-95 duration-500">
      <div className="bg-white rounded-[3rem] p-12 shadow-2xl border border-gray-100 text-center space-y-8">
        <div className="flex justify-center">
          <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center shadow-xl shadow-indigo-100 rotate-2">
            <i className="fas fa-key text-3xl text-white"></i>
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-3xl font-black text-gray-900 uppercase tracking-tight">{t('title')}</h2>
          <p className="text-gray-500 font-medium text-sm leading-relaxed">{t('subtitle')}</p>
        </div>

        <div className="space-y-3">
          <input
            ref={inputRef}
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t('placeholder')}
            className="w-full px-6 py-4 rounded-2xl border border-gray-200 bg-gray-50 font-black uppercase tracking-widest text-gray-900 placeholder:text-gray-400 text-center"
          />
          <button
            onClick={() => onSubmit(code)}
            disabled={loading || !code.trim()}
            className={`w-full py-4 rounded-2xl font-black uppercase tracking-widest text-[11px] text-white ${
              loading || !code.trim() ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {t('action')}
          </button>
        </div>

        {error && (
          <p className="text-[10px] text-red-600 font-bold uppercase tracking-widest">{error}</p>
        )}
      </div>
    </div>
  );
};
