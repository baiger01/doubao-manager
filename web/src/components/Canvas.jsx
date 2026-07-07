import React, { useEffect, useRef } from 'react';
import { useCanvasState } from '../store.jsx';
import { ratioToCss, fmtTime, fmtElapsed, resolveMediaUrl } from '../lib/util.js';
import { saveMediaWithDirectoryChoice } from '../lib/media-actions.js';
import PixelReveal from './PixelReveal.jsx';
import GenLoader from './GenLoader.jsx';

// 生成中轮播的英文短语
const GEN_PHRASES = [
  'Painting your vision',
  'Mixing the colors',
  'Sketching the canvas',
  'Composing the scene',
  'Bringing it to life',
  'Rendering pixels',
  'Adding the details',
  'Almost there',
];

// 中央画布:渲染结果批次 / 占位格 / 空态
export default function Canvas() {
  const { results, setLightbox, openImageMenu, loadMoreHistory, showToast, retryJob, editJob } = useCanvasState();
  const scrollRef = useRef(null);
  const loadingRef = useRef(false);       // 防止一次滚动触发多次加载
  const keepScrollRef = useRef(null);      // 顶部加载后需保持视口的锚点(插入前 scrollHeight)
  const stickBottomRef = useRef(true);     // 用户是否贴着底部(贴底才自动跟随新内容)
  const lastConvKeyRef = useRef(null);     // 上次首批次 id,用于识别「切换会话/全新加载」

  // 滚动定位:顶部加载更早历史 → 保持原视口;切换会话 → 滚到底并重置;否则仅贴底时跟随
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (keepScrollRef.current != null) {
      const delta = el.scrollHeight - keepScrollRef.current;
      el.scrollTop = el.scrollTop + delta;
      keepScrollRef.current = null;
      lastConvKeyRef.current = results[0]?.id || null;  // 历史头 id 已变,同步避免误判换会话
      return;
    }
    // 首批次 id 变化(且非顶部加载)视为切换会话/全新加载:重置贴底并滚到底
    const firstId = results[0]?.id || null;
    if (firstId !== lastConvKeyRef.current) {
      lastConvKeyRef.current = firstId;
      stickBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [results]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 记录是否贴底(距底 60px 内算贴底)
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (loadingRef.current) return;
    if (el.scrollTop <= 40) {
      loadingRef.current = true;
      const beforeHeight = el.scrollHeight;
      const r = loadMoreHistory();
      if (r && r.loaded > 0) keepScrollRef.current = beforeHeight;
      requestAnimationFrame(() => { loadingRef.current = false; });
    }
  };

  return (
    <div className="canvas" ref={scrollRef} onScroll={onScroll}>
      {results.length === 0 ? (
        <div className="result-placeholder">
          <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1">
            <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
          </svg>
          <p>生成结果将在此显示</p>
        </div>
      ) : (
        <div className="results-container">
          {results.map(b => <Batch key={b.id} b={b} onZoom={(src) => setLightbox({ open: true, src })} onImageMenu={openImageMenu} showToast={showToast} retryJob={retryJob} editJob={editJob} />)}
        </div>
      )}
    </div>
  );
}

function Batch({ b, onZoom, onImageMenu, showToast, retryJob, editJob }) {
  if (b.kind === 'trimmed') {
    return <div className="history-trimmed">仅显示最近 {b.shown} 批,更早的 {b.hidden} 批已折叠</div>;
  }
  if (b.kind === 'generating' || b.kind === 'gen-error') {
    const cssRatio = ratioToCss(b.ratio);
    const isErr = b.kind === 'gen-error';
    return (
      <div className="result-batch">
        {b.reply ? <div className="gen-reply">{b.reply}</div> : null}
        <div className="generating-grid" style={{ '--gen-ratio': cssRatio }}>
          {Array.from({ length: b.count || 1 }).map((_, i) => (
            <div key={i} className={'gen-placeholder' + (isErr ? ' error' : '')}>
              <GenLoader style={{ animationDelay: (i * 0.4) + 's' }} />
              <div className="placeholder-label">{isErr ? '生成失败' : GEN_PHRASES[i % GEN_PHRASES.length]}</div>
            </div>
          ))}
        </div>
        {isErr ? (
          <div className="gen-error-bar">
            <span className="gen-error-msg">{b.error || '生成失败'}</span>
            {b.snapshot ? (
              <div className="gen-error-actions">
                <button className="gen-error-btn primary" onClick={() => retryJob(b.id)}>重新提交</button>
                <button className="gen-error-btn" onClick={() => editJob(b.id)}>返回编辑</button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="gen-timer">{fmtElapsed(b.elapsed || 0)}</div>
        )}
      </div>
    );
  }
  if (b.kind === 'message') {
    return (
      <div className="result-batch">
        {b.prompt ? (
          <div className="batch-header">
            <span className="batch-prompt">{b.prompt}</span>
            {b.time ? <span className="batch-time">{fmtTime(b.time)}</span> : null}
          </div>
        ) : null}
        <div className="result-grid">
          <div className="result-card msg-card fade-in">
            <div className="msg-text">{b.text}</div>
          </div>
        </div>
      </div>
    );
  }
  // result
  const cssRatio = ratioToCss(b.ratio);
  return (
    <div className="result-batch">
      <div className="batch-header">
        <span className="batch-prompt">
          {b.platformLabel ? <span className="batch-platform">{b.platformLabel}</span> : null}
          {b.prompt}
        </span>
        {b.time ? <span className="batch-time">{fmtTime(b.time)}</span> : null}
      </div>
      <div className={'result-grid' + (b.type === 'video' ? '' : ' masonry')}>
        {b.urls.map((url, i) => {
          const src = resolveMediaUrl(url);
          return b.type === 'video' ? (
            <div key={i} className={'result-card' + (b.history ? '' : ' fade-in')} style={{ aspectRatio: cssRatio }}>
              <video src={src} controls muted loop
                autoPlay={!b.history} preload={b.history ? 'none' : 'auto'} />
              <button className="card-download" title="下载视频"
                onClick={(e) => {
                  e.stopPropagation();
                  saveMediaWithDirectoryChoice(src, { mediaLabel: '视频', showToast });
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              </button>
              <div className="card-overlay"><div className="card-prompt">{b.prompt}</div></div>
            </div>
          ) : (
            <div key={i} className={'result-card photo' + (b.history ? '' : ' fade-in')}
              onContextMenu={(e) => onImageMenu(e, src)}>
              <PixelReveal src={src} alt={b.prompt} onZoom={onZoom} />
              <button className="card-download" title="下载图片"
                onClick={(e) => {
                  e.stopPropagation();
                  saveMediaWithDirectoryChoice(src, { mediaLabel: '图片', showToast });
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              </button>
              <div className="card-overlay"><div className="card-prompt">{b.prompt}</div></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
