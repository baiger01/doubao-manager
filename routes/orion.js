const express = require('express');

function resolveOrionAuthBaseUrl(config = {}) {
  const videoApi = config.platforms?.orion?.videoApi || {};
  if (videoApi.authBaseUrl) return String(videoApi.authBaseUrl).replace(/\/+$/, '');
  if (videoApi.baseUrl) return String(videoApi.baseUrl).replace(/\/+$/, '');
  if (videoApi.endpoint) {
    try {
      const url = new URL(videoApi.endpoint);
      return url.origin;
    } catch (_) {}
  }
  return 'http://127.0.0.1:8787';
}

function normalizeAuthPayload(body = {}) {
  return {
    browser: body.browser || 'chrome',
    profile: body.profile || 'Default',
  };
}

function normalizeManualCookiePayload(body = {}) {
  return {
    cookie_header: String(body.cookieHeader || body.cookie_header || '').trim(),
  };
}

function extractOrionError(data, fallback = '') {
  const raw = String(
    data?.error
    || data?.message
    || data?.raw
    || fallback
    || ''
  ).trim();
  if (!raw) return '';
  const valueError = raw.match(/^[A-Za-z_]*Error\((['"])([\s\S]*)\1\)$/);
  if (valueError) return valueError[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
  return raw;
}

function isOrionLoginErrorText(value = '') {
  const text = String(value || '');
  const lower = text.toLowerCase();
  return (
    lower.includes('not logged in')
    || lower.includes('no cookies found')
    || lower.includes('no sessionid')
    || lower.includes('user not logged')
    || lower.includes('login required')
    || lower.includes('err_no\': 10010')
    || lower.includes('"err_no":10010')
    || text.includes('用户未登录')
    || text.includes('未登录')
    || text.includes('登录态')
    || lower.includes('cookie')
  );
}

function explainOrionError(data, fallback = '') {
  const rawError = extractOrionError(data, fallback);
  if (isOrionLoginErrorText(rawError)) {
    return {
      status: 400,
      error: 'Orion 登录未完成：没有读取到有效的 douyin.com 登录态。',
      action: '请先在打开的抖音登录窗口完成手机确认或验证码登录；页面跳转成功后再点「回传登录态」。如果一直卡在「正在登录」，改用右侧手机号验证码登录，或在下方粘贴手动 Cookie 保存。',
      rawError,
    };
  }
  return {
    status: 502,
    error: rawError || 'Orion 本地 API 调用失败',
    action: '请检查 Orion 本地服务窗口和输出日志。',
    rawError,
  };
}

async function proxyJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  return { response, data, text };
}

module.exports = function buildOrionRoutes(config = {}) {
  const router = express.Router();

  router.get('/status', async (req, res) => {
    try {
      const baseUrl = resolveOrionAuthBaseUrl(config);
      const { response, data, text } = await proxyJson(`${baseUrl}/health`);
      if (!response.ok || data?.ok === false) {
        const explained = explainOrionError(data, text || `HTTP ${response.status}`);
        return res.status(explained.status).json({
          success: false,
          error: explained.error,
          action: explained.action,
          data: { rawError: explained.rawError, health: data }
        });
      }
      const cookieFileExists = !!data.default_cookie_file_exists;
      const hasLoginCookie = typeof data.default_cookie_login_ready === 'boolean'
        ? data.default_cookie_login_ready
        : cookieFileExists;
      const authenticated = cookieFileExists && hasLoginCookie;
      res.json({
        success: true,
        data: {
          authenticated,
          cookieFileExists,
          hasLoginCookie,
          cookieCount: data.default_cookie_count || 0,
          loginCookieNames: Array.isArray(data.default_cookie_login_cookie_names)
            ? data.default_cookie_login_cookie_names
            : [],
          loginUrl: data.default_login_url || 'https://effect.douyin.com/ac/login-orion',
          action: authenticated
            ? ''
            : '请先完成 Orion 授权并点击「回传登录态」；如果仍失败，请粘贴手动 Cookie 保存。',
          health: data,
        }
      });
    } catch (e) {
      res.status(502).json({
        success: false,
        error: 'Orion 本地服务不可用: ' + e.message,
        action: '请先启动 Orion 本地服务，再重新检查状态。'
      });
    }
  });

  router.get('/health', async (req, res) => {
    try {
      const baseUrl = resolveOrionAuthBaseUrl(config);
      const { response, data } = await proxyJson(`${baseUrl}/health`);
      res.status(response.ok ? 200 : response.status).json({
        success: response.ok,
        data,
        ...(response.ok ? {} : { error: data?.error || data?.message || `Orion API HTTP ${response.status}` })
      });
    } catch (e) {
      res.status(502).json({ success: false, error: 'Orion 本地服务不可用: ' + e.message });
    }
  });

  async function proxyAuth(req, res, path) {
    try {
      const baseUrl = resolveOrionAuthBaseUrl(config);
      const body = normalizeAuthPayload(req.body || {});
      const { response, data, text } = await proxyJson(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok || data?.ok === false) {
        const explained = explainOrionError(data, text || `HTTP ${response.status}`);
        return res.status(explained.status).json({
          success: false,
          error: explained.error,
          action: explained.action,
          data: { ...data, rawError: explained.rawError }
        });
      }
      res.status(response.ok ? 200 : response.status).json({
        success: true,
        data,
      });
    } catch (e) {
      res.status(502).json({
        success: false,
        error: 'Orion 本地服务不可用: ' + e.message,
        action: '请先启动 Orion 本地服务，再重试。'
      });
    }
  }

  async function proxySetCookie(req, res) {
    const body = normalizeManualCookiePayload(req.body || {});
    if (!body.cookie_header) {
      return res.status(400).json({
        success: false,
        error: 'Cookie 不能为空',
        action: '请粘贴完整 Cookie header，例如 sessionid=...; sid_tt=...'
      });
    }
    try {
      const baseUrl = resolveOrionAuthBaseUrl(config);
      const { response, data, text } = await proxyJson(`${baseUrl}/auth/set-cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok || data?.ok === false) {
        const explained = explainOrionError(data, text || `HTTP ${response.status}`);
        return res.status(explained.status).json({
          success: false,
          error: explained.error,
          action: explained.action,
          data: { ...data, rawError: explained.rawError }
        });
      }
      res.json({ success: true, data });
    } catch (e) {
      res.status(502).json({
        success: false,
        error: 'Orion 本地服务不可用: ' + e.message,
        action: '请先启动 Orion 本地服务，再重试。'
      });
    }
  }

  router.post('/open-login', (req, res) => proxyAuth(req, res, '/auth/open-login'));
  router.post('/export-browser-cookies', (req, res) => proxyAuth(req, res, '/auth/export-browser-cookies'));
  router.post('/set-cookie', proxySetCookie);

  return router;
};

module.exports.resolveOrionAuthBaseUrl = resolveOrionAuthBaseUrl;
module.exports.normalizeAuthPayload = normalizeAuthPayload;
module.exports.normalizeManualCookiePayload = normalizeManualCookiePayload;
module.exports.extractOrionError = extractOrionError;
module.exports.explainOrionError = explainOrionError;
module.exports.isOrionLoginErrorText = isOrionLoginErrorText;
