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

test('startup cleanup keeps accounts whose persisted profile directory still exists', () => {
  const accountManagerPath = path.resolve(__dirname, '..', 'services', 'account-manager.js');
  const writes = [];
  const fakePaths = {
    accountsFile: 'D:\\RuntimeData\\data\\accounts.json',
    profilesDir: 'D:\\RuntimeData\\data\\profiles'
  };

  const fakeFs = {
    existsSync(target) {
      if (target === fakePaths.accountsFile) return true;
      if (target === path.join(fakePaths.profilesDir, 'acc-1')) return true;
      return false;
    },
    readFileSync() {
      return JSON.stringify({
        accounts: [{
          id: 'acc-1',
          name: '账号1',
          platform: 'doubao',
          status: 'active',
          session: { cookies: '' }
        }],
        activeAccountId: 'acc-1',
        activeByPlatform: { doubao: 'acc-1' }
      });
    },
    mkdirSync() {},
    writeFileSync(filePath, content) {
      writes.push({ filePath, content: JSON.parse(content) });
    }
  };

  const AccountManager = loadCommonJsModule(accountManagerPath, {
    fs: fakeFs,
    '../paths': fakePaths
  });

  const manager = new AccountManager({ platforms: {} });
  manager.init();

  assert.equal(manager.getAll().length, 1);
  assert.equal(writes.length, 0);
});

test('new account persists browser metadata for isolated profile reuse', () => {
  const accountManagerPath = path.resolve(__dirname, '..', 'services', 'account-manager.js');
  const fakePaths = {
    accountsFile: 'D:\\RuntimeData\\data\\accounts.json',
    profilesDir: 'D:\\RuntimeData\\data\\profiles'
  };
  const writes = [];

  const fakeFs = {
    existsSync() { return false; },
    mkdirSync() {},
    writeFileSync(filePath, content) {
      writes.push({ filePath, content: JSON.parse(content) });
    }
  };

  const AccountManager = loadCommonJsModule(accountManagerPath, {
    fs: fakeFs,
    '../paths': fakePaths
  });

  const manager = new AccountManager({ platforms: {} });
  const account = manager.add({
    name: '账号2',
    platform: 'dola',
    browser: {
      profileDir: 'D:\\RuntimeData\\data\\profiles\\acc-2',
      lastChromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    }
  });

  assert.equal(account.browser.profileDir, 'D:\\RuntimeData\\data\\profiles\\acc-2');
  assert.equal(account.browser.lastChromePath, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(writes.length, 1);
});

test('startup preserves logged-in accounts and active account after reload', () => {
  const accountManagerPath = path.resolve(__dirname, '..', 'services', 'account-manager.js');
  const fakePaths = {
    accountsFile: 'D:\\RuntimeData\\data\\accounts.json',
    profilesDir: 'D:\\RuntimeData\\data\\profiles'
  };
  const writes = [];

  const fakeFs = {
    existsSync(target) {
      if (target === fakePaths.accountsFile) return true;
      if (target === path.join(fakePaths.profilesDir, 'acc-1')) return true;
      if (target === path.join(fakePaths.profilesDir, 'acc-2')) return true;
      return false;
    },
    readFileSync() {
      return JSON.stringify({
        accounts: [
          {
            id: 'acc-1',
            name: '豆包账号',
            platform: 'doubao',
            status: 'active',
            session: { cookies: 'sid=one', device_id: 'dev-1' },
            browser: { profileDir: path.join(fakePaths.profilesDir, 'acc-1') }
          },
          {
            id: 'acc-2',
            name: 'Dola账号',
            platform: 'dola',
            status: 'active',
            session: { cookies: 'sid=two', device_id: 'dev-2' },
            browser: { profileDir: path.join(fakePaths.profilesDir, 'acc-2') }
          }
        ],
        activeAccountId: 'acc-2',
        activeByPlatform: {
          doubao: 'acc-1',
          dola: 'acc-2'
        }
      });
    },
    mkdirSync() {},
    writeFileSync(filePath, content) {
      writes.push({ filePath, content: JSON.parse(content) });
    }
  };

  const AccountManager = loadCommonJsModule(accountManagerPath, {
    fs: fakeFs,
    '../paths': fakePaths
  });

  const manager = new AccountManager({ platforms: {} });
  manager.init();

  assert.equal(manager.getAll().length, 2);
  assert.equal(manager.getActive().id, 'acc-2');
  assert.equal(manager.getActiveByPlatform('doubao').id, 'acc-1');
  assert.equal(manager.getActiveByPlatform('dola').id, 'acc-2');
  assert.equal(writes.length, 0);
});

test('startup restores accounts from backup instead of clearing corrupt primary file', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-accounts-'));
  const dataDir = path.join(dir, 'data');
  const profilesDir = path.join(dataDir, 'profiles');
  const accountsFile = path.join(dataDir, 'accounts.json');
  fs.mkdirSync(path.join(profilesDir, 'acc-1'), { recursive: true });
  fs.writeFileSync(accountsFile, '{"accounts":[', 'utf-8');
  fs.writeFileSync(accountsFile + '.bak', JSON.stringify({
    accounts: [{
      id: 'acc-1',
      name: '账号1',
      platform: 'doubao',
      status: 'active',
      session: { cookies: 'sid=one' },
      browser: { profileDir: path.join(profilesDir, 'acc-1') }
    }],
    activeAccountId: 'acc-1',
    activeByPlatform: { doubao: 'acc-1' }
  }), 'utf-8');

  const AccountManager = loadCommonJsModule(path.resolve(__dirname, '..', 'services', 'account-manager.js'), {
    '../paths': { accountsFile, profilesDir }
  });

  const manager = new AccountManager({ platforms: {} });
  manager.init();

  assert.equal(manager.getAll().length, 1);
  assert.equal(manager.getActive().id, 'acc-1');
  assert.equal(fs.readFileSync(accountsFile + '.corrupt', 'utf-8'), '{"accounts":[');
});
