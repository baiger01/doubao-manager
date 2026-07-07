export function jobMatchesConversation(job, conversationId) {
  if (!job) return false;
  if (!job.conversationId) return false;
  return job.conversationId === conversationId;
}

export function pendingJobToBatch(jobId, job, now = Date.now()) {
  const mode = job.mode || 'image';
  const requestedCount = Number.parseInt(job.count, 10);
  const count = Number.isFinite(requestedCount)
    ? Math.min(4, Math.max(1, requestedCount))
    : (mode === 'video' ? 1 : 4);
  return {
    id: jobId,
    kind: 'generating',
    mode,
    ratio: job.ratioStr || '1:1',
    count,
    elapsed: Math.max(0, Math.floor((now - (job.startTime || now)) / 1000)),
    reply: job.reply || '',
    snapshot: job.snapshot,
    conversationId: job.conversationId || ''
  };
}

export function withConversationPendingBatches(historyBatches, pendingJobs, conversationId, now = Date.now()) {
  const runtime = Object.entries(pendingJobs || {})
    .filter(([, job]) => jobMatchesConversation(job, conversationId))
    .sort((a, b) => (a[1].startTime || 0) - (b[1].startTime || 0))
    .map(([jobId, job]) => pendingJobToBatch(jobId, job, now));
  return [...(historyBatches || []), ...runtime];
}

export function appendPendingBatchIfActive(batches, jobId, job, activeConversationId, now = Date.now()) {
  if (!jobMatchesConversation(job, activeConversationId)) return batches || [];
  return [...(batches || []), pendingJobToBatch(jobId, job, now)];
}

export function mergeRuntimeIntoHistory(historyBatches, pendingJobs, conversationId, now = Date.now()) {
  return withConversationPendingBatches(historyBatches, pendingJobs, conversationId, now);
}
