const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const paths = require('../paths');
const { readJsonFile, atomicWriteJsonFile } = require('./json-store');

class AccountManager {
  constructor(config) {
    this.config = config || {};
    this.filePath = paths.accountsFile;
    // activeByPlatform: 每个平台各记一个当前活跃账号；activeAccountId 保留作全局兜底/向后兼容
    this.data = { accounts: [], activeAccountId: null, activeByPlatform: {} };
  }

  normalizeAccount(account) {
    if (!account.session) account.session = {};
    if (!account.browser) account.browser = {};
    if (!account.profileDir && account.id) {
      account.profileDir = path.join(paths.profilesDir, account.id);
    }
    if (!account.browser.profileDir && account.profileDir) {
      account.browser.profileDir = account.profileDir;
    }
    if (!account.browser.lastChromePath) account.browser.lastChromePath = '';
    if (!account.browser.lastChromeVersion) account.browser.lastChromeVersion = '';
    return account;
  }

  hasPersistedProfile(account) {
    const profileDir = account?.browser?.profileDir || account?.profileDir || (account?.id ? path.join(paths.profilesDir, account.id) : '');
    return !!(profileDir && fs.existsSync(profileDir));
  }

  // 取某平台的配置（默认 doubao）
  getPlatformConfig(platform) {
    const platforms = this.config.platforms || {};
    return platforms[platform] || platforms.doubao || {};
  }

  // 初始化，从文件加载
  init() {
    this.data = readJsonFile(this.filePath, { accounts: [], activeAccountId: null, activeByPlatform: {} }, { fs });
    // 兼容旧数据：补齐 platform 字段（旧账号默认 doubao）与 activeByPlatform 映射
    if (!this.data.activeByPlatform) this.data.activeByPlatform = {};
    let changed = false;

    // 清理空壳账号：添加账号时会先建记录，若用户中途取消/未完成登录，会留下无 cookies 的空壳。
    // 服务启动时不可能有登录进行中，故此时所有无 cookies 的账号都是废弃空壳，直接清掉。
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts
      .map(a => this.normalizeAccount(a))
      .filter(a => (a.session && a.session.cookies) || this.hasPersistedProfile(a));
    if (this.data.accounts.length !== before) changed = true;

    for (const a of this.data.accounts) {
      if (!a.platform) { a.platform = 'doubao'; changed = true; }
      if (!a.browser?.profileDir || !a.profileDir) {
        this.normalizeAccount(a);
        changed = true;
      }
    }
    // 旧的全局 activeAccountId 迁移到对应平台
    if (this.data.activeAccountId) {
      const act = this.data.accounts.find(a => a.id === this.data.activeAccountId);
      if (act && !this.data.activeByPlatform[act.platform]) {
        this.data.activeByPlatform[act.platform] = act.id;
        changed = true;
      }
    }
    // activeByPlatform 指向已被清理的账号时，重新选该平台第一个可用
    for (const [plat, id] of Object.entries(this.data.activeByPlatform)) {
      if (!this.data.accounts.find(a => a.id === id)) {
        const next = this.data.accounts.find(a => (a.platform || 'doubao') === plat);
        if (next) this.data.activeByPlatform[plat] = next.id;
        else { delete this.data.activeByPlatform[plat]; }
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // 保存到文件
  save() {
    atomicWriteJsonFile(this.filePath, this.data, { fs });
  }

  // 获取所有账号
  getAll() {
    return this.data.accounts.map(a => ({
      ...a,
      platform: a.platform || 'doubao',
      isActive: a.id === this.data.activeByPlatform[a.platform || 'doubao']
    }));
  }

  // 按平台获取账号
  getAllByPlatform(platform) {
    return this.getAll().filter(a => a.platform === platform);
  }

  // 获取单个账号
  getById(id) {
    return this.data.accounts.find(a => a.id === id) || null;
  }

  // 获取某平台当前活跃账号
  getActiveByPlatform(platform) {
    const activeId = this.data.activeByPlatform[platform];
    if (activeId) {
      const acc = this.getById(activeId);
      if (acc && (acc.platform || 'doubao') === platform) return acc;
    }
    // 自动选该平台第一个可用账号
    const available = this.data.accounts.find(
      a => (a.platform || 'doubao') === platform && a.status === 'active'
    );
    if (available) {
      this.data.activeByPlatform[platform] = available.id;
      this.save();
    }
    return available || null;
  }

  // 设置某平台活跃账号
  setActiveByPlatform(platform, id) {
    const account = this.getById(id);
    if (!account) throw new Error('账号不存在');
    this.data.activeByPlatform[platform] = id;
    // 同步全局兜底
    this.data.activeAccountId = id;
    this.save();
    return account;
  }

  // 获取当前活跃账号（全局兜底，向后兼容；优先返回 doubao 平台活跃账号）
  getActive() {
    if (this.data.activeAccountId) {
      const acc = this.getById(this.data.activeAccountId);
      if (acc) return acc;
    }
    // 兜底：任意平台第一个可用
    const available = this.data.accounts.find(a => a.status === 'active');
    if (available) {
      this.data.activeAccountId = available.id;
      this.save();
    }
    return available || null;
  }

  // 设置活跃账号（同时更新对应平台）
  setActive(id) {
    const account = this.getById(id);
    if (!account) throw new Error('账号不存在');
    this.data.activeAccountId = id;
    this.data.activeByPlatform[account.platform || 'doubao'] = id;
    this.save();
    return account;
  }

  // 添加账号
  add(accountData) {
    const platform = accountData.platform || 'doubao';
    const pc = this.getPlatformConfig(platform);
    const dp = pc.defaultParams || {};
    const account = {
      id: uuidv4(),
      name: accountData.name || '未命名账号',
      platform,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      session: {
        conversation_id: accountData.conversation_id || '',
        bot_id: accountData.bot_id || pc.botId || '7338286299411103781',
        section_id: accountData.section_id || '',
        device_id: accountData.device_id || '',
        web_id: accountData.web_id || '',
        user_id: accountData.user_id || '',
        aid: accountData.aid || dp.aid || '497858',
        fp: accountData.fp || '',
        cookies: accountData.cookies || ''
      },
      browser: {
        profileDir: accountData.browser?.profileDir || '',
        lastChromePath: accountData.browser?.lastChromePath || '',
        lastChromeVersion: accountData.browser?.lastChromeVersion || ''
      },
      profileDir: accountData.browser?.profileDir || '',
      quota: {
        imageRemaining: null,
        videoRemaining: null,
        lastChecked: null
      }
    };

    account.profileDir = account.profileDir || path.join(paths.profilesDir, account.id);
    account.browser.profileDir = account.browser.profileDir || account.profileDir;

    this.data.accounts.push(account);

    // 该平台首个账号自动激活
    if (!this.data.activeByPlatform[platform]) {
      this.data.activeByPlatform[platform] = account.id;
    }
    // 全局兜底
    if (!this.data.activeAccountId) {
      this.data.activeAccountId = account.id;
    }

    this.save();
    return account;
  }

  // 更新账号
  update(id, updates) {
    const index = this.data.accounts.findIndex(a => a.id === id);
    if (index === -1) throw new Error('账号不存在');

    const account = this.data.accounts[index];

    // 更新基础字段
    if (updates.name !== undefined) account.name = updates.name;
    if (updates.status !== undefined) account.status = updates.status;

    // 更新 session 字段
    if (updates.session) {
      Object.assign(account.session, updates.session);
    }
    if (updates.browser) {
      account.browser = account.browser || {};
      Object.assign(account.browser, updates.browser);
    }
    if (updates.profileDir !== undefined) account.profileDir = updates.profileDir;
    this.normalizeAccount(account);

    this.data.accounts[index] = account;
    this.save();
    return account;
  }

  // 删除账号
  remove(id) {
    const index = this.data.accounts.findIndex(a => a.id === id);
    if (index === -1) throw new Error('账号不存在');

    const removed = this.data.accounts[index];
    const platform = removed.platform || 'doubao';
    this.data.accounts.splice(index, 1);

    // 如果删的是该平台活跃账号，切到同平台下一个
    if (this.data.activeByPlatform[platform] === id) {
      const next = this.data.accounts.find(
        a => (a.platform || 'doubao') === platform && a.status === 'active'
      );
      this.data.activeByPlatform[platform] = next ? next.id : undefined;
      if (!next) delete this.data.activeByPlatform[platform];
    }
    // 全局兜底
    if (this.data.activeAccountId === id) {
      const next = this.data.accounts.find(a => a.status === 'active');
      this.data.activeAccountId = next ? next.id : null;
    }

    this.save();
  }

  // 按平台批量删除账号，返回被删除的账号 id 列表（供调用方关闭浏览器/清理 profile）
  removeByPlatform(platform) {
    const plat = platform || 'doubao';
    const removed = this.data.accounts.filter(a => (a.platform || 'doubao') === plat);
    const removedIds = removed.map(a => a.id);
    if (removedIds.length === 0) return removedIds;

    this.data.accounts = this.data.accounts.filter(a => (a.platform || 'doubao') !== plat);

    // 清理该平台的活跃记录
    delete this.data.activeByPlatform[plat];
    // 全局兜底若指向被删账号，重选任意可用账号
    if (this.data.activeAccountId && removedIds.includes(this.data.activeAccountId)) {
      const next = this.data.accounts.find(a => a.status === 'active');
      this.data.activeAccountId = next ? next.id : null;
    }

    this.save();
    return removedIds;
  }

  // 更新额度
  updateQuota(id, quotaData) {
    const account = this.getById(id);
    if (!account) return;

    if (quotaData.imageRemaining !== undefined) {
      account.quota.imageRemaining = quotaData.imageRemaining;
    }
    if (quotaData.videoRemaining !== undefined) {
      account.quota.videoRemaining = quotaData.videoRemaining;
    }
    account.quota.lastChecked = new Date().toISOString();
    this.save();
  }

  // 标记额度耗尽
  markExhausted(id) {
    this.update(id, { status: 'quota_exhausted' });
  }

  // 获取下一个可用账号（同平台，额度未耗尽）
  getNextAvailable(excludeId, platform) {
    return this.data.accounts.find(a =>
      a.id !== excludeId &&
      a.status === 'active' &&
      (!platform || (a.platform || 'doubao') === platform)
    ) || null;
  }

  // 自动切换到同平台下一个可用账号
  autoSwitch(platform) {
    const current = platform ? this.data.activeByPlatform[platform] : this.data.activeAccountId;
    const next = this.getNextAvailable(current, platform);
    if (next) {
      const p = next.platform || 'doubao';
      this.data.activeByPlatform[p] = next.id;
      this.data.activeAccountId = next.id;
      this.save();
      return next;
    }
    return null;
  }

  // 记录使用时间
  touchAccount(id) {
    const account = this.getById(id);
    if (account) {
      account.lastUsedAt = new Date().toISOString();
      this.save();
    }
  }
}

module.exports = AccountManager;
