// 临时验证脚本：测试"打开网页(挂登录态)"的 cookie 注入是否真的生效。
// 流程：加载 dola 账号 -> launchForLogin(带代理) -> 等页面 -> injectCookies -> CDP 读取登录态。
// 用完即删。
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const appPaths = require('../paths');
const BrowserManager = require('../services/browser-manager');

function loadJson(f) { return JSON.parse(fs.readFileSync(f, 'utf-8')); }

function findAccountsFile() {
  const cands = [
    appPaths.accountsFile,
    path.join(process.env.APPDATA || '', 'lulu-data', 'data', 'accounts.json'),
  ];
  for (const f of cands) {
    if (f && fs.existsSync(f)) return f;
  }
  return null;
}

function getPages(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// 通过 CDP Runtime.evaluate 读取页面登录态相关信息
function probeLoginState(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    const call = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    ws.on('open', async () => {
      try {
        await call('Runtime.enable').catch(() => {});
        const expr = `(function(){
          var out = {};
          out.url = location.href;
          out.cookieNames = document.cookie.split(';').map(s=>s.trim().split('=')[0]).filter(Boolean);
          try { out.lsKeys = Object.keys(localStorage); } catch(e){ out.lsKeys=['<denied>']; }
          // 常见登录态信号
          out.hasLoginBtn = !!document.querySelector('[class*="login"],[class*="Login"]');
          out.bodyTextSample = (document.body? document.body.innerText : '').slice(0,200);
          return JSON.stringify(out);
        })()`;
        const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
        ws.close();
        resolve(r && r.result && r.result.value);
      } catch (e) { ws.close(); reject(e); }
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
    ws.on('error', reject);
    setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('probe 超时')); }, 12000);
  });
}

(async () => {
  const accFile = findAccountsFile();
  if (!accFile) { console.error('找不到 accounts.json'); process.exit(1); }
  console.log('[accounts]', accFile);
  const raw = loadJson(accFile);
  const list = Array.isArray(raw) ? raw : (raw.accounts || []);
  const dolaAccts = list.filter(a => (a.platform === 'dola') && a.session && a.session.cookies);
  if (dolaAccts.length === 0) { console.error('没有可用的 dola 账号(带 cookie)'); process.exit(1); }
  const acc = dolaAccts[0];
  console.log('[account] id=%s name=%s cookieLen=%d', acc.id, acc.name, acc.session.cookies.length);

  const config = loadJson(appPaths.configFile);
  const bm = new BrowserManager(config);
  const platform = acc.platform || 'dola';

  console.log('[launch] launchForLogin ...');
  const { port } = await bm.launchForLogin(acc.id, platform);
  console.log('[launch] port=%d', port);

  console.log('[wait] waiting for platform page ...');
  await bm.waitForPlatformPage(port, 20000, platform);

  // 注入前探测
  let pages = await getPages(port);
  let target = pages.find(p => p.type === 'page' && p.url && p.url.includes(bm.getPlatformHost(platform))) || pages.find(p => p.type === 'page');
  if (target && target.webSocketDebuggerUrl) {
    try {
      const before = await probeLoginState(target.webSocketDebuggerUrl);
      console.log('\n=== 注入前 ===\n' + before);
    } catch (e) { console.log('注入前探测失败:', e.message); }
  }

  console.log('\n[inject] injectCookies ...');
  const ok = await bm.injectCookies(acc.id, acc.session.cookies, platform);
  console.log('[inject] result =', ok);

  // 等页面 reload 后稳定
  await new Promise(r => setTimeout(r, 6000));

  pages = await getPages(port);
  target = pages.find(p => p.type === 'page' && p.url && p.url.includes(bm.getPlatformHost(platform))) || pages.find(p => p.type === 'page');
  if (target && target.webSocketDebuggerUrl) {
    try {
      const after = await probeLoginState(target.webSocketDebuggerUrl);
      console.log('\n=== 注入后 ===\n' + after);
    } catch (e) { console.log('注入后探测失败:', e.message); }
  }

  console.log('\n[done] 浏览器保持打开，请人工目视确认是否已登录。20秒后自动关闭。');
  await new Promise(r => setTimeout(r, 20000));
  bm.close(acc.id);
  process.exit(0);
})().catch(e => { console.error('验证脚本异常:', e); process.exit(1); });
