import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { mergeRuntimeIntoHistory, appendPendingBatchIfActive, jobMatchesConversation } from '../lib/conversation-results.js';
import {
  supportsAccountlessMode,
  platformSupportsReferenceImages,
  accountlessReferenceImageMessage,
  unsupportedModeMessage
} from '../lib/platform-capabilities.js';

let batchSeq = 0;
const nextBatchId = () => `b${Date.now()}_${batchSeq++}`;

export function useConversationGenerationDomain(deps) {
  const {
    setView, platformRef, activeAccountRef,
    setConversations, setActiveConversation, activeConvRef, conversationsRef,
    pendingJobsRef, setPendingJobs, setResults, setStatus,
    showToast, setMode, setParams, setRefImages,
    setInputDraft, setAccountModalOpen,
  } = deps;

  const {
    historyRawRef, historyRenderCountRef, resultsLoadSeqRef,
    buildHistoryBatches, modeRef, paramsRef, refImagesRef,
    platformsRef, resultsRef, curPlatformCfg,
  } = deps;

  const MAX_HISTORY_RENDER = 8;
  const HISTORY_PAGE = 8;

  const rebuildVisibleResults = useCallback((convOverride, pendingOverride, now = Date.now()) => {
    const conv = convOverride !== undefined ? convOverride : activeConvRef.current;
    if (!conv) {
      setResults([]);
      return;
    }
    const pending = pendingOverride !== undefined ? pendingOverride : pendingJobsRef.current;
    const hist = buildHistoryBatches(historyRawRef.current, historyRenderCountRef.current);
    setResults(mergeRuntimeIntoHistory(hist, pending, conv.id, now));
  }, [activeConvRef, buildHistoryBatches, historyRawRef, historyRenderCountRef, pendingJobsRef, setResults]);

  const loadConversations = useCallback(async (acctOverride) => {
    const acct = acctOverride !== undefined ? acctOverride : activeAccountRef.current;
    const accountId = acct ? acct.id : '';
    const result = await api.getConversations(platformRef.current, accountId);
    if (!result.success) return;
    setConversations(result.data);
    const act = result.data.find(c => c.isActive) || result.data[0] || null;
    setActiveConversation(act);
    return act;
  }, [activeAccountRef, platformRef, setActiveConversation, setConversations]);

  const loadConversationResults = useCallback(async (convOverride) => {
    const loadSeq = ++resultsLoadSeqRef.current;
    const conv = convOverride !== undefined ? convOverride : activeConvRef.current;
    if (!conv) {
      historyRawRef.current = [];
      historyRenderCountRef.current = 0;
      setResults([]);
      return;
    }
    const result = await api.getConversationResults(conv.id);
    if (loadSeq !== resultsLoadSeqRef.current) return;
    if (!result.success || !result.data || result.data.length === 0) {
      historyRawRef.current = [];
      historyRenderCountRef.current = 0;
      rebuildVisibleResults(conv, pendingJobsRef.current);
      return;
    }
    const raw = result.data;
    const count = Math.min(MAX_HISTORY_RENDER, raw.length);
    historyRawRef.current = raw;
    historyRenderCountRef.current = count;
    rebuildVisibleResults(conv, pendingJobsRef.current);
  }, [activeConvRef, historyRawRef, historyRenderCountRef, pendingJobsRef, rebuildVisibleResults, resultsLoadSeqRef, setResults]);

  const loadMoreHistory = useCallback(() => {
    const raw = historyRawRef.current;
    const cur = historyRenderCountRef.current;
    if (cur >= raw.length) return { loaded: 0, more: false };
    const newCount = Math.min(cur + HISTORY_PAGE, raw.length);
    historyRenderCountRef.current = newCount;
    rebuildVisibleResults(activeConvRef.current, pendingJobsRef.current);
    return { loaded: newCount - cur, more: newCount < raw.length };
  }, [activeConvRef, historyRawRef, historyRenderCountRef, pendingJobsRef, rebuildVisibleResults]);

  const onJobReply = useCallback((data) => {
    if (!data || !data.reply) return;
    const job = pendingJobsRef.current[data.jobId];
    const eventConversationId = data.conversationId || '';
    if (!job && (!eventConversationId || eventConversationId !== (activeConvRef.current?.id || ''))) return;
    if (job) {
      setPendingJobs(prev => {
        const next = { ...prev, [data.jobId]: { ...prev[data.jobId], reply: data.reply } };
        queueMicrotask(() => rebuildVisibleResults(activeConvRef.current, next));
        return next;
      });
    } else {
      rebuildVisibleResults(activeConvRef.current, pendingJobsRef.current);
    }
  }, [activeConvRef, pendingJobsRef, rebuildVisibleResults, setPendingJobs]);

  const onJobDone = useCallback((data) => {
    const job = pendingJobsRef.current[data.jobId];
    const eventConversationId = data.conversationId || '';
    if (!job && (!eventConversationId || eventConversationId !== (activeConvRef.current?.id || ''))) return;
    const activeConversationId = activeConvRef.current?.id || '';
    const isActiveJob = job ? jobMatchesConversation(job, activeConversationId) : (!!eventConversationId && eventConversationId === activeConversationId);
    if (isActiveJob && job) {
      const doneBatch = {
        id: done_,
        history: false,
        prompt: job.prompt,
        type: job.mode === 'video' ? 'video' : 'image',
        ratio: job.ratioStr,
        brief: data.brief || job.reply || '',
        urls: job.mode === 'video' ? (data.videos || []) : (data.images || []),
        time: new Date().toISOString(),
        completed: true,
      };
      setResults(prev => {
        const withoutPending = Array.isArray(prev) ? prev.filter(item => item.id !== data.jobId) : [];
        return [...withoutPending, doneBatch];
      });
    }
    setPendingJobs(prev => {
      const n = { ...prev };
      delete n[data.jobId];
      if (!isActiveJob) queueMicrotask(() => rebuildVisibleResults(activeConvRef.current, n));
      return n;
    });
    if (!isActiveJob) return;
    if (activeConvRef.current?.id === eventConversationId || (job && jobMatchesConversation(job, activeConversationId))) {
      queueMicrotask(() => loadConversationResults(activeConvRef.current));
    }
    setStatus('ready', '完成');
  }, [activeConvRef, loadConversationResults, pendingJobsRef, rebuildVisibleResults, setPendingJobs, setResults, setStatus]);

  const onJobError = useCallback((data) => {
    const job = pendingJobsRef.current[data.jobId];
    const eventConversationId = data.conversationId || '';
    if (job) {
      const isActiveJob = jobMatchesConversation(job, activeConvRef.current?.id || '');
      setPendingJobs(prev => {
        const n = { ...prev };
        delete n[data.jobId];
        queueMicrotask(() => rebuildVisibleResults(activeConvRef.current, n));
        return n;
      });
      if (!isActiveJob) return;
    } else if (eventConversationId && eventConversationId === (activeConvRef.current?.id || '')) {
      queueMicrotask(() => rebuildVisibleResults(activeConvRef.current, pendingJobsRef.current));
    }
    setStatus('error', '生成失败: ' + (data.error || ''));
  }, [activeConvRef, pendingJobsRef, rebuildVisibleResults, setPendingJobs, setStatus]);

  const startGeneration = useCallback(async (prompt, ctx) => {
    const curMode = ctx ? ctx.mode : modeRef.current;
    const p = ctx ? ctx.params : paramsRef.current;
    const ratioStr = curMode === 'image' ? p.imageRatio : p.videoRatio;
    const supportsImageCount = platformRef.current === 'plus' || platformRef.current === '4k';
    const imageCount = Math.min(4, Math.max(1, parseInt(p.imageCount || 1, 10) || 1));
    const refs = ctx ? ctx.refImages : refImagesRef.current;
    const platformCfg = platformsRef.current.find(item => item.key === platformRef.current) || { requiresAccount: true };
    const accountless = platformCfg.requiresAccount === false;
    const requiresAccount = !accountless;
    if (!requiresAccount && !supportsAccountlessMode(platformCfg, curMode)) {
      const message = unsupportedModeMessage(platformCfg, curMode);
      setStatus('error', message);
      showToast(message);
      return;
    }
    const hasReferenceImage = refs.length > 0;
    const supportsReferenceImages = platformSupportsReferenceImages(platformCfg, curMode);
    if (!requiresAccount && hasReferenceImage && !supportsReferenceImages) {
      const message = accountlessReferenceImageMessage(platformCfg, curMode);
      setStatus('error', message);
      showToast(message);
      return;
    }
    let endpoint = curMode === 'image' ? '/api/generate/image' : '/api/generate/video';
    const acct = activeAccountRef.current;
    const conversationId = activeConvRef.current?.id || '';
    const body = {
      prompt, platform: platformRef.current, accountId: acct?.id || '', conversationId,
      ratio: ratioStr, style: p.imageStyle, duration: p.videoDuration,
      model: curMode === 'image' ? p.imageModel : p.videoModel,
      movement: p.videoMovement, movementSubject: p.videoMovementSubject, movementDirection: p.videoMovementDirection,
    };
    if (curMode === 'image' && supportsImageCount) body.n = imageCount;
    try {
      if (hasReferenceImage) {
        let uploadedRefs = [];
        if (!requiresAccount && supportsReferenceImages) {
          setStatus('generating', `正在准备参考图 ${refs.length}/${refs.length}...`);
          uploadedRefs = refs.map((ref) => ({ dataUrl: ref.dataUrl, name: ref.name }));
        } else {
          const total = refs.length;
          let done = 0;
          setStatus('generating', `正在上传参考图 0/${total}...`);
          uploadedRefs = await Promise.all(refs.map(async (ref, i) => {
            const upload = await api.uploadReferenceImage({
              dataUrl: ref.dataUrl, name: ref.name, platform: platformRef.current, accountId: acct?.id || '',
            });
            if (!upload.success) throw new Error(upload.error || `参考图 ${i + 1} 上传失败`);
            done++;
            setStatus('generating', `正在上传参考图 ${done}/${total}...`);
            return upload.data;
          }));
        }
        const firstUpload = uploadedRefs[0];
        if (curMode === 'video') endpoint = '/api/generate/image-to-video';
        Object.assign(body, {
          imageUri: firstUpload.imageUri, imageIdentifier: firstUpload.imageIdentifier,
          imageName: firstUpload.imageName, imageWidth: firstUpload.imageWidth,
          imageHeight: firstUpload.imageHeight, imageFormat: firstUpload.imageFormat,
          imageReferences: uploadedRefs,
        });
      }
      setStatus('generating', '已提交');
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!result.success) throw new Error(result.error || '提交失败');

      const jobId = result.data.jobId;
      const startTime = Date.now();
      const snapshot = {
        prompt, mode: curMode,
        params: { ...p },
        refImages: refs.map(r => ({ dataUrl: r.dataUrl, name: r.name })),
      };
      const pendingJob = {
        prompt, mode: curMode, ratioStr, startTime, conversationId, snapshot,
        ...(curMode === 'image' && supportsImageCount ? { count: imageCount } : {})
      };
      setPendingJobs(prev => {
        const next = { ...prev, [jobId]: pendingJob };
        queueMicrotask(() => rebuildVisibleResults(activeConvRef.current, next));
        return next;
      });
      setResults(prev => appendPendingBatchIfActive(prev, jobId, pendingJob, activeConvRef.current?.id || '', startTime));
      setStatus('ready', curMode === 'video' ? '视频生成中(可能数分钟~数十分钟)' : '图片生成中...');
      setRefImages([]);
    } catch (err) {
      setStatus('error', '提交失败: ' + err.message);
      showToast('提交失败: ' + err.message);
    }
  }, [activeAccountRef, activeConvRef, modeRef, paramsRef, platformRef, platformsRef, refImagesRef, rebuildVisibleResults, setPendingJobs, setRefImages, setResults, setStatus, showToast]);

  const submitPrompt = useCallback((prompt) => {
    if (!prompt.trim()) return false;
    const acct = activeAccountRef.current;
    const cfg = curPlatformCfg();
    const curMode = modeRef.current;
    const accountless = cfg.requiresAccount === false;
    const requiresAccount = !accountless;
    if (!requiresAccount) {
      if (!supportsAccountlessMode(cfg, curMode)) { showToast(unsupportedModeMessage(cfg, curMode)); return false; }
      if (refImagesRef.current.length > 0 && !platformSupportsReferenceImages(cfg, curMode)) {
        showToast(accountlessReferenceImageMessage(cfg, curMode));
        return false;
      }
      startGeneration(prompt);
      return true;
    }
    if (!acct) {
      showToast('请先在「' + cfg.label + '」添加并激活账号');
      setAccountModalOpen(true);
      return false;
    }
    if (!acct.session?.cookies) { showToast('当前账号未登录,请重新登录'); return false; }
    startGeneration(prompt);
    return true;
  }, [activeAccountRef, curPlatformCfg, modeRef, refImagesRef, setAccountModalOpen, showToast, startGeneration]);

  const retryJob = useCallback((jobId) => {
    const item = resultsRef.current.find(b => b.id === jobId && b.kind === 'gen-error');
    const snap = item && item.snapshot;
    if (!snap) { showToast('无法重试:缺少任务参数'); return; }
    const acct = activeAccountRef.current;
    const cfg = curPlatformCfg();
    if (cfg.requiresAccount !== false && (!acct || !acct.session?.cookies)) { showToast('当前账号未登录,请重新登录'); return; }
    setResults(prev => prev.filter(b => b.id !== jobId));
    startGeneration(snap.prompt, { mode: snap.mode, params: snap.params, refImages: snap.refImages });
  }, [activeAccountRef, curPlatformCfg, resultsRef, setResults, showToast, startGeneration]);

  const editJob = useCallback((jobId) => {
    const item = resultsRef.current.find(b => b.id === jobId && b.kind === 'gen-error');
    const snap = item && item.snapshot;
    if (!snap) { showToast('无法编辑:缺少任务参数'); return; }
    setMode(snap.mode);
    if (snap.params) setParams(snap.params);
    setRefImages((snap.refImages || []).map(r => ({ dataUrl: r.dataUrl, name: r.name, file: null })));
    setInputDraft({ text: snap.prompt || '', nonce: Date.now() });
    setResults(prev => prev.filter(b => b.id !== jobId));
    setView('studio');
  }, [resultsRef, setInputDraft, setMode, setParams, setRefImages, setResults, setView, showToast]);

  return {
    loadConversations,
    loadConversationResults,
    loadMoreHistory,
    onJobReply,
    onJobDone,
    onJobError,
    submitPrompt,
    retryJob,
    editJob,
  };
}

