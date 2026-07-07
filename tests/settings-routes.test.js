const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const os = require('node:os');

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

function buildPaths() {
  const dir = path.join(os.tmpdir(), 'dou-settings-test');
  return {
    configFile: path.join(dir, 'config.json'),
    downloadsDir: dir,
    resolveDownloadDir(value) { return value || dir; },
    mcpServerFile: path.join(dir, 'mcp.js'),
    isPackaged: false
  };
}

test('settings routes use the native bridge for directory picking and opening', async () => {
  const buildSettingsRoutes = require('../routes/settings');
  const calls = [];
  const app = {
    locals: {
      nativeBridge: {
        canPickDir() { return true; },
        canOpenPath() { return true; },
        hasWebviewSession() { return false; },
        async pickDirectory(options) {
          calls.push({ method: 'pickDirectory', options });
          return { canceled: false, filePaths: ['D:\\Picked'] };
        },
        async openPath(dir) {
          calls.push({ method: 'openPath', dir });
        }
      }
    }
  };
  const router = buildSettingsRoutes(
    { storage: { downloadDir: 'D:\\Downloads' }, server: { port: 9527 } },
    app,
    buildPaths(),
    { getConfig() { return { enabled: false, token: '' }; } },
    { getAllByPlatform() { return []; } }
  );

  await withServer(router, async (port) => {
    const settings = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    assert.equal(settings.data.canPickDir, true);

    const picked = await (await fetch(`http://127.0.0.1:${port}/pick-dir`, { method: 'POST' })).json();
    assert.deepEqual(picked, { success: true, data: { dir: 'D:\\Picked' } });

    const opened = await (await fetch(`http://127.0.0.1:${port}/open-dir`, { method: 'POST' })).json();
    assert.equal(opened.success, true);
  });

  assert.deepEqual(calls.map(call => call.method), ['pickDirectory', 'openPath']);
  assert.equal(calls[1].dir, 'D:\\Downloads');
});



test('settings directory picker falls back when Electron native bridge is unavailable', async () => {
  const buildSettingsRoutes = require('../routes/settings');
  const calls = [];
  const app = {
    locals: {
      nativeBridge: {
        canPickDir() { return false; },
        canOpenPath() { return false; },
        hasWebviewSession() { return false; }
      }
    }
  };
  const fallbackPicker = {
    canPickDir() { return true; },
    async pickDirectory(options) {
      calls.push(options);
      return { canceled: false, filePaths: ['E:\\PickedDownloads'] };
    }
  };
  const router = buildSettingsRoutes(
    { storage: { downloadDir: '' }, server: { port: 9527 } },
    app,
    buildPaths(),
    { getConfig() { return { enabled: false, token: '' }; } },
    { getAllByPlatform() { return []; } },
    fallbackPicker
  );

  await withServer(router, async (port) => {
    const settings = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    assert.equal(settings.data.canPickDir, true);

    const picked = await (await fetch(`http://127.0.0.1:${port}/pick-dir`, { method: 'POST' })).json();
    assert.deepEqual(picked, { success: true, data: { dir: 'E:\\PickedDownloads' } });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, '选择下载目录');
});

test('webview binding reinjection uses native bridge partition cookies', async () => {
  const buildSettingsRoutes = require('../routes/settings');
  const calls = [];
  const app = {
    locals: {
      nativeBridge: {
        canPickDir() { return false; },
        canOpenPath() { return false; },
        hasWebviewSession() { return true; },
        async getCookies(partition, filter) {
          calls.push({ method: 'getCookies', partition, filter });
          return [{ name: 'old', domain: '.doubao.com', path: '/', secure: true }];
        },
        async removeCookie(partition, url, name) {
          calls.push({ method: 'removeCookie', partition, url, name });
        },
        async setCookie(partition, cookie) {
          calls.push({ method: 'setCookie', partition, cookie });
        }
      }
    }
  };
  const accountManager = {
    getById(id) {
      return { id, name: 'A', platform: 'doubao', session: { cookies: 'sid=1; uid=2' } };
    },
    getAllByPlatform() { return []; }
  };

  buildSettingsRoutes(
    {
      storage: {},
      platforms: { doubao: { baseUrl: 'https://www.doubao.com' } },
      webviewBinding: { doubao: 'acc-1' },
      server: { port: 9527 }
    },
    app,
    buildPaths(),
    { getConfig() { return { enabled: false, token: '' }; } },
    accountManager
  );

  const result = await app.locals.reinjectWebviewBinding();

  assert.deepEqual(result, { injected: 2, accountId: 'acc-1' });
  assert.deepEqual(calls.map(call => call.method), ['getCookies', 'removeCookie', 'setCookie', 'setCookie']);
  assert.equal(calls[2].partition, 'persist:doubaochat');
  assert.equal(calls[2].cookie.name, 'sid');
  assert.equal(calls[3].cookie.name, 'uid');
});

test('settings image-api route saves plus custom endpoint and masks stored key', async () => {
  const buildSettingsRoutes = require('../routes/settings');
  const config = {
    server: { port: 9527 },
    platforms: {
      plus: {
        label: 'plus',
        requiresAccount: false,
        imageApi: {
          type: 'openai-compatible',
          endpoint: 'http://old.example/v1/images/generations',
          apiKey: 'sk-old-secret',
          model: 'gpt-image-1'
        },
        imageModels: [{ value: 'gpt-image-1', label: 'gpt-image-1' }]
      }
    }
  };
  const app = { locals: { nativeBridge: { canPickDir() { return false; }, canOpenPath() { return false; }, hasWebviewSession() { return false; } } } };
  const router = buildSettingsRoutes(
    config,
    app,
    buildPaths(),
    { getConfig() { return { enabled: false, token: '' }; } },
    { getAllByPlatform() { return []; } }
  );

  await withServer(router, async (port) => {
    const before = await (await fetch(`http://127.0.0.1:${port}/image-api?platform=plus`)).json();
    assert.equal(before.success, true);
    assert.equal(before.data.platform, 'plus');
    assert.equal(before.data.label, 'plus');
    assert.equal(before.data.endpoint, 'http://old.example/v1/images/generations');
    assert.equal(before.data.hasKey, true);
    assert.equal(before.data.apiKey, undefined);
    assert.match(before.data.maskedKey, /^sk-/);

    const saved = await (await fetch(`http://127.0.0.1:${port}/image-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'plus',
        endpoint: 'http://23.148.180.82:3002/v1/images/generations',
        apiKey: 'sk-new-secret',
        model: 'gpt-image2'
      })
    })).json();
    assert.equal(saved.success, true);
    assert.equal(saved.data.model, 'gpt-image-2');
    assert.equal(saved.data.hasKey, true);
  });

  assert.equal(config.platforms.plus.imageApi.endpoint, 'http://23.148.180.82:3002/v1/images/generations');
  assert.equal(config.platforms.plus.imageApi.apiKey, 'sk-new-secret');
  assert.equal(config.platforms.plus.imageApi.model, 'gpt-image-2');
  assert.deepEqual(config.platforms.plus.imageModels, [{ value: 'gpt-image-2', label: 'gpt-image2' }]);
});

test('settings image-api route manages 4k base_url size and quality separately', async () => {
  const buildSettingsRoutes = require('../routes/settings');
  const config = {
    server: { port: 9527 },
    platforms: {
      plus: {
        label: 'plus',
        requiresAccount: false,
        imageApi: {
          type: 'openai-compatible',
          endpoint: 'http://23.148.180.82:3002/v1/images/generations',
          apiKey: 'sk-plus',
          model: 'gpt-image-2'
        },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image2' }]
      },
      '4k': {
        label: '4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: {
          type: 'openai-compatible',
          baseUrl: 'https://5988.de5.net/v1',
          apiKey: 'sk-4k',
          model: 'gpt-image-2',
          size: '3840x2160',
          quality: 'high'
        },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image-2' }],
        videoModels: []
      }
    }
  };
  const app = { locals: { nativeBridge: { canPickDir() { return false; }, canOpenPath() { return false; }, hasWebviewSession() { return false; } } } };
  const router = buildSettingsRoutes(
    config,
    app,
    buildPaths(),
    { getConfig() { return { enabled: false, token: '' }; } },
    { getAllByPlatform() { return []; } }
  );

  await withServer(router, async (port) => {
    const before = await (await fetch(`http://127.0.0.1:${port}/image-api?platform=4k`)).json();
    assert.equal(before.success, true);
    assert.equal(before.data.platform, '4k');
    assert.equal(before.data.endpoint, 'https://5988.de5.net/v1');
    assert.equal(before.data.size, '3840x2160');
    assert.equal(before.data.quality, 'high');
    assert.equal(before.data.hasKey, true);

    const saved = await (await fetch(`http://127.0.0.1:${port}/image-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: '4k',
        endpoint: 'https://5988.de5.net/v1',
        apiKey: '',
        model: 'gpt-image-2',
        size: '3840x2160',
        quality: 'high'
      })
    })).json();
    assert.equal(saved.success, true);
    assert.equal(saved.data.platform, '4k');
    assert.equal(saved.data.endpoint, 'https://5988.de5.net/v1');
    assert.equal(saved.data.size, '3840x2160');
    assert.equal(saved.data.quality, 'high');
  });

  assert.equal(config.platforms['4k'].imageApi.baseUrl, 'https://5988.de5.net/v1');
  assert.equal(config.platforms['4k'].imageApi.endpoint, undefined);
  assert.equal(config.platforms['4k'].imageApi.apiKey, 'sk-4k');
  assert.equal(config.platforms['4k'].imageApi.size, '3840x2160');
  assert.equal(config.platforms['4k'].imageApi.quality, 'high');
});

test('settings image-api route can save a custom 4k API key independently', async () => {
  const buildSettingsRoutes = require('../routes/settings');
  const config = {
    server: { port: 9527 },
    platforms: {
      '4k': {
        label: '4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: {
          type: 'openai-compatible',
          baseUrl: 'https://5988.de5.net/v1',
          apiKey: '',
          model: 'gpt-image-2',
          size: '3840x2160',
          quality: 'high'
        },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image-2' }],
        videoModels: []
      }
    }
  };
  const app = { locals: { nativeBridge: { canPickDir() { return false; }, canOpenPath() { return false; }, hasWebviewSession() { return false; } } } };
  const router = buildSettingsRoutes(
    config,
    app,
    buildPaths(),
    { getConfig() { return { enabled: false, token: '' }; } },
    { getAllByPlatform() { return []; } }
  );

  await withServer(router, async (port) => {
    const saved = await (await fetch(`http://127.0.0.1:${port}/image-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: '4k',
        endpoint: 'https://5988.de5.net/v1',
        apiKey: 'sk-custom-4k',
        model: 'gpt-image-2',
        size: '3840x2160',
        quality: 'high'
      })
    })).json();

    assert.equal(saved.success, true);
    assert.equal(saved.data.platform, '4k');
    assert.equal(saved.data.hasKey, true);
    assert.equal(saved.data.apiKey, undefined);
  });

  assert.equal(config.platforms['4k'].imageApi.apiKey, 'sk-custom-4k');
  assert.equal(config.platforms['4k'].imageApi.baseUrl, 'https://5988.de5.net/v1');
});
