const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../paths');
const { readJsonFile, atomicWriteJsonFile } = require('./json-store');

// 对外 API 访问管理:供外部 AI IDE / agent 通过 token 调用本软件能力。
// 配置持久化到 {dataRoot}/config/api-access.json,与卡密/业务数据解耦。
class ApiTokenManager {
  constructor() {
    this.file = path.join(paths.dataRoot, 'config', 'api-access.json');
    this.data = { enabled: false, token: '', createdAt: null, lastUsedAt: null };
    // lastUsedAt 落盘节流:内存即时更新,最多每 60 秒写一次盘,避免高频调用同步 I/O 拖慢主线程
    this._lastUsedPersistMs = 0;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = readJsonFile(this.file, this.data, { fs });
        this.data = { enabled: false, token: '', createdAt: null, lastUsedAt: null, ...parsed };
      }
    } catch (e) {
      console.error('加载对外 API 配置失败:', e.message);
    }
    // 首次没有 token 时生成一个(不自动开启)
    if (!this.data.token) {
      this.data.token = this._genToken();
      this.data.createdAt = new Date().toISOString();
      this.save();
    }
    return this.data;
  }

  save() {
    try {
      atomicWriteJsonFile(this.file, this.data, { fs });
    } catch (e) {
      console.error('保存对外 API 配置失败:', e.message);
    }
  }

  _genToken() {
    return 'lulu_' + crypto.randomBytes(24).toString('hex');
  }

  getConfig() {
    return { ...this.data };
  }

  isEnabled() {
    return this.data.enabled === true;
  }

  setEnabled(flag) {
    this.data.enabled = !!flag;
    this.save();
    return this.getConfig();
  }

  regenerateToken() {
    this.data.token = this._genToken();
    this.data.createdAt = new Date().toISOString();
    this.data.lastUsedAt = null;
    this.save();
    return this.getConfig();
  }

  // 校验 token(timingSafe 防时序攻击);通过则更新 lastUsedAt
  verify(token) {
    if (!token || !this.data.token) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(this.data.token);
    if (a.length !== b.length) return false;
    let ok = false;
    try { ok = crypto.timingSafeEqual(a, b); } catch (e) { ok = false; }
    if (ok) {
      this.data.lastUsedAt = new Date().toISOString();
      // 落盘节流:lastUsedAt 内存即时更新,最多每 60 秒写一次,避免高频校验同步 I/O 阻塞
      const now = Date.now();
      if (now - this._lastUsedPersistMs >= 60 * 1000) {
        this._lastUsedPersistMs = now;
        try { this.save(); } catch (e) {}
      }
    }
    return ok;
  }
}

module.exports = ApiTokenManager;
