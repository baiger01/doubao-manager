const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function importWebModule(rel) {
  const file = path.resolve(__dirname, '..', rel);
  return import(pathToFileURL(file).href + '?t=' + Date.now());
}

test('video UI exports Doubao video ratios and accepted durations', async () => {
  const { VIDEO_RATIOS, VIDEO_DURATIONS } = await importWebModule('web/src/lib/options.js');

  assert.deepEqual(VIDEO_RATIOS, ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']);
  assert.deepEqual(VIDEO_DURATIONS, [
    { value: 5, label: '5秒' },
    { value: 10, label: '10秒' },
    { value: 15, label: '15秒' },
  ]);
});

test('platform config exposes official Seedance video model label and value', () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config', 'config.json'), 'utf8'));

  for (const platform of ['doubao', 'dola']) {
    assert.deepEqual(config.platforms[platform].videoModels, [
      { value: 'seedance_v2.0', label: 'Seedance 2.0 Fast' }
    ]);
  }
});
