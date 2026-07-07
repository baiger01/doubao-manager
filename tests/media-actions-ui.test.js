const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function importWebModule(rel) {
  const file = path.resolve(__dirname, '..', rel);
  return import(pathToFileURL(file).href + '?t=' + Date.now());
}

test('manual media download asks for a directory and saves to that directory', async () => {
  const calls = [];
  const toasts = [];
  const oldFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === '/api/settings/pick-dir') {
      return { json: async () => ({ success: true, data: { dir: 'E:\\PickedDownloads' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { path: 'E:\\PickedDownloads\\cat.png' } }) };
  };

  try {
    const { saveMediaWithDirectoryChoice } = await importWebModule('web/src/lib/media-actions.js');
    const result = await saveMediaWithDirectoryChoice('local://cat.png', {
      mediaLabel: '图片',
      showToast(message) { toasts.push(message); }
    });

    assert.equal(result.success, true);
  } finally {
    global.fetch = oldFetch;
  }

  assert.equal(calls[0].url, '/api/settings/pick-dir');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[1].url, '/api/media/save?f=cat.png&dir=E%3A%5CPickedDownloads');
  assert.deepEqual(toasts, ['图片已保存到 E:\\PickedDownloads\\cat.png']);
});

test('downloadMedia sends a per-request directory to the backend save endpoint', async () => {
  const calls = [];
  const oldFetch = global.fetch;
  const oldDocument = global.document;
  global.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { path: 'E:\\PickedDownloads\\cat.png' } }) };
  };
  global.document = {
    createElement() {
      return { style: {}, click() {} };
    },
    body: {
      appendChild() {},
      removeChild() {}
    }
  };

  try {
    const { downloadMedia } = await importWebModule('web/src/lib/util.js');
    await downloadMedia('local://cat.png', { dir: 'E:\\PickedDownloads' });
  } finally {
    global.fetch = oldFetch;
    global.document = oldDocument;
  }

  assert.deepEqual(calls, ['/api/media/save?f=cat.png&dir=E%3A%5CPickedDownloads']);
});

test('image context menu releases copying state after success, failure, close, or source changes', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'components', 'ImageContextMenu.jsx'), 'utf8');

  assert.match(source, /finally\s*\{[\s\S]*setCopying\(false\)/);
  assert.match(source, /useEffect\(\(\)\s*=>\s*\{[\s\S]*setCopying\(false\)[\s\S]*\},\s*\[imageMenu\.open,\s*imageMenu\.src\]\)/);
  assert.match(source, /copyImageToClipboardWithTimeout/);
});
