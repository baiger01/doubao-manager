const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
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

function buildRouter(config, generationService, writes = []) {
  const routePath = path.resolve(__dirname, '..', 'routes', 'proxy.js');
  const buildProxyRouter = loadCommonJsModule(routePath, {
    fs: {
      writeFileSync(filePath, content, encoding) {
        writes.push({ filePath, content: JSON.parse(content), encoding });
      }
    },
    '../paths': { configFile: 'D:\\RuntimeData\\config\\config.json' }
  });
  return buildProxyRouter(config, generationService);
}

test('proxy route hides doubao proxy config and reports direct mode', async () => {
  const config = {
    platforms: {
      doubao: { proxy: 'http://127.0.0.1:7897' }
    }
  };
  const router = buildRouter(config, {});

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/?platform=doubao`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.allowed, false);
    assert.equal(payload.data.mode, 'none');
    assert.equal(payload.data.proxy, '');
  });
});

test('proxy route rejects saving proxy for doubao', async () => {
  const writes = [];
  const config = {
    platforms: {
      doubao: {}
    }
  };
  const router = buildRouter(config, {}, writes);

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'doubao', proxy: 'http://127.0.0.1:7897' })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.match(payload.error, /豆包不允许配置代理/);
  });

  assert.equal(config.platforms.doubao.proxy, undefined);
  assert.equal(writes.length, 0);
});

test('proxy route auto-detects and stores first working Dola proxy', async () => {
  const writes = [];
  const attempts = [];
  const config = {
    platforms: {
      dola: {
        baseUrl: 'https://www.dola.com',
        chatEndpoint: '/chat/completion',
        proxyMode: 'auto',
        proxyCandidates: ['http://127.0.0.1:7890', 'http://127.0.0.1:7897']
      }
    }
  };
  const router = buildRouter(config, {
    async httpPostViaProxy(_urlObj, _body, _headers, proxyUrl) {
      attempts.push(proxyUrl);
      if (proxyUrl.endsWith(':7897')) return { status: 400, text: '{"code":1,"msg":"invalid param"}' };
      throw new Error('connect failed');
    }
  }, writes);

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'dola' })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.proxy, 'http://127.0.0.1:7897');
    assert.equal(payload.data.mode, 'auto');
  });

  assert.deepEqual(attempts, ['http://127.0.0.1:7890', 'http://127.0.0.1:7897']);
  assert.equal(config.platforms.dola.proxy, 'http://127.0.0.1:7897');
  assert.equal(writes.length, 1);
});
