const fs = require('fs');
const paths = require('../paths');
const { atomicWriteJsonFile } = require('./json-store');

// Claude 文本对话服务。
// 支持两种上游协议(拉取模型时自动探测,聊天时按探测结果走):
//   - anthropic:  官方 https://api.anthropic.com,鉴权头 x-api-key + anthropic-version
//   - openai:     OpenAI 兼容中转(大量国内 Claude 中转站走这个),鉴权头 Authorization: Bearer
// 出站 HTTP 用 Node 原生 https/http(与 license-manager 一致,不引第三方依赖),
// 聊天走 SSE 流式,逐段回调 onDelta。
class ClaudeService {
  constructor(config) {
    this.config = config;
    if (!this.config.claude) {
      this.config.claude = { baseUrl: 'https://api.anthropic.com', apiKey: '', model: '', models: [], maxTokens: 4096, systemPrompt: '' };
    }
  }

  _c() { return this.config.claude; }

  _persist() {
    try {
      atomicWriteJsonFile(paths.configFile, this.config, { fs });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 归一化 baseUrl:去尾斜杠;若已以 /v1 结尾则去掉,避免与后续拼接的 /v1/... 重复
  _base() {
    let b = String(this._c().baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
    if (/\/v1$/i.test(b)) b = b.slice(0, -3);
    return b;
  }

  getConfig() {
    const c = this._c();
    return {
      baseUrl: c.baseUrl || 'https://api.anthropic.com',
      apiKey: c.apiKey || '',
      apiStyle: c.apiStyle || 'auto',
      model: c.model || '',
      models: Array.isArray(c.models) ? c.models : [],
      maxTokens: c.maxTokens || 4096,
      systemPrompt: c.systemPrompt || '',
      configured: !!(c.apiKey && c.model),
    };
  }

  saveConfig(patch) {
    const c = this._c();
    if (patch.baseUrl !== undefined) c.baseUrl = String(patch.baseUrl || '').trim() || 'https://api.anthropic.com';
    if (patch.apiKey !== undefined) c.apiKey = String(patch.apiKey || '').trim();
    if (patch.model !== undefined) c.model = String(patch.model || '').trim();
    if (patch.maxTokens !== undefined) {
      const n = parseInt(patch.maxTokens, 10);
      if (!isNaN(n) && n > 0) c.maxTokens = Math.min(n, 200000);
    }
    if (patch.systemPrompt !== undefined) c.systemPrompt = String(patch.systemPrompt || '');
    this._persist();
    return this.getConfig();
  }

  // 拉取模型列表。先按 anthropic 探测,401/404/协议不符再回退 openai。
  // 成功后把模型列表与探测到的 apiStyle 写入配置。返回 { success, data:{models,apiStyle} } 或 { success:false, error }
  async fetchModels() {
    const c = this._c();
    if (!c.apiKey) return { success: false, error: 'no_key', message: '请先填写 API Key' };

    // 优先按官方域名 / anthropic 协议尝试
    const preferAnthropic = /anthropic/i.test(this._base()) || c.apiStyle === 'anthropic';
    const order = preferAnthropic ? ['anthropic', 'openai'] : ['openai', 'anthropic'];

    let lastErr = null;
    for (const style of order) {
      try {
        const res = await this._getModels(style);
        if (res.success && res.models.length > 0) {
          c.models = res.models;
          c.apiStyle = style;
          // 若尚未选择模型,默认选第一个
          if (!c.model && res.models[0]) c.model = res.models[0].id;
          this._persist();
          return { success: true, data: { models: res.models, apiStyle: style, model: c.model } };
        }
        lastErr = res.error || 'empty';
      } catch (e) {
        lastErr = e.message;
      }
    }
    return { success: false, error: 'fetch_failed', message: '拉取模型失败: ' + (lastErr || '未知错误') + '(请检查 Base URL 与 API Key)' };
  }

  _headers(style) {
    const c = this._c();
    if (style === 'openai') {
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey };
    }
    return { 'Content-Type': 'application/json', 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' };
  }

  async _getModels(style) {
    const resp = await this._requestJson('GET', '/v1/models', null, this._headers(style));
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
    const body = resp.json;
    let list = [];
    if (body && Array.isArray(body.data)) {
      list = body.data.map(m => ({ id: m.id, label: m.display_name || m.id }));
    } else if (Array.isArray(body)) {
      list = body.map(m => ({ id: m.id || m, label: m.display_name || m.id || String(m) }));
    }
    // OpenAI 兼容站会混入大量非 claude 模型;若能识别则优先展示 claude,但不强制过滤
    return { success: true, models: list };
  }

  // 流式对话。messages: [{role:'user'|'assistant', content}]。回调 onDelta(textChunk) / onDone(fullText) / onError(msg)。
  // 返回可调用的 abort 函数。
  chatStream(messages, opts = {}) {
    const c = this._c();
    const style = c.apiStyle === 'openai' ? 'openai' : 'anthropic';
    const model = opts.model || c.model;
    const onDelta = opts.onDelta || (() => {});
    const onDone = opts.onDone || (() => {});
    const onError = opts.onError || (() => {});

    if (!c.apiKey) { onError('未配置 API Key'); return () => {}; }
    if (!model) { onError('未选择模型'); return () => {}; }

    let path, payload;
    if (style === 'openai') {
      path = '/v1/chat/completions';
      const msgs = [];
      if (c.systemPrompt) msgs.push({ role: 'system', content: c.systemPrompt });
      messages.forEach(m => msgs.push({ role: m.role, content: m.content }));
      payload = { model, messages: msgs, max_tokens: c.maxTokens || 4096, stream: true };
    } else {
      path = '/v1/messages';
      payload = {
        model,
        max_tokens: c.maxTokens || 4096,
        stream: true,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      };
      if (c.systemPrompt) payload.system = c.systemPrompt;
    }

    return this._streamSSE('POST', path, payload, this._headers(style), style, { onDelta, onDone, onError });
  }

  // ---- 底层 HTTP ----

  _requestJson(method, path, body, headers) {
    const url = this._base() + path;
    const mod = url.startsWith('https') ? require('https') : require('http');
    const proxyAgent = this._proxyAgent(url);
    return new Promise((resolve) => {
      let req;
      const options = { method, headers: headers || {} };
      if (proxyAgent) options.agent = proxyAgent;
      const data = body ? JSON.stringify(body) : null;
      if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
      try {
        req = mod.request(url, options, (res) => {
          let raw = '';
          res.on('data', (d) => { raw += d; });
          res.on('end', () => {
            let json = null;
            try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw });
          });
        });
      } catch (e) {
        return resolve({ ok: false, status: 0, error: e.message });
      }
      req.setTimeout(30000, () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, error: 'timeout' }); });
      req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
      if (data) req.write(data);
      req.end();
    });
  }

  _streamSSE(method, path, body, headers, style, cb) {
    const url = this._base() + path;
    const mod = url.startsWith('https') ? require('https') : require('http');
    const proxyAgent = this._proxyAgent(url);
    const data = JSON.stringify(body);
    let aborted = false;
    let req = null;
    let full = '';

    const options = { method, headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(data) }) };
    if (proxyAgent) options.agent = proxyAgent;

    try {
      req = mod.request(url, options, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let raw = '';
          res.on('data', (d) => { raw += d; });
          res.on('end', () => {
            let msg = `HTTP ${res.statusCode}`;
            try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error)) || j.message || msg; } catch (e) { if (raw) msg += ': ' + raw.slice(0, 200); }
            if (!aborted) cb.onError(String(msg));
          });
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk) => {
          if (aborted) return;
          buffer += chunk;
          let idx;
          // SSE 以空行分隔事件;按行解析 data: 负载
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let evt;
            try { evt = JSON.parse(payload); } catch (e) { continue; }
            const piece = this._extractDelta(evt, style);
            if (piece) { full += piece; cb.onDelta(piece); }
          }
        });
        res.on('end', () => { if (!aborted) cb.onDone(full); });
        res.on('error', (e) => { if (!aborted) cb.onError(e.message); });
      });
    } catch (e) {
      cb.onError(e.message);
      return () => {};
    }

    req.setTimeout(300000, () => { if (!aborted) { aborted = true; try { req.destroy(); } catch (e) {} cb.onError('请求超时'); } });
    req.on('error', (e) => { if (!aborted) cb.onError(e.message); });
    req.write(data);
    req.end();

    return () => { aborted = true; try { req.destroy(); } catch (e) {} };
  }

  _extractDelta(evt, style) {
    if (style === 'openai') {
      const d = evt.choices && evt.choices[0] && evt.choices[0].delta;
      return (d && d.content) || '';
    }
    // anthropic: content_block_delta -> delta.text
    if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
      return evt.delta.text || '';
    }
    return '';
  }

  // 若配置了平台级代理可复用;此处 Claude 独立,暂不接代理(留扩展位)
  _proxyAgent() { return null; }
}

module.exports = ClaudeService;
