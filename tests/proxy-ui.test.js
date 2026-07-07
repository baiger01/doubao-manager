const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function importWebModule(rel) {
  const file = path.resolve(__dirname, '..', rel);
  return import(pathToFileURL(file).href + '?t=' + Date.now());
}

test('settings UI contract exposes Dola-only proxy settings with auto detection', async () => {
  const contract = await importWebModule('web/src/lib/settings-ui-contract.js');

  assert.deepEqual(
    contract.SETTINGS_TABS.filter(t => ['proxy', 'imageApi'].includes(t.key)),
    [
      { key: 'proxy', label: '代理' },
      { key: 'imageApi', label: '图片 API' },
    ]
  );
  assert.deepEqual(contract.PROXY_SETTINGS, {
    platform: 'dola',
    directPlatformLabel: '豆包始终直连',
    supportsAutoDetect: true,
  });
});

test('web api client sends explicit proxy and image-api requests', async () => {
  const calls = [];
  const oldFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { json: async () => ({ success: true }) };
  };

  try {
    const { api } = await importWebModule('web/src/lib/api.js');

    await api.getProxy('dola');
    await api.detectProxy('dola');
    await api.getImageApiConfig('4k');
    await api.saveImageApiConfig({ platform: '4k', endpoint: 'https://example.test/v1' });
  } finally {
    global.fetch = oldFetch;
  }

  assert.equal(calls[0].url, '/api/proxy?platform=dola');
  assert.equal(calls[1].url, '/api/proxy/detect');
  assert.equal(calls[1].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].opts.body), { platform: 'dola' });
  assert.equal(calls[2].url, '/api/settings/image-api?platform=4k');
  assert.equal(calls[3].url, '/api/settings/image-api');
  assert.equal(calls[3].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[3].opts.body), { platform: '4k', endpoint: 'https://example.test/v1' });
});

test('web api client sends Orion local auth requests', async () => {
  const calls = [];
  const oldFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { json: async () => ({ success: true }) };
  };

  try {
    const { api } = await importWebModule('web/src/lib/api.js');

    await api.getOrionStatus();
    await api.openOrionLogin();
    await api.exportOrionBrowserCookies({ browser: 'chrome', profile: 'Default' });
    await api.saveOrionCookie({ cookieHeader: 'sessionid=abc; sid_tt=def' });
  } finally {
    global.fetch = oldFetch;
  }

  assert.equal(calls[0].url, '/api/orion/status');
  assert.equal(calls[1].url, '/api/orion/open-login');
  assert.equal(calls[1].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].opts.body), {});
  assert.equal(calls[2].url, '/api/orion/export-browser-cookies');
  assert.equal(calls[2].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].opts.body), { browser: 'chrome', profile: 'Default' });
  assert.equal(calls[3].url, '/api/orion/set-cookie');
  assert.equal(calls[3].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[3].opts.body), { cookieHeader: 'sessionid=abc; sid_tt=def' });
});

test('accounts modal includes persistent Orion auth status and manual cookie fallback UI', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'components', 'AccountsModal.jsx'), 'utf8');

  assert.match(source, /orion-auth-panel/);
  assert.match(source, /检查状态/);
  assert.match(source, /手动 Cookie/);
  assert.match(source, /saveOrionCookie/);
  assert.match(source, /orionAuthState/);
});

test('settings UI contract describes background login mode without off-screen offsets', async () => {
  const { BROWSER_WINDOW_MODE_OPTIONS } = await importWebModule('web/src/lib/settings-ui-contract.js');
  const background = BROWSER_WINDOW_MODE_OPTIONS.find(opt => opt.key === 'background');

  assert.ok(background);
  assert.doesNotMatch(`${background.title} ${background.desc}`, /屏幕外|偏移|window-position/);
  assert.match(`${background.title} ${background.desc}`, /后台无头运行|无窗口/);
});

test('top bar shows API mode instead of account-login wording for accountless API platforms', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'components', 'TopBar.jsx'), 'utf8');

  assert.match(source, /usesImageApiMode/);
  assert.match(source, /API 模式/);
  assert.doesNotMatch(source, /usesLocalVideoAuth \? '本地授权' : '无需账号'/);
});
test('settings UI contract exposes custom plus and 4k image API configuration', async () => {
  const contract = await importWebModule('web/src/lib/settings-ui-contract.js');

  assert.deepEqual(contract.IMAGE_API_FALLBACK_PLATFORMS, [
    { key: 'plus', label: 'plus' },
    { key: '4k', label: '4k' },
  ]);
  assert.deepEqual(
    contract.getImageApiPlatforms([
      { key: 'doubao', label: '豆包' },
      { key: 'plus', label: 'Plus', hasImageApi: true },
      { key: '4k', label: '4K', hasImageApi: true },
    ]),
    [
      { key: 'plus', label: 'Plus', hasImageApi: true },
      { key: '4k', label: '4K', hasImageApi: true },
    ]
  );
  assert.equal(
    contract.getPreferredImageApiPlatform('4k', [
      { key: 'plus', hasImageApi: true },
      { key: '4k', hasImageApi: true },
    ]),
    '4k'
  );
  assert.equal(contract.getPreferredImageApiPlatform('doubao', []), 'plus');
});

test('settings text inputs use normal compact form styling instead of thin full-width bars', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'styles', 'global.css'), 'utf8');

  assert.match(css, /\.settings-dir-row\s*\{[^}]*max-width:\s*520px/s);
  assert.match(css, /\.settings-dir-row \.settings-dir-input\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /\.settings-dir-input\s*\{[^}]*height:\s*44px/s);
  assert.match(css, /\.settings-dir-input\s*\{[^}]*max-width:\s*520px/s);
  assert.match(css, /\.settings-dir-input\s*\{[^}]*padding:\s*0 16px/s);
  assert.match(css, /\.settings-dir-input\s*\{[^}]*font-size:\s*14px/s);
  assert.doesNotMatch(css, /\.settings-dir-input\s*\{[^}]*flex:\s*0 1 520px/s);
  assert.match(css, /\.settings-dir-input:focus\s*\{[^}]*box-shadow:/s);
});

test('settings modal keeps a fixed panel size with thin transparent internal scrollbars', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'styles', 'global.css'), 'utf8');

  assert.match(css, /\.settings-modal\.settings-modal-tabs\s*\{[^}]*width:\s*min\(760px,\s*calc\(100vw - 48px\)\)/s);
  assert.match(css, /\.settings-modal\.settings-modal-tabs\s*\{[^}]*height:\s*min\(640px,\s*calc\(100vh - 48px\)\)/s);
  assert.match(css, /\.settings-tabbed\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /\.settings-pane\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.settings-pane::-webkit-scrollbar\s*\{[^}]*width:\s*4px/s);
  assert.match(css, /\.settings-pane::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.settings-pane::-webkit-scrollbar-thumb\s*\{[^}]*rgba\(26,20,40,0\.18\)/s);
});

