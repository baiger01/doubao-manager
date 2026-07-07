import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store.jsx';

// 自定义输入/确认弹窗(Electron 禁用了原生 prompt/confirm)
export default function AskDialog() {
  const { ask, resolveAsk } = useStore();
  const [val, setVal] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (ask?.kind === 'input') {
      setVal(ask.value || '');
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    }
  }, [ask]);

  if (!ask) return null;

  const ok = () => resolveAsk(ask.kind === 'input' ? val : true);
  const cancel = () => resolveAsk(ask.kind === 'input' ? null : false);

  return (
    <div className="ask-overlay" onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className="ask-box">
        <div className="ask-title">{ask.title || (ask.kind === 'input' ? '输入' : '确认')}</div>
        <div className="ask-label">{ask.label || ''}</div>
        {ask.kind === 'input' && (
          <input ref={inputRef} className="ask-input" type="text" value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ok(); else if (e.key === 'Escape') cancel(); }} />
        )}
        <div className="ask-actions">
          <button className="ask-btn ask-cancel" onClick={cancel}>取消</button>
          <button className="ask-btn ask-ok" onClick={ok}>确定</button>
        </div>
      </div>
    </div>
  );
}
