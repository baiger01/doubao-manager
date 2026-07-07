// 纯 fetch 客户端,从原 public/app.js 的 api 对象逐字移植,逻辑不变。
async function get(url) { return (await fetch(url)).json(); }
async function post(url, data) {
  return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) })).json();
}
async function put(url, data) {
  return (await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) })).json();
}
async function del(url) { return (await fetch(url, { method: 'DELETE' })).json(); }

export const api = {
  get, post, put, del,

  getStatus() { return get('/api/status'); },
  getAccounts() { return get('/api/accounts'); },
  launchLogin(name, platform) { return post('/api/accounts/launch-login', { name, platform }); },
  relogin(reuseId) { return post('/api/accounts/launch-login', { name: '__relogin__', reuseId }); },
  confirmLogin(id) { return post(`/api/accounts/${id}/confirm-login`); },
  activateAccount(id) { return post(`/api/accounts/${id}/activate`); },
  closeAccount(id) { return post(`/api/accounts/${id}/close`); },
  deleteAccount(id) { return del(`/api/accounts/${id}`); },
  clearPlatformAccounts(platform) { return del(`/api/accounts/platform/${encodeURIComponent(platform)}`); },
  openAccount(id) { return post(`/api/accounts/${id}/open`); },
  // windowMode 可选(visible/background/headless);不传则后端读全局设置 config.storage.browserWindowMode
  autoLogin(platform, accounts, windowMode) { return post('/api/accounts/auto-login', { platform, accounts, ...(windowMode ? { windowMode } : {}) }); },

  pickBackupDir() { return post('/api/accounts/pick-backup-dir'); },
  inspectBackup(dir) { return post('/api/accounts/inspect-backup', { dir }); },
  importBackup(dir, opts = {}) { return post('/api/accounts/import-backup', { dir, ...opts }); },

  getConversations(platform, accountId) {
    const params = new URLSearchParams({ platform: platform || '' });
    return get('/api/conversations?' + params.toString());
  },
  createConversation(name, platform, accountId) { return post('/api/conversations', { name, platform }); },
  activateConversation(id) { return post(`/api/conversations/${id}/activate`); },
  renameConversation(id, name) { return put(`/api/conversations/${id}`, { name }); },
  deleteConversation(id) { return del(`/api/conversations/${id}`); },
  getConversationResults(id) { return get(`/api/conversations/${id}/results`); },

  getProxy(platform) { return get('/api/proxy?platform=' + encodeURIComponent(platform || 'dola')); },
  saveProxy(platform, proxy, mode) { return post('/api/proxy', { platform, proxy, ...(mode ? { mode } : {}) }); },
  testProxy(platform, proxy) { return post('/api/proxy/test', { platform, proxy }); },
  detectProxy(platform) { return post('/api/proxy/detect', { platform }); },
  uploadReferenceImage(payload) { return post('/api/generate/upload-reference', payload); },

  openOrionLogin(data) { return post('/api/orion/open-login', data || {}); },
  exportOrionBrowserCookies(data) { return post('/api/orion/export-browser-cookies', data || {}); },
  getOrionHealth() { return get('/api/orion/health'); },
  getOrionStatus() { return get('/api/orion/status'); },
  saveOrionCookie(data) { return post('/api/orion/set-cookie', data || {}); },

  getLicenseStatus() { return get('/api/license/status'); },
  activateLicense(key) { return post('/api/license/activate', { key }); },
  verifyLicense() { return post('/api/license/verify'); },

  getSettings() { return get('/api/settings'); },
  saveSettings(data) { return post('/api/settings', data); },
  pickDownloadDir() { return post('/api/settings/pick-dir'); },
  openDownloadDir() { return post('/api/settings/open-dir'); },
  getImageApiConfig(platform) {
    const params = new URLSearchParams();
    if (platform) params.set('platform', platform);
    const qs = params.toString();
    return get('/api/settings/image-api' + (qs ? '?' + qs : ''));
  },
  saveImageApiConfig(data) { return post('/api/settings/image-api', data); },

  getApiAccess() { return get('/api/settings/api-access'); },
  saveApiAccess(data) { return post('/api/settings/api-access', data); },
  regenApiToken() { return post('/api/settings/api-access/regen'); },

  getMcpConfig() { return get('/api/settings/mcp'); },

  getWebviewBinding() { return get('/api/settings/webview-binding'); },
  setWebviewBinding(accountId) { return post('/api/settings/webview-binding', { accountId }); },

  // ===== Claude 文本对话 =====
  getClaudeConfig() { return get('/api/claude/config'); },
  saveClaudeConfig(data) { return post('/api/claude/config', data); },
  fetchClaudeModels(data) { return post('/api/claude/models', data || {}); },

  // Claude 流式对话:SSE。回调 onDelta(text)/onDone(fullText)/onError(msg)。返回 abort 函数。
  claudeChat(messages, model, handlers = {}) {
    const { onDelta = () => {}, onDone = () => {}, onError = () => {} } = handlers;
    const controller = new AbortController();
    (async () => {
      try {
        const resp = await fetch('/api/claude/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, model }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          let msg = 'HTTP ' + resp.status;
          try { const j = await resp.json(); msg = j.error || j.message || msg; } catch (e) {}
          onError(msg);
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';
        // 解析 SSE:事件块以空行分隔,每块含 event: 与 data: 行
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let evt = 'message', dataStr = '';
            block.split('\n').forEach(line => {
              if (line.startsWith('event:')) evt = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            });
            if (!dataStr) continue;
            let data;
            try { data = JSON.parse(dataStr); } catch (e) { continue; }
            if (evt === 'delta') { full += data.text || ''; onDelta(data.text || ''); }
            else if (evt === 'done') { onDone(data.text || full); }
            else if (evt === 'error') { onError(data.message || '对话失败'); }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') onError(e.message || '连接失败');
      }
    })();
    return () => { try { controller.abort(); } catch (e) {} };
  },
};
