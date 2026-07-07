const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

async function withServer(router, run) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
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

test('generate routes return the persistence promise to JobManager', async () => {
  delete require.cache[require.resolve('../routes/generate')];
  const buildGenerateRoutes = require('../routes/generate');
  let capturedOnResult;
  const jobManager = {
    create(meta) { return { id: 'job-1', ...meta }; },
    run(job, runner, onResult) { capturedOnResult = onResult; }
  };
  const persistence = {
    saveResult() {
      return Promise.reject(new Error('disk full'));
    }
  };
  const router = buildGenerateRoutes(
    {},
    {},
    {},
    () => {},
    { ensureActive() {}, addResult() {} },
    jobManager,
    null,
    persistence
  );

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'draw' })
    });
    assert.equal(response.status, 200);
  });

  await assert.rejects(
    () => capturedOnResult({ images: ['local://a.png'], quota: null }),
    /disk full/
  );
});

test('generate routes pass submitted conversationId to result persistence', async () => {
  delete require.cache[require.resolve('../routes/generate')];
  const buildGenerateRoutes = require('../routes/generate');
  let capturedOnResult;
  let capturedSaveArgs;
  const jobManager = {
    create(meta) { return { id: 'job-1', ...meta }; },
    run(job, runner, onResult) { capturedOnResult = onResult; }
  };
  const persistence = {
    saveResult(args) {
      capturedSaveArgs = args;
      return Promise.resolve(true);
    }
  };
  const router = buildGenerateRoutes(
    {},
    {},
    {},
    () => {},
    { ensureActive() {}, addResult() {} },
    jobManager,
    null,
    persistence
  );

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'draw', conversationId: 'conv-submitted' })
    });
    assert.equal(response.status, 200);
  });

  await capturedOnResult({ images: ['local://a.png'], quota: null });

  assert.equal(capturedSaveArgs.conversationId, 'conv-submitted');
});

test('generate image route forwards submitted image count to generation service', async () => {
  delete require.cache[require.resolve('../routes/generate')];
  const buildGenerateRoutes = require('../routes/generate');
  let capturedRunner;
  let capturedOptions;
  const jobManager = {
    create(meta) { return { id: 'job-1', ...meta }; },
    run(job, runner) { capturedRunner = runner; }
  };
  const generationService = {
    async generateImage(prompt, options) {
      capturedOptions = options;
      return { images: ['local://a.png'], quota: null };
    }
  };
  const router = buildGenerateRoutes(
    generationService,
    {},
    {},
    () => {},
    { ensureActive() {}, addResult() {} },
    jobManager,
    null,
    { saveResult() { return Promise.resolve(true); } }
  );

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'draw', platform: '4k', n: 3 })
    });
    assert.equal(response.status, 200);
  });

  await capturedRunner(() => {});

  assert.equal(capturedOptions.n, 3);
});

test('external routes return the persistence promise to JobManager', async () => {
  delete require.cache[require.resolve('../routes/ext')];
  const buildExtRoutes = require('../routes/ext');
  let capturedOnResult;
  const jobManager = {
    create(meta) { return { id: 'job-1', ...meta }; },
    run(job, runner, onResult) { capturedOnResult = onResult; },
    list() { return []; },
    get() { return null; }
  };
  const persistence = {
    saveResult() {
      return Promise.reject(new Error('disk full'));
    }
  };
  const router = buildExtRoutes({
    accountManager: { getActive() { return null; }, getAll() { return []; }, config: {} },
    generationService: {},
    quotaPoller: { getQuotaStatus() { return []; } },
    conversationManager: { ensureActive() {}, addResult() {} },
    jobManager,
    mediaDownloader: null,
    broadcast() {},
    apiTokenManager: {
      isEnabled() { return true; },
      verify() { return true; }
    },
    resultPersistenceService: persistence
  });

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ prompt: 'draw' })
    });
    assert.equal(response.status, 200);
  });

  await assert.rejects(
    () => capturedOnResult({ images: ['local://a.png'], quota: null }),
    /disk full/
  );
});

test('external routes pass submitted conversationId to result persistence', async () => {
  delete require.cache[require.resolve('../routes/ext')];
  const buildExtRoutes = require('../routes/ext');
  let capturedOnResult;
  let capturedSaveArgs;
  const jobManager = {
    create(meta) { return { id: 'job-1', ...meta }; },
    run(job, runner, onResult) { capturedOnResult = onResult; },
    list() { return []; },
    get() { return null; }
  };
  const persistence = {
    saveResult(args) {
      capturedSaveArgs = args;
      return Promise.resolve(true);
    }
  };
  const router = buildExtRoutes({
    accountManager: { getActive() { return null; }, getAll() { return []; }, config: {} },
    generationService: {},
    quotaPoller: { getQuotaStatus() { return []; } },
    conversationManager: { ensureActive() {}, addResult() {} },
    jobManager,
    mediaDownloader: null,
    broadcast() {},
    apiTokenManager: {
      isEnabled() { return true; },
      verify() { return true; }
    },
    resultPersistenceService: persistence
  });

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ prompt: 'draw', conversationId: 'ext-conv-1' })
    });
    assert.equal(response.status, 200);
  });

  await capturedOnResult({ images: ['local://a.png'], quota: null });

  assert.equal(capturedSaveArgs.conversationId, 'ext-conv-1');
});

test('result persistence downloads remote urls before saving the conversation result', async () => {
  const ResultPersistenceService = require('../services/result-persistence-service');
  const calls = [];
  const service = new ResultPersistenceService({
    ensureActive(platform, accountId) {
      calls.push(['ensureActive', platform, accountId]);
      return { id: 'conv-1' };
    },
    addResult(id, payload) {
      calls.push(['addResult', id, payload]);
    }
  }, {
    async downloadUrls(urls, meta) {
      calls.push(['downloadUrls', urls, meta]);
      return urls.map((u, i) => `local://asset-${i}`);
    }
  });

  await service.saveResult({
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'image',
    results: { images: ['https://cdn/a.png', 'https://cdn/b.png'], brief: 'ok' }
  });

  assert.deepEqual(calls[0], ['ensureActive', 'doubao', 'acc-1']);
  assert.deepEqual(calls[1], ['downloadUrls', ['https://cdn/a.png', 'https://cdn/b.png'], {
    platform: 'doubao',
    accountId: 'acc-1',
    type: 'image'
  }]);
  assert.deepEqual(calls[2], ['addResult', 'conv-1', {
    prompt: 'draw',
    type: 'image',
    platform: 'doubao',
    accountId: 'acc-1',
    urls: ['local://asset-0', 'local://asset-1'],
    brief: 'ok'
  }]);
});

test('result persistence keeps original urls when download fails', async () => {
  const ResultPersistenceService = require('../services/result-persistence-service');
  let saved;
  const service = new ResultPersistenceService({
    ensureActive() { return { id: 'conv-1' }; },
    addResult(_id, payload) { saved = payload; }
  }, {
    async downloadUrls() {
      throw new Error('download failed');
    }
  });

  await service.saveResult({
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'video',
    results: { videos: ['https://cdn/video.mp4'], brief: 'ok' }
  });

  assert.deepEqual(saved.urls, ['https://cdn/video.mp4']);
});

test('result persistence rejects when conversation saving fails', async () => {
  const ResultPersistenceService = require('../services/result-persistence-service');
  const service = new ResultPersistenceService({
    ensureActive() { return { id: 'conv-1' }; },
    addResult() { throw new Error('save failed'); }
  }, null);

  await assert.rejects(() => service.saveResult({
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'image',
    results: { images: ['https://cdn/a.png'], brief: 'ok' }
  }), /save failed/);
});

test('result persistence saves to the submitted conversation when conversationId is provided', async () => {
  const ResultPersistenceService = require('../services/result-persistence-service');
  const calls = [];
  const service = new ResultPersistenceService({
    getById(id) {
      calls.push(['getById', id]);
      return { id, platform: 'doubao', accountId: 'acc-2' };
    },
    ensureActive() {
      calls.push(['ensureActive']);
      return { id: 'fallback' };
    },
    addResult(id, payload) {
      calls.push(['addResult', id, payload]);
    }
  }, null);

  await service.saveResult({
    conversationId: 'conv-submitted',
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'image',
    results: { images: ['local://a.png'], brief: 'ok' }
  });

  assert.deepEqual(calls[0], ['getById', 'conv-submitted']);
  assert.equal(calls.some(([name]) => name === 'ensureActive'), false);
  assert.deepEqual(calls[1], ['addResult', 'conv-submitted', {
    prompt: 'draw',
    type: 'image',
    platform: 'doubao',
    accountId: 'acc-2',
    urls: ['local://a.png'],
    brief: 'ok'
  }]);
});

test('result persistence returns false when submitted conversation does not exist', async () => {
  const ResultPersistenceService = require('../services/result-persistence-service');
  let calledEnsureActive = false;
  let calledAddResult = false;
  const service = new ResultPersistenceService({
    getById() { return null; },
    ensureActive() { calledEnsureActive = true; return { id: 'fallback' }; },
    addResult() { calledAddResult = true; }
  }, null);

  const ok = await service.saveResult({
    conversationId: 'missing-conv',
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'image',
    results: { images: ['local://a.png'], brief: 'ok' }
  });

  assert.equal(ok, false);
  assert.equal(calledEnsureActive, false);
  assert.equal(calledAddResult, false);
});

test('result persistence tolerates mismatched explicit platform/account and prefers submitted conversation ownership', async () => {
  const ResultPersistenceService = require('../services/result-persistence-service');
  let saved;
  const service = new ResultPersistenceService({
    getById(id) { return { id, platform: 'plus', accountId: '' }; },
    addResult(_id, payload) { saved = payload; }
  }, null);

  await service.saveResult({
    conversationId: 'conv-plus',
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'image',
    results: { images: ['local://a.png'], brief: 'ok' }
  });

  assert.equal(saved.platform, 'plus');
  assert.equal(saved.accountId, '');
});
