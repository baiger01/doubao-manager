import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useConversationGenerationDomain } from './domains/conversation-generation-domain.js';
import { useClaudeChatDomain } from './domains/claude-chat-domain.js';
import { useLicenseDomain } from './domains/license-domain.js';
import { useAccountBulkDomain } from './domains/account-bulk-domain.js';
import { getAccountlessPlatformHint } from './lib/accounts-modal-contract.js';
import { appendStatusLog } from './lib/status-log.js';

const StoreCtx = createContext(null);
export function useStore() { return useContext(StoreCtx); }
export function useCanvasState() {
  const s = useStore();
  return {
    results: s.results,
    setLightbox: s.setLightbox,
    openImageMenu: s.openImageMenu,
    loadMoreHistory: s.loadMoreHistory,
    showToast: s.showToast,
    retryJob: s.retryJob,
    editJob: s.editJob,
  };
}

export function useInputPodState() {
  const s = useStore();
  return {
    refImages: s.refImages,
    addRefImageFiles: s.addRefImageFiles,
    removeRefImage: s.removeRefImage,
    clearRefImages: s.clearRefImages,
    submitPrompt: s.submitPrompt,
    mode: s.mode,
    setMode: s.setMode,
    params: s.params,
    setParams: s.setParams,
    curPlatformCfg: s.curPlatformCfg,
    pendingJobs: s.pendingJobs,
    inputDraft: s.inputDraft,
    setInputDraft: s.setInputDraft,
  };
}

export function useNavRailState() {
  const s = useStore();
  return {
    connected: s.connected,
    activeAccount: s.activeAccount,
    status: s.status,
    conversations: s.conversations,
    newConversation: s.newConversation,
    selectConversation: s.selectConversation,
    renameConversation: s.renameConversation,
    deleteConversation: s.deleteConversation,
    setSettingsOpen: s.setSettingsOpen,
    view: s.view,
    setView: s.setView,
  };
}

export function useLogPanelState() {
  const s = useStore();
  return {
    status: s.status,
    statusLog: s.statusLog,
    clearStatusLog: s.clearStatusLog,
  };
}

let batchSeq = 0;
const nextBatchId = () => `b${Date.now()}_${batchSeq++}`;

export function StoreProvider({ children }) {
  // ====== 平台/模式 ======
  const [platform, setPlatform] = useState(localStorage.getItem('cur_platform') || 'doubao');
  const [platforms, setPlatforms] = useState([]);
  const [mode, setMode] = useState('image');

  // ====== 连接/状态 ======
  const [connected, setConnected] = useState(false);
  const [status, setStatusState] = useState({ type: 'ready', text: '启动中...' });
  const [statusLog, setStatusLog] = useState(() => appendStatusLog([], { type: 'ready', text: '启动中...', source: 'status' }));

  // ====== 账号/会话 ======
  const [accounts, setAccounts] = useState([]);
  const [activeAccount, setActiveAccount] = useState(null);
  const [pendingLoginId, setPendingLoginId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);

  // ====== 参数 ======
  const [params, setParams] = useState({
    imageRatio: '1:1', imageStyle: '', imageModel: '', imageCount: 1,
    videoRatio: '1:1', videoDuration: 10, videoModel: '',
    videoMovement: 'auto', videoMovementSubject: '', videoMovementDirection: '',
  });

  // ====== 参考图 / 结果 / 任务 ======
  const [refImages, setRefImages] = useState([]);
  const [results, setResults] = useState([]);            // 渲染态结果批次数据(由历史+运行时派生)
  const [pendingJobs, setPendingJobs] = useState({});    // jobId -> {prompt,mode,ratioStr,startTime,reply}

  // ====== UI ======
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [loginForm, setLoginForm] = useState(null);      // {title,hint,accountId,busy}
  const [lightbox, setLightbox] = useState({ open: false, src: '' });
  // 图片右键菜单:{ open, x, y, src }
  const [imageMenu, setImageMenu] = useState({ open: false, x: 0, y: 0, src: '' });
  const openImageMenu = useCallback((e, src) => {
    e.preventDefault(); e.stopPropagation();
    setImageMenu({ open: true, x: e.clientX, y: e.clientY, src });
  }, []);
  const closeImageMenu = useCallback(() => setImageMenu(m => m.open ? { ...m, open: false } : m), []);
  const {
    licenseGate,
    license,
    refreshLicense,
    activateLicense,
    verifyLicenseNow,
    onLicenseInvalid,
  } = useLicenseDomain();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('download'); // 设置弹窗当前标签
  // 内置浏览器 webview 刷新信号:绑定/解绑账号后自增,WebToolView 监听后重载页面
  const [webviewReloadNonce, setWebviewReloadNonce] = useState(0);
  const reloadWebviews = useCallback(() => setWebviewReloadNonce(n => n + 1), []);
  // 主区域视图:'studio'(生成台) | 'gemini'(内置浏览器)
  const [view, setView] = useState('studio');
  // 分屏:网页工具与生成台并排显示;split 比例为生成台占比 0.2~0.8
  const [splitView, setSplitView] = useState(false);
  const [splitRatio, setSplitRatio] = useState(() => {
    const v = parseFloat(localStorage.getItem('split_ratio'));
    return (v >= 0.2 && v <= 0.8) ? v : 0.5;
  });
  const [ask, setAsk] = useState(null);                  // {kind:'input'|'confirm',title,label,value,resolve}
  // 输入舱回填信号:「返回编辑」时把失败任务的文本推回输入框(refImages/params 直接写 state)
  const [inputDraft, setInputDraft] = useState(null);    // {text, nonce}
  // 背景外观:'tiles'(方格瓷砖,默认) | 'dots'(交互式点阵)
  const [background, setBackgroundState] = useState(() => localStorage.getItem('bg_style') || 'tiles');
  const setBackground = useCallback((v) => {
    setBackgroundState(v);
    localStorage.setItem('bg_style', v);
  }, []);
  // 字体色调:'dark'(黑字,默认,配浅背景) | 'light'(白字,配暗背景)
  const [textTone, setTextToneState] = useState(() => localStorage.getItem('text_tone') || 'dark');
  const setTextTone = useCallback((v) => {
    setTextToneState(v);
    localStorage.setItem('text_tone', v);
  }, []);
  // 玻璃材质:'liquid'(液态色散,默认) | 'frosted'(雾蒙磨砂) | 'none'(全普通无玻璃)
  const [glassMode, setGlassModeState] = useState(() => {
    const v = localStorage.getItem('glass_mode');
    if (v === 'blur') return 'frosted';  // 兼容旧值
    return v || 'liquid';
  });
  const setGlassMode = useCallback((v) => {
    setGlassModeState(v);
    localStorage.setItem('glass_mode', v);
  }, []);
  const [orionAuthState, setOrionAuthState] = useState({
    status: 'idle',
    authenticated: false,
    message: '未检查 Orion 登录态',
    action: '',
    cookieCount: 0,
    loginUrl: '',
  });

  // ====== refs(供 WS / 异步回调读取最新值)======
  const platformRef = useRef(platform); platformRef.current = platform;
  const platformsRef = useRef(platforms); platformsRef.current = platforms;
  const pendingJobsRef = useRef(pendingJobs); pendingJobsRef.current = pendingJobs;
  const resultsRef = useRef(results); resultsRef.current = results;
  const modeRef = useRef(mode); modeRef.current = mode;
  const paramsRef = useRef(params); paramsRef.current = params;
  const refImagesRef = useRef(refImages); refImagesRef.current = refImages;
  const splitViewRef = useRef(splitView); splitViewRef.current = splitView;

  const pushStatusLog = useCallback((entry) => {
    setStatusLog(prev => appendStatusLog(prev, entry));
  }, []);
  const clearStatusLog = useCallback(() => setStatusLog([]), []);
  const setStatus = useCallback((type, text) => {
    setStatusState({ type, text });
    setStatusLog(prev => appendStatusLog(prev, { type, text, source: 'status' }));
  }, []);

  const curPlatformCfg = useCallback(() => {
    return platforms.find(p => p.key === platform)
      || { key: platform, label: platform, imageModels: [], videoModels: [], requiresAccount: true, supportsImage: true, supportsVideo: true };
  }, [platforms, platform]);

  // 平台切换后,模型选项随平台重置
  useEffect(() => {
    const cfg = curPlatformCfg();
    setParams(p => ({
      ...p,
      imageModel: (cfg.imageModels && cfg.imageModels[0]?.value) || '',
      videoModel: (cfg.videoModels && cfg.videoModels[0]?.value) || '',
    }));
  }, [platform, platforms]); // eslint-disable-line

  // ====== Toast(借状态栏文案,3 秒回落)======
  const toastTimer = useRef(null);
  const connectedRef = useRef(connected); connectedRef.current = connected;
  const showToast = useCallback((msg) => {
    setStatusState({ type: 'ready', text: msg });
    setStatusLog(prev => appendStatusLog(prev, { type: 'ready', text: msg, source: 'toast' }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      setStatusState({ type: 'ready', text: connectedRef.current ? '就绪' : '未连接' });
    }, 3000);
  }, []);

  // ====== 自定义弹窗 ======
  const askInput = useCallback((title, label, defaultValue) =>
    new Promise((resolve) => setAsk({ kind: 'input', title, label, value: defaultValue || '', resolve })), []);
  const askConfirm = useCallback((title, label) =>
    new Promise((resolve) => setAsk({ kind: 'confirm', title, label, resolve })), []);
  const resolveAsk = useCallback((val) => {
    setAsk((cur) => { if (cur) cur.resolve(val); return null; });
  }, []);

  // ====== 账号 ======
  const loadAccounts = useCallback(async () => {
    const result = await api.getAccounts();
    if (!result.success) return;
    // 按平台分组注入稳定序号与显示名(顶部/左栏只显示「账号N」,真实邮箱仅详情页用)
    const seqByPlatform = {};
    const decorated = result.data.map(a => {
      const plat = a.platform || 'doubao';
      seqByPlatform[plat] = (seqByPlatform[plat] || 0) + 1;
      const seq = seqByPlatform[plat];
      return { ...a, seq, displayName: '账号 ' + seq };
    });
    setAccounts(decorated);
    const cur = decorated.filter(a => a.platform === platformRef.current);
    const act = cur.find(a => a.isActive) || null;
    setActiveAccount(act);
    const platformCfg = platformsRef.current.find(p => p.key === platformRef.current);
    const accountless = platformCfg?.requiresAccount === false;
    const conn = !!(act && act.session?.cookies);
    setConnected(accountless || conn);
    return act;
  }, []);

  const {
    autoLoginState,
    importState,
    onAutoLoginProgress,
    onImportProgress,
    startAutoLogin,
    clearAutoLogin,
    pickBackupDir,
    inspectBackup,
    startImportBackup,
    clearImport,
  } = useAccountBulkDomain({ loadAccounts, showToast });

  // ====== 会话 ======
  const activeAccountRef = useRef(activeAccount); activeAccountRef.current = activeAccount;

  // ====== 历史结果 ======
  const historyRawRef = useRef([]);          // 当前会话全量历史原始数据
  const historyRenderCountRef = useRef(0);   // 已展开渲染的历史条数
  const resultsLoadSeqRef = useRef(0);       // 防止切会话时旧请求晚返回覆盖当前画布

  const buildHistoryBatches = useCallback((raw, count) => {
    const items = raw.slice(-count);
    const hidden = raw.length - items.length;
    const batches = [];
    if (hidden > 0) {
      batches.push({ id: nextBatchId(), kind: 'trimmed', _hist: true, shown: items.length, hidden });
    }
    items.forEach(item => {
      if ((item.type === 'image' || item.type === 'video') && item.urls?.length > 0) {
        batches.push({
          id: nextBatchId(), kind: 'result', _hist: true, type: item.type, prompt: item.prompt,
          urls: item.urls, ratio: '1:1', time: item.time, history: true,
        });
      } else {
        batches.push({ id: nextBatchId(), kind: 'message', _hist: true, text: item.brief || '无结果', prompt: item.prompt, time: item.time });
      }
    });
    return batches;
  }, []);

  const activeConvRef = useRef(activeConversation); activeConvRef.current = activeConversation;
  const conversationsRef = useRef(conversations); conversationsRef.current = conversations;

  const conversationDomain = useConversationGenerationDomain({
    setView, platformRef, activeAccountRef,
    setConversations, setActiveConversation, activeConvRef, conversationsRef,
    pendingJobsRef, setPendingJobs, setResults, setStatus, showToast,
    setMode, setParams, setRefImages, setInputDraft, setAccountModalOpen,
    historyRawRef, historyRenderCountRef, resultsLoadSeqRef, buildHistoryBatches,
    modeRef, paramsRef, refImagesRef, platformsRef, resultsRef, curPlatformCfg,
  });

  const {
    loadConversations,
    loadConversationResults,
    loadMoreHistory,
    onJobReply,
    onJobDone,
    onJobError,
    submitPrompt,
    retryJob,
    editJob,
  } = conversationDomain;

  const {
    claudeMessages,
    claudeSending,
    claudeConfig,
    loadClaudeConfig,
    sendClaudeMessage,
    stopClaude,
    clearClaudeChat,
  } = useClaudeChatDomain();

  // ====== 平台切换 ======
  const switchPlatform = useCallback(async (next) => {
    // 分屏模式下保持当前网页视图(只更新右栏生成台数据),非分屏则回到生成台
    if (!splitViewRef.current) setView('studio');
    if (next === platformRef.current) return;
    platformRef.current = next;
    setPlatform(next);
    localStorage.setItem('cur_platform', next);
    const acct = await loadAccounts();
    const conv = await loadConversations(acct);
    await loadConversationResults(conv ?? null);
  }, [loadAccounts, loadConversations, loadConversationResults]);

  // ====== 参考图 ======
  const addRefImageFiles = useCallback((files) => {
    const imgs = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'));
    imgs.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setRefImages(prev => [...prev, { file, dataUrl: ev.target.result, name: file.name || 'image' }]);
      };
      reader.readAsDataURL(file);
    });
  }, []);
  const removeRefImage = useCallback((i) => setRefImages(prev => prev.filter((_, idx) => idx !== i)), []);
  const clearRefImages = useCallback(() => setRefImages([]), []);

  const handleWS = useCallback((msg) => {
    switch (msg.type) {
      case 'quota_update':
        if (msg.data.refreshed) loadAccounts();
        break;
      case 'job_done': onJobDone(msg.data); break;
      case 'job_reply': onJobReply(msg.data); break;
      case 'job_error': onJobError(msg.data); break;
      case 'job_progress':
        if (msg.data?.message || msg.data?.status || msg.data?.progress !== undefined) {
          pushStatusLog({
            type: 'generating',
            text: msg.data.message || msg.data.status || `生成进度 ${msg.data.progress}`,
            source: 'status',
            meta: msg.data,
          });
        }
        break;
      case 'license_invalid': onLicenseInvalid(); break;
      case 'auto_login_progress': onAutoLoginProgress(msg.data); break;
      case 'import_progress': onImportProgress(msg.data); break;
      default: break;
    }
  }, [loadAccounts, onJobDone, onJobReply, onJobError, onAutoLoginProgress, onImportProgress, onLicenseInvalid, pushStatusLog]);
  useWebSocket(handleWS);

  // ====== 计时器:每秒刷新占位格 elapsed ======
  useEffect(() => {
    const hasPending = Object.keys(pendingJobs).length > 0;
    if (!hasPending) return;
    const t = setInterval(() => {
      setResults(prev => prev.map(b => {
        if (b.kind !== 'generating') return b;
        const job = pendingJobsRef.current[b.id];
        if (!job) return b;
        return { ...b, elapsed: Math.floor((Date.now() - job.startTime) / 1000) };
      }));
    }, 1000);
    return () => clearInterval(t);
  }, [pendingJobs]);

  const newConversation = useCallback(async () => {
    setView('studio');
    const name = await askInput('新建会话', '输入会话名称:', '会话 ' + (conversations.length + 1));
    if (name === null || !name.trim()) return;
    const result = await api.createConversation(name.trim(), platformRef.current, activeAccountRef.current?.id || '');
    if (result.success) {
      await loadConversations();
      await loadConversationResults(result.data ?? null);
    }
  }, [askInput, conversations.length, loadConversations, loadConversationResults]);

  const selectConversation = useCallback(async (id) => {
    setView('studio');
    if (activeConvRef.current && activeConvRef.current.id === id) {
      await loadConversationResults(activeConvRef.current);
      return;
    }
    // 直接用被点击的会话对象，不绕路重新拉列表猜测（跨账号/空账号作用域会猜空导致白屏）
    const target = conversationsRef.current.find(c => c.id === id);
    if (!target) return;
    activeConvRef.current = target;
    setActiveConversation(target);
    setConversations(prev => prev.map(c => ({ ...c, isActive: c.id === id })));
    await loadConversationResults(target);
    api.activateConversation(id).catch(() => {});  // 后台同步激活态，不阻塞渲染
  }, [loadConversationResults]);

  const renameConversation = useCallback(async (id) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    const newName = await askInput('重命名会话', '输入新名称:', conv.name);
    if (newName === null || !newName.trim() || newName.trim() === conv.name) return;
    await api.renameConversation(id, newName.trim());
    loadConversations();
  }, [conversations, askInput, loadConversations]);

  const deleteConversation = useCallback(async (id) => {
    if (!(await askConfirm('删除会话', '确定删除此会话?'))) return;
    await api.deleteConversation(id);
    const conv = await loadConversations();
    await loadConversationResults(conv ?? null);
  }, [askConfirm, loadConversations, loadConversationResults]);

  // ====== 账号操作 ======
  const startAddAccount = useCallback(async (plat) => {
    const cfg = platforms.find(p => p.key === plat) || { label: plat };
    if (cfg.requiresAccount === false) {
      showToast(getAccountlessPlatformHint(cfg));
      return;
    }
    const cnt = accounts.filter(a => a.platform === plat).length + 1;
    const name = await askInput('添加账号', `输入「${cfg.label}」账号备注名称:`, cfg.label + ' 账号 ' + cnt);
    if (name === null) return;
    setAccountModalOpen(true);
    try {
      const result = await api.launchLogin(name, plat);
      if (!result.success) throw new Error(result.error);
      setPendingLoginId(result.data.accountId);
      setLoginForm({ title: '等待登录', hint: `浏览器已打开 ${cfg.label},请完成登录后点击保存`, accountId: result.data.accountId, busy: false });
    } catch (e) {
      showToast('启动失败: ' + e.message);
    }
  }, [platforms, accounts, askInput, showToast]);

  const setOrionAuthFromError = useCallback((fallback, result) => {
    setOrionAuthState(s => ({
      ...s,
      status: 'error',
      authenticated: false,
      message: result?.error || fallback,
      action: result?.action || '',
    }));
    showToast(result?.error || fallback);
  }, [showToast]);

  const refreshOrionAuthStatus = useCallback(async () => {
    setOrionAuthState(s => ({ ...s, status: 'checking', message: '正在检查 Orion 登录态...', action: '' }));
    try {
      const r = await api.getOrionStatus();
      if (!r.success) {
        setOrionAuthFromError('Orion 状态检查失败', r);
        return r;
      }
      const authenticated = !!r.data?.authenticated;
      const cookieFileExists = !!r.data?.cookieFileExists;
      const hasLoginCookie = !!r.data?.hasLoginCookie;
      const cookieCount = r.data?.cookieCount || r.data?.health?.default_cookie_count || r.data?.health?.cookie_count || 0;
      const pendingMessage = cookieFileExists && !hasLoginCookie
        ? 'Orion 登录态文件存在，但缺少 sessionid/sid_tt/uid_tt，请重新回传或粘贴手动 Cookie'
        : 'Orion 尚未保存登录态，请先打开授权并回传登录态';
      const next = {
        status: authenticated ? 'ok' : 'warn',
        authenticated,
        message: authenticated ? 'Orion 登录态已保存' : pendingMessage,
        action: authenticated ? '' : (r.data?.action || '如果扫码后一直停在「正在登录」，请改用手机号验证码登录；登录完成后再点「回传登录态」。'),
        cookieCount,
        loginUrl: r.data?.loginUrl || '',
      };
      setOrionAuthState(s => ({ ...s, ...next }));
      return r;
    } catch (e) {
      const result = { success: false, error: 'Orion 状态检查失败: ' + e.message };
      setOrionAuthFromError(result.error, result);
      return result;
    }
  }, [setOrionAuthFromError]);

  const openOrionLogin = useCallback(async () => {
    setOrionAuthState(s => ({ ...s, status: 'opening', message: '正在打开 Orion 授权窗口...', action: '' }));
    try {
      const r = await api.openOrionLogin();
      if (!r.success) {
        setOrionAuthFromError('打开授权失败', r);
        return r;
      }
      setOrionAuthState(s => ({
        ...s,
        status: 'waiting',
        authenticated: false,
        message: '授权窗口已打开，完成手机确认/验证码登录后点「回传登录态」',
        action: '如果页面一直显示「正在登录」，请改用手机号验证码登录；不要在登录完成前回传。',
        loginUrl: r.data?.login_url || s.loginUrl,
      }));
      showToast('已打开 Orion 扫码登录');
      return r;
    } catch (e) {
      const result = { success: false, error: 'Orion 授权失败: ' + e.message };
      setOrionAuthFromError(result.error, result);
      return result;
    }
  }, [setOrionAuthFromError, showToast]);

  const exportOrionBrowserCookies = useCallback(async () => {
    setOrionAuthState(s => ({ ...s, status: 'exporting', message: '正在回传 Orion 登录态...', action: '' }));
    try {
      const r = await api.exportOrionBrowserCookies();
      if (!r.success) {
        setOrionAuthFromError('回传登录态失败', r);
        return r;
      }
      const count = r.data?.cookie_count;
      setOrionAuthState(s => ({
        ...s,
        status: 'ok',
        authenticated: true,
        message: count ? `Orion 登录态已保存（${count} 个 cookie）` : 'Orion 登录态已保存',
        action: '',
        cookieCount: count || 0,
      }));
      showToast(count ? `Orion 登录态已保存（${count} 个 cookie）` : 'Orion 登录态已保存');
      return r;
    } catch (e) {
      const result = { success: false, error: 'Orion 登录态回传失败: ' + e.message };
      setOrionAuthFromError(result.error, result);
      return result;
    }
  }, [setOrionAuthFromError, showToast]);

  const saveOrionCookie = useCallback(async (cookieHeader) => {
    setOrionAuthState(s => ({ ...s, status: 'saving', message: '正在保存手动 Cookie...', action: '' }));
    try {
      const r = await api.saveOrionCookie({ cookieHeader });
      if (!r.success) {
        setOrionAuthFromError('保存手动 Cookie 失败', r);
        return r;
      }
      const count = r.data?.cookie_count;
      setOrionAuthState(s => ({
        ...s,
        status: 'ok',
        authenticated: true,
        message: count ? `手动 Cookie 已保存（${count} 个 cookie）` : '手动 Cookie 已保存',
        action: '',
        cookieCount: count || 0,
      }));
      showToast('Orion 手动 Cookie 已保存');
      return r;
    } catch (e) {
      const result = { success: false, error: '保存手动 Cookie 失败: ' + e.message };
      setOrionAuthFromError(result.error, result);
      return result;
    }
  }, [setOrionAuthFromError, showToast]);

  const confirmLogin = useCallback(async (accountId) => {
    setLoginForm(f => f ? { ...f, busy: true } : f);
    try {
      const result = await api.confirmLogin(accountId);
      if (!result.success) throw new Error(result.error);
      setPendingLoginId(null);
      setLoginForm(null);
      showToast('登录态已保存');
      await api.activateAccount(accountId);
      await loadAccounts();
    } catch (e) {
      showToast('获取失败: ' + e.message);
      setLoginForm(f => f ? { ...f, busy: false } : f);
    }
  }, [showToast, loadAccounts]);

  const cancelLogin = useCallback(async (accountId) => {
    const id = accountId || pendingLoginId;
    if (id) {
      await api.closeAccount(id);
      if (pendingLoginId === id) await api.deleteAccount(id);
      setPendingLoginId(null);
    }
    setLoginForm(null);
    loadAccounts();
  }, [pendingLoginId, loadAccounts]);

  const activateAccount = useCallback(async (id) => {
    await api.activateAccount(id);
    await loadAccounts();
    const conv = await loadConversations(accounts.find(a => a.id === id) || activeAccountRef.current);
    await loadConversationResults(conv ?? null);
  }, [loadAccounts, loadConversations, loadConversationResults, accounts]);

  const reloginAccount = useCallback(async (accountId) => {
    try {
      await api.closeAccount(accountId);
      const result = await api.relogin(accountId);
      if (!result.success) throw new Error(result.error);
      setPendingLoginId(null);
      setLoginForm({ title: '重新登录', hint: '浏览器已打开,请重新登录后点击确认', accountId, busy: false });
    } catch (err) {
      showToast('启动失败: ' + err.message);
    }
  }, [showToast]);

  const openAccount = useCallback(async (id) => {
    try {
      const r = await api.openAccount(id);
      if (!r.success) throw new Error(r.error);
      showToast('已打开网页(挂登录态)');
    } catch (err) {
      showToast('打开失败: ' + err.message);
    }
  }, [showToast]);

  const deleteAccount = useCallback(async (id) => {
    if (!(await askConfirm('删除账号', '确定删除此账号?'))) return;
    await api.deleteAccount(id);
    await loadAccounts();
  }, [askConfirm, loadAccounts]);

  const clearPlatformAccounts = useCallback(async (plat) => {
    const cfg = platforms.find(p => p.key === plat) || { label: plat };
    const count = accounts.filter(a => a.platform === plat).length;
    if (!(await askConfirm('清空账号', `确定清空「${cfg.label}」下全部 ${count} 个账号?此操作会删除登录态,不可恢复。`))) return;
    try {
      const r = await api.clearPlatformAccounts(plat);
      if (!r.success) throw new Error(r.error || '清空失败');
      showToast(`已清空 ${cfg.label} 的 ${r.data?.count ?? count} 个账号`);
      await loadAccounts();
      const conv = await loadConversations();
      await loadConversationResults(conv ?? null);
    } catch (e) {
      showToast('清空失败: ' + e.message);
    }
  }, [platforms, accounts, askConfirm, showToast, loadAccounts, loadConversations, loadConversationResults]);

  // ====== 代理 ======
  const saveProxy = useCallback(async (proxy) => {
    const r = await api.saveProxy(platformRef.current, proxy);
    if (r.success) {
      setPlatforms(prev => prev.map(p => p.key === platformRef.current ? { ...p, proxy: r.data.proxy } : p));
    }
    return r;
  }, []);
  const testProxy = useCallback((proxy) => api.testProxy(platformRef.current, proxy), []);

  // 打开设置并切到指定标签
  const openSettings = useCallback((tab) => {
    if (tab) setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // 分屏比例持久化
  useEffect(() => {
    localStorage.setItem('split_ratio', String(splitRatio));
  }, [splitRatio]);

  // ====== 初始化 ======
  useEffect(() => {
    (async () => {
      setStatus('ready', '启动中...');
      try {
        const st = await api.getStatus();
        if (st.success) {
          const pls = st.data.platforms || [];
          setPlatforms(pls);
          if (!pls.find(p => p.key === platformRef.current)) {
            const fallback = pls[0]?.key || 'doubao';
            platformRef.current = fallback;
            setPlatform(fallback);
          }
        }
      } catch (e) {
        setStatus('error', '无法连接后端服务');
      }
      await loadAccounts();
      const conv = await loadConversations(activeAccountRef.current);
      await loadConversationResults(conv ?? null);
      loadClaudeConfig();
      setStatus('ready', connectedRef.current ? '就绪' : '未连接');
    })();
  }, []); // eslint-disable-line

  const value = {
    // state
    platform, platforms, mode, connected, status, statusLog,
    accounts, activeAccount, pendingLoginId, conversations, activeConversation,
    params, refImages, results, pendingJobs,
    accountModalOpen, loginForm, lightbox, imageMenu, licenseGate, license, ask,
    autoLoginState, importState, settingsOpen, settingsTab, view, splitView, splitRatio, webviewReloadNonce, inputDraft, background, textTone, glassMode,
    orionAuthState,
    claudeMessages, claudeSending, claudeConfig,
    // setters / helpers
    setMode, setParams, curPlatformCfg, setStatus, showToast, appendStatusLog: pushStatusLog, clearStatusLog,
    setAccountModalOpen, setLightbox, openImageMenu, closeImageMenu, setSettingsOpen, setSettingsTab, openSettings, setView, setSplitView, setSplitRatio, reloadWebviews, setBackground, setTextTone, setGlassMode,
    // actions
    switchPlatform, addRefImageFiles, removeRefImage, clearRefImages,
    submitPrompt, newConversation, selectConversation, renameConversation, deleteConversation,
    retryJob, editJob, setInputDraft,
    loadMoreHistory,
    startAddAccount, confirmLogin, cancelLogin, activateAccount, reloginAccount, openAccount,
    openOrionLogin, exportOrionBrowserCookies, refreshOrionAuthStatus, saveOrionCookie,
    startAutoLogin, clearAutoLogin,
    pickBackupDir, inspectBackup, startImportBackup, clearImport,
    deleteAccount, clearPlatformAccounts, saveProxy, testProxy, activateLicense, refreshLicense, verifyLicenseNow,
    loadClaudeConfig, sendClaudeMessage, stopClaude, clearClaudeChat,
    askInput, askConfirm, resolveAsk,
  };

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
