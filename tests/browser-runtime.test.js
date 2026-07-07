const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCommonJsModule(filePath, overrides = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const module = { exports: {} };
  const dirname = path.dirname(filePath);
  const filename = filePath;

  function localRequire(request) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) {
      return overrides[request];
    }
    if (request.startsWith('./') || request.startsWith('../')) {
      const resolved = require.resolve(path.resolve(dirname, request));
      return require(resolved);
    }
    return require(request);
  }

  const context = vm.createContext({
    module,
    exports: module.exports,
    require: localRequire,
    __dirname: dirname,
    __filename: filename,
    console,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    process: overrides.process || process
  });

  const wrapped = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
  const compiled = vm.runInContext(wrapped, context, { filename });
  compiled(module.exports, localRequire, module, filename, dirname);
  return module.exports;
}

test('browser runtime prefers CHROME_PATH before other probes', () => {
  const runtimePath = path.resolve(__dirname, '..', 'services', 'browser-runtime.js');
  const BrowserRuntime = loadCommonJsModule(runtimePath, {
    fs: {
      existsSync(target) {
        return target === 'D:\\Portable\\Chrome\\chrome.exe';
      }
    },
    process: {
      env: {
        CHROME_PATH: 'D:\\Portable\\Chrome\\chrome.exe',
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
      }
    }
  });

  const runtime = new BrowserRuntime({
    dialog: {},
    shell: {}
  });

  const found = runtime.findChromeExecutable();
  assert.equal(found.path, 'D:\\Portable\\Chrome\\chrome.exe');
  assert.equal(found.source, 'env');
});

test('browser runtime can fall back to manually selecting chrome.exe', async () => {
  const runtimePath = path.resolve(__dirname, '..', 'services', 'browser-runtime.js');
  const savedPaths = [];

  const BrowserRuntime = loadCommonJsModule(runtimePath, {
    fs: { existsSync() { return false; } },
    process: {
      env: {
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
      }
    }
  });

  const runtime = new BrowserRuntime({
    dialog: {
      async showMessageBox() {
        return { response: 0 };
      },
      async showOpenDialog() {
        return {
          canceled: false,
          filePaths: ['D:\\Tools\\Chrome\\chrome.exe']
        };
      }
    },
    shell: {},
    savePreferredPath(chromePath) {
      savedPaths.push(chromePath);
    }
  });

  const result = await runtime.ensureChromeAvailable();
  assert.equal(result.path, 'D:\\Tools\\Chrome\\chrome.exe');
  assert.equal(result.source, 'manual');
  assert.deepEqual(savedPaths, ['D:\\Tools\\Chrome\\chrome.exe']);
});

test('browser runtime prefers persisted configured path before filesystem fallbacks', () => {
  const runtimePath = path.resolve(__dirname, '..', 'services', 'browser-runtime.js');
  const BrowserRuntime = loadCommonJsModule(runtimePath, {
    fs: {
      existsSync(target) {
        return target === 'D:\\Pinned\\Chrome\\chrome.exe';
      }
    },
    process: {
      env: {
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
      }
    }
  });

  const runtime = new BrowserRuntime({
    dialog: {},
    shell: {},
    getPreferredPath() {
      return 'D:\\Pinned\\Chrome\\chrome.exe';
    }
  });

  const found = runtime.findChromeExecutable();
  assert.equal(found.path, 'D:\\Pinned\\Chrome\\chrome.exe');
  assert.equal(found.source, 'config');
});

test('browser runtime persists manually selected path back into writable config', async () => {
  const runtimePath = path.resolve(__dirname, '..', 'services', 'browser-runtime.js');
  const writes = [];
  const BrowserRuntime = loadCommonJsModule(runtimePath, {
    fs: {
      existsSync() { return false; },
      mkdirSync() {},
      writeFileSync(filePath, content) {
        writes.push({ filePath, content: JSON.parse(content) });
      }
    },
    process: {
      env: {
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
      }
    }
  });

  const runtime = new BrowserRuntime({
    dialog: {
      async showMessageBox() { return { response: 0 }; },
      async showOpenDialog() {
        return {
          canceled: false,
          filePaths: ['D:\\Manual\\Chrome\\chrome.exe']
        };
      }
    },
    configFile: 'D:\\RuntimeData\\config\\config.json',
    config: {
      server: { port: 9527, host: '0.0.0.0' }
    }
  });

  await runtime.ensureChromeAvailable();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filePath, 'D:\\RuntimeData\\config\\config.json');
  assert.equal(writes[0].content.browser.chromePath, 'D:\\Manual\\Chrome\\chrome.exe');
});

test('browser manager launches login flow through resolved browser runtime executable', async () => {
  const browserManagerPath = path.resolve(__dirname, '..', 'services', 'browser-manager.js');
  const launches = [];
  const BrowserManager = loadCommonJsModule(browserManagerPath, {
    child_process: {
      execFile(filePath, args) {
        launches.push({ filePath, args });
        return { on() {} };
      }
    },
    fs: {
      existsSync() { return true; },
      mkdirSync() {}
    },
    http: {
      get() {
        // 模拟端口探测(probeCdp):无 CDP 在监听 → 触发超时回调使 Promise 以 false 落地,
        // 否则 findAvailablePort 会因 Promise 永不 resolve 而挂起。
        return {
          on() { return this; },
          setTimeout(_ms, cb) { if (typeof cb === 'function') cb(); },
          destroy() {}
        };
      }
    },
    '../paths': {
      profilesDir: 'D:\\RuntimeData\\data\\profiles'
    },
    './browser-runtime': class FakeRuntime {
      async ensureChromeAvailable() {
        return { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', source: 'filesystem' };
      }
    }
  });

  const manager = new BrowserManager({ cdp: { basePort: 19222 } }, {
    runtime: { ensureChromeAvailable: async () => ({ path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }) }
  });
  manager.waitForCDP = async () => {};

  const result = await manager.launchForLogin('acc-1', 'doubao');
  assert.equal(result.alreadyRunning, false);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].filePath, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.match(launches[0].args[0], /--user-data-dir=/);
});

test('browser manager background login mode uses headless without off-screen window offset', async () => {
  const browserManagerPath = path.resolve(__dirname, '..', 'services', 'browser-manager.js');
  const launches = [];
  const BrowserManager = loadCommonJsModule(browserManagerPath, {
    child_process: {
      execFile(filePath, args) {
        launches.push({ filePath, args });
        return { on() {} };
      }
    },
    fs: {
      existsSync() { return true; },
      mkdirSync() {}
    },
    http: {
      get() {
        return {
          on() { return this; },
          setTimeout(_ms, cb) { if (typeof cb === 'function') cb(); },
          destroy() {}
        };
      }
    },
    '../paths': {
      profilesDir: 'D:\\RuntimeData\\data\\profiles'
    },
    './browser-runtime': class FakeRuntime {
      async ensureChromeAvailable() {
        return { path: 'C:\\Chrome\\chrome.exe', source: 'filesystem' };
      }
    }
  });

  const manager = new BrowserManager({ cdp: { basePort: 19222 } });
  manager.waitForCDP = async () => {};

  await manager.launchForLogin('acc-1', 'dola', { windowMode: 'background' });

  assert.equal(launches.length, 1);
  assert.ok(launches[0].args.includes('--headless=new'));
  assert.equal(launches[0].args.some(arg => arg.startsWith('--window-position=')), false);
});

test('browser manager keeps doubao Chrome direct even if config contains a proxy', async () => {
  const browserManagerPath = path.resolve(__dirname, '..', 'services', 'browser-manager.js');
  const launches = [];
  const BrowserManager = loadCommonJsModule(browserManagerPath, {
    child_process: {
      execFile(filePath, args) {
        launches.push({ filePath, args });
        return { on() {} };
      }
    },
    fs: {
      existsSync() { return true; },
      mkdirSync() {}
    },
    http: {
      get() {
        return {
          on() { return this; },
          setTimeout(_ms, cb) { if (typeof cb === 'function') cb(); },
          destroy() {}
        };
      }
    },
    '../paths': {
      profilesDir: 'D:\\RuntimeData\\data\\profiles'
    },
    './browser-runtime': class FakeRuntime {
      async ensureChromeAvailable() {
        return { path: 'C:\\Chrome\\chrome.exe', source: 'filesystem' };
      }
    }
  });

  const manager = new BrowserManager({
    cdp: { basePort: 19222 },
    platforms: {
      doubao: { baseUrl: 'https://www.doubao.com', proxy: 'http://127.0.0.1:7897' }
    }
  });
  manager.waitForCDP = async () => {};

  await manager.launchForLogin('acc-1', 'doubao');

  assert.equal(launches.length, 1);
  assert.equal(launches[0].args.some(arg => arg.startsWith('--proxy-server=')), false);
});

test('browser manager applies Dola proxy to Chrome launch', async () => {
  const browserManagerPath = path.resolve(__dirname, '..', 'services', 'browser-manager.js');
  const launches = [];
  const BrowserManager = loadCommonJsModule(browserManagerPath, {
    child_process: {
      execFile(filePath, args) {
        launches.push({ filePath, args });
        return { on() {} };
      }
    },
    fs: {
      existsSync() { return true; },
      mkdirSync() {}
    },
    http: {
      get() {
        return {
          on() { return this; },
          setTimeout(_ms, cb) { if (typeof cb === 'function') cb(); },
          destroy() {}
        };
      }
    },
    '../paths': {
      profilesDir: 'D:\\RuntimeData\\data\\profiles'
    },
    './browser-runtime': class FakeRuntime {
      async ensureChromeAvailable() {
        return { path: 'C:\\Chrome\\chrome.exe', source: 'filesystem' };
      }
    }
  });

  const manager = new BrowserManager({
    cdp: { basePort: 19222 },
    platforms: {
      dola: { baseUrl: 'https://www.dola.com', proxy: 'http://127.0.0.1:7897' }
    }
  });
  manager.waitForCDP = async () => {};

  await manager.launchForLogin('acc-1', 'dola');

  assert.ok(launches[0].args.includes('--proxy-server=http://127.0.0.1:7897'));
});

test('browser manager rejects malformed CDP websocket messages instead of throwing globally', async () => {
  const browserManagerPath = path.resolve(__dirname, '..', 'services', 'browser-manager.js');
  const pageWsUrl = 'ws://127.0.0.1/devtools/page/1';

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.handlers = {};
      setTimeout(() => this.handlers.open && this.handlers.open(), 0);
      setTimeout(() => this.handlers.message && this.handlers.message(Buffer.from('not-json')), 1);
    }
    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }
    send() {}
    close() {
      this.closed = true;
    }
  }

  const BrowserManager = loadCommonJsModule(browserManagerPath, {
    ws: FakeWebSocket,
    fs: {
      existsSync() { return true; },
      mkdirSync() {}
    },
    http: {
      get(_url, cb) {
        const res = {
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify([
              { type: 'page', url: 'https://www.doubao.com/chat', webSocketDebuggerUrl: pageWsUrl }
            ])));
            if (event === 'end') handler();
          }
        };
        cb(res);
        return { on() { return this; } };
      }
    },
    '../paths': {
      profilesDir: 'D:\\RuntimeData\\data\\profiles'
    },
    './browser-runtime': class FakeRuntime {}
  });

  const manager = new BrowserManager({ platforms: { doubao: { baseUrl: 'https://www.doubao.com' } } });
  manager.processes.set('acc-1', { port: 19222, platform: 'doubao' });

  await assert.rejects(
    () => manager.grabCookiesAndParams('acc-1'),
    /CDP消息解析失败/
  );
});
