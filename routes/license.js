const express = require('express');
const router = express.Router();

module.exports = function (licenseManager) {
  // GET /api/license/status — 始终可访问
  router.get('/status', (req, res) => {
    res.json({ success: true, data: licenseManager.getStatus() });
  });

  // POST /api/license/activate — 提交卡密激活
  router.post('/activate', async (req, res) => {
    try {
      const { key } = req.body;
      if (!key || !key.trim()) {
        return res.status(400).json({ success: false, error: 'empty_key', message: '请输入卡密' });
      }
      const result = await licenseManager.activate(key.trim());
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  // POST /api/license/verify — 手动触发验证
  router.post('/verify', async (req, res) => {
    try {
      const result = await licenseManager.verify();
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: 'server_error', message: e.message });
    }
  });

  return router;
};
