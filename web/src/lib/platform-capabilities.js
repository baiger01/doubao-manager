export function platformSupportsImage(platform = {}) {
  if (platform.supportsImage === false) return false;
  return Array.isArray(platform.imageModels) && platform.imageModels.length > 0;
}

export function platformSupportsVideo(platform = {}) {
  if (platform.supportsVideo === false) return false;
  return Array.isArray(platform.videoModels) && platform.videoModels.length > 0;
}

export function supportsAccountlessMode(platform = {}, mode = 'image') {
  if (platform.requiresAccount !== false) return true;
  return mode === 'video'
    ? platformSupportsVideo(platform)
    : platformSupportsImage(platform);
}

export function platformSupportsReferenceImages(platform = {}, mode = 'image') {
  if (platform.requiresAccount !== false) return true;
  if (mode === 'video' && platform.key === 'orion') return true;
  if (mode !== 'image') return false;
  return platform.supportsReferenceImages === true || platform.key === 'plus' || platform.key === '4k';
}

export function unsupportedModeMessage(platform = {}, mode = 'image') {
  const label = platform.label || platform.key || '当前平台';
  return mode === 'video'
    ? `${label} 不支持视频生成`
    : `${label} 不支持图片生成`;
}

export function accountlessReferenceImageMessage(platform = {}, mode = 'image') {
  return mode === 'video'
    ? '当前平台暂不支持视频参考图'
    : '自定义 API 暂不支持参考图';
}
