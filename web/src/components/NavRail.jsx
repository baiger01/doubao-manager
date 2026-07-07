import React, { useState } from 'react';
import { useNavRailState } from '../store.jsx';
import { WEB_TOOLS } from '../lib/webTools.jsx';
import LiquidGlass from './LiquidGlass.jsx';

// 常驻会话侧栏:品牌 + 平台切换 + 新建绘画 + 会话列表 + 账号入口
export default function NavRail({ onOpenAccounts, accountsOpen }) {
  const {
    connected, activeAccount, status,
    conversations, newConversation, selectConversation, renameConversation, deleteConversation,
    setSettingsOpen, view, setView,
  } = useNavRailState();

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('railCollapsed') === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('railCollapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  };
  const toolActiveIndex = (() => {
    const i = WEB_TOOLS.findIndex(t => t.key === view);
    if (i >= 0) return i;
    if (view === 'claude') return WEB_TOOLS.length;
    if (view === 'logs') return WEB_TOOLS.length + 1;
    return 0;
  })();
  const toolActive = view === 'logs' || view === 'claude' || WEB_TOOLS.some(t => t.key === view);

  // 左上角只放短状态,完整状态统一进日志页,避免长文本挤占侧栏。
  const IDLE_TEXTS = ['就绪', '未连接', '启动中...'];
  const busy = status && status.text && !IDLE_TEXTS.includes(status.text);
  const statusBrief = status?.type === 'error' ? '出错' : (status?.type === 'generating' ? '生成中' : '有状态');

  return (
    <LiquidGlass radius={18} blur={16} strength={36} tint="rgba(255,255,255,0.07)" className={'nav-rail' + (collapsed ? ' collapsed' : '')}>
      {/* 顶部:品牌 + 平台切换 */}
      <div className="rail-head">
        <div className="rail-brand">
          <span className={'conn-dot' + (connected ? ' connected' : '')} title={connected ? '已连接' : '未连接'} />
          {busy ? (
            <span className={'rail-brand-status ' + (status.type || 'ready')} title={status.text}>{statusBrief}</span>
          ) : (
            <>
              <span className="rail-brand-name">lulu</span>
              <span className="rail-brand-ver">v{__APP_VERSION__}</span>
            </>
          )}
          <button className="rail-collapse-btn" onClick={toggleCollapsed} title={collapsed ? '展开侧栏' : '收起侧栏'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {collapsed
                ? <path d="M9 18l6-6-6-6" />
                : <path d="M15 18l-6-6 6-6" />}
            </svg>
          </button>
        </div>

        <button className="rail-new" onClick={newConversation} title="新建会话">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.45L3.5 20.5l1.55-4.9A8.5 8.5 0 1 1 21 11.5Z" />
            <path d="M12 8.2v6.6M8.7 11.5h6.6" />
          </svg>
          <span className="rail-new-text">新建会话</span>
        </button>

        <div className="rail-seg"
          style={{ '--seg-count': WEB_TOOLS.length + 2, '--seg-active': toolActiveIndex }}>
          <span className={'seg-thumb' + (!toolActive ? ' hidden' : '')} />
          {WEB_TOOLS.map(t => (
            <button key={t.key}
              className={'seg-option' + (view === t.key ? ' active' : '')}
              onClick={() => setView(t.key)} title={t.label}>
              {t.icon()}
              <span className="rail-tool-text">{t.label}</span>
            </button>
          ))}
          <button key="claude"
            className={'seg-option' + (view === 'claude' ? ' active' : '')}
            onClick={() => setView('claude')} title="Claude 对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.4c.35 0 .64.26.68.6l.63 5.05 3.6-3.6a.69.69 0 0 1 .97.97l-3.6 3.6 5.05.63a.69.69 0 0 1 0 1.36l-5.05.63 3.6 3.6a.69.69 0 0 1-.97.97l-3.6-3.6-.63 5.05a.69.69 0 0 1-1.36 0l-.63-5.05-3.6 3.6a.69.69 0 0 1-.97-.97l3.6-3.6-5.05-.63a.69.69 0 0 1 0-1.36l5.05-.63-3.6-3.6a.69.69 0 0 1 .97-.97l3.6 3.6.63-5.05c.04-.34.33-.6.68-.6Z" /></svg>
            <span className="rail-tool-text">Claude</span>
          </button>
          <button key="logs"
            className={'seg-option' + (view === 'logs' ? ' active' : '')}
            onClick={() => setView('logs')} title="日志">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16" />
              <path d="M4 12h16" />
              <path d="M4 19h10" />
            </svg>
            <span className="rail-tool-text">日志</span>
          </button>
        </div>
      </div>

      {/* 中部:会话列表 */}
      <div className="rail-convs">
        {conversations.length === 0 ? (
          <div className="rail-conv-empty">暂无会话</div>
        ) : conversations.map(conv => (
          <div key={conv.id} className={'rail-conv-item' + (conv.isActive ? ' active' : '')}>
            <button className="rail-conv-name" onClick={() => selectConversation(conv.id)} onDoubleClick={() => renameConversation(conv.id)} title={conv.name}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.45L3.5 20.5l1.55-4.9A8.5 8.5 0 1 1 21 11.5Z" /></svg>
              <span className="rail-conv-text">{conv.name}</span>
            </button>
            <button className="rail-conv-del" title="删除会话"
              onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}>&times;</button>
          </div>
        ))}
      </div>

      {/* 底部:设置 + 账号入口 */}
      <div className="rail-foot">
        <button className="rail-settings-btn" title="设置" onClick={() => setSettingsOpen(true)}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button className={'rail-account-btn' + (accountsOpen ? ' active' : '')} onClick={onOpenAccounts}>
          <span className="rail-avatar">{activeAccount ? String(activeAccount.seq || '?') : '?'}</span>
          <span className="rail-account-name">{activeAccount ? activeAccount.displayName : '未登录'}</span>
        </button>
      </div>
    </LiquidGlass>
  );
}


