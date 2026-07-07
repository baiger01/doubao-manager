const express = require('express');
const router = express.Router();
const fs = require('fs');
const paths = require('../paths');
const { atomicWriteJsonFile } = require('../services/json-store');
const ProxyPolicy = require('../services/proxy-policy');

// 代理管理：只服务于有地区限制的平台（如 dola）。doubao 永远直连，不暴露代理设置。
module.exports = function (config, generationService) {
  const configPath = paths.configFile;
  const policy = new ProxyPolicy(config);

  function persistConfig() {
    try {
      atomicWriteJsonFile(configPath, config, { fs });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function getPlatform(platform) {
    const platforms = config.platforms || {};
    return platforms[platform] || null;
  }

  async function probeProxy(pc, proxyUrl) {
    // 用一个最小请求打到平台的 chat/completion：
    //  - 代理连不上 -> 代理不可用
    //  - 返回 country restricted(710022003) -> 代理没绕过地区
    //  - 其它(invalid param 等) -> 平台可达，代理有效
    const url = `${pc.baseUrl}${pc.chatEndpoint}`;
    const urlObj = new URL(url);
    const probeBody = Buffer.from(JSON.stringify({ ping: 1 }), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': probeBody.length,
      'User-Agent': 'Mozilla/5.0 Chrome/149.0 Safari/537.36',
      'Origin': pc.baseUrl,
      'Referer': pc.baseUrl + '/'
    };
    const r = await generationService.httpPostViaProxy(urlObj, probeBody, headers, proxyUrl);
    const restricted = /710022003|country restricted|国家\/地区不可用/.test(r.text);
    if (restricted) throw new Error('代理生效但仍被地区限制，请换可用的海外节点');
    return { status: r.status };
  }

  // GET /api/proxy?platform=dola - 读取某平台当前代理
  router.get('/', (req, res) => {
    const platform = req.query.platform || 'dola';
    const pc = getPlatform(platform);
    if (!pc) return res.status(404).json({ success: false, error: '平台不存在' });
    res.json({ success: true, data: policy.getPublicConfig(platform) });
  });

  // POST /api/proxy - 保存某平台代理 { platform, proxy, mode }
  router.post('/', (req, res) => {
    const { platform, proxy, mode } = req.body;
    let saved;
    try {
      saved = policy.setProxy(platform, proxy, mode || (proxy ? 'manual' : 'none'));
    } catch (e) {
      const status = e.message === '平台不存在' ? 404 : 400;
      return res.status(status).json({ success: false, error: e.message });
    }
    const persisted = persistConfig();
    if (!persisted.ok) {
      return res.status(500).json({ success: false, error: '代理保存失败: ' + persisted.error.message });
    }
    res.json({ success: true, data: { ...policy.getPublicConfig(platform), ...saved } });
  });

  // POST /api/proxy/test - 测试代理能否绕过地区限制 { platform, proxy }
  // 通过给定代理访问该平台，检查是否仍被 country restricted。
  router.post('/test', async (req, res) => {
    const { platform, proxy } = req.body;
    const pc = getPlatform(platform);
    if (!pc) return res.status(404).json({ success: false, error: '平台不存在' });
    if (!policy.isProxyAllowed(platform)) {
      return res.status(400).json({ success: false, error: '豆包不允许配置代理，必须直连' });
    }
    let proxyUrl = '';
    try {
      proxyUrl = policy.validateProxyUrl(proxy || policy.getProxy(platform));
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }
    if (!proxyUrl) return res.json({ success: false, error: '未配置代理地址' });

    try {
      const r = await probeProxy(pc, proxyUrl);
      return res.json({ success: true, data: { reachable: true, status: r.status, message: '代理可用，平台可访问' } });
    } catch (e) {
      return res.json({ success: false, error: '代理连接失败: ' + e.message });
    }
  });

  // POST /api/proxy/detect - 自动检测 Dola 常见本地代理并保存 { platform }
  router.post('/detect', async (req, res) => {
    const platform = req.body.platform || 'dola';
    const pc = getPlatform(platform);
    if (!pc) return res.status(404).json({ success: false, error: '平台不存在' });
    try {
      const detected = await policy.detect(platform, async (candidate) => {
        try {
          await probeProxy(pc, candidate);
          return true;
        } catch (e) {
          return false;
        }
      });
      if (!detected) {
        return res.json({ success: false, error: '未检测到可用代理，请手动填写 Dola 可用代理' });
      }
      const persisted = persistConfig();
      if (!persisted.ok) {
        return res.status(500).json({ success: false, error: '代理保存失败: ' + persisted.error.message });
      }
      return res.json({ success: true, data: policy.getPublicConfig(platform) });
    } catch (e) {
      const status = e.message === '平台不存在' ? 404 : 400;
      return res.status(status).json({ success: false, error: e.message });
    }
  });

  return router;
};
