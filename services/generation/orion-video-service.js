const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const appPaths = require('../../paths');

function isOrionVideoConfig(config) {
  return !!(config && config.type === 'orion-local');
}

function resolveOrionEndpoint(videoApi = {}) {
  const endpoint = String(videoApi.endpoint || '').trim();
  if (endpoint) return endpoint;
  const baseUrl = String(videoApi.baseUrl || 'http://127.0.0.1:8787').trim().replace(/\/+$/, '');
  return `${baseUrl}/generate`;
}

function buildOrionGeneratePayload(videoApi = {}, prompt, options = {}) {
  const duration = parseInt(options.duration || videoApi.duration || 15, 10) || 15;
  const payload = {
    project_dir: String(videoApi.projectDir || videoApi.project_dir || '').trim(),
    images: Array.isArray(options.images) && options.images.length > 0
      ? options.images
      : (Array.isArray(videoApi.images) ? videoApi.images : []),
    duration,
    prompt: String(prompt || ''),
    poll: videoApi.poll !== false,
    poll_seconds: parseInt(videoApi.pollSeconds || videoApi.poll_seconds || 900, 10) || 900,
    poll_interval: parseInt(videoApi.pollInterval || videoApi.poll_interval || 10, 10) || 10,
    download: videoApi.download !== false
  };
  const outputDir = String(videoApi.outputDir || videoApi.output_dir || '').trim();
  if (outputDir) payload.output_dir = outputDir;
  const cookieFile = String(videoApi.cookieFile || videoApi.cookie_file || options.cookieFile || options.cookie_file || '').trim();
  if (cookieFile) payload.cookie_file = cookieFile;
  const cookie = String(videoApi.cookie || videoApi.cookieHeader || videoApi.cookie_header || options.cookie || options.cookieHeader || options.cookie_header || '').trim();
  if (cookie) payload.cookie = cookie;
  const params = String(videoApi.params || '').trim();
  if (params) payload.params = params;
  const reuseUploads = String(videoApi.reuseUploads || videoApi.reuse_uploads || '').trim();
  if (reuseUploads) payload.reuse_uploads = reuseUploads;
  const appVersion = String(videoApi.appVersion || videoApi.app_version || '').trim();
  if (appVersion) payload.app_version = appVersion;
  const timeout = parseInt(videoApi.timeout || 0, 10);
  if (timeout > 0) payload.timeout = timeout;
  return payload;
}

function parseJsonResponse(text, label = 'Orion API') {
  try {
    return JSON.parse(text || '{}');
  } catch (e) {
    throw new Error(`${label} 返回的不是 JSON: ${String(text || '').slice(0, 200)}`);
  }
}

function extractOrionErrorText(text) {
  let raw = String(text || '').trim();
  try {
    const json = JSON.parse(raw || '{}');
    raw = String(json.error || json.message || json.raw || raw).trim();
  } catch (_) {}
  const valueError = raw.match(/^[A-Za-z_]*Error\((['"])([\s\S]*)\1\)$/);
  if (valueError) raw = valueError[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
  return raw;
}

function isOrionLoginErrorText(value = '') {
  const text = String(value || '');
  const lower = text.toLowerCase();
  return (
    lower.includes('not logged in')
    || lower.includes('no cookies found')
    || lower.includes('no sessionid')
    || lower.includes('user not logged')
    || lower.includes('login required')
    || lower.includes('err_no\': 10010')
    || lower.includes('"err_no":10010')
    || text.includes('用户未登录')
    || text.includes('未登录')
    || text.includes('登录态')
    || lower.includes('cookie')
  );
}

function orionLoginGuidance() {
  return 'Orion 登录未完成：本地 API 没有有效抖音登录态。请打开「账号管理 → Orion」，先完成登录窗口里的手机确认/验证码登录，再点「回传登录态」；如果仍失败，用「手动 Cookie」保存后重试。';
}

function explainOrionGenerationError(status, text) {
  const raw = extractOrionErrorText(text);
  if (isOrionLoginErrorText(raw)) return orionLoginGuidance();
  return `Orion API HTTP ${status}: ${raw || String(text || '').slice(0, 300)}`;
}

function safeVideoExtension(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ['.mp4', '.mov', '.webm'].includes(ext) ? ext : '.mp4';
}

function copyOrionDownloadToLocal(downloadPath, config = {}, platform = 'orion') {
  const source = String(downloadPath || '').trim();
  if (!source) return '';
  if (!fs.existsSync(source)) return '';
  const dir = appPaths.resolveDownloadDir(config.storage && config.storage.downloadDir);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex');
  const safePlatform = String(platform || 'orion').replace(/[^a-z0-9_-]/gi, '') || 'orion';
  const fileName = `${safePlatform}_video_${stamp}_${rand}${safeVideoExtension(source)}`;
  fs.copyFileSync(source, path.join(dir, fileName));
  return 'local://' + fileName;
}

function parseOrionGenerateResult(json, options = {}) {
  if (!json || typeof json !== 'object') throw new Error('Orion API 返回空响应');
  if (json.ok === false || json.error) {
    const raw = json.error || json.message || 'Orion API 生成失败';
    if (isOrionLoginErrorText(raw)) throw new Error(orionLoginGuidance());
    throw new Error(raw);
  }
  const taskId = json.task_id || json.taskId || '';
  const videoUrl = json.video_result && (json.video_result.video_url || json.video_result.url);
  const localVideo = !videoUrl && json.download && json.download.path
    ? copyOrionDownloadToLocal(json.download.path, options.config || {}, options.platform || 'orion')
    : '';
  const videos = videoUrl ? [String(videoUrl)] : (localVideo ? [localVideo] : []);
  if (videos.length === 0) {
    throw new Error(taskId ? `Orion 任务 ${taskId} 未返回视频地址` : 'Orion API 未返回视频地址');
  }
  const briefParts = ['Orion'];
  if (taskId) briefParts.push(`task ${taskId}`);
  if (json.result_path) briefParts.push(`结果: ${json.result_path}`);
  return {
    images: [],
    videos,
    videoKeys: taskId ? [String(taskId)] : [],
    quota: null,
    brief: briefParts.join(' · '),
    raw: json
  };
}

module.exports = {
  isOrionVideoConfig,
  resolveOrionEndpoint,
  buildOrionGeneratePayload,
  parseJsonResponse,
  extractOrionErrorText,
  isOrionLoginErrorText,
  orionLoginGuidance,
  explainOrionGenerationError,
  parseOrionGenerateResult,
  copyOrionDownloadToLocal
};

