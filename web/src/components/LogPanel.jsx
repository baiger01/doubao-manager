import React from 'react';
import { useLogPanelState } from '../store.jsx';
import LiquidGlass from './LiquidGlass.jsx';

function formatTime(time) {
  try {
    return new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function typeLabel(type) {
  if (type === 'error') return '错误';
  if (type === 'generating') return '生成';
  return '状态';
}

function sourceLabel(source) {
  if (source === 'toast') return '提示';
  if (source === 'ws') return '推送';
  if (source === 'test') return '测试';
  return '系统';
}

export default function LogPanel() {
  const { status, statusLog, clearStatusLog } = useLogPanelState();
  const items = [...(statusLog || [])].reverse();

  return (
    <div className="log-panel">
      <LiquidGlass radius={14} blur={14} strength={34} tint="rgba(255,255,255,0.08)" className="log-bar">
        <div className="log-bar-title">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5h16" />
            <path d="M4 12h16" />
            <path d="M4 19h10" />
          </svg>
          <span>日志</span>
          <span className={'log-current log-type-' + (status?.type || 'ready')}>{status?.text || '就绪'}</span>
        </div>
        <button className="log-clear-btn" onClick={clearStatusLog} title="清空日志">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M6 6l1 15h10l1-15" />
          </svg>
        </button>
      </LiquidGlass>

      <div className="log-scroll">
        <div className="log-list">
          {items.length === 0 ? (
            <div className="log-empty">暂无日志</div>
          ) : items.map(item => (
            <div key={item.id} className={'log-item log-type-' + (item.type || 'ready')}>
              <div className="log-time">{formatTime(item.time)}</div>
              <div className="log-tags">
                <span className="log-type-tag">{typeLabel(item.type)}</span>
                <span className="log-source-tag">{sourceLabel(item.source)}</span>
              </div>
              <div className="log-text">{item.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
