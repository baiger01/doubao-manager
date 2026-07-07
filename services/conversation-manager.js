const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const paths = require('../paths');
const { readJsonFile, atomicWriteJsonFile } = require('./json-store');

class ConversationManager {
  constructor(config) {
    this.filePath = paths.conversationsFile;
    this.data = { conversations: [], activeConversationId: null, activeByPlatform: {}, activeByAccount: {} }; // activeByAccount 仅为历史兼容保留
  }

  init() {
    this.data = readJsonFile(this.filePath, {
      conversations: [],
      activeConversationId: null,
      activeByPlatform: {},
      activeByAccount: {}
    }, { fs });
    // 兼容旧数据：补 platform 字段（旧会话默认 doubao）+ activeByPlatform 映射。
    // 会话现已是平台作用域，accountId/activeByAccount 仅作为旧文件形状兼容，不再承载语义。
    if (!this.data.activeByPlatform) this.data.activeByPlatform = {};
    if (!this.data.activeByAccount) this.data.activeByAccount = {};
    let changed = false;
    for (const c of this.data.conversations) {
      if (!c.platform) { c.platform = 'doubao'; changed = true; }
      if (c.accountId) {
        c.accountId = '';
        c.doubaoConversationId = '';
        c.sectionId = '';
        c.lastMessageIndex = 0;
        changed = true;
      }
    }
    if (this.data.activeConversationId) {
      const act = this.data.conversations.find(c => c.id === this.data.activeConversationId);
      if (act && !this.data.activeByPlatform[act.platform]) {
        this.data.activeByPlatform[act.platform] = act.id;
        changed = true;
      }
    }
    if (Object.keys(this.data.activeByAccount || {}).length > 0) {
      this.data.activeByAccount = {};
      changed = true;
    }
    if (changed) this.save();
    // 历史数据迁移：把按账号炸开的多条会话按平台合并成一条
    this.migrateToPlatformScope();
  }

  // 一次性迁移：会话归类维度从「账号」改为「平台」。
  // 旧逻辑下每个 dola 小号各建一条「默认会话」，这里合并为每平台一条。
  migrateToPlatformScope() {
    const byPlatform = {};
    for (const c of this.data.conversations) {
      const p = c.platform || 'doubao';
      (byPlatform[p] = byPlatform[p] || []).push(c);
    }
    let needMerge = false;
    for (const p of Object.keys(byPlatform)) {
      if (byPlatform[p].length > 1) { needMerge = true; break; }
    }
    if (!needMerge) return;

    // 备份原始数据（仅备份一次）；备份失败时停止迁移，避免破坏性覆盖后无恢复点。
    try {
      const bak = this.filePath + '.premerge.bak';
      if (!fs.existsSync(bak) && fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, bak);
      }
    } catch (e) {
      return;
    }

    const merged = [];
    for (const p of Object.keys(byPlatform)) {
      const group = byPlatform[p];
      // 主会话：优先有 doubaoConversationId 的，其次 results 最多的
      group.sort((a, b) => {
        const am = a.doubaoConversationId ? 1 : 0;
        const bm = b.doubaoConversationId ? 1 : 0;
        if (am !== bm) return bm - am;
        return (b.results?.length || 0) - (a.results?.length || 0);
      });
      const primary = group[0];
      // 合并其它会话的 results，按时间排序
      const allResults = [];
      for (const c of group) {
        if (Array.isArray(c.results)) allResults.push(...c.results);
      }
      allResults.sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
      primary.results = allResults;
      primary.messageCount = group.reduce((s, c) => s + (c.messageCount || 0), 0);
      primary.name = '默认会话';
      primary.accountId = '';
      // 平台会话桶跨账号共享，不能保留任何单账号的服务端会话 ID，
      // 否则历史遗留代码若读到会导致多账号生成串号。服务端状态一律按账号从 session 取。
      primary.doubaoConversationId = '';
      primary.sectionId = '';
      primary.lastMessageIndex = 0;
      merged.push(primary);
    }

    this.data.conversations = merged;
    // 重建活跃映射
    this.data.activeByPlatform = {};
    for (const c of merged) {
      this.data.activeByPlatform[c.platform || 'doubao'] = c.id;
    }
    this.data.activeByAccount = {};
    this.data.activeConversationId = merged[0]?.id || null;
    this.save();
  }

  save() {
    atomicWriteJsonFile(this.filePath, this.data, { fs });
  }

  getScopeKey(platform, accountId) {
    return `${platform || 'doubao'}:${accountId || ''}`;
  }

  matchesScope(conv, platform, accountId) {
    // 会话按平台归类，不再按账号细分（账号是后台轮换的额度资源，
    // 多个小号不应在 UI 里拆成多条「默认会话」）
    if (platform && (conv.platform || 'doubao') !== platform) return false;
    return true;
  }

  getAll(platform, accountId) {
    let list = this.data.conversations;
    if (platform) list = list.filter(c => (c.platform || 'doubao') === platform);
    return list.map(c => ({
      ...c,
      platform: c.platform || 'doubao',
      accountId: c.accountId || '',
      isActive: c.id === this.data.activeByPlatform[c.platform || 'doubao']
    }));
  }

  getById(id) {
    return this.data.conversations.find(c => c.id === id) || null;
  }

  // 获取当前活跃会话。会话按平台归类，accountId 仅作兼容参数（已忽略）。
  getActive(platform, accountId) {
    if (platform) {
      const activeId = this.data.activeByPlatform[platform];
      if (activeId) {
        const c = this.data.conversations.find(x => x.id === activeId && (x.platform || 'doubao') === platform);
        if (c) return c;
      }
      // 自动选该平台第一个会话
      const first = this.data.conversations.find(c => (c.platform || 'doubao') === platform);
      if (first) {
        this.data.activeByPlatform[platform] = first.id;
        this.save();
      }
      return first || null;
    }
    // 全局兜底（向后兼容）
    if (!this.data.activeConversationId && this.data.conversations.length > 0) {
      this.data.activeConversationId = this.data.conversations[0].id;
      this.save();
    }
    return this.data.conversations.find(c => c.id === this.data.activeConversationId) || null;
  }

  // 确保指定平台启动时总有一个可打开的会话。
  ensureActive(platform = 'doubao', accountId = '') {
    const active = this.getActive(platform);
    if (active) return active;
    // 没有现存会话，自动创建一个默认会话
    return this.create('默认会话', platform, '');
  }

  setActive(id) {
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) throw new Error('会话不存在');
    this.data.activeConversationId = id;
    this.data.activeByPlatform[conv.platform || 'doubao'] = id;
    this.data.activeByAccount = {};
    this.save();
    return conv;
  }

  // 新建会话（平台作用域；初始没有 doubao conversation_id，第一次发消息时会自动创建）
  create(name, platform = 'doubao', accountId = '') {
    const sameP = this.data.conversations.filter(c => this.matchesScope(c, platform, ''));
    const conv = {
      id: uuidv4(),
      name: name || `会话 ${sameP.length + 1}`,
      platform,
      accountId: '',
      createdAt: new Date().toISOString(),
      doubaoConversationId: '',
      sectionId: '',
      lastMessageIndex: 0,
      messageCount: 0,
      results: []  // 存储生成结果 [{prompt, type, urls, time}]
    };
    this.data.conversations.push(conv);
    this.data.activeConversationId = conv.id;
    this.data.activeByPlatform[platform] = conv.id;
    this.data.activeByAccount = {};
    this.save();
    return conv;
  }

  // 添加生成结果到当前会话
  addResult(id, result) {
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) return;
    if (!conv.results) conv.results = [];
    conv.results.push({
      prompt: result.prompt,
      type: result.type,
      platform: result.platform || conv.platform || 'doubao',
      urls: result.urls || [],
      brief: result.brief || '',
      time: new Date().toISOString()
    });
    this.save();
  }

  // 获取会话的所有生成结果
  getResults(id) {
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) return [];
    return conv.results || [];
  }

  // 更新doubao侧的会话元数据（从SSE_ACK响应中获取）
  updateDoubaoMeta(id, meta) {
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) return;
    if (meta.conversationId) conv.doubaoConversationId = meta.conversationId;
    if (meta.sectionId) conv.sectionId = meta.sectionId;
    if (meta.lastMessageIndex !== undefined) conv.lastMessageIndex = meta.lastMessageIndex;
    if (meta.messageCount !== undefined) conv.messageCount = meta.messageCount;
    this.save();
  }

  // 重命名
  rename(id, name) {
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) throw new Error('会话不存在');
    conv.name = name;
    this.save();
    return conv;
  }

  // 删除
  remove(id) {
    const idx = this.data.conversations.findIndex(c => c.id === id);
    if (idx === -1) throw new Error('会话不存在');
    const removed = this.data.conversations[idx];
    const platform = removed.platform || 'doubao';
    const accountId = removed.accountId || '';
    this.data.conversations.splice(idx, 1);
    // 该平台活跃会话被删，切到同平台下一个
    if (this.data.activeByPlatform[platform] === id) {
      const next = this.data.conversations.find(c => (c.platform || 'doubao') === platform);
      if (next) this.data.activeByPlatform[platform] = next.id;
      else delete this.data.activeByPlatform[platform];
    }
    this.data.activeByAccount = {};
    if (this.data.activeConversationId === id) {
      this.data.activeConversationId = this.data.conversations[0]?.id || null;
    }
    this.save();
  }

  // 账号删除策略：保留平台级历史结果，但移除该账号的兼容绑定。
  // 不级联删除 conversations/results，避免删除账号时误删用户生成历史。
  detachAccount(accountId) {
    const target = String(accountId || '').trim();
    if (!target) return false;

    let changed = false;
    for (const conv of this.data.conversations) {
      if ((conv.accountId || '') !== target) continue;
      conv.accountId = '';
      // 这些服务端会话游标来自单账号登录态；账号删除后不能继续复用。
      conv.doubaoConversationId = '';
      conv.sectionId = '';
      conv.lastMessageIndex = 0;
      changed = true;
    }

    if (Object.keys(this.data.activeByAccount || {}).length > 0) {
      this.data.activeByAccount = {};
      changed = true;
    }

    if (changed) this.save();
    return changed;
  }

  detachAccounts(accountIds) {
    let changed = false;
    for (const id of accountIds || []) {
      changed = this.detachAccount(id) || changed;
    }
    return changed;
  }

  // 清空所有
  clear() {
    this.data.conversations = [];
    this.data.activeConversationId = null;
    this.data.activeByPlatform = {};
    this.data.activeByAccount = {};
    this.save();
  }
}

module.exports = ConversationManager;
