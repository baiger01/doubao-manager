const test = require('node:test');
const assert = require('node:assert/strict');
const { submitGenerationJob } = require('../services/generation-job-submitter');
const { WS_EVENTS } = require('../services/ws-events');

function createHarness() {
  const created = [];
  const runs = [];
  const responses = [];
  const broadcasts = [];
  const jobManager = {
    create(payload) {
      const job = { id: 'job-1', ...payload };
      created.push(job);
      return job;
    },
    run(job, execute, onComplete) {
      runs.push({ job, execute, onComplete });
    }
  };
  const res = { json(payload) { responses.push(payload); } };
  return { created, runs, responses, broadcasts, jobManager, res, broadcast: msg => broadcasts.push(msg) };
}

test('submitGenerationJob creates the job, responds immediately, and wires execution', async () => {
  const h = createHarness();
  const execute = async () => ({ images: ['img'], quota: 7 });

  const job = submitGenerationJob({
    jobManager: h.jobManager,
    broadcast: h.broadcast,
    res: h.res,
    type: 'image',
    platform: 'dola',
    accountId: 'acc-1',
    prompt: '画猫',
    execute,
  });

  assert.deepEqual(h.created, [{ id: 'job-1', type: 'image', platform: 'dola', accountId: 'acc-1', prompt: '画猫' }]);
  assert.equal(job, h.created[0]);
  assert.deepEqual(h.responses, [{ success: true, data: { jobId: 'job-1', status: 'submitted' } }]);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].job, job);
  assert.deepEqual(await h.runs[0].execute('progress-cb'), await execute('progress-cb'));
});

test('submitGenerationJob broadcasts quota and persists results on completion', async () => {
  const h = createHarness();
  const persisted = [];

  submitGenerationJob({
    jobManager: h.jobManager,
    broadcast: h.broadcast,
    res: h.res,
    type: 'video',
    platform: 'dola',
    accountId: 'acc-2',
    prompt: '视频猫',
    execute: async () => ({ videos: ['v'], quota: 3 }),
    persistResult: results => persisted.push(results),
  });

  const result = { videos: ['v'], quota: 3 };
  await h.runs[0].onComplete(result);

  assert.deepEqual(h.broadcasts, [{ type: WS_EVENTS.QUOTA_UPDATE, data: { quota: 3, platform: 'dola' } }]);
  assert.deepEqual(persisted, [result]);
});

test('submitGenerationJob skips quota broadcast when result has no quota', async () => {
  const h = createHarness();

  submitGenerationJob({
    jobManager: h.jobManager,
    broadcast: h.broadcast,
    res: h.res,
    type: 'message',
    platform: 'doubao',
    accountId: 'acc-3',
    prompt: '聊天',
    execute: async () => ({ brief: 'ok' }),
  });

  await h.runs[0].onComplete({ brief: 'ok' });
  assert.deepEqual(h.broadcasts, []);
});
