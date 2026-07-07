const express = require('express');
const router = express.Router();
const ProxyPolicy = require('../services/proxy-policy');

module.exports = function(accountManager, browserManager, generationService, quotaPoller, broadcast, conversationManager, jobManager, mediaDownloader, resultPersistenceService) {
  const accountRoutes = require('./accounts')(accountManager, browserManager, broadcast, conversationManager);
  const generateRoutes = require('./generate')(generationService, accountManager, quotaPoller, broadcast, conversationManager, jobManager, mediaDownloader, resultPersistenceService);
  const conversationRoutes = require('./conversations')(conversationManager);
  const proxyRoutes = require('./proxy')(accountManager.config, generationService);
  const mediaRoutes = require('./media');
  const orionRoutes = require('./orion')(accountManager.config || {});

  router.use('/accounts', accountRoutes);
  router.use('/generate', generateRoutes);
  router.use('/conversations', conversationRoutes);
  router.use('/proxy', proxyRoutes);
  router.use('/media', mediaRoutes);
  router.use('/orion', orionRoutes);

  // GET /api/status
  router.get('/status', (req, res) => {
    const activeAccount = accountManager.getActive();
    // 暴露平台元数据给前端（label/模型/风格/比例选项），不含敏感信息
    const platformsCfg = (accountManager.config && accountManager.config.platforms) || {};
    const proxyPolicy = new ProxyPolicy(accountManager.config || {});
    const platforms = Object.entries(platformsCfg).map(([key, p]) => {
      const proxy = proxyPolicy.getPublicConfig(key);
      return {
        key,
        label: p.label || key,
        videoModels: p.videoModels || [],
        imageModels: p.imageModels || [],
        requiresAccount: p.requiresAccount !== false,
        supportsImage: p.supportsImage !== false && Array.isArray(p.imageModels) && p.imageModels.length > 0,
        supportsVideo: p.supportsVideo !== false && Array.isArray(p.videoModels) && p.videoModels.length > 0,
        supportsReferenceImages: p.supportsReferenceImages === true || key === 'plus' || key === '4k',
        hasImageApi: !!(p.imageApi && p.imageApi.type === 'openai-compatible'),
        hasVideoApi: !!(p.videoApi && p.videoApi.type === 'orion-local'),
        needsProxy: proxy.allowed,
        proxyAllowed: proxy.allowed,
        proxyMode: proxy.mode,
        proxy: proxy.proxy
      };
    });
    res.json({
      success: true,
      data: {
        platforms,
        activeAccount: activeAccount ? {
          id: activeAccount.id,
          name: activeAccount.name,
          platform: activeAccount.platform || 'doubao',
          quota: activeAccount.quota,
          session: activeAccount.session ? {
            cookies: !!activeAccount.session.cookies,
            device_id: activeAccount.session.device_id || ''
          } : null
        } : null,
        totalAccounts: accountManager.getAll().length
      }
    });
  });

  // GET /api/quota
  router.get('/quota', (req, res) => {
    const status = quotaPoller.getQuotaStatus();
    res.json({ success: true, data: status });
  });

  return router;
};
