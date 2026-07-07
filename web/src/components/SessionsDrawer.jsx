import React from 'react';
import { useStore } from '../store.jsx';
import LiquidGlass from './LiquidGlass.jsx';

export default function SessionsDrawer({ open, onClose }) {
  const {
    conversations, activeConversation, newConversation,
    selectConversation, renameConversation, deleteConversation, curPlatformCfg,
  } = useStore();

  return (
    <div className={'drawer-wrap left' + (open ? ' open' : '')}>
      <div className="drawer-scrim" onClick={onClose} />
      <LiquidGlass radius={22} blur={20} strength={40} tint="rgba(255,255,255,0.06)" className="drawer sessions-drawer">
        <div className="drawer-header">
          <h3>会话 · {curPlatformCfg().label}</h3>
          <div className="drawer-header-actions">
            <button className="drawer-add" title="新建会话" onClick={newConversation}>+</button>
            <button className="drawer-close" onClick={onClose}>&times;</button>
          </div>
        </div>
        <div className="conv-list">
          {conversations.length === 0 ? (
            <div className="conv-empty">暂无会话</div>
          ) : conversations.map(conv => (
            <div key={conv.id} className={'conv-item' + (conv.isActive ? ' active' : '')}>
              <div className="conv-name" onClick={() => selectConversation(conv.id)} onDoubleClick={() => renameConversation(conv.id)}>
                {conv.name}
              </div>
              <div className="conv-meta">{conv.messageCount || 0}条消息</div>
              <button className="conv-delete" title="删除会话"
                onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}>&times;</button>
            </div>
          ))}
        </div>
      </LiquidGlass>
    </div>
  );
}
