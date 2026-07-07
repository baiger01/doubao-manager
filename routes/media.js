const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const paths = require('../paths');
const router = express.Router();

const ALLOWED_IMAGE_HOSTS = [
  /(^|\.)byteimg\.com$/i,
  /(^|\.)ibyteimg\.com$/i,
  /(^|\.)ciciai\.com$/i,
  /(^|\.)douyinpic\.com$/i,
  /(^|\.)hello4am\.com$/i
];

function isAllowedImageUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return ALLOWED_IMAGE_HOSTS.some((pattern) => pattern.test(parsed.hostname));
}

function fetchImage(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) {
      reject(new Error('图片重定向次数过多'));
      return;
    }
    const parsed = new URL(rawUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.doubao.com/'
      }
    }, (upstream) => {
      const location = upstream.headers.location;
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && location) {
        upstream.resume();
        const nextUrl = new URL(location, parsed).toString();
        fetchImage(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (upstream.statusCode !== 200) {
        upstream.resume();
        reject(new Error(`图片上游返回 HTTP ${upstream.statusCode}`));
        return;
      }
      resolve(upstream);
    });
    req.on('timeout', () => req.destroy(new Error('图片代理请求超时')));
    req.on('error', reject);
  });
}

function isHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (e) {
    return false;
  }
}

function isMediaContentType(contentType, rawUrl) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/') || ct.startsWith('video/')) return true;
  if (ct.includes('application/octet-stream') || !ct) {
    return /\.(png|jpe?g|webp|gif|avif|bmp|mp4|mov|webm)(?:$|[?#])/i.test(String(rawUrl || ''));
  }
  return false;
}

// API 图片渠道的上游 CDN 不固定，保存/下载时不再按域名拦截，而是按 HTTP 状态 + 媒体 content-type 校验。
function fetchRemoteMedia(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (!isHttpUrl(rawUrl)) {
      reject(new Error('不支持的媒体地址'));
      return;
    }
    if (redirectCount > 3) {
      reject(new Error('媒体重定向次数过多'));
      return;
    }
    const parsed = new URL(rawUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.get(parsed, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/mp4,video/webm,video/*,*/*;q=0.8'
      }
    }, (upstream) => {
      const location = upstream.headers.location;
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && location) {
        upstream.resume();
        const nextUrl = new URL(location, parsed).toString();
        fetchRemoteMedia(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (upstream.statusCode !== 200) {
        upstream.resume();
        reject(new Error(`媒体上游返回 HTTP ${upstream.statusCode}`));
        return;
      }
      const type = upstream.headers['content-type'] || '';
      if (!isMediaContentType(type, rawUrl)) {
        upstream.resume();
        reject(new Error('上游返回的不是图片或视频'));
        return;
      }
      resolve(upstream);
    });
    req.on('timeout', () => req.destroy(new Error('媒体请求超时')));
    req.on('error', reject);
  });
}

router.get('/image', async (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!isAllowedImageUrl(rawUrl)) {
    res.status(400).json({ success: false, error: '不支持的图片地址' });
    return;
  }

  try {
    const upstream = await fetchImage(rawUrl);
    const type = upstream.headers['content-type'] || 'image/png';
    const length = upstream.headers['content-length'];
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (length) res.setHeader('Content-Length', length);
    upstream.pipe(res);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// 从 URL 推断下载文件名;失败则用默认名 + 推断的扩展名
function guessFilename(rawUrl, fallbackBase, contentType) {
  try {
    const u = new URL(rawUrl);
    const last = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (last && /\.[A-Za-z0-9]{2,5}$/.test(last)) return last;
  } catch (e) { /* ignore */ }
  let ext = '';
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) ext = '.png';
  else if (ct.includes('webp')) ext = '.webp';
  else if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
  else if (ct.includes('gif')) ext = '.gif';
  else if (ct.includes('mp4')) ext = '.mp4';
  return fallbackBase + ext;
}

// 把文件名编码进 Content-Disposition(兼容中文,用 RFC5987 filename*)
function attachmentHeader(filename) {
  const safeAscii = String(filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const enc = encodeURIComponent(filename);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${enc}`;
}

function sanitizeFilename(filename, fallback = 'lulu-media') {
  const base = path.basename(String(filename || fallback));
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function uniqueFilename(dir, filename) {
  const safe = sanitizeFilename(filename);
  const parsed = path.parse(safe);
  let candidate = safe;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${parsed.name}-${i++}${parsed.ext}`;
  }
  return candidate;
}

function resolveWritableDir(rawDir, fallbackDir) {
  const dir = String(rawDir || '').trim()
    ? path.resolve(String(rawDir || '').trim())
    : paths.resolveDownloadDir(fallbackDir);
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error('下载路径不是文件夹');
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    throw new Error('下载路径不可写');
  }
  return dir;
}

// GET /api/media/download?url=远程CDN地址  或  ?f=本地文件名
// 强制以附件形式下载(浏览器/webview 弹保存对话框)。CDN 图走代理白名单,本地文件走下载目录。
router.get('/download', async (req, res) => {
  const localFile = String(req.query.f || '');
  const rawUrl = String(req.query.url || '');

  // 1) 本地已下载文件
  if (localFile) {
    if (/[\\/]/.test(localFile) || localFile.includes('..') || !/^[A-Za-z0-9._-]+$/.test(localFile)) {
      return res.status(400).json({ success: false, error: '非法文件名' });
    }
    const dir = paths.resolveDownloadDir(req.app.locals.downloadDir);
    const full = path.join(dir, localFile);
    if (path.dirname(full) !== path.resolve(dir)) {
      return res.status(400).json({ success: false, error: '非法路径' });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ success: false, error: '文件不存在' });
    }
    res.setHeader('Content-Disposition', attachmentHeader(localFile));
    return res.sendFile(full);
  }

  // 2) 远程媒体：API 图片渠道的 CDN 不固定，按 content-type 校验而不是按域名拦截。
  if (!isHttpUrl(rawUrl)) {
    return res.status(400).json({ success: false, error: '不支持的下载地址' });
  }
  try {
    const upstream = await fetchRemoteMedia(rawUrl);
    const type = upstream.headers['content-type'] || 'application/octet-stream';
    const length = upstream.headers['content-length'];
    const name = sanitizeFilename(guessFilename(rawUrl, 'lulu-' + Date.now(), type));
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', attachmentHeader(name));
    if (length) res.setHeader('Content-Length', length);
    upstream.pipe(res);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// GET /api/media/save?url=远程媒体地址 或 ?f=本地文件名
// 直接保存到应用设置的下载目录，避开浏览器/Electron 下载链路的静默失败。
router.get('/save', async (req, res) => {
  const localFile = String(req.query.f || '');
  const rawUrl = String(req.query.url || '');
  let dir;
  try {
    dir = resolveWritableDir(req.query.dir, req.app.locals.downloadDir);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  if (localFile) {
    if (/[\\/]/.test(localFile) || localFile.includes('..') || !/^[A-Za-z0-9._-]+$/.test(localFile)) {
      return res.status(400).json({ success: false, error: '非法文件名' });
    }
    const sourceDir = paths.resolveDownloadDir(req.app.locals.downloadDir);
    const full = path.join(sourceDir, localFile);
    if (path.dirname(full) !== path.resolve(sourceDir)) {
      return res.status(400).json({ success: false, error: '非法路径' });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ success: false, error: '文件不存在' });
    }
    if (path.resolve(dir) === path.resolve(sourceDir)) {
      return res.json({ success: true, data: { file: localFile, path: full, alreadyLocal: true } });
    }
    const name = uniqueFilename(dir, localFile);
    const target = path.join(dir, name);
    fs.copyFileSync(full, target);
    return res.json({ success: true, data: { file: name, path: target, alreadyLocal: false, copied: true } });
  }

  if (!isHttpUrl(rawUrl)) {
    return res.status(400).json({ success: false, error: '不支持的保存地址' });
  }

  try {
    const upstream = await fetchRemoteMedia(rawUrl);
    const type = upstream.headers['content-type'] || 'application/octet-stream';
    const name = uniqueFilename(dir, guessFilename(rawUrl, 'lulu-' + Date.now(), type));
    const full = path.join(dir, name);
    await pipeline(upstream, fs.createWriteStream(full));
    return res.json({ success: true, data: { file: name, path: full, contentType: type } });
  } catch (e) {
    return res.status(502).json({ success: false, error: e.message });
  }
});

// GET /api/media/local?f=文件名 - 读取已下载到本地的媒体文件
// 安全：只允许纯文件名（拒绝路径分隔符/穿越），从当前下载目录读取。
router.get('/local', (req, res) => {
  const f = String(req.query.f || '');
  // 文件名白名单：字母数字、下划线、连字符、点；且不含路径分隔与 ..
  if (!f || /[\\/]/.test(f) || f.includes('..') || !/^[A-Za-z0-9._-]+$/.test(f)) {
    return res.status(400).json({ success: false, error: '非法文件名' });
  }
  const dir = paths.resolveDownloadDir(req.app.locals.downloadDir);
  const full = path.join(dir, f);
  // 二次校验：解析后路径必须仍在下载目录内
  if (path.dirname(full) !== path.resolve(dir)) {
    return res.status(400).json({ success: false, error: '非法路径' });
  }
  if (!fs.existsSync(full)) {
    return res.status(404).json({ success: false, error: '文件不存在' });
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full);
});

module.exports = router;
