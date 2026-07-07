const express = require('express');
const router = express.Router();

module.exports = function(conversationManager) {

  // GET /api/conversations - 获取所有会话（按平台为主；accountId 仅兼容保留）
  router.get('/', (req, res) => {
    const { platform } = req.query;
    let data = conversationManager.getAll(platform, '');
    if (platform && data.length === 0 && typeof conversationManager.ensureActive === 'function') {
      const conv = conversationManager.ensureActive(platform, '');
      data = conv ? [{ ...conv, isActive: true }] : [];
    }
    res.json({ success: true, data });
  });

  // GET /api/conversations/active - 获取当前会话（按平台为主；accountId 仅兼容保留）
  router.get('/active', (req, res) => {
    const { platform } = req.query;
    const conv = platform && typeof conversationManager.ensureActive === 'function'
      ? conversationManager.ensureActive(platform, '')
      : conversationManager.getActive(platform, '');
    res.json({ success: true, data: conv });
  });

  // GET /api/conversations/:id/results - 获取会话的生成结果
  router.get('/:id/results', (req, res) => {
    const results = conversationManager.getResults(req.params.id);
    res.json({ success: true, data: results });
  });

  // POST /api/conversations - 新建会话（平台作用域；accountId 仅兼容保留）
  router.post('/', (req, res) => {
    const { name, platform } = req.body;
    const conv = conversationManager.create(name, platform || 'doubao', '');
    res.json({ success: true, data: conv });
  });

  // POST /api/conversations/:id/activate - 切换到指定会话
  router.post('/:id/activate', (req, res) => {
    try {
      const conv = conversationManager.setActive(req.params.id);
      res.json({ success: true, data: conv });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // PUT /api/conversations/:id - 重命名
  router.put('/:id', (req, res) => {
    try {
      const conv = conversationManager.rename(req.params.id, req.body.name);
      res.json({ success: true, data: conv });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/conversations/:id - 删除会话
  router.delete('/:id', (req, res) => {
    try {
      conversationManager.remove(req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/conversations - 清空所有会话
  router.delete('/', (req, res) => {
    conversationManager.clear();
    res.json({ success: true });
  });

  return router;
};
