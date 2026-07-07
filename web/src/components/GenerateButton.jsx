import React from 'react';

const GEN_WORD = 'Generate'.split('');
const GENING_WORD = 'Generating'.split('');

// 玻璃质感生成按钮:字母逐个排列,生成中翻字为 Generating
export default function GenerateButton({ onClick, generating, disabled, title }) {
  return (
    <div className="gen-btn-wrapper">
      <button
        type="button"
        className={'gen-btn' + (generating ? ' is-generating' : '')}
        onClick={onClick}
        disabled={disabled}
        title={title}
      >
        <svg className="gen-btn-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
        </svg>

        <div className="gen-txt-wrapper">
          <div className="gen-txt gen-txt-1">
            {GEN_WORD.map((c, i) => (
              <span key={i} className="gen-letter" style={{ '--i': i }}>{c}</span>
            ))}
          </div>
          <div className="gen-txt gen-txt-2">
            {GENING_WORD.map((c, i) => (
              <span key={i} className="gen-letter" style={{ '--i': i }}>{c}</span>
            ))}
          </div>
        </div>
      </button>
    </div>
  );
}
