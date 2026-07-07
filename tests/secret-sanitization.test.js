const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

function readProjectFile(...parts) {
  return fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8');
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, out));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectStrings(item, out));
  }
  return out;
}

async function withServer(router, run) {
  const app = express();
  app.use(router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('bundled default config contains no API keys, master keys, or machine-local paths', () => {
  const source = readProjectFile('config', 'config.json');
  const config = JSON.parse(source);
  const strings = collectStrings(config);

  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]+/);
  assert.doesNotMatch(source, new RegExp('LULU-' + 'MASTER', 'i'));
  assert.equal(config.license && Object.hasOwn(config.license, 'master' + 'Key'), false);
  assert.deepEqual(strings.filter(value => /^[A-Z]:\\/i.test(value)), []);
});

test('production defaults do not carry fallback secrets in source code', () => {
  const settingsSource = readProjectFile('services', 'settings-image-api-config.js');
  const licenseSource = readProjectFile('services', 'license-manager.js');
  const pathsSource = readProjectFile('paths.js');

  assert.doesNotMatch(settingsSource, /sk-[A-Za-z0-9_-]+/);
  assert.doesNotMatch(licenseSource, new RegExp('LULU-' + 'MASTER', 'i'));
  assert.doesNotMatch(pathsSource, /fillEmptyImageApiKeys/);
});

test('external API ping reports package version', async () => {
  const buildExtRoutes = require('../routes/ext');
  const pkg = require('../package.json');
  const router = buildExtRoutes({
    accountManager: {},
    generationService: {},
    quotaPoller: {},
    conversationManager: {},
    jobManager: {},
    mediaDownloader: {},
    broadcast: () => {},
    apiTokenManager: { isEnabled: () => true }
  });

  await withServer(router, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/ping`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.data.version, pkg.version);
  });
});
