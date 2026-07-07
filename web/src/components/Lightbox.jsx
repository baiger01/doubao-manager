import React, { useEffect } from 'react';
import { useStore } from '../store.jsx';
import { saveMediaWithDirectoryChoice } from '../lib/media-actions.js';

export default function Lightbox() {
  const { lightbox, setLightbox, openImageMenu, showToast } = useStore();
  const close = () => setLightbox({ open: false, src: '' });

  useEffect(() => {
    if (!lightbox.open) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox.open]); // eslint-disable-line

  if (!lightbox.open) return null;
  return (
    <div className="lightbox" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <button className="lightbox-download" title="下载图片"
        onClick={(e) => {
          e.stopPropagation();
          saveMediaWithDirectoryChoice(lightbox.src, { mediaLabel: '图片', showToast });
        }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
      </button>
      <span className="lightbox-close" onClick={close}>&times;</span>
      <img src={lightbox.src} alt="预览" onContextMenu={(e) => openImageMenu(e, lightbox.src)} />
    </div>
  );
}
