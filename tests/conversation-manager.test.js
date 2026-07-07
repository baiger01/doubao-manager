const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCommonJsModule(filePath, overrides = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const module = { exports: {} };
  const dirname = path.dirname(filePath);
  const filename = filePath;

  function localRequire(request) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) {
      return overrides[request];
    }
    if (request.startsWith('./') || request.startsWith('../')) {
      const resolved = require.resolve(path.resolve(dirname, request));
      return require(resolved);
    }
    return require(request);
  }

  const context = vm.createContext({
    module,
    exports: module.exports,
    require: localRequire,
    __dirname: dirname,
    __filename: filename,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    process: overrides.process || process
  });

  const wrapped = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
  const compiled = vm.runInContext(wrapped, context, { filename });
  compiled(module.exports, localRequire, module, filename, dirname);
  return module.exports;
}

function createManager(initialData) {
  const managerPath = path.resolve(__dirname, '..', 'services', 'conversation-manager.js');
  const writes = [];
  const fakeFs = {
    existsSync(target) {
      return target === 'D:\\RuntimeData\\data\\conversations.json' && !!initialData;
    },
    readFileSync() {
      return JSON.stringify(initialData);
    },
    mkdirSync() {},
    copyFileSync() {},
    writeFileSync(filePath, content) {
      writes.push({ filePath, content: JSON.parse(content) });
    }
  };
  const ConversationManager = loadCommonJsModule(managerPath, {
    fs: fakeFs,
    '../paths': {
      conversationsFile: 'D:\\RuntimeData\\data\\conversations.json'
    }
  });
  return { manager: new ConversationManager({}), writes };
}

test('conversations are grouped by platform regardless of account', () => {
  const { manager } = createManager();

  // 同平台下不同账号建会话：第二条会合并进同平台的会话列表，
  // getAll(platform) 返回该平台全部会话（账号参数被忽略）
  const c1 = manager.create('豆包会话1', 'doubao', 'acc-1');
  const c2 = manager.create('Dola会话', 'dola', 'acc-2');

  assert.equal(c1.accountId, '');
  assert.equal(c2.accountId, '');
  assert.deepEqual(Object.keys(manager.data.activeByAccount), []);

  // 按平台过滤：doubao 只返回 doubao 会话，账号参数不影响结果
  assert.equal(manager.getAll('doubao', 'acc-1').map(c => c.id).join(','), c1.id);
  assert.equal(manager.getAll('doubao', 'acc-2').map(c => c.id).join(','), c1.id);
  assert.equal(manager.getAll('dola', 'acc-1').map(c => c.id).join(','), c2.id);
  // 不传账号也是同样结果（按平台归类）
  assert.equal(manager.getActive('doubao').id, c1.id);
  assert.equal(manager.getActive('dola').id, c2.id);
});

test('active conversation is restored per platform after reload', () => {
  const { manager } = createManager({
    conversations: [
      { id: 'conv-1', name: '豆包会话', platform: 'doubao', accountId: 'acc-1', results: [] },
      { id: 'conv-2', name: 'Dola会话', platform: 'dola', accountId: 'acc-2', results: [] }
    ],
    activeConversationId: 'conv-2',
    activeByPlatform: { doubao: 'conv-1', dola: 'conv-2' },
    activeByAccount: {}
  });

  manager.init();

  // 按平台恢复活跃会话；传任意账号参数都不影响（已忽略）
  assert.equal(manager.getActive('doubao', 'acc-1').id, 'conv-1');
  assert.equal(manager.getActive('dola', 'acc-anything').id, 'conv-2');
  assert.equal(manager.getById('conv-1').accountId, '');
  assert.equal(manager.getById('conv-2').accountId, '');
  assert.deepEqual(Object.keys(manager.data.activeByAccount), []);
});

test('legacy per-account conversations are merged into one per platform on init', () => {
  // 旧数据：dola 平台有 3 个小号各建一条「默认会话」
  const { manager } = createManager({
    conversations: [
      { id: 'dola-a', name: '默认会话', platform: 'dola', accountId: 'acc-a', doubaoConversationId: 'cid-a', results: [{ prompt: 'p1', type: 'image', urls: ['u1'], time: '2026-06-01T00:00:00Z' }] },
      { id: 'dola-b', name: '默认会话', platform: 'dola', accountId: 'acc-b', results: [{ prompt: 'p2', type: 'video', urls: ['u2'], time: '2026-06-02T00:00:00Z' }] },
      { id: 'dola-c', name: '默认会话', platform: 'dola', accountId: 'acc-c', results: [] },
      { id: 'doubao-x', name: '默认会话', platform: 'doubao', accountId: 'acc-x', results: [] }
    ],
    activeConversationId: 'dola-a',
    activeByPlatform: { dola: 'dola-a', doubao: 'doubao-x' },
    activeByAccount: {}
  });

  manager.init();

  // 每平台合并为一条
  assert.equal(manager.getAll('dola').length, 1);
  assert.equal(manager.getAll('doubao').length, 1);
  // dola 主会话保留有 doubaoConversationId 的那条，并吸收全部 results（按时间排序）
  const dola = manager.getAll('dola')[0];
  assert.equal(dola.id, 'dola-a');
  assert.equal(dola.results.length, 2);
  assert.equal(dola.results[0].urls[0], 'u1');
  assert.equal(dola.results[1].urls[0], 'u2');
  assert.equal(dola.accountId, '');
});

test('ensureActive returns the platform conversation, creating one only if none exists', () => {
  const { manager, writes } = createManager({
    conversations: [
      { id: 'legacy-dola', name: '旧会话', platform: 'dola', results: [] }
    ],
    activeConversationId: 'legacy-dola',
    activeByPlatform: { dola: 'legacy-dola' },
    activeByAccount: {}
  });

  manager.init();
  // 已存在 dola 会话：ensureActive 返回它，不新建（账号参数被忽略）
  const conv = manager.ensureActive('dola', 'acc-dola');
  assert.equal(conv.id, 'legacy-dola');
  assert.equal(manager.getAll('dola').length, 1);

  // 该平台无会话时才新建
  const fresh = manager.ensureActive('doubao', 'acc-new');
  assert.equal(fresh.platform, 'doubao');
  assert.equal(fresh.accountId, '');
  assert.equal(fresh.name, '默认会话');
  assert.equal(manager.getActive('doubao').id, fresh.id);
  assert.ok(writes.length >= 1);
});

test('detaching a deleted account preserves platform history and clears account compatibility state', () => {
  const { manager } = createManager();
  manager.data = {
    conversations: [
      {
        id: 'conv-dola',
        name: 'Dola 历史',
        platform: 'dola',
        accountId: 'acc-delete',
        results: [{ prompt: 'keep me', type: 'image', urls: ['local://kept'], time: '2026-07-01T00:00:00Z' }]
      },
      {
        id: 'conv-doubao',
        name: '豆包历史',
        platform: 'doubao',
        accountId: 'acc-other',
        results: [{ prompt: 'other', type: 'image', urls: ['local://other'], time: '2026-07-02T00:00:00Z' }]
      }
    ],
    activeConversationId: 'conv-dola',
    activeByPlatform: { dola: 'conv-dola', doubao: 'conv-doubao' },
    activeByAccount: {
      'dola:acc-delete': 'conv-dola',
      'doubao:acc-other': 'conv-doubao'
    }
  };

  const changed = manager.detachAccount('acc-delete');

  assert.equal(changed, true);
  const dola = manager.getById('conv-dola');
  assert.equal(dola.accountId, '');
  assert.deepEqual(dola.results, [{ prompt: 'keep me', type: 'image', urls: ['local://kept'], time: '2026-07-01T00:00:00Z' }]);
  assert.equal(manager.data.activeByPlatform.dola, 'conv-dola');
  assert.equal(manager.data.activeByAccount['dola:acc-delete'], undefined);
  assert.equal(manager.data.activeByAccount['doubao:acc-other'], undefined);
});

test('startup restores conversations from backup instead of clearing corrupt primary file', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-conversations-'));
  const file = path.join(dir, 'conversations.json');
  fs.writeFileSync(file, '{"conversations":[', 'utf-8');
  fs.writeFileSync(file + '.bak', JSON.stringify({
    conversations: [
      { id: 'conv-1', name: '默认会话', platform: 'doubao', results: [{ prompt: 'p', type: 'image', urls: ['u'] }] }
    ],
    activeConversationId: 'conv-1',
    activeByPlatform: { doubao: 'conv-1' },
    activeByAccount: {}
  }), 'utf-8');

  const ConversationManager = loadCommonJsModule(path.resolve(__dirname, '..', 'services', 'conversation-manager.js'), {
    '../paths': { conversationsFile: file }
  });

  const manager = new ConversationManager({});
  manager.init();

  assert.equal(manager.getAll('doubao').length, 1);
  assert.equal(manager.getResults('conv-1')[0].urls[0], 'u');
  assert.equal(fs.readFileSync(file + '.corrupt', 'utf-8'), '{"conversations":[');
});
