const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

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
    fetch,
    setTimeout,
    clearTimeout,
    process: overrides.process || process
  });

  const wrapped = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
  const compiled = vm.runInContext(wrapped, context, { filename });
  compiled(module.exports, localRequire, module, filename, dirname);
  return module.exports;
}

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('conversation routes accept accountId for compatibility but use platform-only scope', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'conversations.js');
  const calls = [];
  const buildRoutes = loadCommonJsModule(routePath);
  const router = buildRoutes({
    getAll(platform, accountId) {
      calls.push({ method: 'getAll', platform, accountId });
      return [{ id: 'conv-1', platform, accountId }];
    },
    create(name, platform, accountId) {
      calls.push({ method: 'create', name, platform, accountId });
      return { id: 'conv-2', name, platform, accountId };
    }
  });

  await withServer(router, async (port) => {
    const listResponse = await fetch(`http://127.0.0.1:${port}/?platform=doubao&accountId=acc-1`);
    const listPayload = await listResponse.json();
    assert.equal(listPayload.data[0].accountId, '');

    const createResponse = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '会话', platform: 'doubao', accountId: 'acc-1' })
    });
    const createPayload = await createResponse.json();
    assert.equal(createPayload.data.accountId, '');
  });

  assert.equal(calls[0].method, 'getAll');
  assert.equal(calls[0].accountId, '');
  assert.equal(calls[1].method, 'create');
  assert.equal(calls[1].accountId, '');
});

test('conversation list auto-opens a scoped default conversation when missing', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'conversations.js');
  const calls = [];
  const buildRoutes = loadCommonJsModule(routePath);
  const router = buildRoutes({
    getAll(platform, accountId) {
      calls.push({ method: 'getAll', platform, accountId });
      return [];
    },
    ensureActive(platform, accountId) {
      calls.push({ method: 'ensureActive', platform, accountId });
      return {
        id: 'conv-default',
        name: '默认会话',
        platform,
        accountId,
        isActive: true,
        results: []
      };
    }
  });

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/?platform=dola&accountId=acc-dola`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].id, 'conv-default');
    assert.equal(payload.data[0].isActive, true);
    assert.equal(payload.data[0].accountId, '');
  });

  assert.deepEqual(calls.map(c => c.method), ['getAll', 'ensureActive']);
  assert.equal(calls[1].platform, 'dola');
  assert.equal(calls[1].accountId, '');
});

test('conversation list auto-opens a platform default conversation without an account', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'conversations.js');
  const calls = [];
  const buildRoutes = loadCommonJsModule(routePath);
  const router = buildRoutes({
    getAll(platform, accountId) {
      calls.push({ method: 'getAll', platform, accountId });
      return [];
    },
    ensureActive(platform, accountId) {
      calls.push({ method: 'ensureActive', platform, accountId });
      return {
        id: 'conv-default',
        name: '默认会话',
        platform,
        accountId,
        isActive: true,
        results: []
      };
    }
  });

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/?platform=doubao`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].id, 'conv-default');
    assert.equal(payload.data[0].isActive, true);
    assert.equal(payload.data[0].platform, 'doubao');
    assert.equal(payload.data[0].accountId, '');
  });

  assert.deepEqual(calls.map(c => c.method), ['getAll', 'ensureActive']);
  assert.equal(calls[1].platform, 'doubao');
  assert.equal(calls[1].accountId, '');
});
