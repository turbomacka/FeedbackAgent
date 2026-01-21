import React, { useState } from 'react';

interface TeacherTosModalProps {
  language: 'sv' | 'en';
  onLanguageChange: (language: 'sv' | 'en') => void;
  onAccept: () => Promise<void>;
  loading?: boolean;
}

export const TeacherTosModal: React.FC<TeacherTosModalProps> = ({ language, onLanguageChange, onAccept, loading }) => {
  const [checked, setChecked] = useState(false);

  const translations = {
    title: {
      sv: 'Viktigt innan du fortsätter',
      en: 'Important before you continue'
    },
    subtitle: {
      sv: 'Läs igenom och bekräfta villkoren för att få åtkomst till lärarvyn.',
      en: 'Review and accept the terms to access the teacher dashboard.'
    },
    accept: {
      sv: 'Jag har läst och accepterar',
      en: 'I have read and accept'
    },
    button: {
      sv: 'Acceptera',
      en: 'Accept'
    },
    points: {
      copyright: {
        title: { sv: 'Upphovsrätt', en: 'Copyright' },
        body: {
          sv: 'Du ansvarar för att material du laddar upp följer upphovsrätt och lokala licensavtal.',
          en: 'You are responsible for ensuring uploaded material complies with copyright and local licenses.'
        }
      },
      anonymity: {
        title: { sv: 'Anonymitet', en: 'Anonymity' },
        body: {
          sv: 'Elever använder en anonym länk. Ingen identitet sparas utan att eleven själv lämnar in verifieringskod.',
          en: 'Students use an anonymous link. No identity is stored unless the student submits a verification code.'
        }
      },
      pedagogy: {
        title: { sv: 'Pedagogiskt beslutsstöd', en: 'Pedagogical decision support' },
        body: {
          sv: 'AI-feedback är formativt stöd och ersätter inte lärarens professionella bedömning.',
          en: 'AI feedback is formative support and does not replace the teacher’s professional judgment.'
        }
      },
      gdpr: {
        title: { sv: 'GDPR & personuppgifter', en: 'GDPR & personal data' },
        body: {
          sv: 'Dela aldrig känsliga personuppgifter eller sekretessbelagt material. All text bearbetas av externa AI-modeller.',
          en: 'Never share sensitive personal data or confidential content. All text is processed by external AI models.'
        }
      }
    }
  };

  const t = (key: keyof typeof translations) => translations[key][language];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 w-full max-w-2xl p-10 space-y-8">
        <div className="flex justify-end">
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
        </div>

        <div className="space-y-2 text-center">
          <h2 className="text-2xl font-black text-slate-900 uppercase tracking-tight">{t('title')}</h2>
          <p className="text-sm font-semibold text-slate-500">{t('subtitle')}</p>
        </div>

        <div className="space-y-5">
          {(['copyright', 'anonymity', 'pedagogy', 'gdpr'] as const).map(key => (
            <div key={key} className="bg-slate-50 border border-slate-100 rounded-2xl p-5">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-900">
                {translations.points[key].title[language]}
              </p>
              <p className="text-sm text-slate-600 font-medium mt-2">
                {translations.points[key].body[language]}
              </p>
            </div>
          ))}
        </div>

        <label className="flex items-center gap-3 text-sm font-semibold text-slate-700">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="accent-indigo-600"
          />
          {t('accept')}
        </label>

        <button
          type="button"
          disabled={!checked || loading}
          onClick={() => checked && onAccept()}
          className={`w-full py-4 rounded-2xl font-black uppercase tracking-widest text-[11px] text-white ${
            !checked || loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'
          }`}
        >
          {t('button')}
        </button>
      </div>
    </div>
  );
};
