import React, { useRef, useState, useEffect } from 'react';
import { useInputPodState } from '../store.jsx';
import { refFileLabel } from '../lib/util.js';
import { platformSupportsImage, platformSupportsVideo } from '../lib/platform-capabilities.js';
import LiquidGlass from './LiquidGlass.jsx';
import GenerateButton from './GenerateButton.jsx';
import { IMAGE_RATIOS, VIDEO_RATIOS, VIDEO_DURATIONS, VIDEO_MOVEMENTS, IMAGE_STYLES } from '../lib/options.js';

// 悬浮输入舱:模式切换 + 内联参数 + 参考图 + 文本框 + 生成
export default function InputPod() {
  const {
    refImages, addRefImageFiles, removeRefImage, clearRefImages, submitPrompt,
    mode, setMode, params, setParams, curPlatformCfg, pendingJobs,
    inputDraft, setInputDraft,
  } = useInputPodState();
  const generating = Object.keys(pendingJobs || {}).length > 0;
  const [text, setText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const taRef = useRef(null);

  // 「返回编辑」回填:store 推来草稿文本后填入输入框并聚焦(refImages/params 已在 store 里写好)
  useEffect(() => {
    if (!inputDraft) return;
    setText(inputDraft.text || '');
    setInputDraft(null);
    requestAnimationFrame(() => taRef.current?.focus());
  }, [inputDraft, setInputDraft]);

  const cfg = curPlatformCfg();
  const imgModels = cfg.imageModels || [];
  const vidModels = cfg.videoModels || [];
  const supportsImage = platformSupportsImage(cfg);
  const supportsVideo = platformSupportsVideo(cfg);
  const supportsImageCount = cfg.key === 'plus' || cfg.key === '4k';
  const setP = (patch) => setParams(p => ({ ...p, ...patch }));

  useEffect(() => {
    if (!supportsImage && mode === 'image' && supportsVideo) setMode('video');
    if (!supportsVideo && mode === 'video' && supportsImage) setMode('image');
  }, [supportsImage, supportsVideo, mode, setMode]);

  // 自动撑高文本框
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [text]);

  // 阻止 Electron 默认拖放打开文件
  useEffect(() => {
    const prevent = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);

  const doGenerate = () => {
    const ok = submitPrompt(text);
    if (ok) setText('');
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doGenerate(); }
  };
  const onPaste = (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); addRefImageFiles(files); }
  };

  const needsSubject = params.videoMovement === 'pan' || params.videoMovement === 'zoom';
  const needsDirection = params.videoMovement === 'move';

  return (
    <LiquidGlass
      radius={26}
      blur={18}
      strength={50}
      tint="rgba(255,255,255,0.08)"
      className={'input-pod' + (dragOver ? ' drag-over' : '')}
      onDragEnter={(e) => { if (e.dataTransfer?.types?.includes?.('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes?.('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(false);
        if (e.dataTransfer?.files?.length) addRefImageFiles(e.dataTransfer.files);
      }}
    >
      {/* 模式切换 */}
      <div className="pod-modes">
        <button className={'pod-mode' + (mode === 'image' ? ' active' : '')}
          onClick={() => supportsImage && setMode('image')}
          disabled={!supportsImage}
          title={supportsImage ? '图片生成' : '当前平台不支持图片生成'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
          <span>图片生成</span>
        </button>
        <button className={'pod-mode' + (mode === 'video' ? ' active' : '')} onClick={() => supportsVideo && setMode('video')} disabled={!supportsVideo} title={supportsVideo ? '视频生成' : '当前平台不支持视频生成'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
          <span>视频生成</span>
        </button>
      </div>

      {refImages.length > 0 && (
        <div className="ref-images-bar">
          <div className="ref-images-list">
            {refImages.map((img, i) => (
              <div key={i} className="ref-thumb"
                title={`文件名「${img.name}」→ 脚本里 @图片[..] 会自动改写成 @image${i + 1}`}>
                <img src={img.dataUrl} alt={img.name} />
                <span className="ref-index">@image{i + 1}</span>
                <span className="ref-file">{refFileLabel(img.name)}</span>
                <button className="remove-ref" onClick={() => removeRefImage(i)}>&times;</button>
              </div>
            ))}
          </div>
          <button className="btn-clear-refs" onClick={() => { clearRefImages(); setText(''); taRef.current?.focus(); }}>清除全部</button>
        </div>
      )}

      <div className="input-row">
        <label className="btn-upload" title="上传参考图">
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { addRefImageFiles(e.target.files); e.target.value = ''; }} />
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
        </label>

        <textarea
          ref={taRef}
          className="prompt-input"
          placeholder={mode === 'image' ? '描述你想生成的图片...' : '描述你想生成的视频...'}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <GenerateButton onClick={doGenerate} generating={generating} title="生成" />
      </div>

      {/* 内联参数条 */}
      <div className="pod-params">
        {mode === 'image' ? (
          <>
            <PodSelect label="比例" value={params.imageRatio} onChange={(v) => setP({ imageRatio: v })}
              options={IMAGE_RATIOS.map(r => ({ value: r, label: r }))} />
            <PodSelect label="风格" value={params.imageStyle} onChange={(v) => setP({ imageStyle: v })}
              options={IMAGE_STYLES} />
            <PodSelect label="模型" value={params.imageModel} onChange={(v) => setP({ imageModel: v })}
              options={imgModels.length ? imgModels : [{ value: '', label: '默认' }]} />
            {supportsImageCount && (
              <PodSelect label="数量" value={params.imageCount} onChange={(v) => setP({ imageCount: parseInt(v) || 1 })}
                options={[1, 2, 3, 4].map(n => ({ value: n, label: String(n) }))} />
            )}
          </>
        ) : (
          <>
            <PodSelect label="比例" value={params.videoRatio} onChange={(v) => setP({ videoRatio: v })}
              options={VIDEO_RATIOS.map(r => ({ value: r, label: r }))} />
            <PodSelect label="时长" value={params.videoDuration} onChange={(v) => setP({ videoDuration: parseInt(v) })}
              options={VIDEO_DURATIONS.map(d => ({ value: d.value, label: d.label }))} />
            <PodSelect label="镜头" value={params.videoMovement} onChange={(v) => setP({ videoMovement: v })}
              options={VIDEO_MOVEMENTS} />
            {needsSubject && (
              <input className="pod-text" type="text" placeholder="主体,如:小猫"
                value={params.videoMovementSubject} onChange={(e) => setP({ videoMovementSubject: e.target.value.trim() })} />
            )}
            {needsDirection && (
              <input className="pod-text" type="text" placeholder="方向,如:前方"
                value={params.videoMovementDirection} onChange={(e) => setP({ videoMovementDirection: e.target.value.trim() })} />
            )}
            <PodSelect label="模型" value={params.videoModel} onChange={(v) => setP({ videoModel: v })}
              options={vidModels.length ? vidModels : [{ value: '', label: '默认' }]} />
          </>
        )}
      </div>
    </LiquidGlass>
  );
}

// 内联参数下拉:自绘弹层,完全适配暗色主题(原生 select 在 Windows 下拉层无法可靠改色)
function PodSelect({ label, value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const cur = options.find(o => String(o.value) === String(value)) || options[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className={'pod-select' + (open ? ' open' : '')} ref={rootRef}>
      <span className="pod-select-label">{label}</span>
      <button type="button" className="pod-select-btn" onClick={() => setOpen(o => !o)}>
        <span className="pod-select-val">{cur ? cur.label : ''}</span>
        <svg className="pod-select-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="pod-select-menu">
          {options.map(o => (
            <button
              key={String(o.value)}
              type="button"
              className={'pod-select-opt' + (String(o.value) === String(value) ? ' active' : '')}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
