const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function runElectronMain({ electron, serverModule, processStub, fsStub, httpStub }) {
  const filePath = path.resolve(__dirname, '..', 'electron-main.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const module = { exports: {} };
  const dirname = path.dirname(filePath);

  function localRequire(request) {
    if (request === 'electron') return electron;
    if (request === './server') return serverModule;
    if (request === 'fs') return fsStub || require('fs');
    if (request === 'http' || request === 'node:http') return httpStub || require('http');
    if (request === 'path') return require('path');
    if (request.startsWith('./') || request.startsWith('../')) {
      return require(path.resolve(dirname, request));
    }
    return require(request);
  }

  const context = vm.createContext({
    module,
    exports: module.exports,
    require: localRequire,
    __dirname: dirname,
    __filename: filePath,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    process: processStub
  });

  const wrapped = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
  const compiled = vm.runInContext(wrapped, context, { filename: filePath });
  compiled(module.exports, localRequire, module, filePath, dirname);
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createReadyHttpStub() {
  return {
    get(_url, callback) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = () => req;
      process.nextTick(() => callback({ statusCode: 200, resume() {} }));
      return req;
    }
  };
}

test('second app instance exits before starting the embedded server', () => {
  let quitCalled = false;
  let whenReadyCalled = false;
  let serverStarted = false;

  const app = {
    requestSingleInstanceLock() {
      return false;
    },
    quit() {
      quitCalled = true;
    },
    whenReady() {
      whenReadyCalled = true;
      return Promise.resolve();
    },
    on() {}
  };

  runElectronMain({
    electron: {
      app,
      BrowserWindow: function () {},
      shell: {},
      dialog: {}
    },
    serverModule: {
      start() {
        serverStarted = true;
        return Promise.resolve({ url: 'http://127.0.0.1:9527', cleanup() {} });
      }
    },
    processStub: {
      execPath: 'C:\\Doubao\\豆包工作台.exe',
      on() {},
      exit() {},
      versions: {}
    },
    fsStub: {
      appendFileSync() {}
    },
    httpStub: createReadyHttpStub()
  });

  assert.equal(quitCalled, true);
  assert.equal(whenReadyCalled, false);
  assert.equal(serverStarted, false);
});

test('main window does not auto-open DevTools by default (opt-in via OPEN_DEVTOOLS)', async () => {
  let loadedUrl = null;
  let openDevToolsOptions = null;

  const app = {
    requestSingleInstanceLock() {
      return true;
    },
    quit() {},
    whenReady() {
      return Promise.resolve();
    },
    on() {}
  };

  const webContents = {
    setWindowOpenHandler() {},
    on() {},
    toggleDevTools() {},
    openDevTools(options) {
      openDevToolsOptions = options;
    }
  };

  function BrowserWindow() {
    return {
      webContents,
      async loadURL(url) {
        loadedUrl = url;
      },
      on() {}
    };
  }
  BrowserWindow.getAllWindows = () => [];

  runElectronMain({
    electron: {
      app,
      BrowserWindow,
      shell: { openExternal() {} },
      dialog: { showErrorBox() {} }
    },
    serverModule: {
      async start() {
        return { url: 'http://127.0.0.1:9527', cleanup() {} };
      }
    },
    processStub: {
      execPath: 'C:\\Doubao\\豆包工作台.exe',
      on() {},
      exit() {},
      versions: {}
    },
    fsStub: {
      appendFileSync() {}
    },
    httpStub: createReadyHttpStub()
  });

  await nextTick();
  await nextTick();
  await nextTick();

  assert.equal(loadedUrl, 'http://127.0.0.1:9527');
  // DevTools 现在默认关闭(需 OPEN_DEVTOOLS=1 才自动打开),启动时不应调用 openDevTools。
  assert.equal(openDevToolsOptions, null);
});

test('main window waits for embedded server readiness before loading the app URL', async () => {
  let readyChecked = false;
  let loadSawReady = false;
  let loadCount = 0;

  const app = {
    requestSingleInstanceLock() {
      return true;
    },
    quit() {},
    whenReady() {
      return Promise.resolve();
    },
    on() {}
  };

  const webContents = {
    setWindowOpenHandler() {},
    on() {},
    toggleDevTools() {},
    openDevTools() {}
  };

  function BrowserWindow() {
    return {
      webContents,
      async loadURL() {
        loadSawReady = readyChecked;
        loadCount += 1;
      },
      on() {}
    };
  }
  BrowserWindow.getAllWindows = () => [];

  const httpStub = {
    get(url, callback) {
      assert.equal(url, 'http://127.0.0.1:9527');
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = () => req;
      process.nextTick(() => {
        readyChecked = true;
        callback({ statusCode: 200, resume() {} });
      });
      return req;
    }
  };

  runElectronMain({
    electron: {
      app,
      BrowserWindow,
      shell: { openExternal() {} },
      dialog: { showErrorBox() {} }
    },
    serverModule: {
      async start() {
        return { url: 'http://127.0.0.1:9527', cleanup() {} };
      }
    },
    processStub: {
      execPath: 'C:\\Doubao\\豆包工作台.exe',
      env: {},
      on() {},
      exit() {},
      versions: {}
    },
    fsStub: {
      appendFileSync() {}
    },
    httpStub
  });

  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();

  assert.equal(loadCount, 1);
  assert.equal(loadSawReady, true);
});

test('electron main injects native bridge before webview binding reinjection', async () => {
  let injectedBridge = null;
  let reinjectSawBridge = false;

  const app = {
    requestSingleInstanceLock() {
      return true;
    },
    quit() {},
    whenReady() {
      return Promise.resolve();
    },
    on() {}
  };

  const webContents = {
    setWindowOpenHandler() {},
    on() {},
    toggleDevTools() {},
    openDevTools() {}
  };

  function BrowserWindow() {
    return {
      webContents,
      async loadURL() {},
      on() {}
    };
  }
  BrowserWindow.getAllWindows = () => [];

  const expressApp = {
    locals: {
      async reinjectWebviewBinding() {
        reinjectSawBridge = !!this.nativeBridge && this.nativeBridge.hasWebviewSession();
        injectedBridge = this.nativeBridge;
        return { injected: 1 };
      }
    }
  };

  runElectronMain({
    electron: {
      app,
      BrowserWindow,
      shell: { openExternal() {}, openPath() {} },
      dialog: { showErrorBox() {}, showOpenDialog() {} },
      session: { fromPartition() { return { cookies: {} }; } }
    },
    serverModule: {
      async start() {
        return { url: 'http://127.0.0.1:9527', cleanup() {}, app: expressApp };
      }
    },
    processStub: {
      execPath: 'C:\\Doubao\\豆包工作台.exe',
      on() {},
      exit() {},
      versions: {}
    },
    fsStub: {
      appendFileSync() {}
    },
    httpStub: createReadyHttpStub()
  });

  await nextTick();
  await nextTick();
  await nextTick();

  assert.equal(reinjectSawBridge, true);
  assert.equal(injectedBridge.canPickDir(), true);
  assert.equal(injectedBridge.canOpenPath(), true);
});
