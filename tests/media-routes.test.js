const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const os = require('node:os');

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
    process,
    setTimeout,
    clearTimeout
  });

  const wrapped = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
  const compiled = vm.runInContext(wrapped, context, { filename });
  compiled(module.exports, localRequire, module, filename, dirname);
  return module.exports;
}

function fakeHttpsGet(url, options, callback) {
  const req = new EventEmitter();
  req.destroy = (error) => {
    if (error) process.nextTick(() => req.emit('error', error));
  };

  process.nextTick(() => {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = {
      'content-type': 'image/png',
      'content-length': '7'
    };
    callback(upstream);
    upstream.end('pngdata');
  });
  return req;
}

async function withServer(router, fn, locals = {}) {
  const app = express();
  Object.assign(app.locals, locals);
  app.use(router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('media image proxy streams allowed ByteDance image CDN URLs', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'media.js');
  const router = loadCommonJsModule(routePath, {
    https: { get: fakeHttpsGet }
  });

  await withServer(router, async (port) => {
    const imageUrl = 'https://p6-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/test.jpeg~tplv-a9rns2rl98-image_raw_b.png?x-signature=abc';
    const response = await fetch(`http://127.0.0.1:${port}/image?url=${encodeURIComponent(imageUrl)}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(body, 'pngdata');
  });
});

test('media image proxy rejects non-CDN URLs', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'media.js');
  const router = loadCommonJsModule(routePath, {
    https: { get: fakeHttpsGet }
  });

  await withServer(router, async (port) => {
    const imageUrl = 'https://example.com/private.png';
    const response = await fetch(`http://127.0.0.1:${port}/image?url=${encodeURIComponent(imageUrl)}`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
  });
});

test('media download streams OpenAI-compatible generated image CDN URLs as image attachments', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'media.js');
  const router = loadCommonJsModule(routePath, {
    https: { get: fakeHttpsGet }
  });

  await withServer(router, async (port) => {
    const imageUrl = 'https://cdn.yumato.hello4am.com/chatgpt2api/images/2026/07/05/1783185544_94babf99a634b6643f1e4908dda7f33d.png';
    const response = await fetch(`http://127.0.0.1:${port}/download?url=${encodeURIComponent(imageUrl)}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.match(response.headers.get('content-disposition'), /1783185544_94babf99a634b6643f1e4908dda7f33d\.png/);
    assert.equal(body, 'pngdata');
  });
});

test('media save writes arbitrary OpenAI-compatible API image CDN URLs to the configured download directory', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'media.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-media-save-'));
  const router = loadCommonJsModule(routePath, {
    https: { get: fakeHttpsGet }
  });

  await withServer(router, async (port) => {
    const imageUrl = 'https://images.openai-compatible.example/generated/custom-output.png';
    const response = await fetch(`http://127.0.0.1:${port}/save?url=${encodeURIComponent(imageUrl)}`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.file, 'custom-output.png');
    assert.equal(fs.readFileSync(path.join(dir, 'custom-output.png'), 'utf8'), 'pngdata');
  }, { downloadDir: dir });
});

test('media save writes remote media to the per-request download directory when provided', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'media.js');
  const defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-media-default-'));
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-media-custom-'));
  const router = loadCommonJsModule(routePath, {
    https: { get: fakeHttpsGet }
  });

  await withServer(router, async (port) => {
    const imageUrl = 'https://images.openai-compatible.example/generated/picked-output.png';
    const response = await fetch(`http://127.0.0.1:${port}/save?url=${encodeURIComponent(imageUrl)}&dir=${encodeURIComponent(customDir)}`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.file, 'picked-output.png');
    assert.equal(payload.data.path, path.join(customDir, 'picked-output.png'));
    assert.equal(fs.existsSync(path.join(defaultDir, 'picked-output.png')), false);
    assert.equal(fs.readFileSync(path.join(customDir, 'picked-output.png'), 'utf8'), 'pngdata');
  }, { downloadDir: defaultDir });
});

test('media save copies local media into the per-request download directory', async () => {
  const routePath = path.resolve(__dirname, '..', 'routes', 'media.js');
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-media-source-'));
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-media-copy-'));
  fs.writeFileSync(path.join(sourceDir, 'cat.png'), 'localcat');
  const router = loadCommonJsModule(routePath, {
    https: { get: fakeHttpsGet }
  });

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/save?f=cat.png&dir=${encodeURIComponent(customDir)}`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.file, 'cat.png');
    assert.equal(payload.data.path, path.join(customDir, 'cat.png'));
    assert.equal(payload.data.alreadyLocal, false);
    assert.equal(fs.readFileSync(path.join(sourceDir, 'cat.png'), 'utf8'), 'localcat');
    assert.equal(fs.readFileSync(path.join(customDir, 'cat.png'), 'utf8'), 'localcat');
  }, { downloadDir: sourceDir });
});
