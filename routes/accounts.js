const express = require('express');
const router = express.Router();
const AutoLogin = require('../services/auto-login');
const AccountImporter = require('../services/account-importer');
const { WS_EVENTS } = require('../services/ws-events');

module.exports = function(accountManager, browserManager, broadcast, conversationManager) {
  const emit = typeof broadcast === 'function' ? broadcast : () => {};
  const importer = new AccountImporter(accountManager, browserManager);

  function getPlatformConfig(platform) {
    const platforms = (accountManager.config && accountManager.config.platforms) || {};
    return platforms[platform] || null;
  }

  function ensurePlatformAllowsAccounts(platform) {
    const pc = getPlatformConfig(platform);
    if (pc && pc.requiresAccount === false) {
      const label = pc.label || platform;
      const err = new Error(`${label} 不需要添加账号，请使用该平台的本地授权/API 配置`);
      err.statusCode = 400;
      throw err;
    }
  }

  // 脱敏：不下发完整 cookies 原文，只给布尔标记（减小负载 + 防泄露）
  function sanitize(a) {
    if (!a) return a;
    return {
      ...a,
      session: a.session ? {
        device_id: a.session.device_id || '',
        web_id: a.session.web_id || '',
        aid: a.session.aid || '',
        bot_id: a.session.bot_id || '',
        cookies: !!a.session.cookies
      } : null
    };
  }

  // GET /api/accounts - 获取所有账号（脱敏：不下发完整 cookies，只给布尔标记，减小负载）
  router.get('/', (req, res) => {
    const accounts = accountManager.getAll().map(sanitize);
    res.json({ success: true, data: accounts });
  });

  // GET /api/accounts/active - 获取当前活跃账号（同样脱敏）
  router.get('/active', (req, res) => {
    const account = accountManager.getActive();
    if (!account) return res.json({ success: true, data: null });
    res.json({ success: true, data: { ...sanitize(account), isActive: true } });
  });

  // POST /api/accounts/launch-login - 拉起浏览器让用户登录
  router.post('/launch-login', async (req, res) => {
    try {
      const { name, reuseId, platform } = req.body;
      let account;

      if (reuseId) {
        // 重新登录已有账号
        account = accountManager.getById(reuseId);
        if (!account) return res.status(404).json({ success: false, error: '账号不存在' });
        ensurePlatformAllowsAccounts(account.platform || platform || 'doubao');
      } else {
        // 新建账号（带平台，默认 doubao）
        ensurePlatformAllowsAccounts(platform || 'doubao');
        account = accountManager.add({ name: name || '新账号', platform: platform || 'doubao' });
      }

      const accPlatform = account.platform || platform || 'doubao';
      const { port } = await browserManager.launchForLogin(account.id, accPlatform);
      res.json({
        success: true,
        data: { accountId: account.id, port, platform: accPlatform }
      });
    } catch (e) {
      if (e && e.code === 'CHROME_SELECTION_CANCELLED') {
        return res.status(400).json({ success: false, error: 'chrome_selection_cancelled', message: e.message });
      }
      res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
  });

  // POST /api/accounts/:id/confirm-login - 用户确认已登录，抓取cookies并存储
  router.post('/:id/confirm-login', async (req, res) => {
    try {
      const accountId = req.params.id;
      if (!browserManager.isRunning(accountId)) {
        return res.status(400).json({ success: false, error: '浏览器未运行' });
      }

      const account = accountManager.getById(accountId);
      const platform = (account && account.platform) || 'doubao';
      // 该平台的默认 aid（从平台配置取）
      const platforms = (accountManager.config && accountManager.config.platforms) || {};
      const pc = platforms[platform] || platforms.doubao || {};
      const aid = (pc.defaultParams && pc.defaultParams.aid) || '497858';
      const botId = pc.botId || '';

      // 通过 CDP 抓取 cookies 和参数
      const data = await browserManager.grabCookiesAndParams(accountId);

      if (!data.cookies) {
        return res.status(400).json({ success: false, error: '未获取到cookies，请确认已登录' });
      }

      // 存储到账号
      accountManager.update(accountId, {
        status: 'active',
        browser: browserManager.getAccountBrowserState(accountId),
        session: {
          cookies: data.cookies,
          device_id: data.device_id || '',
          web_id: data.web_id || '',
          user_id: data.user_id || '',
          fp: data.fp || '',
          conversation_id: data.conversation_id || '',
          aid,
          bot_id: botId
        }
      });

      // 关闭浏览器
      browserManager.close(accountId);

      res.json({ success: true, data: { message: '登录态已保存' } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/accounts/:id/status - 浏览器是否运行
  router.get('/:id/status', (req, res) => {
    const running = browserManager.isRunning(req.params.id);
    res.json({ success: true, data: { browserRunning: running } });
  });

  // POST /api/accounts/:id/open - 用该账号登录态打开对应平台网页（可见浏览器）
  router.post('/:id/open', async (req, res) => {
    try {
      const account = accountManager.getById(req.params.id);
      if (!account) return res.status(404).json({ success: false, error: '账号不存在' });
      const platform = account.platform || 'doubao';
      const { port } = await browserManager.launchForLogin(account.id, platform);
      accountManager.update(account.id, {
        browser: browserManager.getAccountBrowserState(account.id)
      });
      // 关键：把保存的登录态 cookie 注入浏览器，避免 profile 会话 cookie 失效后打开是未登录页。
      const cookieStr = account.session && account.session.cookies;
      if (cookieStr) {
        try {
          // 等页面初步加载出来再注入（首启需要时间）
          await browserManager.waitForPlatformPage(port, 12000, platform);
          await browserManager.injectCookies(account.id, cookieStr, platform);
        } catch (e) {
          // 注入失败不阻断打开，浏览器仍可用（用户可手动登录）
          console.warn(`[open] 注入 cookie 失败 [${account.id}]:`, e.message);
        }
      }
      res.json({ success: true, data: { port, platform } });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/accounts/:id/activate - 设为活跃账号（同时更新所属平台的活跃账号）
  router.post('/:id/activate', (req, res) => {
    try {
      const account = accountManager.setActive(req.params.id);
      res.json({ success: true, data: account });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // POST /api/accounts/:id/close - 关闭浏览器
  router.post('/:id/close', (req, res) => {
    browserManager.close(req.params.id);
    res.json({ success: true });
  });

  // DELETE /api/accounts/platform/:platform - 清空指定平台的所有账号
  router.delete('/platform/:platform', (req, res) => {
    try {
      const platform = req.params.platform;
      const fs = require('fs');
      // 先取出该平台账号 id，关闭浏览器并清理 profile 目录
      const targets = accountManager.getAllByPlatform(platform);
      for (const acc of targets) {
        try { browserManager.close(acc.id); } catch (e) {}
        try {
          const dir = browserManager.getProfileDir(acc.id);
          if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {}
      }
      const removedIds = accountManager.removeByPlatform(platform);
      if (conversationManager && typeof conversationManager.detachAccounts === 'function') {
        conversationManager.detachAccounts(removedIds);
      }
      res.json({ success: true, data: { count: removedIds.length } });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/accounts/:id - 删除账号
  router.delete('/:id', (req, res) => {
    try {
      const fs = require('fs');
      browserManager.close(req.params.id);
      const account = accountManager.getById ? accountManager.getById(req.params.id) : null;
      const dir = (account && (account.profileDir || account.browser?.profileDir)) || (browserManager.getProfileDir ? browserManager.getProfileDir(req.params.id) : '');
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      if (conversationManager && typeof conversationManager.detachAccount === 'function') {
        conversationManager.detachAccount(req.params.id);
      }
      accountManager.remove(req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // POST /api/accounts/auto-login - 批量自动登录（dola 谷歌账号，email|password 格式）
  // body: { platform, accounts: [{email, password}], windowMode? }
  // 立即返回 started:true，进度/结果通过 WebSocket 广播（type: 'auto_login_progress'）。
  router.post('/auto-login', async (req, res) => {
    try {
      const { accounts: list, windowMode: reqMode } = req.body || {};
      const platform = normalizePlatform((req.body && req.body.platform) || 'dola');
      if (!Array.isArray(list) || list.length === 0) {
        return res.status(400).json({ success: false, error: '账号列表为空' });
      }
      if (platform !== 'dola') {
        return res.status(400).json({ success: false, error: '批量自动登录目前仅支持 Dola 谷歌账号' });
      }
      // 窗口模式:请求显式指定优先,否则读全局设置 config.storage.browserWindowMode,默认 background。
      const cfgMode = (accountManager.config && accountManager.config.storage && accountManager.config.storage.browserWindowMode);
      const windowMode = ['visible', 'background', 'headless'].includes(reqMode) ? reqMode
        : (['visible', 'background', 'headless'].includes(cfgMode) ? cfgMode : 'background');
      // 立即响应，后台异步执行
      res.json({ success: true, data: { started: true, total: list.length } });

      // 后台串行登录（避免代理/端口争用，且更像真人）
      (async () => {
        for (let i = 0; i < list.length; i++) {
          const cred = list[i] || {};
          const email = normalizeEmail(cred.email);
          const password = normalizePassword(cred.password);
          const masked = maskEmail(email);
          const idx = i + 1;

          if (!email || !password) {
            emit({ type: WS_EVENTS.AUTO_LOGIN_PROGRESS, data: { index: idx, total: list.length, email: masked, status: 'error', message: '邮箱或密码为空' } });
            continue;
          }

          // 重复检测：同平台同备注名(邮箱)已存在则跳过
          const exists = accountManager.getAllByPlatform(platform).find(a => normalizeEmail(a.name) === email);
          if (exists) {
            emit({ type: WS_EVENTS.AUTO_LOGIN_PROGRESS, data: { index: idx, total: list.length, email: masked, status: 'skip', message: '账号已存在,跳过' } });
            continue;
          }

          let account = null;
          try {
            emit({ type: WS_EVENTS.AUTO_LOGIN_PROGRESS, data: { index: idx, total: list.length, email: masked, status: 'running', message: '启动浏览器...' } });
            account = accountManager.add({ name: email, platform });
            await browserManager.launchForLogin(account.id, platform, { windowMode });

            const auto = new AutoLogin(browserManager, {
              platform,
              log: (msg) => emit({ type: WS_EVENTS.AUTO_LOGIN_PROGRESS, data: { index: idx, total: list.length, email: masked, status: 'running', message: msg } }),
            });
            const r = await auto.loginOne(account.id, { email, password });
            if (!r || !r.success) throw new Error((r && r.error) || '登录失败');

            // 抓 cookie 保存
            emit({ type: WS_EVENTS.AUTO_LOGIN_PROGRESS, data: { index: idx, total: list.length, email: masked, status: 'running', message: '保存登录态...' } });
            const platforms = (accountManager.config && accountManager.config.platforms) || {};
            const pc = platforms[platform] || {};
            const aid = (pc.defaultParams && pc.defaultParams.aid) || '';
            const botId = pc.botId || '';
            const data = await browserManager.grabCookiesAndParams(account.id);
            if (!data.cookies) throw new Error('未获取到登录态cookie');

            accountManager.update(account.id, {
              status: 'active',
              browser: browserManager.getAccountBrowserState(account.id),
              session: {
                cookies: data.cookies,
                device_id: data.device_id || '',
                web_id: data.web_id || '',
                user_id: data.user_id || '',
                fp: data.fp || '',
                conversation_id: data.conversation_id || '',
                aid, bot_id: botId,
              },
            });
            browserManager.close(account.id);
            emit({ type: WS_EVENTS.AUTO_LOGIN_PROGRESS, data: { index: idx, total: list.length, email: masked, status: 'success', message: '登录成功' } });
          } catch (e) {
            const keepBrowserOpen = !!(account && e && e.keepBrowserOpen);
            if (keepBrowserOpen) {
              try {
                if (accountManager.update) {
                  accountManager.update(account.id, {
                    status: 'login_attention',
                    loginAttention: {
                      stage: e.stage || 'google_manual_attention',
                      reason: e.reason || 'manual_attention_required',
                      message: e.message || 'Google 登录需要人工处理',
                      updatedAt: new Date().toISOString()
                    },
                    browser: browserManager.getAccountBrowserState ? browserManager.getAccountBrowserState(account.id) : undefined
                  });
                }
              } catch (_) {}
            } else {
              // 非人工处理类失败：关浏览器 + 删除半成品账号
              try { if (account) browserManager.close(account.id); } catch (_) {}
              try { if (account) accountManager.remove(account.id); } catch (_) {}
            }
            emit({
              type: WS_EVENTS.AUTO_LOGIN_PROGRESS,
              data: {
                index: idx,
                total: list.length,
                email: masked,
                status: 'error',
                message: e.message || '登录失败',
                ...(account ? { accountId: account.id } : {}),
                ...(keepBrowserOpen ? { browserKeptOpen: true } : {}),
                ...(e.stage ? { stage: e.stage } : {}),
                ...(e.reason ? { reason: e.reason } : {})
              }
            });
          }
          await new Promise(r => setTimeout(r, 1500));
        }
        emit({ type: WS_EVENTS.AUTO_LOGIN_PROGRESS, data: { done: true, total: list.length } });
        emit({ type: WS_EVENTS.QUOTA_UPDATE, data: { refreshed: true } });
      })();
    } catch (e) {
      // 已发送响应则忽略
      if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
    }
  });

  // 邮箱脱敏（前3位 + ***@域名）
  function maskEmail(email) {
    if (!email || email.indexOf('@') < 0) return '***';
    const [u, d] = email.split('@');
    return u.slice(0, 3) + '***@' + d;
  }

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizePassword(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function normalizePlatform(value) {
    return String(value || '').trim().toLowerCase();
  }

  // ===== 账号备份导入(兼容 doubao-account-switcher 的 account-login-backup 格式)=====

  // POST /api/accounts/pick-backup-dir - 弹原生选目录框(仅 Electron),供前端选备份文件夹
  router.post('/pick-backup-dir', async (req, res) => {
    const bridge = req.app.locals.nativeBridge;
    if (!bridge || !bridge.canPickDir || !bridge.canPickDir()) {
      return res.json({ success: false, error: 'no_native', message: '当前环境不支持原生选目录,请手动输入路径' });
    }
    try {
      const result = await bridge.pickDirectory({
        title: '选择账号备份文件夹',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return res.json({ success: false, error: 'canceled' });
      }
      res.json({ success: true, data: { dir: result.filePaths[0] } });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // POST /api/accounts/inspect-backup { dir } - 探测备份目录,返回账号数量供前端确认
  router.post('/inspect-backup', (req, res) => {
    const dir = String((req.body && req.body.dir) || '').trim();
    if (!dir) return res.status(400).json({ success: false, error: '未提供目录' });
    const info = importer.inspect(dir);
    if (!info.ok) return res.json({ success: false, error: info.error });
    const platforms = {};
    for (const a of info.accounts) {
      const p = a.platform || 'doubao';
      platforms[p] = (platforms[p] || 0) + 1;
    }
    res.json({ success: true, data: { total: info.accounts.length, platforms, hasLocalState: !!info.localStateFile } });
  });

  // POST /api/accounts/import-backup { dir, platform?, skipExisting?, grab? }
  // 立即响应,后台异步导入,进度经 WS(IMPORT_PROGRESS)广播。
  router.post('/import-backup', async (req, res) => {
    const dir = String((req.body && req.body.dir) || '').trim();
    if (!dir) return res.status(400).json({ success: false, error: '未提供目录' });

    const info = importer.inspect(dir);
    if (!info.ok) return res.status(400).json({ success: false, error: info.error });

    const opts = {
      platform: (req.body && req.body.platform) || undefined,
      skipExisting: (req.body && req.body.skipExisting) !== false,
      grab: !!(req.body && req.body.grab),
    };

    res.json({ success: true, data: { started: true, total: info.accounts.length } });

    (async () => {
      try {
        const summary = await importer.import(dir, opts, (p) => {
          emit({ type: WS_EVENTS.IMPORT_PROGRESS, data: p });
        });
        emit({ type: WS_EVENTS.IMPORT_PROGRESS, data: { done: true, ...summary } });
        emit({ type: WS_EVENTS.QUOTA_UPDATE, data: { refreshed: true } });
      } catch (e) {
        emit({ type: WS_EVENTS.IMPORT_PROGRESS, data: { done: true, success: false, error: e.message || '导入失败' } });
      }
    })();
  });

  return router;
};
