export const ADD_ACCOUNT_MAIN_CLASS = 'btn-add-account-main';
export const ADD_ACCOUNT_MAIN_LABEL = '+ 添加账号';
export const DEFAULT_ADD_ACCOUNT_PLATFORM = 'doubao';

export const AUTO_LOGIN_PLATFORM_KEYS = ['dola'];
export const AUTO_LOGIN_FALLBACK_TARGET = { key: 'dola', label: 'Dola' };
export const AUTO_LOGIN_HINT = '仅支持 Dola 谷歌账号自动登录';
export const AUTO_LOGIN_KEPT_BROWSER_BADGE_LABEL = '浏览器已保留';

export function platformRequiresAccount(platform = {}) {
  return platform?.requiresAccount !== false;
}

export function shouldShowPlatformAddAccount(platform = {}) {
  return platformRequiresAccount(platform);
}

export function shouldShowOrionAuthActions(platform = {}) {
  return String(platform?.key || '').toLowerCase() === 'orion'
    && platformRequiresAccount(platform) === false
    && (platform.hasVideoApi === true || platform.supportsVideo === true);
}

export function getAccountlessPlatformHint(platform = {}) {
  if (shouldShowOrionAuthActions(platform)) return 'Orion 使用本地授权，不需要添加账号';
  const label = platform?.label || platform?.key || '该平台';
  return `${label} 使用 API 配置，不需要添加账号`;
}

export function getDefaultAddAccountPlatform(currentPlatform, platforms = []) {
  if (currentPlatform) {
    const current = platforms.find(p => p.key === currentPlatform);
    if (!current || platformRequiresAccount(current)) return currentPlatform;
  }
  return platforms.find(platformRequiresAccount)?.key || DEFAULT_ADD_ACCOUNT_PLATFORM;
}

export function getAutoLoginPlatforms(platforms = []) {
  return platforms.filter(p => AUTO_LOGIN_PLATFORM_KEYS.includes(p.key));
}

export function getAutoLoginTarget(platforms = []) {
  const target = getAutoLoginPlatforms(platforms)[0];
  if (!target) return { ...AUTO_LOGIN_FALLBACK_TARGET };
  return { key: target.key, label: target.label || target.key };
}

export function normalizeAutoLoginProgressItem(data = {}) {
  return {
    email: data.email || '',
    status: data.status || 'running',
    message: data.message || '',
    accountId: data.accountId || '',
    browserKeptOpen: !!data.browserKeptOpen,
    stage: data.stage || '',
    reason: data.reason || '',
  };
}

export function shouldShowKeptBrowserBadge(item = {}) {
  return !!item.browserKeptOpen;
}

export function getAutoLoginMessageTitle(item = {}) {
  return item.message || '';
}
