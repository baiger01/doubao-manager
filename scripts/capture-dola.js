// Dola 全量网络抓包脚本（CDP）
//
// 用途：拉起一个带 CDP 的 Chrome（走 dola 代理），打开 dola，让你登录并操作；
// 通过 Chrome DevTools Protocol 的 Network 域拦截所有请求/响应，重点完整记录
// API（XHR/Fetch/Document）的：URL、query、请求头、请求体(postData)、响应头、响应体。
//
// 运行： node scripts/capture-dola.js
// 输出： debug/capture/dola-<时间戳>.jsonl  （逐条事件，便于 grep/解析）
//        debug/capture/dola-<时间戳>.log    （人类可读摘要）
//
// 退出： Ctrl+C，会自动 flush 文件并关闭浏览器。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const WebSocket = require('ws');

const appPaths = require('../paths');
const BrowserRuntime = require('../services/browser-runtime');

// ── 读取配置 ──────────────────────────────────────────────
function loadConfig() {
  const candidates = [appPaths.configFile, path.join(__dirname, '..', 'config', 'config.json')];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch (e) { /* next */ }
  }
  return {};
}
const config = loadConfig();
const dolaCfg = (config.platforms && config.platforms.dola) || {};
const PROXY = dolaCfg.proxy || '';
const START_URL = dolaCfg.loginUrl || dolaCfg.baseUrl || 'https://www.dola.com/chat/';
const PORT = 19333;

// 抓包专用 profile（复用登录态，下次不用重登）
const PROFILE_DIR = path.join(appPaths.profilesDir, '_capture_dola');

// 输出目录
const OUT_DIR = path.join(appPaths.debugDir, 'capture');
fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const JSONL_FILE = path.join(OUT_DIR, `dola-${stamp}.jsonl`);
const LOG_FILE = path.join(OUT_DIR, `dola-${stamp}.log`);
const jsonlStream = fs.createWriteStream(JSONL_FILE, { flags: 'a' });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function writeJsonl(obj) { jsonlStream.write(JSON.stringify(obj) + '\n'); }
function log(line) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const msg = `[${t}] ${line}`;
  console.log(msg);
  logStream.write(msg + '\n');
}

// 只对 API 类资源抓 body，静态资源(脚本/样式/图片/字体)只记 URL，减少噪音
const API_TYPES = new Set(['XHR', 'Fetch', 'Document', 'EventSource', 'WebSocket']);
// 关心的 dola 业务接口（命中则强制完整记录，并高亮打印）
const HOT_PATTERNS = [
  /\/chat\/completion/i,
  /upload/i,
  /imagex/i,
  /get_play_info/i,
  /media/i,
  /attachment/i,
  /\/im\/chain/i,
  /apply.*image|prepare.*upload|commit/i,
];
function isHot(url) { return HOT_PATTERNS.some(re => re.test(url)); }

// ── 清理 profile lockfile ────────────────────────────────
for (const name of ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  try { fs.unlinkSync(path.join(PROFILE_DIR, name)); } catch (e) { /* 不存在就忽略 */ }
}

// ── 启动 Chrome ──────────────────────────────────────────
async function launchChrome() {
  const runtime = new BrowserRuntime({ config, configFile: appPaths.configFile });
  const found = runtime.findChromeExecutable();
  if (!found) throw new Error('未找到 Chrome，请先安装或设置 CHROME_PATH 环境变量');
  const chromePath = found.path;

  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (PROXY) args.push(`--proxy-server=${PROXY}`);
  args.push(START_URL);

  log(`启动 Chrome: ${chromePath}`);
  log(`代理: ${PROXY || '(无)'}`);
  log(`抓包 profile: ${PROFILE_DIR}`);
  const proc = execFile(chromePath, args, { windowsHide: false });
  return proc;
}

// ── 等待 CDP 就绪，拿 browser 级 websocket ───────────────
function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${pathname}`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function waitBrowserWs(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await getJson('/json/version');
      if (v && v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('CDP 端口等待超时');
}

// ── CDP 连接与抓包 ───────────────────────────────────────
let ws;
let msgId = 0;
const pending = new Map();       // id -> {resolve, reject}
const requests = new Map();      // requestId -> 请求元数据
let captureCount = 0;

function send(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(payload));
  });
}

async function main() {
  await launchChrome();
  const browserWs = await waitBrowserWs();
  log('CDP 已连接，开始抓包。请在打开的浏览器里登录 dola 并操作（含带图参考）。');
  log(`输出文件:\n  ${JSONL_FILE}\n  ${LOG_FILE}`);

  ws = new WebSocket(browserWs, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });

  ws.on('open', async () => {
    // 自动 attach 所有 target（含未来新开的标签页），flatten 模式用 sessionId 路由
    await send('Target.setDiscoverTargets', { discover: true });
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    // 命令回执
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    const sid = msg.sessionId || null;
    const p = msg.params || {};

    // 新 target attach：开启它的 Network 域
    if (msg.method === 'Target.attachedToTarget') {
      const newSid = p.sessionId;
      const ti = p.targetInfo || {};
      try {
        await send('Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: 50000000 }, newSid);
        await send('Page.enable', {}, newSid).catch(() => {});
        log(`+ 附加 target: ${ti.type} ${ti.url || ''}`);
      } catch (e) { /* 某些 target 不支持 Network，忽略 */ }
      return;
    }

    // 请求发出
    if (msg.method === 'Network.requestWillBeSent') {
      const req = p.request || {};
      const rec = {
        requestId: p.requestId,
        sessionId: sid,
        type: p.type || '',
        url: req.url,
        method: req.method,
        headers: req.headers || {},
        postData: req.postData || null,
        hasPostData: !!req.hasPostData,
        ts: Date.now(),
      };
      requests.set(p.requestId, rec);

      // body 较大时 postData 不在事件里，主动拉取
      if (rec.hasPostData && !rec.postData && API_TYPES.has(rec.type)) {
        try {
          const r = await send('Network.getRequestPostData', { requestId: p.requestId }, sid);
          rec.postData = r && r.postData ? r.postData : null;
        } catch (e) { /* 流式/已释放，忽略 */ }
      }

      const hot = isHot(rec.url);
      if (API_TYPES.has(rec.type) || hot) {
        writeJsonl({ kind: 'request', ...rec });
        captureCount++;
        const tag = hot ? '★REQ' : ' REQ';
        log(`${tag} ${rec.method} ${rec.url.slice(0, 120)}`);
        if (rec.postData) {
          const preview = rec.postData.length > 400 ? rec.postData.slice(0, 400) + `…(共${rec.postData.length}字节)` : rec.postData;
          if (hot) log(`     body: ${preview.replace(/\n/g, ' ')}`);
        }
      }
      return;
    }

    // 响应头到达
    if (msg.method === 'Network.responseReceived') {
      const rec = requests.get(p.requestId);
      if (rec) {
        rec.status = p.response?.status;
        rec.mimeType = p.response?.mimeType;
        rec.respHeaders = p.response?.headers || {};
      }
      return;
    }

    // 请求完成：尝试取响应体
    if (msg.method === 'Network.loadingFinished') {
      const rec = requests.get(p.requestId);
      if (!rec) return;
      const hot = isHot(rec.url);
      if (API_TYPES.has(rec.type) || hot) {
        let body = null, base64 = false;
        try {
          const r = await send('Network.getResponseBody', { requestId: p.requestId }, rec.sessionId);
          body = r ? r.body : null;
          base64 = r ? !!r.base64Encoded : false;
        } catch (e) { /* SSE/流式响应取不到 body，正常 */ }
        writeJsonl({
          kind: 'response',
          requestId: rec.requestId,
          url: rec.url,
          method: rec.method,
          status: rec.status,
          mimeType: rec.mimeType,
          respHeaders: rec.respHeaders || {},
          bodyBase64: base64,
          body: body,
        });
        if (hot) {
          log(`★RES ${rec.status} ${rec.url.slice(0, 120)}`);
          if (body && !base64) {
            const preview = body.length > 300 ? body.slice(0, 300) + '…' : body;
            log(`     resp: ${preview.replace(/\n/g, ' ')}`);
          }
        }
      }
      requests.delete(p.requestId);
      return;
    }

    // 失败也记一条
    if (msg.method === 'Network.loadingFailed') {
      const rec = requests.get(p.requestId);
      if (rec && (API_TYPES.has(rec.type) || isHot(rec.url))) {
        writeJsonl({ kind: 'failed', url: rec.url, method: rec.method, error: p.errorText });
        log(`  ERR ${p.errorText} ${rec.url.slice(0, 100)}`);
      }
      requests.delete(p.requestId);
      return;
    }
  });

  ws.on('error', (e) => log('CDP WebSocket 错误: ' + e.message));
  ws.on('close', () => { log('CDP 连接已关闭'); flushAndExit(0); });
}

function flushAndExit(code) {
  log(`抓包结束，共记录 ${captureCount} 条关注请求。`);
  try { jsonlStream.end(); } catch (e) {}
  try { logStream.end(); } catch (e) {}
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => {
  log('收到 Ctrl+C，正在收尾…');
  flushAndExit(0);
});

main().catch((e) => {
  log('启动失败: ' + e.message);
  flushAndExit(1);
});
