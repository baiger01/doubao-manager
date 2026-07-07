export const SETTINGS_TABS = [
  { key: 'download', label: '下载' },
  { key: 'proxy', label: '代理' },
  { key: 'imageApi', label: '图片 API' },
  { key: 'appearance', label: '外观' },
  { key: 'claude', label: 'Claude' },
  { key: 'browser', label: '内置浏览器' },
  { key: 'license', label: '授权' },
  { key: 'api', label: 'API 接口' },
  { key: 'mcp', label: 'MCP' },
  { key: 'about', label: '关于' },
];

export const PROXY_SETTINGS = {
  platform: 'dola',
  directPlatformLabel: '豆包始终直连',
  supportsAutoDetect: true,
};

export const BROWSER_WINDOW_MODE_OPTIONS = [
  { key: 'visible', title: '有头可见', desc: '窗口正常显示,可实时观察和手动介入,登录成功率最高' },
  { key: 'background', title: '后台运行', desc: '后台无头运行,无窗口,不会遮挡桌面(推荐)' },
  { key: 'headless', title: '无头模式', desc: '完全不弹窗、占用最小,但谷歌登录可能被风控拦截' },
];

export const IMAGE_API_FALLBACK_PLATFORMS = [
  { key: 'plus', label: 'plus' },
  { key: '4k', label: '4k' },
];

export function getImageApiPlatforms(platforms = []) {
  return platforms.filter(p => p.hasImageApi);
}

export function getPreferredImageApiPlatform(activePlatform, platforms = []) {
  const imagePlatforms = getImageApiPlatforms(platforms);
  return imagePlatforms.find(p => p.key === activePlatform)?.key || imagePlatforms[0]?.key || 'plus';
}

export function getRenderableImageApiPlatforms(platforms = []) {
  const imagePlatforms = getImageApiPlatforms(platforms);
  return imagePlatforms.length ? imagePlatforms : IMAGE_API_FALLBACK_PLATFORMS;
}
