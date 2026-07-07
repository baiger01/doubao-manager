const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

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

test('status exposes proxy settings only for Dola', async () => {
  const buildApiRoutes = require('../routes/api');
  const config = {
    platforms: {
      doubao: {
        label: '豆包',
        proxy: 'http://127.0.0.1:7897',
        defaultParams: { region: 'CN' }
      },
      dola: {
        label: 'Dola',
        proxy: 'http://127.0.0.1:7897',
        defaultParams: { region: 'SC' }
      },
      plus: {
        label: 'plus',
        requiresAccount: false,
        imageApi: { type: 'openai-compatible' },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image2' }]
      },
      '4k': {
        label: '4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: { type: 'openai-compatible' },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image-2' }]
      },
      orion: {
        label: 'Orion',
        requiresAccount: false,
        supportsImage: false,
        supportsVideo: true,
        videoApi: { type: 'orion-local', endpoint: 'http://127.0.0.1:8787/generate' },
        imageModels: [],
        videoModels: [{ value: 'orion-project1', label: 'Orion 项目1 15s' }]
      }
    }
  };
  const accountManager = {
    config,
    getActive() { return null; },
    getAll() { return []; }
  };
  const generationService = {
    config,
    httpPostViaProxy() {
      throw new Error('not used');
    }
  };
  const router = buildApiRoutes(
    accountManager,
    {},
    generationService,
    { getQuotaStatus() { return {}; } },
    () => {},
    {},
    { create() {}, run() {} },
    null,
    null
  );

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    const byKey = Object.fromEntries(payload.data.platforms.map(platform => [platform.key, platform]));
    assert.equal(byKey.doubao.needsProxy, false);
    assert.equal(byKey.doubao.proxy, '');
    assert.equal(byKey.doubao.proxyAllowed, false);
    assert.equal(byKey.dola.needsProxy, true);
    assert.equal(byKey.dola.proxy, 'http://127.0.0.1:7897');
    assert.equal(byKey.dola.proxyAllowed, true);
    assert.equal(byKey.plus.requiresAccount, false);
    assert.equal(byKey.plus.hasImageApi, true);
    assert.deepEqual(byKey.plus.imageModels, [{ value: 'gpt-image-2', label: 'gpt-image2' }]);
    assert.equal(byKey['4k'].requiresAccount, false);
    assert.equal(byKey['4k'].supportsVideo, false);
    assert.equal(byKey['4k'].hasImageApi, true);
    assert.deepEqual(byKey['4k'].imageModels, [{ value: 'gpt-image-2', label: 'gpt-image-2' }]);
    assert.equal(byKey.orion.requiresAccount, false);
    assert.equal(byKey.orion.label, 'Orion');
    assert.equal(byKey.orion.supportsImage, false);
    assert.equal(byKey.orion.supportsVideo, true);
    assert.equal(byKey.orion.hasVideoApi, true);
    assert.deepEqual(byKey.orion.videoModels, [{ value: 'orion-project1', label: 'Orion 项目1 15s' }]);
  });
});


test('api proxy routes receive canonical account manager config instead of reaching through generation service', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'api.js'), 'utf8');

  assert.match(source, /require\('\.\/proxy'\)\(accountManager\.config, generationService\)/);
  assert.doesNotMatch(source, /require\('\.\/proxy'\)\(generationService\.config, generationService\)/);
});
