const express = require('express');
const pkg = require('../package.json');
const ResultPersistenceService = require('../services/result-persistence-service');
const { submitGenerationJob } = require('../services/generation-job-submitter');

// 对外 API:供外部 AI IDE / agent 调用本软件能力。
// 独立挂载于 /ext,自带 token 鉴权 + CORS。按用户要求:不受卡密限制。
module.exports = function (deps) {
  const {
    accountManager, generationService, quotaPoller, conversationManager,
    jobManager, mediaDownloader, broadcast, apiTokenManager, resultPersistenceService
  } = deps;
  const router = express.Router();
  const resultPersistence = resultPersistenceService || new ResultPersistenceService(conversationManager, mediaDownloader);

  // ---- CORS:允许任意来源带 Authorization 调用 ----
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ---- ping:健康检查,不需要 token,仅反映开关与版本 ----
  router.get('/ping', (req, res) => {
    res.json({
      success: true,
      data: {
        service: 'lulu',
        enabled: apiTokenManager.isEnabled(),
        version: pkg.version,
        time: new Date().toISOString()
      }
    });
  });

  // ---- 鉴权中间件:开关关闭 → 503;token 缺失/错误 → 401 ----
  router.use((req, res, next) => {
    if (!apiTokenManager.isEnabled()) {
      return res.status(503).json({ success: false, error: 'api_disabled', message: '对外 API 未开启' });
    }
    const auth = req.headers['authorization'] || '';
    let token = '';
    if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
    if (!token && req.query.token) token = String(req.query.token);
    if (!apiTokenManager.verify(token)) {
      return res.status(401).json({ success: false, error: 'unauthorized', message: 'token 无效或缺失' });
    }
    next();
  });

  // 鉴权通过后才解析 JSON body:避免未授权请求的大 body 被无谓解析拖慢主线程
  router.use(express.json({ limit: '25mb' }));

  // 把结果落库到当前账号的当前会话(复用 generate.js 的逻辑)
  function saveResult(platform, accountId, conversationId, prompt, type, results) {
    return resultPersistence.saveResult({ conversationId, platform, accountId, prompt, type, results });
  }

  // ---- GET /ext/v1/status:平台 + 当前账号 + 额度 ----
  router.get('/v1/status', (req, res) => {
    const activeAccount = accountManager.getActive();
    const platformsCfg = (accountManager.config && accountManager.config.platforms) || {};
    const platforms = Object.entries(platformsCfg).map(([key, p]) => ({
      key, label: p.label || key,
      videoModels: p.videoModels || [],
      imageModels: p.imageModels || [],
      requiresAccount: p.requiresAccount !== false,
      supportsImage: p.supportsImage !== false && Array.isArray(p.imageModels) && p.imageModels.length > 0,
      supportsVideo: p.supportsVideo !== false && Array.isArray(p.videoModels) && p.videoModels.length > 0,
      supportsReferenceImages: p.supportsReferenceImages === true || key === 'plus' || key === '4k',
      hasImageApi: !!(p.imageApi && p.imageApi.type === 'openai-compatible'),
      hasVideoApi: !!(p.videoApi && p.videoApi.type === 'orion-local')
    }));
    res.json({
      success: true,
      data: {
        platforms,
        activeAccount: activeAccount ? {
          id: activeAccount.id, name: activeAccount.name,
          platform: activeAccount.platform || 'doubao', quota: activeAccount.quota
        } : null,
        quota: quotaPoller.getQuotaStatus(),
        totalAccounts: accountManager.getAll().length
      }
    });
  });

  // ---- GET /ext/v1/accounts:账号列表(脱敏,不含 cookie) ----
  router.get('/v1/accounts', (req, res) => {
    const list = accountManager.getAll().map(a => ({
      id: a.id, name: a.name, platform: a.platform || 'doubao',
      isActive: !!a.isActive, quota: a.quota || null
    }));
    res.json({ success: true, data: list });
  });

  // ---- POST /ext/v1/images:文生图(异步,返回 jobId) ----
  router.post('/v1/images', (req, res) => {
    try {
      const { prompt, ratio, style, model, platform, accountId, conversationId } = req.body || {};
      if (!prompt) return res.status(400).json({ success: false, error: 'missing_prompt', message: '缺少 prompt' });
      submitGenerationJob({
        jobManager,
        broadcast,
        res,
        type: 'image',
        platform,
        accountId,
        prompt,
        execute: (onProgress) => generationService.generateImage(prompt, { ratio, style, model, platform, accountId, onProgress }),
        persistResult: (results) => saveResult(platform, accountId, conversationId, prompt, 'image', results),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  // ---- POST /ext/v1/videos:文生视频(异步) ----
  router.post('/v1/videos', (req, res) => {
    try {
      const { prompt, ratio, duration, model, movement, movementSubject, movementDirection, platform, accountId, conversationId } = req.body || {};
      if (!prompt) return res.status(400).json({ success: false, error: 'missing_prompt', message: '缺少 prompt' });
      submitGenerationJob({
        jobManager,
        broadcast,
        res,
        type: 'video',
        platform,
        accountId,
        prompt,
        execute: (onProgress) => generationService.generateVideo(prompt, {
          ratio, duration, model, movement, movementSubject, movementDirection, platform, accountId, onProgress
        }),
        persistResult: (results) => saveResult(platform, accountId, conversationId, prompt, 'video', results),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  // ---- POST /ext/v1/image-to-video:图生视频(异步) ----
  router.post('/v1/image-to-video', (req, res) => {
    try {
      const {
        prompt, imageUri, imageIdentifier, imageReferences, ratio, duration,
        imageName, imageWidth, imageHeight, imageFormat,
        model, movement, movementSubject, movementDirection, platform, accountId, conversationId
      } = req.body || {};
      const refs = Array.isArray(imageReferences) ? imageReferences.filter(r => r && r.imageUri) : [];
      if (!imageUri && refs.length === 0) return res.status(400).json({ success: false, error: 'missing_image', message: '缺少 imageUri' });
      const jobPrompt = prompt || '图生视频';
      submitGenerationJob({
        jobManager,
        broadcast,
        res,
        type: 'video',
        platform,
        accountId,
        prompt: jobPrompt,
        execute: (onProgress) => generationService.generateImageToVideo(prompt, imageUri || refs[0].imageUri, {
          ratio, duration, imageName, imageIdentifier, imageWidth, imageHeight, imageFormat,
          imageReferences: refs, model, movement, movementSubject, movementDirection, platform, accountId, onProgress
        }),
        persistResult: (results) => saveResult(platform, accountId, conversationId, jobPrompt, 'video', results),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  // ---- POST /ext/v1/messages:纯文本对话(异步,多轮)----
  // body: { prompt, chatId?, newConversation?, platform?, accountId? }
  //   chatId 续聊已有对话;不传或 newConversation=true 则新建。
  // 完成后 GET /v1/jobs/:id 返回 { reply, chatId, conversationId }。
  router.post('/v1/messages', (req, res) => {
    try {
      const { prompt, chatId, newConversation, platform, accountId } = req.body || {};
      if (!prompt) return res.status(400).json({ success: false, error: 'missing_prompt', message: '缺少 prompt' });
      submitGenerationJob({
        jobManager,
        broadcast,
        res,
        type: 'message',
        platform,
        accountId,
        prompt,
        execute: (onProgress) => generationService.generateMessage(prompt, { chatId, newConversation, platform, accountId, onProgress }),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  // ---- POST /ext/v1/upload-reference:上传参考图,返回 imageUri ----
  router.post('/v1/upload-reference', async (req, res) => {
    try {
      const { dataUrl, name, platform, accountId } = req.body || {};
      if (!dataUrl) return res.status(400).json({ success: false, error: 'missing_data', message: '缺少 dataUrl' });
      const data = await generationService.uploadReferenceImage({ dataUrl, name }, { platform, accountId });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  // ---- GET /ext/v1/jobs:进行中/最近完成的任务列表 ----
  router.get('/v1/jobs', (req, res) => {
    res.json({ success: true, data: jobManager.list() });
  });

  // ---- GET /ext/v1/jobs/:id:单任务状态/结果(轮询用,完成后保留 10 分钟) ----
  router.get('/v1/jobs/:id', (req, res) => {
    const job = jobManager.get(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'job_not_found', message: '任务不存在或已过期' });
    res.json({
      success: true,
      data: {
        id: job.id, type: job.type, status: job.status, prompt: job.prompt,
        platform: job.platform, createdAt: job.createdAt,
        images: job.result?.images || [], videos: job.result?.videos || [],
        brief: job.result?.brief || '', error: job.error || null,
        persisted: job.persisted,
        persistError: job.persistError,
        // 对话任务(type==='message')额外回传会话标识,供外部续聊
        reply: job.result?.reply || job.result?.brief || '',
        chatId: job.result?.chatId || null,
        conversationId: job.result?.conversationId || null
      }
    });
  });

  // ---- GET /ext/v1/conversations/:id/results ----
  router.get('/v1/conversations/:id/results', (req, res) => {
    try {
      const results = conversationManager.getResults(req.params.id);
      res.json({ success: true, data: results || [] });
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  return router;
};
