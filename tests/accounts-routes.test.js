const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCommonJsModule(filePath, mocks = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const module = { exports: {} };
  const dirname = path.dirname(filePath);
  const customRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = path.resolve(dirname, specifier.endsWith('.js') ? specifier : `${specifier}.js`);
      if (Object.prototype.hasOwnProperty.call(mocks, resolved)) return mocks[resolved];
      return require(resolved);
    }
    return require(specifier);
  };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: customRequire,
    __filename: filePath,
    __dirname: dirname,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });
  new vm.Script(`(function (exports, require, module, __filename, __dirname) { ${source}\n})`, { filename: filePath })
    .runInContext(context)(module.exports, customRequire, module, filePath, dirname);
  return module.exports;
}

const routePath = path.resolve(__dirname, '..', 'routes', 'accounts.js');

test('launch-login returns actionable error when chrome.exe manual selection is cancelled', async () => {
  const buildRouter = loadCommonJsModule(routePath, {
    '../services/auto-login': class { async run() { throw new Error('unused'); } }
  });
  const browserManager = {
    launchForLogin() {
      const error = new Error('manual selection cancelled');
      error.code = 'CHROME_SELECTION_CANCELLED';
      throw error;
    }
  };
  const accountManager = {
    add() { return { id: 'acc-new' }; }
  };
  const router = buildRouter(accountManager, browserManager, () => {});
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/launch-login' && entry.route.methods.post);
  const handler = layer.route.stack[0].handle;

  const req = { body: { name: 'A', platform: 'doubao' } };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.success, false);
  assert.equal(res.payload.error, 'chrome_selection_cancelled');
});

test('launch-login rejects accountless Orion before creating an account or launching browser', async () => {
  const buildRouter = loadCommonJsModule(routePath, {
    '../services/auto-login': class { async run() { throw new Error('unused'); } }
  });
  let added = false;
  let launched = false;
  const accountManager = {
    config: {
      platforms: {
        orion: { label: 'Orion', requiresAccount: false }
      }
    },
    add() { added = true; return { id: 'acc-new', platform: 'orion' }; }
  };
  const browserManager = {
    launchForLogin() { launched = true; throw new Error('should not launch'); }
  };
  const router = buildRouter(accountManager, browserManager, () => {});
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/launch-login' && entry.route.methods.post);
  const handler = layer.route.stack[0].handle;

  const req = { body: { name: 'Orion', platform: 'orion' } };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.success, false);
  assert.match(res.payload.error, /Orion.*不需要添加账号/);
  assert.equal(added, false);
  assert.equal(launched, false);
});


test('auto-login reports malformed account rows and still finishes the batch', async () => {
  const events = [];
  class FakeAutoLoginService {
    async run(platform, accounts, options = {}) {
      const { onProgress = () => {} } = options;
      onProgress({ total: accounts.length, index: 1, email: accounts[0].email, status: 'error', message: '格式错误', reason: 'invalid_credentials' });
      onProgress({ total: accounts.length, index: 2, email: accounts[1].email, status: 'ok', message: '登录成功', accountId: 'acc-2' });
      return { success: true, total: accounts.length, successCount: 1, failedCount: 1, results: [] };
    }
  }
  const buildRouter = loadCommonJsModule(routePath, {
    '../services/auto-login': FakeAutoLoginService
  });
  const router = buildRouter({ config: { storage: { browserWindowMode: 'background' } }, getAllByPlatform() { return []; } }, {}, (message) => events.push(message));
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/auto-login' && entry.route.methods.post);
  const handler = layer.route.stack[0].handle;

  const req = { body: { platform: 'dola', accounts: [{ email: 'bad', password: '' }, { email: 'ok@example.com', password: 'secret' }] } };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.data.started, true);
});

test('auto-login keeps browser open and reports stage when Google needs manual attention', async () => {
  const events = [];
  class FakeAutoLoginService {
    async run(_platform, accounts, options = {}) {
      const { onProgress = () => {} } = options;
      onProgress({
        total: accounts.length,
        index: 1,
        email: accounts[0].email,
        status: 'error',
        message: '需要人工继续',
        reason: 'google_manual_attention',
        stage: 'google-consent',
        browserKeptOpen: true
      });
      return { success: true, total: 1, successCount: 0, failedCount: 1, results: [] };
    }
  }
  const buildRouter = loadCommonJsModule(routePath, {
    '../services/auto-login': FakeAutoLoginService
  });
  const router = buildRouter({ config: { storage: { browserWindowMode: 'visible' } }, getAllByPlatform() { return []; } }, {}, (message) => events.push(message));
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/auto-login' && entry.route.methods.post);
  const handler = layer.route.stack[0].handle;

  const req = { body: { platform: 'dola', accounts: [{ email: 'manual@example.com', password: 'secret' }] } };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.started, true);
});

test('single account deletion removes persisted profile directory before deleting the account record', async () => {
  let removedId = null;
  const closed = [];
  const profileDir = path.join(__dirname, 'tmp-profile-delete-single');
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Cookies'), 'x');

  const buildRouter = loadCommonJsModule(routePath, {
    '../services/auto-login': class { async run() { throw new Error('unused'); } }
  });
  const accountManager = {
    getById(id) { return { id, profileDir }; },
    remove(id) { removedId = id; }
  };
  const browserManager = {
    close(id) { closed.push(id); },
    getProfileDir(id) { return id === 'acc-1' ? profileDir : ''; }
  };
  const router = buildRouter(accountManager, browserManager, () => {});
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/:id' && entry.route.methods.delete);
  const handler = layer.route.stack[0].handle;

  const req = { params: { id: 'acc-1' } };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(closed, ['acc-1']);
  assert.equal(removedId, 'acc-1');
  assert.equal(fs.existsSync(profileDir), true);
});

test('single account deletion detaches conversation ownership without deleting history', async () => {
  let detachedId = null;
  const buildRouter = loadCommonJsModule(routePath, {
    '../services/auto-login': class { async run() { throw new Error('unused'); } }
  });
  const accountManager = {
    getById(id) { return { id, platform: 'dola' }; },
    remove() {}
  };
  const browserManager = {
    close() {},
    getProfileDir() { return ''; }
  };
  const conversationManager = {
    detachAccount(id) { detachedId = id; return true; }
  };
  const router = buildRouter(accountManager, browserManager, () => {}, conversationManager);
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/:id' && entry.route.methods.delete);
  const handler = layer.route.stack[0].handle;

  const req = { params: { id: 'acc-history' } };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(detachedId, 'acc-history');
  assert.equal(res.payload.success, true);
});
