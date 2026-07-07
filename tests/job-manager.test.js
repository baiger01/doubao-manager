const test = require('node:test');
const assert = require('node:assert/strict');

const JobManager = require('../services/job-manager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(check, label = 'condition') {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('job records partial success when result persistence fails', async () => {
  const events = [];
  const manager = new JobManager((message) => events.push(message));
  const job = manager.create({ type: 'image', platform: 'doubao', accountId: 'acc-1', prompt: 'p' });

  manager.run(
    job,
    async () => ({ images: ['local://x.png'], videos: [], quota: null }),
    async () => { throw new Error('disk full'); }
  );

  await waitFor(() => events.some(e => e.type === 'job_done'), 'job_done');
  await waitFor(() => job.persisted === false, 'job.persisted=false');

  assert.equal(job.status, 'done');
  assert.equal(job.persisted, false);
  assert.equal(job.persistError, 'disk full');
  const done = events.find(e => e.type === 'job_done');
  assert.equal(done.data.persisted, null);
  assert.equal(done.data.persistError, null);
});

test('job manager queues work beyond the configured concurrency limit', async () => {
  const manager = new JobManager(() => {}, { concurrency: 1 });
  const order = [];
  const first = manager.create({ type: 'video', platform: 'dola', prompt: 'first' });
  const second = manager.create({ type: 'video', platform: 'dola', prompt: 'second' });
  const firstGate = deferred();

  manager.run(first, () => {
    order.push('first-start');
    return firstGate.promise.then(() => {
      order.push('first-end');
      return { videos: ['v1'] };
    });
  });
  manager.run(second, async () => {
    order.push('second-start');
    return { videos: ['v2'] };
  });

  await waitFor(() => order.includes('first-start'), 'first start');
  assert.deepEqual(order, ['first-start']);
  assert.equal(second.status, 'queued');

  firstGate.resolve();
  await waitFor(() => order.includes('second-start'), 'second start');
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
  assert.equal(second.status, 'done');
});

test('job manager rejects new work once the queue limit is exceeded', () => {
  const manager = new JobManager(() => {}, { concurrency: 1, maxQueueSize: 1 });
  const first = manager.create({ type: 'video', platform: 'dola', prompt: 'first' });
  const second = manager.create({ type: 'video', platform: 'dola', prompt: 'second' });
  const third = manager.create({ type: 'video', platform: 'dola', prompt: 'third' });

  manager.run(first, () => new Promise(() => {}));
  manager.run(second, () => Promise.resolve({ videos: ['v2'] }));

  assert.throws(
    () => manager.run(third, () => Promise.resolve({ videos: ['v3'] })),
    /queue_full/
  );
  assert.equal(third.status, 'rejected');
  assert.equal(third.error, 'queue_full');
});

test('job manager emits job_done before slow result persistence finishes', async () => {
  const events = [];
  const manager = new JobManager((message) => events.push({ ...message, ts: Date.now() }));
  const job = manager.create({ type: 'video', platform: 'dola', prompt: 'slow-persist' });
  const gate = deferred();
  let releaseTs = null;

  manager.run(
    job,
    async () => ({ videos: ['https://cdn.example.com/v.mp4'], quota: null }),
    async () => {
      await gate.promise;
      releaseTs = Date.now();
    }
  );

  await waitFor(() => events.some(e => e.type === 'job_done'), 'job_done');
  const doneEvent = events.find(e => e.type === 'job_done');
  assert.equal(job.status, 'done');
  assert.equal(releaseTs, null);

  gate.resolve();
  await waitFor(() => job.persisted === true, 'job persisted');
  assert.ok(releaseTs !== null && doneEvent.ts <= releaseTs);
});


