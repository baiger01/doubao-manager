const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const paths = require('../paths');
const { readJsonFile, atomicWriteJsonFile } = require('./json-store');

// _request 在这些情况下返回失败对象（而非 throw）：均属网络层/环境问题，
// 不是服务器对卡密的业务裁决，应走离线宽限期，绝不能据此撤销已验证状态。
const NETWORK_LEVEL_ERRORS = new Set(['network', 'timeout', 'no_server', 'invalid_response']);

class LicenseManager {
  constructor(config) {
    this.config = config;
    this.licenseFile = path.join(paths.dataRoot, 'config', 'license.json');
    this.licenseData = null;
    this.verified = false;
    this.recheckTimer = null;
    this.serverUrl = config.license?.serverUrl || '';
    this.graceHours = config.license?.graceHours || 24;
    this.recheckIntervalMs = config.license?.recheckIntervalMs || 3600000;
    this.onLicenseInvalid = null; // callback
    // 运行期状态(供 getStatus 展示;不持久化)
    this.offline = false;              // 当前是否处于离线宽限
    this.graceRemainingHours = null;   // 离线时剩余宽限小时
    this.consecutiveFailures = 0;      // 连续网络层失败次数(驱动分级心跳退避)
    // 分级心跳的快速重试退避梯度(网络层失败时使用),毫秒
    this.retryBackoffMs = [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
    // 硬件指纹缓存:运行期不变,首次计算后复用,避免每次校验同步跑 wmic 阻塞主线程
    this._fingerprintCache = null;
  }

  load() {
    try {
      if (fs.existsSync(this.licenseFile)) {
        this.licenseData = readJsonFile(this.licenseFile, null, { fs });
        // 乐观放行：本地已有有效卡密缓存（指纹匹配且未过期）时，启动即视为已验证，
        // 避免异步联网验证未完成时误拦已激活的正版用户。联网验证在后台纠错（失败再弹卡密）。
        if (this._isLocallyValid()) {
          this.verified = true;
        }
        return this.licenseData;
      }
    } catch (e) {
      console.error('加载卡密数据失败:', e.message);
    }
    this.licenseData = null;
    return null;
  }

  // 防系统时钟回拨:有效"当前时间"不能早于上次服务器确认时间(锚点),
  // 用户把系统时钟调回过去也无法让已到期卡密复活。
  _effectiveNow() {
    let now = Date.now();
    const anchor = this.licenseData?.lastServerTime ? new Date(this.licenseData.lastServerTime).getTime() : 0;
    if (anchor && now < anchor) now = anchor;
    return now;
  }

  // 本地快速校验（不联网）：普通卡密需指纹匹配且未过期
  _isLocallyValid() {
    const d = this.licenseData;
    if (!d || !d.key) return false;
    if (d.fingerprint !== this.getFingerprint()) return false;
    if (d.expiresAt && this._effectiveNow() >= new Date(d.expiresAt).getTime()) return false;
    return true;
  }

  save() {
    try {
      atomicWriteJsonFile(this.licenseFile, this.licenseData, { fs });
    } catch (e) {
      console.error('保存卡密数据失败:', e.message);
    }
  }

  // 硬件指纹：MAC + 磁盘序列号 + 用户名 → SHA256 前32位
  getFingerprint() {
    if (this._fingerprintCache) return this._fingerprintCache;
    const parts = [];

    // MAC 地址（第一块非内部网卡）
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const iface of nets[name]) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          parts.push(iface.mac);
          break;
        }
      }
      if (parts.length > 0) break;
    }

    // 磁盘序列号 (Windows)
    try {
      const raw = execSync('wmic diskdrive get serialnumber', {
        encoding: 'utf-8', timeout: 5000, windowsHide: true
      });
      const serial = raw.split('\n').map(s => s.trim()).filter(s => s && s !== 'SerialNumber')[0] || '';
      if (serial) parts.push(serial);
    } catch (e) {
      // fallback: hostname + cpu
      parts.push(os.hostname());
      const cpus = os.cpus();
      if (cpus.length > 0) parts.push(cpus[0].model);
    }

    // 用户名
    parts.push(os.userInfo().username);

    this._fingerprintCache = crypto.createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 32);
    return this._fingerprintCache;
  }

  // 激活卡密
  async activate(licenseKey) {
    const fingerprint = this.getFingerprint();

    const response = await this._request('/api/license/activate', {
      key: licenseKey,
      fingerprint,
      deviceInfo: {
        platform: process.platform,
        hostname: os.hostname(),
        arch: os.arch()
      }
    });

    if (response.success) {
      this.licenseData = {
        key: licenseKey,
        fingerprint,
        type: response.data.type,
        activatedAt: response.data.activatedAt,
        expiresAt: response.data.expiresAt,
        lastVerified: new Date().toISOString(),
        lastServerTime: response.data.serverTime
      };
      this.verified = true;
      this.save();
      this.startPeriodicCheck();
      return { success: true, data: this.licenseData };
    }
    // 网络层失败给更准确的提示（避免误导用户以为卡密无效）
    if (NETWORK_LEVEL_ERRORS.has(response.error)) {
      return { success: false, error: response.error, message: '无法连接验证服务器，请检查网络后重试' };
    }
    return { success: false, error: response.error || '激活失败', message: response.message || '激活失败' };
  }

  // 验证已有卡密
  async verify() {
    if (!this.licenseData || !this.licenseData.key) {
      this.verified = false;
      return { success: false, error: 'no_license', message: '未输入卡密' };
    }

    const fingerprint = this.getFingerprint();
    if (fingerprint !== this.licenseData.fingerprint) {
      this.verified = false;
      this.licenseData = null;
      this.save();
      return { success: false, error: 'fingerprint_mismatch', message: '硬件指纹不匹配，请重新激活' };
    }

    try {
      const response = await this._request('/api/license/verify', {
        key: this.licenseData.key,
        fingerprint
      });

      if (response.success) {
        this.licenseData.lastVerified = new Date().toISOString();
        this.licenseData.lastServerTime = response.data.serverTime;
        this.licenseData.expiresAt = response.data.expiresAt;
        this.licenseData.type = response.data.type || this.licenseData.type;
        // 记录本地时钟锚点(用于防系统时钟回拨):成功验证时的本地时间戳
        this.licenseData.lastVerifiedLocalMs = Date.now();
        this.verified = true;
        // 在线验证成功:清除离线态与失败计数
        this.offline = false;
        this.graceRemainingHours = null;
        this.consecutiveFailures = 0;
        this.save();
        return { success: true, data: this.licenseData };
      }

      // 区分网络层失败 vs 服务器明确拒绝：
      // _request 在网络异常/超时/未配置/响应非法时不会 throw，而是 resolve 失败对象。
      // 这类“非业务拒绝”应走离线宽限期，绝不能当成服务器拒绝而撤销验证。
      if (NETWORK_LEVEL_ERRORS.has(response.error)) {
        return this._applyGracePeriod();
      }

      // 服务器明确拒绝（expired / device_mismatch / disabled / invalid_key 等）
      this.verified = false;
      return { success: false, error: response.error, message: response.message || '验证失败' };
    } catch (e) {
      // 网络异常：宽限期
      return this._applyGracePeriod();
    }
  }

  _applyGracePeriod() {
    if (!this.licenseData || !this.licenseData.lastVerified) {
      this.verified = false;
      this.offline = true;
      this.graceRemainingHours = 0;
      return { success: false, error: 'offline_no_cache', message: '无法连接验证服务器' };
    }

    const lastCheck = new Date(this.licenseData.lastVerified).getTime();
    // 用防回拨的有效时间,并钳制非负:系统时钟被调回过去时,hoursElapsed 不会变负而无限延长宽限期
    const hoursElapsed = Math.max(0, (this._effectiveNow() - lastCheck) / (1000 * 60 * 60));

    if (hoursElapsed < this.graceHours) {
      this.verified = true;
      this.offline = true;
      this.graceRemainingHours = Math.ceil(this.graceHours - hoursElapsed);
      return { success: true, offline: true, graceRemaining: this.graceRemainingHours, data: this.licenseData };
    }

    this.verified = false;
    this.offline = true;
    this.graceRemainingHours = 0;
    return { success: false, error: 'grace_expired', message: `离线超过${this.graceHours}小时，请连接网络验证` };
  }

  // 定时复验:分级心跳。成功 → 正常间隔;网络层失败 → 快速重试退避(30s→1m→2m→5m),
  // 网络恢复后立即回到正常间隔,把离线宽限期的"消耗"降到最低。
  startPeriodicCheck() {
    this.stopPeriodicCheck();
    const tick = async () => {
      let delay = this.recheckIntervalMs;
      try {
        const result = await this.verify();
        if (result.success && !result.offline) {
          // 在线验证通过:正常间隔
          delay = this.recheckIntervalMs;
        } else if (result.success && result.offline) {
          // 处于离线宽限(网络层失败但仍放行):快速重试,尽快恢复在线锚点
          const idx = Math.min(this.consecutiveFailures, this.retryBackoffMs.length - 1);
          delay = this.retryBackoffMs[idx];
          this.consecutiveFailures++;
        } else {
          // 明确失败(服务器拒绝 / 宽限耗尽):通知前端弹门禁,之后慢节奏重试
          if (result.error !== 'offline_no_cache' && this.onLicenseInvalid) {
            this.onLicenseInvalid(result);
          }
          delay = this.recheckIntervalMs;
        }
      } catch (e) {
        delay = this.retryBackoffMs[Math.min(this.consecutiveFailures, this.retryBackoffMs.length - 1)];
        this.consecutiveFailures++;
      }
      this.recheckTimer = setTimeout(tick, delay);
    };
    this.recheckTimer = setTimeout(tick, this.recheckIntervalMs);
  }

  stopPeriodicCheck() {
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
  }

  isValid() {
    return this.verified === true;
  }

  getStatus() {
    const d = this.licenseData;
    const isPermanent = !!(d && !d.expiresAt);
    let daysRemaining = null;
    if (d && d.expiresAt) {
      const ms = new Date(d.expiresAt).getTime() - this._effectiveNow();
      daysRemaining = ms > 0 ? Math.ceil(ms / 86400000) : 0;
    }
    return {
      hasLicense: !!(d && d.key),
      verified: this.verified,
      type: d?.type || null,
      key: d?.key || null,
      activatedAt: d?.activatedAt || null,
      expiresAt: d?.expiresAt || null,
      lastVerified: d?.lastVerified || null,
      serverTime: d?.lastServerTime || null,
      offline: this.offline,
      graceRemainingHours: this.offline ? this.graceRemainingHours : null,
      daysRemaining,
      isPermanent
    };
  }

  clear() {
    this.licenseData = null;
    this.verified = false;
    this.stopPeriodicCheck();
    this.save();
  }

  async _request(endpoint, body) {
    if (!this.serverUrl || this.serverUrl === 'https://待填写') {
      return { success: false, error: 'no_server', message: '验证服务器未配置' };
    }
    const url = this.serverUrl + endpoint;
    const mod = url.startsWith('https') ? require('https') : require('http');

    return new Promise((resolve) => {
      const data = JSON.stringify(body);
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 10000
      };

      const req = mod.request(options, (res) => {
        let chunks = '';
        res.on('data', chunk => chunks += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); }
          catch (e) { resolve({ success: false, error: 'invalid_response' }); }
        });
      });
      req.on('error', (e) => resolve({ success: false, error: 'network', message: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
      req.write(data);
      req.end();
    });
  }
}

module.exports = LicenseManager;
