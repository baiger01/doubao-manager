const { v4: uuidv4 } = require('uuid');
const { WS_EVENTS } = require('./ws-events');

// 生成任务管理：把耗时的图片/视频生成放后台跑，立即返回 jobId，
// 进度/完成通过 WebSocket broadcast 推给前端。支持 dola 视频这种长达 55 分钟的异步生成。
class JobManager {
  constructor(broadcast, options = {}) {
    this.broadcast = broadcast || (() => {});
    this.jobs = new Map(); // jobId -> { id, type, platform, prompt, status, result, error, createdAt }
    this.concurrency = Math.max(1, parseInt(options.concurrency || process.env.LULU_JOB_CONCURRENCY || '2', 10) || 2);
    this.maxQueueSize = Math.max(0, parseInt(options.maxQueueSize || process.env.LULU_JOB_MAX_QUEUE || '100', 10) || 100);
    this.runningCount = 0;
    this.queue = [];
  }

  create(meta) {
    const id = 'job_' + uuidv4();
    const job = {
      id,
      type: meta.type,            // 'image' | 'video'
      platform: meta.platform,
      accountId: meta.accountId,
      prompt: meta.prompt,
      status: 'created',          // created | queued | running | done | error
      result: null,
      error: null,
      persisted: null,
      persistError: null,
      createdAt: Date.now()
    };
    this.jobs.set(id, job);
    return job;
  }

  // 后台执行：runner 是返回 Promise<results> 的函数；onResult 把 results 落库等
  run(job, runner, onResult) {
    const task = { job, runner, onResult };
    if (this.runningCount >= this.concurrency) {
      if (this.queue.length >= this.maxQueueSize) {
        job.status = 'rejected';
        job.error = 'queue_full';
        throw new Error('queue_full');
      }
      job.status = 'queued';
      this.queue.push(task);
      this.broadcast({ type: WS_EVENTS.JOB_QUEUED, data: { jobId: job.id, jobType: job.type, platform: job.platform, prompt: job.prompt } });
      return;
    }
    this._start(task);
  }

  _start({ job, runner, onResult }) {
    this.runningCount++;
    job.status = 'running';
    this.broadcast({ type: WS_EVENTS.JOB_START, data: { jobId: job.id, jobType: job.type, platform: job.platform, prompt: job.prompt } });
    Promise.resolve().then(() => runner((payload) => {
      // 回调有两种载荷：dola 原话回传 {reply}，或进度 {attempt,total,elapsedMs}
      if (payload && payload.reply) {
        this.broadcast({ type: WS_EVENTS.JOB_REPLY, data: { jobId: job.id, platform: job.platform, reply: payload.reply } });
        return;
      }
      const { attempt, total, elapsedMs } = payload || {};
      this.broadcast({ type: WS_EVENTS.JOB_PROGRESS, data: { jobId: job.id, platform: job.platform, attempt, total, elapsedMs } });
    })).then((results) => {
      job.status = 'done';
      job.result = results;
      job.persisted = null;
      job.persistError = null;

      this.broadcast({
        type: WS_EVENTS.JOB_DONE,
        data: {
          jobId: job.id, jobType: job.type, platform: job.platform, prompt: job.prompt,
          images: results.images || [], videos: results.videos || [],
          brief: results.brief || '', quota: results.quota,
          persisted: null,
          persistError: null
        }
      });

      Promise.resolve().then(async () => {
        job.persisted = true;
        job.persistError = null;
        if (onResult) await onResult(results);
      }).catch((e) => {
        job.persisted = false;
        job.persistError = e.message || String(e);
      }).finally(() => {
        this.scheduleCleanup(job.id);
      });
    }).catch((err) => {
      job.status = 'error';
      job.error = err.message;
      this.broadcast({ type: WS_EVENTS.JOB_ERROR, data: { jobId: job.id, platform: job.platform, prompt: job.prompt, error: err.message } });
      this.scheduleCleanup(job.id);
    }).finally(() => {
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drain();
    });
  }

  scheduleCleanup(id) {
    const timer = setTimeout(() => this.jobs.delete(id), 10 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  drain() {
    while (this.runningCount < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      this._start(next);
    }
  }

  get(id) { return this.jobs.get(id) || null; }
  list() { return [...this.jobs.values()]; }
}

module.exports = JobManager;
