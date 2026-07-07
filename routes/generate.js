const express = require('express');
const router = express.Router();
const ResultPersistenceService = require('../services/result-persistence-service');
const { submitGenerationJob } = require('../services/generation-job-submitter');

module.exports = function(generationService, accountManager, quotaPoller, broadcast, conversationManager, jobManager, mediaDownloader, resultPersistenceService) {
  const resultPersistence = resultPersistenceService || new ResultPersistenceService(conversationManager, mediaDownloader);

  // 把结果落库到当前账号的当前会话
  // 关键：先把无水印 CDN 链接（会过期）下载到本地，会话里存本地路径，保证历史永不失效。
  // 下载失败的单条保留原链接兜底（至少当次能看）。整段异步，不阻塞 WS 推送给前端的实时秒显。
  function saveResult(platform, accountId, conversationId, prompt, type, results) {
    return resultPersistence.saveResult({ platform, accountId, conversationId, prompt, type, results });
  }

  // POST /api/generate/upload-reference - 上传参考图并返回豆包 imageUri
  router.post('/upload-reference', async (req, res) => {
    try {
      const { dataUrl, name, platform, accountId } = req.body;
      if (!dataUrl) return res.status(400).json({ success: false, error: '缺少参考图 dataUrl' });
      const data = await generationService.uploadReferenceImage({ dataUrl, name }, { platform, accountId });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/generate/image - 文生图 / 参考图生图（异步：立即返回 jobId，后台轮询，WS 推送结果）
  router.post('/image', async (req, res) => {
    try {
      const {
        prompt, ratio, style, model, platform, accountId,
        conversationId, n,
        imageUri, imageIdentifier, imageReferences, imageName, imageWidth, imageHeight, imageFormat
      } = req.body;
      if (!prompt) return res.status(400).json({ success: false, error: '缺少 prompt' });

      // 带图生图:附件透传给生成层(可选,无图时即纯文生图)
      const refs = Array.isArray(imageReferences) ? imageReferences.filter(r => r && (r.imageUri || r.dataUrl)) : [];

      submitGenerationJob({
        jobManager,
        broadcast,
        res,
        type: 'image',
        platform,
        accountId,
        prompt,
        execute: (onProgress) => generationService.generateImage(prompt, {
          ratio, style, model, platform, accountId, n, onProgress,
          imageUri, imageIdentifier, imageName, imageWidth, imageHeight, imageFormat,
          imageReferences: refs
        }),
        persistResult: (results) => saveResult(platform, accountId, conversationId, prompt, 'image', results),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/generate/video - 文生视频（异步）
  router.post('/video', async (req, res) => {
    try {
      const { prompt, ratio, duration, model, movement, movementSubject, movementDirection, platform, accountId, conversationId } = req.body;
      if (!prompt) return res.status(400).json({ success: false, error: '缺少 prompt' });

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
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/generate/image-to-video - 图生视频（异步）
  router.post('/image-to-video', async (req, res) => {
    try {
      const {
        prompt, imageUri, imageIdentifier, imageReferences, ratio, duration, imageName, imageWidth, imageHeight, imageFormat,
        model, movement, movementSubject, movementDirection, platform, accountId, conversationId
      } = req.body;
      const refs = Array.isArray(imageReferences) ? imageReferences.filter(ref => ref && ref.imageUri) : [];
      if (!imageUri && refs.length === 0) return res.status(400).json({ success: false, error: '缺少 imageUri' });

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
          imageReferences: refs,
          model, movement, movementSubject, movementDirection, platform, accountId, onProgress
        }),
        persistResult: (results) => saveResult(platform, accountId, conversationId, jobPrompt, 'video', results),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/generate/jobs - 查询进行中的任务（前端重连后恢复）
  router.get('/jobs', (req, res) => {
    res.json({ success: true, data: jobManager.list() });
  });

  return router;
};
