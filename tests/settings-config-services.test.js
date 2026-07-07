const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const imageApiConfig = require('../services/settings-image-api-config');
const apiAccessPresenter = require('../services/api-access-presenter');

test('settings image API config service masks keys and migrates legacy gptimage to plus', () => {
  const config = {
    platforms: {
      gptimage: {
        label: 'legacy',
        requiresAccount: false,
        imageApi: { type: 'openai-compatible', endpoint: 'http://old.example/v1/images/generations', apiKey: 'sk-legacy-secret', model: 'gpt-image2' },
        imageModels: []
      }
    }
  };

  const publicConfig = imageApiConfig.publicImageApiConfig(config, 'gptimage');

  assert.equal(config.platforms.gptimage, undefined);
  assert.equal(publicConfig.platform, 'plus');
  assert.equal(publicConfig.model, 'gpt-image-2');
  assert.equal(publicConfig.hasKey, true);
  assert.equal(publicConfig.apiKey, undefined);
  assert.match(publicConfig.maskedKey, /^sk-leg\*\*\*\*/);
});

test('settings image API config service saves endpoint or baseUrl without injecting a bundled API key', () => {
  const config = { platforms: {} };

  imageApiConfig.saveImageApiConfig(config, {
    platform: '4k',
    endpoint: 'https://5988.de5.net/v1',
    apiKey: '',
    model: 'gpt-image2',
    size: '3840x2160',
    quality: 'high'
  });

  assert.equal(config.platforms['4k'].imageApi.baseUrl, 'https://5988.de5.net/v1');
  assert.equal(config.platforms['4k'].imageApi.endpoint, undefined);
  assert.equal(config.platforms['4k'].imageApi.apiKey, '');
  assert.equal(config.platforms['4k'].imageApi.model, 'gpt-image-2');
  assert.equal(config.platforms['4k'].imageApi.size, '3840x2160');
  assert.equal(config.platforms['4k'].imageApi.quality, 'high');
  assert.deepEqual(config.platforms['4k'].imageModels, [{ value: 'gpt-image-2', label: 'gpt-image-2' }]);
});

test('api access presenter builds token DTOs and MCP snippets outside settings routes', () => {
  const tokenConfig = { enabled: true, token: 'tok-1', createdAt: 'c', lastUsedAt: 'u' };
  const access = apiAccessPresenter.buildApiAccessData(tokenConfig, { port: 9527, lanUrls: ['http://10.0.0.2:9527/ext'] });
  const mcp = apiAccessPresenter.buildMcpData(tokenConfig, {
    port: 9527,
    mcpServerFile: path.join('C:', 'app', 'mcp.js'),
    isPackaged: false,
    execPath: 'lulu.exe',
    serverExists: true
  });

  assert.equal(access.baseUrl, 'http://127.0.0.1:9527/ext');
  assert.deepEqual(access.lanHints, ['http://10.0.0.2:9527/ext']);
  assert.equal(mcp.hasToken, true);
  assert.match(mcp.snippets.claude, /LULU_TOKEN/);
  assert.match(mcp.snippets.codex, /\[mcp_servers\.lulu\]/);
});

test('settings route uses config boundary helpers for image API and API token presentation', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'settings.js'), 'utf8');

  assert.match(source, /settings-image-api-config/);
  assert.match(source, /api-access-presenter/);
  assert.doesNotMatch(source, /const IMAGE_API_DEFAULTS =/);
  assert.doesNotMatch(source, /function listLanUrls/);
});
