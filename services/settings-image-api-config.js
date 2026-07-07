const IMAGE_API_DEFAULTS = {
  plus: {
    label: 'plus',
    requiresAccount: false,
    supportsReferenceImages: true,
    supportsVideo: false,
    imageModels: [{ value: 'gpt-image-2', label: 'gpt-image2' }],
    videoModels: [],
    imageApi: { type: 'openai-compatible', endpoint: '', apiKey: '', model: 'gpt-image-2' }
  },
  '4k': {
    label: '4k',
    requiresAccount: false,
    supportsReferenceImages: true,
    supportsVideo: false,
    imageModels: [{ value: 'gpt-image-2', label: 'gpt-image-2' }],
    videoModels: [],
    imageApi: {
      type: 'openai-compatible',
      baseUrl: 'https://5988.de5.net/v1',
      apiKey: '',
      model: 'gpt-image-2',
      size: '3840x2160',
      quality: 'high'
    }
  }
};

function cloneDefault(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

function maskSecret(value) {
  const key = String(value || '');
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '****';
  return key.slice(0, 6) + '****' + key.slice(-4);
}

function normalizeImageModel(model) {
  const value = String(model || '').trim();
  if (value === 'gpt-image2') return 'gpt-image-2';
  return value || 'gpt-image-2';
}

function normalizeImagePlatform(platform) {
  const value = String(platform || 'plus').trim();
  if (!value || value === 'gptimage') return 'plus';
  return value;
}

function imageModelLabel(model, platform) {
  if (platform === 'plus' && model === 'gpt-image-2') return 'gpt-image2';
  return model;
}

function migrateLegacyImageApiPlatform(config) {
  if (!config.platforms || !config.platforms.gptimage) return false;
  if (!config.platforms.plus) {
    config.platforms.plus = cloneDefault(config.platforms.gptimage);
    config.platforms.plus.label = 'plus';
  }
  delete config.platforms.gptimage;
  return true;
}

function ensureImageApiPlatform(config, platform = 'plus') {
  if (!config.platforms) config.platforms = {};
  migrateLegacyImageApiPlatform(config);
  const key = normalizeImagePlatform(platform);
  if (!config.platforms[key]) {
    config.platforms[key] = cloneDefault(IMAGE_API_DEFAULTS[key] || {
      label: key,
      requiresAccount: false,
      supportsVideo: false,
      imageModels: [{ value: 'gpt-image-2', label: 'gpt-image-2' }],
      videoModels: [],
      imageApi: { type: 'openai-compatible', endpoint: '', apiKey: '', model: 'gpt-image-2' }
    });
  }
  const pc = config.platforms[key];
  const defaults = IMAGE_API_DEFAULTS[key];
  pc.label = pc.label || key;
  pc.requiresAccount = false;
  if (defaults && defaults.supportsReferenceImages === true) pc.supportsReferenceImages = true;
  pc.supportsVideo = false;
  pc.videoModels = [];
  if (!pc.imageApi) pc.imageApi = { type: 'openai-compatible', endpoint: '', apiKey: '', model: 'gpt-image-2' };
  pc.imageApi.type = 'openai-compatible';
  if (defaults && defaults.imageApi) {
    for (const [field, value] of Object.entries(defaults.imageApi)) {
      if (pc.imageApi[field] === undefined) pc.imageApi[field] = value;
    }
  }
  pc.imageApi.model = normalizeImageModel(pc.imageApi.model);
  pc.imageModels = [{ value: pc.imageApi.model, label: imageModelLabel(pc.imageApi.model, key) }];
  return { key, pc };
}

function publicImageApiConfig(config, platform) {
  const { key, pc } = ensureImageApiPlatform(config, platform);
  const imageApi = pc.imageApi || {};
  return {
    platform: key,
    label: pc.label || key,
    endpoint: imageApi.endpoint || imageApi.baseUrl || '',
    baseUrl: imageApi.baseUrl || '',
    model: normalizeImageModel(imageApi.model),
    size: imageApi.size || '',
    quality: imageApi.quality || '',
    hasKey: !!imageApi.apiKey,
    maskedKey: maskSecret(imageApi.apiKey),
    imageModels: pc.imageModels || []
  };
}

function saveImageApiConfig(config, input = {}) {
  const { platform, endpoint, baseUrl, apiKey, model, size, quality } = input;
  const { key, pc } = ensureImageApiPlatform(config, platform);
  const imageApi = pc.imageApi;
  const address = endpoint !== undefined ? endpoint : baseUrl;
  if (address !== undefined) {
    const nextAddress = String(address || '').trim();
    if (!nextAddress) {
      const err = new Error('缺少图片 API 地址');
      err.statusCode = 400;
      throw err;
    }
    try { new URL(nextAddress); } catch (e) {
      const err = new Error('图片 API 地址格式不对');
      err.statusCode = 400;
      throw err;
    }
    if (/\/images\/generations\/?$/i.test(nextAddress)) {
      imageApi.endpoint = nextAddress.replace(/\/+$/, '');
      delete imageApi.baseUrl;
    } else {
      imageApi.baseUrl = nextAddress.replace(/\/+$/, '');
      delete imageApi.endpoint;
    }
  }
  if (apiKey !== undefined && String(apiKey).trim()) {
    imageApi.apiKey = String(apiKey).trim();
  }
  if (model !== undefined) {
    imageApi.model = normalizeImageModel(model);
  }
  if (size !== undefined) {
    const nextSize = String(size || '').trim();
    if (nextSize) imageApi.size = nextSize;
    else delete imageApi.size;
  }
  if (quality !== undefined) {
    const nextQuality = String(quality || '').trim();
    if (nextQuality) imageApi.quality = nextQuality;
    else delete imageApi.quality;
  }
  pc.imageModels = [{ value: imageApi.model, label: imageModelLabel(imageApi.model, key) }];
  return { key, pc };
}

module.exports = {
  IMAGE_API_DEFAULTS,
  maskSecret,
  normalizeImageModel,
  normalizeImagePlatform,
  imageModelLabel,
  ensureImageApiPlatform,
  publicImageApiConfig,
  saveImageApiConfig,
};
