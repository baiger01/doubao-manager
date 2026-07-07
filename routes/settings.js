const express = require('express');
const fs = require('fs');
const { atomicWriteJsonFile } = require('../services/json-store');
const { createNullNativeBridge } = require('../services/native-bridge');
const { createSystemDirectoryPicker } = require('../services/directory-picker');
const { publicImageApiConfig, saveImageApiConfig } = require('../services/settings-image-api-config');
const { buildApiAccessData, buildMcpData } = require('../services/api-access-presenter');

// 设置路由：读写 storage 配置（自动下载开关 + 下载目录）+ 原生选目录 + 打开目录。
// Electron 原生能力（选目录/打开目录/webview cookie）由主进程注入到 app.locals.nativeBridge。
module.exports = function (config, app, paths, apiTokenManager, accountManager, directoryPicker = createSystemDirectoryPicker()) {
  const router = express.Router();

  // 内置「豆包对话」webview 使用的持久化分区(与 web/src/lib/webTools.jsx 保持一致)
  const DOUBAO_WEBVIEW_PARTITION = 'persist:doubaochat';

  function nativeBridge() {
    return app.locals.nativeBridge || createNullNativeBridge();
  }

  function canPickDownloadDir() {
    const bridge = nativeBridge();
    return !!(bridge.canPickDir() || (directoryPicker && directoryPicker.canPickDir && directoryPicker.canPickDir()));
  }

  function pickDownloadDir(options) {
    const bridge = nativeBridge();
    if (bridge.canPickDir()) return bridge.pickDirectory(options);
    if (directoryPicker && directoryPicker.canPickDir && directoryPicker.canPickDir()) {
      return directoryPicker.pickDirectory(options);
    }
    return Promise.reject(new Error('no_native'));
  }

  // 把账号存储的 cookie 串注入到 webview 分区,使内置浏览器免登录。
  // 需要 Electron 主进程注入 nativeBridge；非 Electron 环境直接失败。
  async function injectCookiesToPartition(cookieStr, platform) {
    const bridge = nativeBridge();
    if (!bridge.hasWebviewSession()) throw new Error('当前环境不支持内置浏览器免登录(需在桌面应用中使用)');
    const pc = (config.platforms && config.platforms[platform]) || {};
    const baseUrl = (pc.baseUrl || 'https://www.doubao.com').replace(/\/+$/, '');
    let host = 'doubao.com';
    try { host = new URL(baseUrl).hostname.split('.').slice(-2).join('.'); } catch (e) { /* ignore */ }

    const pairs = String(cookieStr || '').split(';').map(s => s.trim()).filter(Boolean);
    const seen = new Set();
    let count = 0;
    for (const p of pairs) {
      const idx = p.indexOf('=');
      if (idx <= 0) continue;
      const name = p.slice(0, idx).trim();
      const value = p.slice(idx + 1).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      try {
        await bridge.setCookie(DOUBAO_WEBVIEW_PARTITION, {
          url: baseUrl,
          name,
          value,
          domain: '.' + host,
          path: '/',
          secure: true
        });
        count++;
      } catch (e) { /* 单条失败跳过 */ }
    }
    return count;
  }

  // 清空 webview 分区里指定域的全部 cookie(解绑用)
  async function clearPartitionCookies(platform) {
    const bridge = nativeBridge();
    if (!bridge.hasWebviewSession()) return;
    try {
      const all = await bridge.getCookies(DOUBAO_WEBVIEW_PARTITION, {});
      for (const c of all) {
        const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
        try { await bridge.removeCookie(DOUBAO_WEBVIEW_PARTITION, url, c.name); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  function persist() {
    try {
      atomicWriteJsonFile(paths.configFile, config, { fs });
      return true;
    } catch (e) {
      return false;
    }
  }

  // GET /api/settings - 读取当前存储设置
  router.get('/', (req, res) => {
    const storage = config.storage || { autoDownload: true, downloadDir: '' };
    res.json({
      success: true,
      data: {
        autoDownload: storage.autoDownload !== false,
        downloadDir: storage.downloadDir || '',
        effectiveDir: paths.resolveDownloadDir(storage.downloadDir),
        defaultDir: paths.downloadsDir,
        canPickDir: canPickDownloadDir(),
        // 浏览器窗口模式:visible=有头可见 / background=后台离屏 / headless=无头。默认 background。
        browserWindowMode: ['visible', 'background', 'headless'].includes(storage.browserWindowMode) ? storage.browserWindowMode : 'background'
      }
    });
  });

  // POST /api/settings - 保存存储设置 { autoDownload, downloadDir, browserWindowMode }
  router.post('/', (req, res) => {
    const { autoDownload, downloadDir, browserWindowMode } = req.body || {};
    if (!config.storage) config.storage = {};
    if (autoDownload !== undefined) config.storage.autoDownload = !!autoDownload;
    if (browserWindowMode !== undefined) {
      if (!['visible', 'background', 'headless'].includes(browserWindowMode)) {
        return res.status(400).json({ success: false, error: '无效的窗口模式' });
      }
      config.storage.browserWindowMode = browserWindowMode;
    }
    if (downloadDir !== undefined) {
      const dir = String(downloadDir || '').trim();
      // 校验：非空时尝试创建/确认可写
      if (dir) {
        const resolved = require('path').resolve(dir);
        try {
          fs.mkdirSync(resolved, { recursive: true });
          fs.accessSync(resolved, fs.constants.W_OK);
        } catch (e) {
          return res.status(400).json({ success: false, error: '目录不可写: ' + e.message });
        }
        config.storage.downloadDir = resolved;
      } else {
        config.storage.downloadDir = '';
      }
    }
    if (!persist()) return res.status(500).json({ success: false, error: '保存配置失败' });
    // 同步给 media 本地文件服务
    app.locals.downloadDir = config.storage.downloadDir || '';
    res.json({
      success: true,
      data: {
        autoDownload: config.storage.autoDownload !== false,
        downloadDir: config.storage.downloadDir || '',
        effectiveDir: paths.resolveDownloadDir(config.storage.downloadDir),
        browserWindowMode: config.storage.browserWindowMode || 'background'
      }
    });
  });

  // POST /api/settings/pick-dir - 弹原生选目录框（仅 Electron）
  router.post('/pick-dir', async (req, res) => {
    if (!canPickDownloadDir()) {
      return res.json({ success: false, error: 'no_native', message: '当前环境不支持原生选目录，请手动输入路径' });
    }
    try {
      const result = await pickDownloadDir({
        title: '选择下载目录',
        properties: ['openDirectory', 'createDirectory']
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return res.json({ success: false, error: 'canceled' });
      }
      res.json({ success: true, data: { dir: result.filePaths[0] } });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // POST /api/settings/open-dir - 在系统文件管理器中打开下载目录
  router.post('/open-dir', (req, res) => {
    const dir = paths.resolveDownloadDir(config.storage && config.storage.downloadDir);
    const bridge = nativeBridge();
    if (bridge.canOpenPath()) {
      bridge.openPath(dir).then(() => res.json({ success: true, data: { dir } }))
        .catch(e => res.json({ success: false, error: e.message }));
      return;
    }
    // 非 Electron 兜底：用系统命令打开
    try {
      const { exec } = require('child_process');
      const cmd = process.platform === 'win32' ? `explorer "${dir}"`
        : process.platform === 'darwin' ? `open "${dir}"` : `xdg-open "${dir}"`;
      exec(cmd);
      res.json({ success: true, data: { dir } });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // ---- 自定义图片 API 渠道 / OpenAI-compatible 图片 API ----
  // GET /api/settings/image-api - 读取配置（不返回明文 key）
  router.get('/image-api', (req, res) => {
    res.json({ success: true, data: publicImageApiConfig(config, req.query.platform) });
  });

  // POST /api/settings/image-api - 保存 { platform, endpoint/baseUrl, apiKey?, model, size?, quality? }
  // apiKey 留空时保持原值，避免前端每次保存都要求重填密钥。
  router.post('/image-api', (req, res) => {
    try {
      const { platform } = req.body || {};
      const { key } = saveImageApiConfig(config, { ...(req.body || {}), platform: platform || req.query.platform });
      if (!persist()) return res.status(500).json({ success: false, error: '保存配置失败' });
      res.json({ success: true, data: publicImageApiConfig(config, key) });
    } catch (e) {
      res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
  });

  // 启动时重新注入已绑定账号的登录态:
  // webview 分区虽是 persist:,但豆包登录态含大量 session cookie(无过期时间,关进程即失效),
  // 所以每次启动需按 config.webviewBinding.doubao 重新注入一次,否则用户得手动再绑一次。
  // 挂到 app.locals,供 Electron 主进程在注入 nativeBridge 后调用。
  app.locals.reinjectWebviewBinding = async function () {
    try {
      if (!nativeBridge().hasWebviewSession() || !accountManager) return { injected: 0, reason: 'no_session_or_manager' };
      const bind = (config.webviewBinding && config.webviewBinding.doubao) || '';
      if (!bind) return { injected: 0, reason: 'not_bound' };
      const acc = accountManager.getById(bind);
      const cookies = acc && acc.session && acc.session.cookies;
      if (!cookies) return { injected: 0, reason: 'no_cookies' };
      await clearPartitionCookies('doubao');
      const injected = await injectCookiesToPartition(cookies, 'doubao');
      return { injected, accountId: bind };
    } catch (e) {
      return { injected: 0, error: e.message };
    }
  };

  // ---- 内置浏览器(豆包对话 webview)账号绑定 ----
  // GET /api/settings/webview-binding - 当前绑定状态 + 可选豆包账号列表
  router.get('/webview-binding', (req, res) => {
    const bind = (config.webviewBinding && config.webviewBinding.doubao) || null;
    let accounts = [];
    if (accountManager) {
      accounts = accountManager.getAllByPlatform('doubao')
        .filter(a => a.session && a.session.cookies) // 仅列出有登录态的账号
        .map(a => ({ id: a.id, name: a.name }));
    }
    let boundName = '';
    if (bind && accountManager) {
      const acc = accountManager.getById(bind);
      boundName = acc ? acc.name : '';
    }
    res.json({
      success: true,
      data: {
        supported: nativeBridge().hasWebviewSession(),
        boundAccountId: bind || '',
        boundAccountName: boundName,
        accounts
      }
    });
  });

  // POST /api/settings/webview-binding - 绑定/解绑 { accountId }(空字符串=解绑)
  router.post('/webview-binding', async (req, res) => {
    if (!accountManager) return res.status(500).json({ success: false, error: 'no_account_manager' });
    const accountId = String((req.body && req.body.accountId) || '').trim();

    if (!config.webviewBinding) config.webviewBinding = {};

    // 解绑:清掉分区 cookie + 配置
    if (!accountId) {
      await clearPartitionCookies('doubao');
      delete config.webviewBinding.doubao;
      persist();
      return res.json({ success: true, data: { boundAccountId: '', injected: 0 } });
    }

    const acc = accountManager.getById(accountId);
    if (!acc) return res.status(404).json({ success: false, error: '账号不存在' });
    if ((acc.platform || 'doubao') !== 'doubao') return res.status(400).json({ success: false, error: '只能绑定豆包账号' });
    const cookies = acc.session && acc.session.cookies;
    if (!cookies) return res.status(400).json({ success: false, error: '该账号无登录态,请先登录' });

    try {
      // 先清旧的,再注入新的,避免多账号 cookie 残留串味
      await clearPartitionCookies('doubao');
      const injected = await injectCookiesToPartition(cookies, 'doubao');
      config.webviewBinding.doubao = accountId;
      persist();
      res.json({ success: true, data: { boundAccountId: accountId, injected } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---- 对外 API 访问配置 ----
  // GET /api/settings/api-access - 读取开关 + token + 本机访问地址
  router.get('/api-access', (req, res) => {
    if (!apiTokenManager) return res.status(500).json({ success: false, error: 'no_manager' });
    const cfg = apiTokenManager.getConfig();
    const port = (config.server && config.server.port) || 9527;
    res.json({ success: true, data: buildApiAccessData(cfg, { port }) });
  });

  // POST /api/settings/api-access - 设置开关 { enabled }
  router.post('/api-access', (req, res) => {
    if (!apiTokenManager) return res.status(500).json({ success: false, error: 'no_manager' });
    const { enabled } = req.body || {};
    const cfg = apiTokenManager.setEnabled(!!enabled);
    res.json({ success: true, data: { enabled: cfg.enabled } });
  });

  // POST /api/settings/api-access/regen - 重新生成 token
  router.post('/api-access/regen', (req, res) => {
    if (!apiTokenManager) return res.status(500).json({ success: false, error: 'no_manager' });
    const cfg = apiTokenManager.regenerateToken();
    res.json({ success: true, data: { token: cfg.token, createdAt: cfg.createdAt } });
  });

  // ---- MCP 接入配置 ----
  // MCP 复用「对外 API」的同一个开关与 token:MCP 垫片本质是把 IDE 的调用转发到 /ext。
  // GET /api/settings/mcp - 返回垫片路径 + 现成的 IDE 配置片段(Claude / Codex / 通用)
  router.get('/mcp', (req, res) => {
    if (!apiTokenManager) return res.status(500).json({ success: false, error: 'no_manager' });
    const cfg = apiTokenManager.getConfig();
    const port = (config.server && config.server.port) || 9527;
    const serverPath = paths.mcpServerFile;
    const serverExists = (() => { try { return fs.existsSync(serverPath); } catch (e) { return false; } })();

    res.json({
      success: true,
      data: buildMcpData(cfg, {
        port,
        mcpServerFile: serverPath,
        isPackaged: paths.isPackaged,
        execPath: process.execPath,
        serverExists
      })
    });
  });

  return router;
};
