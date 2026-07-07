import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { copyImageToClipboardWithTimeout, saveMediaWithDirectoryChoice } from '../lib/media-actions.js';

// 图片右键菜单:复制图片到剪贴板 / 下载图片。
// 定位用 fixed + clientX/Y,超出视口边缘时自动回拉。
export default function ImageContextMenu() {
  const { imageMenu, closeImageMenu, showToast } = useStore();
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    setCopying(false);
  }, [imageMenu.open, imageMenu.src]);

  useEffect(() => {
    if (!imageMenu.open) return;
    const onDown = (e) => { if (!menuRef.current || !menuRef.current.contains(e.target)) closeImageMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') closeImageMenu(); };
    const onScroll = () => closeImageMenu();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onScroll);
    };
  }, [imageMenu.open, closeImageMenu]);

  // 打开后按菜单实际尺寸做边缘回拉
  useEffect(() => {
    if (!imageMenu.open) return;
    const el = menuRef.current;
    const w = el ? el.offsetWidth : 168;
    const h = el ? el.offsetHeight : 96;
    const pad = 8;
    const x = Math.min(imageMenu.x, window.innerWidth - w - pad);
    const y = Math.min(imageMenu.y, window.innerHeight - h - pad);
    setPos({ x: Math.max(pad, x), y: Math.max(pad, y) });
  }, [imageMenu.open, imageMenu.x, imageMenu.y]);

  if (!imageMenu.open) return null;

  const onCopy = async () => {
    if (copying) return;
    setCopying(true);
    try {
      await copyImageToClipboardWithTimeout(imageMenu.src);
      showToast('图片已复制到剪贴板');
      closeImageMenu();
    } catch (err) {
      showToast('复制失败: ' + (err?.message || err));
    } finally {
      setCopying(false);
    }
  };

  const onDownload = () => {
    saveMediaWithDirectoryChoice(imageMenu.src, { mediaLabel: '图片', showToast });
    closeImageMenu();
  };

  return (
    <div ref={menuRef} className="img-ctx-menu" style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}>
      <button className="img-ctx-item" onClick={onCopy} disabled={copying}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        <span>{copying ? '复制中…' : '复制图片'}</span>
      </button>
      <button className="img-ctx-item" onClick={onDownload}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span>下载图片</span>
      </button>
    </div>
  );
}
