const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  atomicWriteJsonFile,
  readJsonFile,
  ensureJsonFile,
} = require('../services/json-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lulu-json-store-'));
}

test('atomicWriteJsonFile keeps a backup of the previous valid JSON before replacing it', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, value: 'old' }), 'utf-8');

  atomicWriteJsonFile(file, { version: 2, value: 'new' });

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { version: 2, value: 'new' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf-8')), { version: 1, value: 'old' });
});

test('readJsonFile restores from .bak when the primary JSON is corrupt', () => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, '{"accounts":[', 'utf-8');
  fs.writeFileSync(file + '.bak', JSON.stringify({ accounts: [{ id: 'acc-1' }] }), 'utf-8');

  const data = readJsonFile(file, { accounts: [] });

  assert.deepEqual(data, { accounts: [{ id: 'acc-1' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { accounts: [{ id: 'acc-1' }] });
  assert.equal(fs.readFileSync(file + '.corrupt', 'utf-8'), '{"accounts":[');
});

test('ensureJsonFile replaces corrupt config with defaults and preserves the corrupt file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"server":', 'utf-8');

  const data = ensureJsonFile(file, { server: { port: 9527 }, storage: { autoDownload: true } });

  assert.deepEqual(data, { server: { port: 9527 }, storage: { autoDownload: true } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { server: { port: 9527 }, storage: { autoDownload: true } });
  assert.equal(fs.readFileSync(file + '.corrupt', 'utf-8'), '{"server":');
});
