export const MAX_STATUS_LOG_ITEMS = 200;

export function appendStatusLog(items = [], entry = {}, now = Date.now()) {
  const text = String(entry.text || '').trim();
  if (!text) return items || [];
  const item = {
    id: entry.id || `log_${now}_${Math.random().toString(36).slice(2, 8)}`,
    time: now,
    type: entry.type || 'ready',
    source: entry.source || 'status',
    text,
    meta: entry.meta || null,
  };
  return [...(items || []), item].slice(-MAX_STATUS_LOG_ITEMS);
}
