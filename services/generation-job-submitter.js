const { WS_EVENTS } = require('./ws-events');

function hasQuota(results) {
  return results && results.quota !== null && results.quota !== undefined;
}

function submitGenerationJob({
  jobManager,
  broadcast,
  res,
  type,
  platform,
  accountId,
  prompt,
  execute,
  persistResult,
}) {
  const job = jobManager.create({ type, platform, accountId, prompt });
  res.json({ success: true, data: { jobId: job.id, status: 'submitted' } });

  jobManager.run(job, execute, (results) => {
    if (hasQuota(results) && typeof broadcast === 'function') {
      broadcast({ type: WS_EVENTS.QUOTA_UPDATE, data: { quota: results.quota, platform } });
    }
    if (typeof persistResult === 'function') return persistResult(results);
    return undefined;
  });

  return job;
}

module.exports = { submitGenerationJob, hasQuota };
