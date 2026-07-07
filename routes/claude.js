const express = require('express');

// Claude 文本对话路由。挂在 /api/claude(受卡密中间件保护)。
//   GET  /config            读取配置(apiKey 脱敏)
//   POST /config            保存 { baseUrl, apiKey, model, maxTokens, systemPrompt }
//   POST /models            用当前(或传入的)配置拉取模型列表
//   POST /chat              SSE 流式对话 { messages:[{role,content}], model? }
module.exports = function (claudeService) {
  const router = express.Router();

  // apiKey 脱敏:只回显首尾,避免整串泄露到前端日志
  function maskKey(k) {
    if (!k) return '';
    if (k.length <= 10) return k.slice(0, 2) + '****';
    return k.slice(0, 6) + '****' + k.slice(-4);
  }

  router.get('/config', (req, res) => {
    const c = claudeService.getConfig();
    res.json({
      success: true,
      data: {
        baseUrl: c.baseUrl,
        hasKey: !!c.apiKey,
        maskedKey: maskKey(c.apiKey),
        model: c.model,
        models: c.models,
        apiStyle: c.apiStyle,
        maxTokens: c.maxTokens,
        systemPrompt: c.systemPrompt,
        configured: c.configured,
      },
    });
  });

  router.post('/config', (req, res) => {
    const { baseUrl, apiKey, model, maxTokens, systemPrompt } = req.body || {};
    const patch = {};
    if (baseUrl !== undefined) patch.baseUrl = baseUrl;
    // 前端传空串表示不改 key(避免脱敏回显被当成新 key 覆盖);仅当非空且非脱敏串才更新
    if (apiKey !== undefined && apiKey !== '' && !/\*{2,}/.test(apiKey)) patch.apiKey = apiKey;
    if (model !== undefined) patch.model = model;
    if (maxTokens !== undefined) patch.maxTokens = maxTokens;
    if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt;
    const c = claudeService.saveConfig(patch);
    res.json({ success: true, data: { model: c.model, maxTokens: c.maxTokens, configured: c.configured } });
  });

  router.post('/models', async (req, res) => {
    // 允许先带着未保存的 baseUrl/apiKey 试拉(方便"填完就点获取模型")
    const { baseUrl, apiKey } = req.body || {};
    const patch = {};
    if (baseUrl) patch.baseUrl = baseUrl;
    if (apiKey && !/\*{2,}/.test(apiKey)) patch.apiKey = apiKey;
    if (Object.keys(patch).length) claudeService.saveConfig(patch);
    const r = await claudeService.fetchModels();
    if (r.success) res.json({ success: true, data: r.data });
    else res.status(400).json(r);
  });

  router.post('/chat', (req, res) => {
    const { messages, model } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: '缺少 messages' });
    }

    // SSE 响应头
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    };

    const abort = claudeService.chatStream(messages, {
      model,
      onDelta: (t) => send('delta', { text: t }),
      onDone: (full) => { send('done', { text: full }); try { res.end(); } catch (e) {} },
      onError: (msg) => { send('error', { message: msg }); try { res.end(); } catch (e) {} },
    });

    // 客户端断开(切走/关闭)时中止上游请求,避免僵尸连接
    req.on('close', () => { try { abort(); } catch (e) {} });
  });

  return router;
};
