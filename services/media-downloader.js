const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');

// 媒体下载器：把生成结果的无水印 CDN 链接（会过期）落到本地永久文件。
// 复用 generationService.httpRequest —— 它会按平台 proxy 自动走代理（dola 需要），
// 且返回的 url 本身已是去水印直链，所以下载源天然无水印。
class MediaDownloader {
  constructor(generationService, config) {
    this.gen = generationService;
    this.config = config || {};
  }

  // 当前生效的下载目录（每次读配置，支持运行时改目录）
  getDir() {
    const custom = this.config.storage && this.config.storage.downloadDir;
    return paths.resolveDownloadDir(custom);
  }

  isEnabled() {
    // 未配置 storage 时默认开启
    if (!this.config.storage) return true;
    return this.config.storage.autoDownload !== false;
  }

  // 从 content-type / URL 推断扩展名
  guessExt(type, url, contentType) {
    const ct = (contentType || '').toLowerCase();
    // 先看 content-type
    if (type === 'video') {
      if (ct.includes('webm')) return '.webm';
      if (ct.includes('quicktime')) return '.mov';
      if (ct.includes('mp4')) return '.mp4';
    } else {
      if (ct.includes('png')) return '.png';
      if (ct.includes('webp')) return '.webp';
      if (ct.includes('gif')) return '.gif';
      if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
    }
    // content-type 不明确：从 URL 路径取
    try {
      const p = new URL(url).pathname.toLowerCase();
      const m = p.match(/\.(mp4|webm|mov|png|webp|gif|jpe?g)(?:$|[^a-z])/);
      if (m) return '.' + m[1].replace('jpeg', 'jpg');
    } catch (e) {}
    return type === 'video' ? '.mp4' : '.jpg';
  }

  // 是否已是本地标识（不需要再下）
  isLocal(url) {
    return typeof url === 'string' && url.startsWith('local://');
  }

  // 下载单个 url 到本地，返回 local://文件名；失败返回原 url（降级兜底，不阻塞）
  async downloadOne(url, { platform, accountId, type }) {
    if (!url || this.isLocal(url)) return url;
    try {
      // 借平台代理：构造一个最小 account 形态供 httpRequest 取 proxy
      const account = { platform: platform || 'doubao', id: accountId || '' };
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': platform === 'dola' ? 'https://www.dola.com/' : 'https://www.doubao.com/'
      };
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const rand = crypto.randomBytes(4).toString('hex');
      const dir = this.getDir();

      if (typeof this.gen.downloadToFile === 'function') {
        const provisional = path.join(dir, `${platform || 'doubao'}_${type || 'media'}_${stamp}_${rand}.download`);
        const res = await this.gen.downloadToFile(url, provisional, headers, account);
        if (!res || (res.status && res.status >= 400)) {
          try { if (fs.existsSync(provisional)) fs.unlinkSync(provisional); } catch (e) {}
          return url;
        }
        const ext = this.guessExt(type, url, (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '');
        const fname = `${platform || 'doubao'}_${type || 'media'}_${stamp}_${rand}${ext}`;
        const finalPath = path.join(dir, fname);
        fs.renameSync(provisional, finalPath);
        return 'local://' + fname;
      }

      const res = await this.gen.httpRequest(url, 'GET', null, headers, account);
      if (!res || (res.status && res.status >= 400) || !res.buffer || res.buffer.length === 0) {
        return url; // 拉取失败：保留原链接
      }
      const ext = this.guessExt(type, url, (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '');
      const fname = `${platform || 'doubao'}_${type || 'media'}_${stamp}_${rand}${ext}`;
      fs.writeFileSync(path.join(dir, fname), res.buffer);
      return 'local://' + fname;
    } catch (e) {
      return url; // 任何异常都降级保留原链接
    }
  }

  // 批量下载一组 url（生成结果通常是 1~4 个）。返回新 url 数组（本地或原始）。
  async downloadUrls(urls, meta) {
    if (!Array.isArray(urls) || urls.length === 0) return urls || [];
    if (!this.isEnabled()) return urls;
    const out = [];
    for (const u of urls) {
      out.push(await this.downloadOne(u, meta));
    }
    return out;
  }
}

module.exports = MediaDownloader;
