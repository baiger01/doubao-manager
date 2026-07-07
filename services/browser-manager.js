const { execFile } = require('child_process');
const appPaths = require('../paths');
const BrowserRuntime = require('./browser-runtime');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ProxyPolicy = require('./proxy-policy');

class BrowserManager {
  constructor(config, deps = {}) {
    this.config = config;
    this.runtime = deps.runtime || new BrowserRuntime({
      config,
      configFile: appPaths.configFile,
      ...(deps.runtimeOptions || {})
    });
    this.profilesDir = appPaths.profilesDir;
    this.processes = new Map(); // accountId -> { process, port, platform }
    this.basePort = config.cdp?.basePort || 19222;

    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }
  }

  // 取平台配置（默认 doubao），兼容旧 config.doubao
  getPlatformConfig(platform) {
    const platforms = this.config.platforms || {};
    return platforms[platform] || platforms.doubao || this.config.doubao || {};
  }

  getProxyForPlatform(platform) {
    return new ProxyPolicy(this.config).getProxy(platform || 'doubao');
  }

  // 平台登录/首页 URL
  getPlatformUrl(platform) {
    const pc = this.getPlatformConfig(platform);
    return pc.loginUrl || pc.baseUrl || 'https://www.doubao.com';
  }

  // 平台页面识别用的主域名（从 baseUrl 取 host，如 www.doubao.com -> doubao.com）
  getPlatformHost(platform) {
    const pc = this.getPlatformConfig(platform);
    try {
      const h = new URL(pc.baseUrl).hostname; // www.doubao.com
      const parts = h.split('.');
      return parts.slice(-2).join('.'); // doubao.com
    } catch (e) {
      return 'doubao.com';
    }
  }

  // 记录某账号正在用哪个平台（启动时存）
  getRunningPlatform(accountId) {
    const info = this.processes.get(accountId);
    return (info && info.platform) || 'doubao';
  }

  // 获取账号的 profile 目录
  getProfileDir(accountId) {
    return path.join(this.profilesDir, accountId);
  }

  async getBrowserExecutable() {
    const result = await this.runtime.ensureChromeAvailable();
    return result.path;
  }

  getAccountBrowserState(accountId) {
    const profileDir = this.getProfileDir(accountId);
    const running = this.processes.get(accountId);
    return {
      profileDir,
      lastChromePath: running?.chromePath || '',
      lastChromeVersion: ''
    };
  }

  // 探测某端口是否已有 CDP 在监听（外部残留 Chrome 也算占用）
  probeCdp(port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(res.statusCode === 200));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    });
  }

  // 分配一个真正空闲的端口：跳过本进程已用端口 + 跳过已有 CDP 在监听的端口
  // （关键修复：外部残留 Chrome 占着 basePort 时，避免新浏览器连到旧实例造成"假登录"）
  async findAvailablePort() {
    let port = this.basePort;
    const usedPorts = new Set([...this.processes.values()].map(p => p.port));
    for (let i = 0; i < 100; i++) {
      if (!usedPorts.has(port)) {
        const occupied = await this.probeCdp(port);
        if (!occupied) return port;
      }
      port++;
    }
    throw new Error('找不到空闲调试端口');
  }

  // 启动 Chrome（用于添加账号 / 登录）
  // opts.windowMode 三档窗口模式(优先级高于旧的 opts.hidden):
  //   'visible'    有头可见——窗口正常显示在屏幕上,可实时观察/手动介入,谷歌风控最宽松,登录成功率最高
  //   'background' 后台运行——无头 Chrome,不创建可见/偏移窗口
  //   'headless'   无头模式——与 background 等价,保留为显式选项
  // 兼容旧调用:未传 windowMode 时,opts.hidden=true → 'background',否则 'visible'。
  async launchForLogin(accountId, platform = 'doubao', opts = {}) {
    const chromePath = await this.getBrowserExecutable();

    const profileDir = this.getProfileDir(accountId);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    // 清理残留 lockfile，防止上次崩溃后 Chrome 拒绝加载已有 profile
    this.cleanupLockfile(profileDir);

    // 如果该账号已经在运行，直接复用
    if (this.processes.has(accountId)) {
      return { port: this.processes.get(accountId).port, alreadyRunning: true };
    }

    // 分配真正空闲的调试端口（跳过被外部残留 Chrome 占用的端口，避免连到旧实例造成"假登录"）
    const port = await this.findAvailablePort();

    // 解析窗口模式
    let windowMode = opts.windowMode;
    if (!windowMode) windowMode = opts.hidden ? 'background' : 'visible';
    if (!['visible', 'background', 'headless'].includes(windowMode)) windowMode = 'visible';

    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      // ===== 反自动化指纹(降低被风控识别为机器人的概率)=====
      // disable-blink-features=AutomationControlled 是关键:它让 navigator.webdriver 保持 false,
      // 并去掉 Blink 层的自动化标记。配合下面注入的 stealth 脚本一起生效。
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,DiceWebSigninInterception', // DiceWebSigninInterception:禁掉托管账号登录拦截页(chrome://managed-user-profile-notice)
      '--disable-infobars',
      '--password-store=basic',
      '--lang=zh-CN',
    ];

    if (windowMode === 'headless' || windowMode === 'background') {
      // 后台/无头:纯后台,不弹窗,禁止用屏幕外窗口偏移。
      args.push('--headless=new');
      args.push('--disable-gpu');
      args.push('--window-size=1280,860');
      args.push('--disable-renderer-backgrounding');
    }
    // visible:不加任何隐藏参数,窗口正常显示

    // 代理必须按平台策略隔离：豆包直连，Dola 才允许代理。
    const proxy = this.getProxyForPlatform(platform);
    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }

    args.push(this.getPlatformUrl(platform));

    const proc = execFile(chromePath, args, { windowsHide: false });

    this.processes.set(accountId, { process: proc, port, platform, chromePath });

    proc.on('exit', () => {
      this.processes.delete(accountId);
    });

    proc.on('error', (err) => {
      console.error(`Chrome启动失败 [${accountId}]:`, err.message);
      this.processes.delete(accountId);
    });

    // 等待 CDP 就绪
    await this.waitForCDP(port, 15000);
    return { port, alreadyRunning: false };
  }

  // 启动 Chrome（用于生成，无头模式，用户不可见）
  async launchForGeneration(accountId, platform = 'doubao') {
    const chromePath = await this.getBrowserExecutable();

    const profileDir = this.getProfileDir(accountId);
    if (!fs.existsSync(profileDir)) {
      throw new Error('账号 profile 不存在，请先登录');
    }

    // 清理残留 lockfile
    this.cleanupLockfile(profileDir);

    // 已经在运行
    if (this.processes.has(accountId)) {
      const info = this.processes.get(accountId);
      await this.waitForPlatformPage(info.port, 30000, info.platform || platform);
      return info.port;
    }

    const port = await this.findAvailablePort();

    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    // 代理必须按平台策略隔离：豆包直连，Dola 才允许代理。
    const proxy = this.getProxyForPlatform(platform);
    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }

    args.push(this.getPlatformUrl(platform));

    const proc = execFile(chromePath, args, { windowsHide: false });

    this.processes.set(accountId, { process: proc, port, platform, chromePath });

    proc.on('exit', () => {
      this.processes.delete(accountId);
    });

    await this.waitForCDP(port, 15000);
    // 等待平台页面完全加载
    await this.waitForPlatformPage(port, 30000, platform);
    return port;
  }

  // 等待平台页面出现并加载完成
  waitForPlatformPage(port, timeoutMs, platform = 'doubao') {
    const host = this.getPlatformHost(platform);
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (Date.now() - start > timeoutMs) {
          // 超时了但还是继续，可能页面慢
          resolve();
          return;
        }

        const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const pages = JSON.parse(data);
              const target = pages.find(p =>
                p.url && p.url.includes(host) && p.type === 'page'
              );
              if (target) {
                resolve();
                return;
              }
            } catch (e) { /* retry */ }
            setTimeout(check, 1000);
          });
        });
        req.on('error', () => setTimeout(check, 1000));
        req.setTimeout(3000, () => { req.destroy(); setTimeout(check, 1000); });
      };
      check();
    });
  }

  // 等待 CDP 端口可用
  waitForCDP(port, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Chrome CDP端口等待超时'));
          return;
        }

        const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const pages = JSON.parse(data);
              if (pages.length > 0) {
                resolve();
                return;
              }
            } catch (e) { /* retry */ }
            setTimeout(check, 500);
          });
        });
        req.on('error', () => setTimeout(check, 500));
        req.setTimeout(2000, () => { req.destroy(); setTimeout(check, 500); });
      };
      check();
    });
  }

  // 通过 CDP 抓取 cookies 和页面参数（用于登录后保存）
  async grabCookiesAndParams(accountId) {
    const info = this.processes.get(accountId);
    if (!info) throw new Error('Chrome 未运行');

    const port = info.port;
    const platform = info.platform || 'doubao';
    const host = this.getPlatformHost(platform);
    const pc = this.getPlatformConfig(platform);
    const cookieDomains = pc.cookieDomains || ['doubao.com', 'byteimg.com', 'bytedance.com'];

    const pages = await this.getPages(port);
    const targetPage = pages.find(p => p.url && p.url.includes(host) && p.type === 'page');
    if (!targetPage) throw new Error(`未找到 ${host} 页面`);

    const WebSocket = require('ws');
    const ws = new WebSocket(targetPage.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      let msgId = 0;
      const results = {};
      let timeout = null;
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        try { ws.close(); } catch (e) {}
        if (err) reject(err);
        else resolve(value);
      };

      ws.on('open', () => {
        // 1. 获取所有 cookies
        ws.send(JSON.stringify({ id: ++msgId, method: 'Network.getAllCookies', params: {} }));
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (e) {
          finish(new Error('CDP消息解析失败: ' + e.message));
          return;
        }

        if (msg.id === 1) {
          // cookies 响应：按平台 cookieDomains 过滤
          const cookies = msg.result?.cookies || [];
          const filtered = cookies
            .filter(c => cookieDomains.some(d => c.domain.includes(d)))
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
          results.cookies = filtered;

          // 2. 从页面 JS 获取 device_id, web_id, fp, conversation_id
          ws.send(JSON.stringify({
            id: ++msgId,
            method: 'Runtime.evaluate',
            params: {
              expression: `(function(){
                var result = { device_id: '', web_id: '', fp: '', conversation_id: '', user_id: '' };
                
                // 方法1: 从 window.__NEXT_DATA__ 或 __INITIAL_STATE__
                try {
                  if (window.__NEXT_DATA__) {
                    var s = JSON.stringify(window.__NEXT_DATA__);
                    var m = s.match(/"web_id":"(\\d+)"/);
                    if (m) result.web_id = m[1];
                    m = s.match(/"device_id":"(\\d+)"/);
                    if (m) result.device_id = m[1];
                  }
                } catch(e){}

                // 方法2: 从 localStorage
                try {
                  var fpData = localStorage.getItem('__ac_fp');
                  if (fpData) {
                    var parsed = JSON.parse(fpData);
                    if (parsed && parsed.value) result.fp = parsed.value;
                  }
                } catch(e){}

                // 方法3: 从当前页面 URL 获取 conversation_id
                try {
                  var pathMatch = location.pathname.match(/\\/chat\\/(\\d+)/);
                  if (pathMatch) result.conversation_id = pathMatch[1];
                } catch(e){}

                // 方法4: 从 cookie 获取 s_v_web_id 作为 fp 备选
                try {
                  var cookies = document.cookie;
                  if (!result.fp) {
                    var fpMatch = cookies.match(/s_v_web_id=([^;]+)/);
                    if (fpMatch) result.fp = fpMatch[1];
                  }
                } catch(e){}

                // 方法5: 从页面请求拦截获取 (读取 performance entries)
                try {
                  var entries = performance.getEntriesByType('resource');
                  for (var i = entries.length - 1; i >= 0; i--) {
                    var name = entries[i].name;
                    if (name.includes('/chat/completion') || name.includes('samantha_web')) {
                      var urlParams = new URLSearchParams(name.split('?')[1] || '');
                      if (!result.device_id) result.device_id = urlParams.get('device_id') || '';
                      if (!result.web_id) result.web_id = urlParams.get('web_id') || '';
                      if (!result.fp) result.fp = urlParams.get('fp') || '';
                      if (result.device_id) break;
                    }
                  }
                } catch(e){}

                // 方法6: 从 tea SDK 全局对象
                try {
                  if (window.TEA_CONFIG) {
                    if (!result.web_id && window.TEA_CONFIG.web_id) result.web_id = window.TEA_CONFIG.web_id;
                    if (!result.device_id && window.TEA_CONFIG.device_id) result.device_id = window.TEA_CONFIG.device_id;
                    if (!result.user_id && window.TEA_CONFIG.user_id) result.user_id = window.TEA_CONFIG.user_id;
                  }
                  if (window.__tea_sdk_config) {
                    if (!result.web_id) result.web_id = window.__tea_sdk_config.web_id || '';
                    if (!result.device_id) result.device_id = window.__tea_sdk_config.device_id || '';
                  }
                } catch(e){}

                // 方法7: 从 script 标签内容
                try {
                  var scripts = document.querySelectorAll('script');
                  for (var i = 0; i < scripts.length; i++) {
                    var t = scripts[i].textContent || '';
                    if (t.length > 500000) continue;
                    if (!result.web_id) {
                      var m = t.match(/web_id['"=:\\s]+['"]?(\\d{15,})['"]?/);
                      if (m) result.web_id = m[1];
                    }
                    if (!result.device_id) {
                      var m = t.match(/device_id['"=:\\s]+['"]?(\\d{15,})['"]?/);
                      if (m) result.device_id = m[1];
                    }
                    if (result.web_id && result.device_id) break;
                  }
                } catch(e){}

                // web_id 兜底 = device_id
                if (!result.web_id && result.device_id) result.web_id = result.device_id;
                if (!result.device_id && result.web_id) result.device_id = result.web_id;

                return result;
              })()`,
              returnByValue: true
            }
          }));
        } else if (msg.id === 2) {
          // eval 响应
          const val = msg.result?.result?.value || {};
          results.fp = val.fp || '';
          results.device_id = val.device_id || '';
          results.web_id = val.web_id || '';
          results.conversation_id = val.conversation_id || '';
          results.user_id = val.user_id || '';

          finish(null, results);
        }
      });

      ws.on('error', (e) => finish(e));
      timeout = setTimeout(() => finish(new Error('抓取超时')), 15000);
    });
  }

  // 获取 CDP pages 列表
  getPages(port) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/json`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  // 把存储的登录态 cookie 注入到已打开的浏览器，并刷新页面。
  // 解决：profile 里的会话 cookie 过期/丢失后，点"打开网页"虽带着 profile 启动，
  // 但页面是未登录的；这里用 CDP Network.setCookies 把我们保存的 cookie 灌进去再 reload。
  // cookieStr: "k=v; k2=v2" 形式；platform 决定写入哪些域名。
  async injectCookies(accountId, cookieStr, platform = 'doubao') {
    if (!cookieStr) return false;
    const info = this.processes.get(accountId);
    if (!info) throw new Error('Chrome 未运行');
    const port = info.port;
    const host = this.getPlatformHost(platform); // 如 dola.com
    const pc = this.getPlatformConfig(platform);
    const cookieDomains = pc.cookieDomains || [host];

    // 解析 cookie 串
    const baseUrl = (pc.baseUrl || `https://www.${host}`).replace(/\/+$/, '');
    const pairs = cookieStr.split(';').map(s => s.trim()).filter(Boolean);
    const cookies = [];
    const seen = new Set();
    for (const p of pairs) {
      const idx = p.indexOf('=');
      if (idx <= 0) continue;
      const name = p.slice(0, idx).trim();
      const value = p.slice(idx + 1).trim();
      if (!name || seen.has(name)) continue; // 去重（同名只取首个）
      seen.add(name);
      // 用 url 让 Chrome 自行推导 domain/secure，并显式补 domain=.主域 覆盖全部子域。
      cookies.push({ name, value, url: baseUrl, domain: '.' + host, path: '/', secure: true });
    }
    if (cookies.length === 0) return false;

    // 找到目标平台页面的 ws 调试地址（没有就用 browser 级）
    const pages = await this.getPages(port);
    const target = pages.find(p => p.url && p.url.includes(host) && p.type === 'page')
      || pages.find(p => p.type === 'page');
    const wsUrl = target && target.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('未找到可注入的页面');

    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    const navUrl = this.getPlatformUrl(platform);

    return new Promise((resolve, reject) => {
      let id = 0;
      const pending = new Map();
      let timeout = null;
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        try { ws.close(); } catch (_) {}
        for (const { rej } of pending.values()) rej(err || new Error('CDP连接已关闭'));
        pending.clear();
        if (err) reject(err);
        else resolve(value);
      };
      const call = (method, params = {}) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });

      ws.on('open', async () => {
        try {
          await call('Network.enable');
          // 批量写 cookie
          await call('Network.setCookies', { cookies });
          // 导航到平台首页，让登录态生效
          await call('Page.enable').catch(() => {});
          await call('Page.navigate', { url: navUrl });
          finish(null, true);
        } catch (e) {
          finish(e);
        }
      });

      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      });

      ws.on('error', (e) => finish(e));
      timeout = setTimeout(() => finish(new Error('注入 cookie 超时')), 15000);
    });
  }

  // 清理 Chrome profile 目录中的 lockfile / SingletonLock，防止崩溃后下次启动被拒
  cleanupLockfile(profileDir) {
    for (const name of ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const p = path.join(profileDir, name);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* 被占用就忽略 */ }
    }
  }

  // 关闭某个账号的 Chrome
  close(accountId) {
    const info = this.processes.get(accountId);
    if (info && info.process) {
      // Windows 上 process.kill() 只杀父进程，Chrome 子进程(renderer/gpu)会残留并锁住 profile。
      // 用 taskkill /T /F 杀整棵进程树。
      const pid = info.process.pid;
      if (pid && process.platform === 'win32') {
        try {
          require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } catch (e) { /* 进程可能已退出 */ }
      } else {
        info.process.kill();
      }
      this.processes.delete(accountId);
    }
  }

  // 检查某个账号 Chrome 是否在运行
  isRunning(accountId) {
    return this.processes.has(accountId);
  }

  // 获取运行中的 CDP 端口
  getRunningPort(accountId) {
    const info = this.processes.get(accountId);
    return info ? info.port : null;
  }

  // 关闭所有
  closeAll() {
    for (const [id] of this.processes) {
      this.close(id);
    }
  }
}

module.exports = BrowserManager;
