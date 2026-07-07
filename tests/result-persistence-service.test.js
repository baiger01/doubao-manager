const test = require('node:test');
const assert = require('node:assert/strict');

const ResultPersistenceService = require('../services/result-persistence-service');

test('result persistence downloads remote urls before saving the conversation result', async () => {
  const saved = [];
  const conversations = {
    ensureActive(platform, accountId) {
      assert.equal(platform, 'doubao');
      assert.equal(accountId, 'acc-1');
      return { id: 'conv-1' };
    },
    addResult(id, result) {
      saved.push({ id, result });
    }
  };
  const downloader = {
    async downloadUrls(urls, options) {
      assert.deepEqual(urls, ['https://cdn.example/a.png']);
      assert.deepEqual(options, { platform: 'doubao', accountId: 'acc-1', type: 'image' });
      return ['local://a.png'];
    }
  };
  const service = new ResultPersistenceService(conversations, downloader);

  await service.saveResult({
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'image',
    results: { images: ['https://cdn.example/a.png'], brief: 'ok' }
  });

  assert.deepEqual(saved, [{
    id: 'conv-1',
    result: {
      prompt: 'draw',
      type: 'image',
      platform: 'doubao',
      accountId: 'acc-1',
      urls: ['local://a.png'],
      brief: 'ok'
    }
  }]);
});

test('result persistence keeps original urls when download fails', async () => {
  let saved;
  const conversations = {
    ensureActive() { return { id: 'conv-1' }; },
    addResult(id, result) { saved = result; }
  };
  const downloader = {
    async downloadUrls() {
      throw new Error('network down');
    }
  };
  const service = new ResultPersistenceService(conversations, downloader);

  await service.saveResult({
    platform: '',
    accountId: '',
    prompt: 'clip',
    type: 'video',
    results: { videos: ['https://cdn.example/v.mp4'] }
  });

  assert.deepEqual(saved, {
    prompt: 'clip',
    type: 'video',
    platform: 'doubao',
    accountId: '',
    urls: ['https://cdn.example/v.mp4'],
    brief: ''
  });
});

test('result persistence rejects when conversation saving fails', async () => {
  const conversations = {
    ensureActive() { return { id: 'conv-1' }; },
    addResult() {
      throw new Error('disk full');
    }
  };
  const service = new ResultPersistenceService(conversations, null);

  await assert.rejects(
    () => service.saveResult({
      platform: 'doubao',
      accountId: 'acc-1',
      prompt: 'draw',
      type: 'image',
      results: { images: ['local://a.png'] }
    }),
    /disk full/
  );
});

test('result persistence saves to the submitted conversation when conversationId is provided', async () => {
  const saved = [];
  const conversations = {
    getById(id) {
      assert.equal(id, 'conv-submitted');
      return { id: 'conv-submitted', platform: 'doubao', accountId: '' };
    },
    ensureActive() {
      throw new Error('should not use active conversation');
    },
    addResult(id, result) {
      saved.push({ id, result });
    }
  };
  const service = new ResultPersistenceService(conversations, null);

  await service.saveResult({
    conversationId: 'conv-submitted',
    platform: 'doubao',
    accountId: 'acc-1',
    prompt: 'draw',
    type: 'image',
    results: { images: ['local://a.png'] }
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'conv-submitted');
  assert.equal(saved[0].result.accountId, '');
});
