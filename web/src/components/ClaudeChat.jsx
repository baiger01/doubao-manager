import React, { useRef, useState, useEffect } from 'react';
import { useStore } from '../store.jsx';
import LiquidGlass from './LiquidGlass.jsx';

// Claude 文本对话视图(ChatGPT 布局):居中消息流 + 底部悬浮输入。
// 未配置(无 apiKey/model)时,中央引导去设置里配置。
export default function ClaudeChat() {
  const {
    claudeMessages, claudeSending, claudeConfig,
    sendClaudeMessage, stopClaude, clearClaudeChat,
    openSettings, setView,
  } = useStore();

  const [text, setText] = useState('');
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const stickRef = useRef(true);

  // 自动撑高输入框
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  // 贴底自动跟随流式输出
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [claudeMessages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const doSend = () => {
    if (claudeSending) return;
    const ok = sendClaudeMessage(text);
    if (ok) { setText(''); stickRef.current = true; }
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  };

  const configured = claudeConfig && claudeConfig.configured;
  const empty = claudeMessages.length === 0;

  return (
    <div className="claude-chat">
      {/* 顶部条:标题 + 模型 + 操作 */}
      <LiquidGlass radius={14} blur={20} strength={32} tint="rgba(255,255,255,0.07)" className="claude-bar">
        <div className="claude-bar-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4c.35 0 .64.26.68.6l.63 5.05 3.6-3.6a.69.69 0 0 1 .97.97l-3.6 3.6 5.05.63a.69.69 0 0 1 0 1.36l-5.05.63 3.6 3.6a.69.69 0 0 1-.97.97l-3.6-3.6-.63 5.05a.69.69 0 0 1-1.36 0l-.63-5.05-3.6 3.6a.69.69 0 0 1-.97-.97l3.6-3.6-5.05-.63a.69.69 0 0 1 0-1.36l5.05-.63-3.6-3.6a.69.69 0 0 1 .97-.97l3.6 3.6.63-5.05c.04-.34.33-.6.68-.6Z" /></svg>
          <span>Claude</span>
          {claudeConfig?.model ? <span className="claude-model-tag">{claudeConfig.model}</span> : null}
        </div>
        <div className="claude-bar-actions">
          <button className="claude-bar-btn" title="对话设置" onClick={() => openSettings('claude')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </button>
          <button className="claude-bar-btn" title="清空对话" onClick={clearClaudeChat} disabled={empty}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
          </button>
          <button className="claude-bar-btn claude-bar-close" title="返回生成台" onClick={() => setView('studio')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </LiquidGlass>

      {/* 消息流 */}
      <div className="claude-scroll" ref={scrollRef} onScroll={onScroll}>
        {!configured ? (
          <div className="claude-welcome">
            <div className="claude-welcome-logo">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4c.35 0 .64.26.68.6l.63 5.05 3.6-3.6a.69.69 0 0 1 .97.97l-3.6 3.6 5.05.63a.69.69 0 0 1 0 1.36l-5.05.63 3.6 3.6a.69.69 0 0 1-.97.97l-3.6-3.6-.63 5.05a.69.69 0 0 1-1.36 0l-.63-5.05-3.6 3.6a.69.69 0 0 1-.97-.97l3.6-3.6-5.05-.63a.69.69 0 0 1 0-1.36l5.05-.63-3.6-3.6a.69.69 0 0 1 .97-.97l3.6 3.6.63-5.05c.04-.34.33-.6.68-.6Z" /></svg>
            </div>
            <h2>还没配置 Claude</h2>
            <p>在设置里填写 Base URL 与 API Key,获取并选择模型后即可开始对话。</p>
            <button className="btn-primary" onClick={() => openSettings('claude')}>去配置</button>
          </div>
        ) : empty ? (
          <div className="claude-welcome">
            <div className="claude-welcome-logo">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4c.35 0 .64.26.68.6l.63 5.05 3.6-3.6a.69.69 0 0 1 .97.97l-3.6 3.6 5.05.63a.69.69 0 0 1 0 1.36l-5.05.63 3.6 3.6a.69.69 0 0 1-.97.97l-3.6-3.6-.63 5.05a.69.69 0 0 1-1.36 0l-.63-5.05-3.6 3.6a.69.69 0 0 1-.97-.97l3.6-3.6-5.05-.63a.69.69 0 0 1 0-1.36l5.05-.63-3.6-3.6a.69.69 0 0 1 .97-.97l3.6 3.6.63-5.05c.04-.34.33-.6.68-.6Z" /></svg>
            </div>
            <h2>有什么可以帮你的?</h2>
            <p>输入消息开始与 Claude 对话</p>
          </div>
        ) : (
          <div className="claude-messages">
            {claudeMessages.map(m => (
              <div key={m.id} className={'claude-msg ' + m.role}>
                <div className="claude-msg-avatar">
                  {m.role === 'user' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4c.35 0 .64.26.68.6l.63 5.05 3.6-3.6a.69.69 0 0 1 .97.97l-3.6 3.6 5.05.63a.69.69 0 0 1 0 1.36l-5.05.63 3.6 3.6a.69.69 0 0 1-.97.97l-3.6-3.6-.63 5.05a.69.69 0 0 1-1.36 0l-.63-5.05-3.6 3.6a.69.69 0 0 1-.97-.97l3.6-3.6-5.05-.63a.69.69 0 0 1 0-1.36l5.05-.63-3.6-3.6a.69.69 0 0 1 .97-.97l3.6 3.6.63-5.05c.04-.34.33-.6.68-.6Z" /></svg>
                  )}
                </div>
                <div className="claude-msg-body">
                  {m.content ? <div className="claude-msg-text">{m.content}</div> : null}
                  {m.streaming && !m.content ? <div className="claude-typing"><span /><span /><span /></div> : null}
                  {m.streaming && m.content ? <span className="claude-cursor" /> : null}
                  {m.error ? <div className="claude-msg-error">{m.error}</div> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部输入 */}
      <div className="claude-input-wrap">
        <LiquidGlass radius={24} blur={18} strength={50} tint="rgba(255,255,255,0.08)" className="claude-input-pod">
          <textarea
            ref={taRef}
            className="claude-input"
            rows={1}
            placeholder={configured ? '给 Claude 发送消息...' : '请先在设置中配置 Claude'}
            value={text}
            disabled={!configured}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {claudeSending ? (
            <button className="claude-send stop" title="停止" onClick={stopClaude}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <button className="claude-send" title="发送" onClick={doSend} disabled={!configured || !text.trim()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7Z" /></svg>
            </button>
          )}
        </LiquidGlass>
        <div className="claude-input-hint">Enter 发送 · Shift+Enter 换行</div>
      </div>
    </div>
  );
}
