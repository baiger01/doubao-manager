const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function importWebModule(rel) {
  const file = path.resolve(__dirname, '..', rel);
  return import(pathToFileURL(file).href + '?t=' + Date.now());
}

test('platform capabilities allow accountless Orion video but not image generation', async () => {
  const {
    platformSupportsImage,
    platformSupportsVideo,
    supportsAccountlessMode,
    platformSupportsReferenceImages,
    accountlessReferenceImageMessage
  } = await importWebModule('web/src/lib/platform-capabilities.js');

  const orion = {
    key: 'orion',
    requiresAccount: false,
    supportsImage: false,
    supportsVideo: true,
    imageModels: [],
    videoModels: [{ value: 'orion-project1', label: 'Orion 项目1 15s' }]
  };
  const plus = {
    key: 'plus',
    requiresAccount: false,
    supportsVideo: false,
    imageModels: [{ value: 'gpt-image-2', label: 'gpt-image2' }],
    videoModels: []
  };
  const fourK = {
    key: '4k',
    requiresAccount: false,
    supportsVideo: false,
    imageModels: [{ value: 'gpt-image-2', label: 'gpt-image-2' }],
    videoModels: []
  };

  assert.equal(platformSupportsImage(orion), false);
  assert.equal(platformSupportsVideo(orion), true);
  assert.equal(supportsAccountlessMode(orion, 'video'), true);
  assert.equal(supportsAccountlessMode(orion, 'image'), false);
  assert.equal(platformSupportsReferenceImages(orion, 'video'), true);
  assert.match(accountlessReferenceImageMessage(orion, 'video'), /视频参考图|当前平台/);

  assert.equal(platformSupportsImage(plus), true);
  assert.equal(platformSupportsVideo(plus), false);
  assert.equal(supportsAccountlessMode(plus, 'image'), true);
  assert.equal(supportsAccountlessMode(plus, 'video'), false);
  assert.equal(platformSupportsReferenceImages(plus, 'image'), true);
  assert.equal(platformSupportsReferenceImages(plus, 'video'), false);

  assert.equal(platformSupportsImage(fourK), true);
  assert.equal(platformSupportsReferenceImages(fourK, 'image'), true);
  assert.equal(platformSupportsReferenceImages(fourK, 'video'), false);
});

