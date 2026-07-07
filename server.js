const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const paths = require('./paths');
const { createNullNativeBridge } = require('./services/native-bridge');
const { WS_EVENTS } = require('./services/ws-events');

const DEFAULT_SERVER_PORT = 9527;
const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_PORT_FALLBACK_COUNT = 20;
const FALLBACKABLE_LISTEN_ERRORS = new Set(['EADDRINUSE', 'EACCES']);

function toPort(value, fallback = DEFAULT_SERVER_PORT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) return fallback;
  return parsed;
}

function toFallbackCount(value, fallback = DEFAULT_PORT_FALLBACK_COUNT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, 100);
}

function normalizeListenHost(host) {
  const value = String(host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::' || value === '*') return DEFAULT_SERVER_HOST;
  return value;
}

function resolveListenOptions(config = {}, env = process.env || {}) {
  const serverConfig = config.server || {};
  return {
    port: toPort(env.LULU_PORT || serverConfig.port, DEFAULT_SERVER_PORT),
    host: env.LULU_HOST ? String(env.LULU_HOST).trim() || DEFAULT_SERVER_HOST : normalizeListenHost(serverConfig.host),
    fallbackCount: toFallbackCount(env.LULU_PORT_FALLBACK_COUNT || serverConfig.portFallbackCount, DEFAULT_PORT_FALLBACK_COUNT)
  };
}

function buildPortCandidates(port, fallbackCount = DEFAULT_PORT_FALLBACK_COUNT) {
  const basePort = toPort(port, DEFAULT_SERVER_PORT);
  if (basePort === 0) return [0];
  const count = toFallbackCount(fallbackCount, DEFAULT_PORT_FALLBACK_COUNT);
  const ports = [];
  for (let i = 0; i <= count && basePort + i <= 65535; i++) {
    ports.push(basePort + i);
  }
  return ports;
}

function formatUrlHost(host) {
  const value = String(host || DEFAULT_SERVER_HOST).trim();
  if (value === '0.0.0.0' || value === '::' || value === '*') return DEFAULT_SERVER_HOST;
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onError = (error) => finish(reject, error);
    const onListening = () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      finish(resolve, { port: actualPort, host });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function listenWithPortFallback(server, options) {
  const host = options.host || DEFAULT_SERVER_HOST;
  const candidates = buildPortCandidates(options.port, options.fallbackCount);
  let lastError = null;

  for (const port of candidates) {
    try {
      return await listenOnce(server, port, host);
    } catch (error) {
      lastError = error;
      if (!FALLBACKABLE_LISTEN_ERRORS.has(error && error.code)) throw error;
    }
  }

  throw lastError || new Error('No available listen port');
}

// 启动服务，返回 { server, port, config }。可被 Electron 主进程调用，也可独立运行。
function start() {
  paths.ensureDirs();
  paths.ensureConfig();

  // 加载配置（打包后从外部 config/config.json 读，用户可改）
  const config = paths.loadConfig ? paths.loadConfig() : JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'));
  const listenOptions = resolveListenOptions(config);

  const AccountManager = require('./services/account-manager');
  const BrowserManager = require('./services/browser-manager');
  const GenerationService = require('./services/generation-service');
  const QuotaPoller = require('./services/quota-poller');
  const ConversationManager = require('./services/conversation-manager');
  const JobManager = require('./services/job-manager');
  const LicenseManager = require('./services/license-manager');
  const MediaDownloader = require('./services/media-downloader');
  const ApiTokenManager = require('./services/api-token-manager');
  const ResultPersistenceService = require('./services/result-persistence-service');
  const ClaudeService = require('./services/claude-service');

  const accountManager = new AccountManager(config);
  const browserManager = new BrowserManager(config);
  const conversationManager = new ConversationManager(config);
  const generationService = new GenerationService(accountManager, conversationManager, config);
  const quotaPoller = new QuotaPoller(null, accountManager, config);
  const licenseManager = new LicenseManager(config);
  const mediaDownloader = new MediaDownloader(generationService, config);
  const resultPersistenceService = new ResultPersistenceService(conversationManager, mediaDownloader);
  const apiTokenManager = new ApiTokenManager();
  const claudeService = new ClaudeService(config);
  licenseManager.load();
  apiTokenManager.load();

  accountManager.init();
  conversationManager.init();

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: WS_EVENTS.INIT,
      data: {
        activeAccount: accountManager.getActive(),
        quotaStatus: quotaPoller.getQuotaStatus()
      }
    }));
  });

  function broadcast(message) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(data);
    });
  }

  // 全局 JSON 解析跳过 /ext:对外 API 的 body 解析延迟到 ext.js 内部鉴权通过后再做,
  // 避免无 token / 错 token 的大 JSON(最大 25mb)被无谓解析拖慢主 event loop。
  const jsonParser = express.json({ limit: '25mb' });
  app.use((req, res, next) => {
    if (req.path.startsWith('/ext')) return next();
    return jsonParser(req, res, next);
  });
  app.use(express.static(paths.publicDir, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); }
  }));

  // 卡密路由（不受拦截中间件限制）
  app.use('/api/license', require('./routes/license')(licenseManager));

  // API 拦截中间件：未验证卡密时阻止所有业务接口
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/license')) return next();
    if (!licenseManager.isValid()) {
      return res.status(403).json({ success: false, error: 'license_required', message: '请先激活卡密' });
    }
    next();
  });

  const jobManager = new JobManager(broadcast);
  app.locals.nativeBridge = createNullNativeBridge();
  // media 本地文件服务读取当前下载目录（运行时改目录时同步更新）
  app.locals.downloadDir = (config.storage && config.storage.downloadDir) || '';
  const apiRoutes = require('./routes/api')(accountManager, browserManager, generationService, quotaPoller, broadcast, conversationManager, jobManager, mediaDownloader, resultPersistenceService);
  app.use('/api', apiRoutes);

  // 对外 API(供外部 AI IDE / agent 调用):独立挂载 /ext,自带 token+CORS,不受卡密中间件限制
  app.use('/ext', require('./routes/ext')({
    accountManager, generationService, quotaPoller, conversationManager,
    jobManager, mediaDownloader, broadcast, apiTokenManager, resultPersistenceService
  }));

  // 设置路由：读写 storage 配置 + 原生选目录 + 打开目录 + 对外 API 开关 + 内置浏览器账号绑定
  app.use('/api/settings', require('./routes/settings')(config, app, paths, apiTokenManager, accountManager));

  // Claude 文本对话路由(配置 + 拉模型 + SSE 流式对话)
  app.use('/api/claude', require('./routes/claude')(claudeService));

  // SPA fallback：手动读文件返回（打包快照下比 sendFile 更可靠）
  app.get('*', (req, res) => {
    try {
      const html = fs.readFileSync(path.join(paths.publicDir, 'index.html'), 'utf-8');
      res.type('html').send(html);
    } catch (e) {
      res.status(500).send('index.html 读取失败');
    }
  });

  quotaPoller.start(wss);

  // 卡密定时复验失败时广播给前端
  licenseManager.onLicenseInvalid = (result) => {
    broadcast({ type: WS_EVENTS.LICENSE_INVALID, data: result });
  };
  // 启动时联网验证（不阻塞）：load() 已对有效本地缓存乐观放行，这里在后台纠错。
  // 仅当服务器"明确拒绝"（非网络异常/宽限期）时才撤销放行并弹卡密。
  licenseManager.verify().then(r => {
    if (r.success) {
      licenseManager.startPeriodicCheck();
    } else if (r.error && r.error !== 'offline_no_cache' && r.error !== 'no_license') {
      broadcast({ type: WS_EVENTS.LICENSE_INVALID, data: r });
    }
  }).catch(() => {});

  // 启动时主动查询所有账号额度（不阻塞启动）
  generationService.queryAllQuotas().then(() => {
    broadcast({ type: WS_EVENTS.QUOTA_UPDATE, data: { refreshed: true } });
  }).catch(() => {});

  // 退出清理
  const cleanup = () => {
    try { quotaPoller.stop(); } catch (e) {}
    try { browserManager.closeAll(); } catch (e) {}
    try { server.close(); } catch (e) {}
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  return new Promise((resolve, reject) => {
    listenWithPortFallback(server, listenOptions).then(({ port, host }) => {
      const url = `http://${formatUrlHost(host)}:${port}`;
      config.server = {
        ...(config.server || {}),
        port,
        host,
        portFallbackCount: listenOptions.fallbackCount
      };
      console.log(`豆包管理工作台已启动: ${url}`);
      console.log(`账号数据: ${accountManager.getAll().length} 个`);
      console.log(`数据目录: ${paths.dataRoot}`);
      resolve({ server, port, url, config, cleanup, browserManager, app });
    }).catch(reject);
  });
}

module.exports = {
  start,
  buildPortCandidates,
  listenWithPortFallback,
  resolveListenOptions
};

// 独立运行（node server.js）：启动后按需自动开浏览器（仅 pkg 打包模式）
if (require.main === module) {
  start().then(({ url }) => {
    if (paths.isPackaged) {
      try { require('child_process').exec(`start "" "${url}"`); } catch (e) {}
    }
  }).catch(err => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });
}
