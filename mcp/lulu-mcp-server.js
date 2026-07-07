#!/usr/bin/env node
'use strict';

/*
 * lulu MCP stdio 垫片(零依赖)
 * ------------------------------------------------------------
 * 供 Codex / Claude 等 AI IDE 以子进程方式拉起,通过 stdio 走 JSON-RPC。
 * 本进程只做转发:把 MCP 的 tools/call 翻译成对 lulu 本地 /ext 接口的 HTTP 调用。
 *
 * 环境变量:
 *   LULU_URL   lulu ext 接口根地址,默认 http://127.0.0.1:9527/ext
 *   LULU_TOKEN api-access 令牌(lulu 设置页开启接口后生成)
 *
 * 依赖:仅 Node 内置模块(http/https/url/readline)。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const readline = require('readline');

const SERVER_NAME = 'lulu';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const BASE_URL = (process.env.LULU_URL || 'http://127.0.0.1:9527/ext').replace(/\/+$/, '');
const TOKEN = process.env.LULU_TOKEN || '';

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(BASE_URL + path);
    } catch (e) {
      reject(new Error('LULU_URL 无效: ' + BASE_URL));
      return;
    }
    const payload = body != null ? JSON.stringify(body) : null;
    const mod = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        Accept: 'application/json',
      },
    };
    if (TOKEN) options.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = mod.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* 保留原文 */ }
        resolve({ status: resp.statusCode || 0, json, text });
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(30000, () => { req.destroy(new Error('请求超时: ' + path)); });
    if (payload) req.write(payload);
    req.end();
  });
}

function explainHttpError(res) {
  if (res.status === 401 || res.status === 403) {
    return 'lulu 接口鉴权失败(401/403):请检查 LULU_TOKEN 是否与 lulu 设置页当前令牌一致。';
  }
  if (res.status === 503) {
    return 'lulu 接口未开启(503):请在 lulu 设置页「接口/MCP」中打开开关。';
  }
  if (res.status === 0) {
    return '无法连接 lulu(' + BASE_URL + '):请确认 lulu 已启动。';
  }
  const msg = res.json && (res.json.message || res.json.error);
  return 'lulu 接口返回 ' + res.status + (msg ? ': ' + msg : '');
}

// 提交异步任务并轮询到完成
async function submitAndWait(path, body) {
  const submit = await httpRequest('POST', path, body);
  if (submit.status !== 200 || !submit.json || submit.json.success !== true) {
    throw new Error(explainHttpError(submit));
  }
  const jobId = submit.json.data && submit.json.data.jobId;
  if (!jobId) throw new Error('提交成功但未返回 jobId');

  const started = Date.now();
  for (;;) {
    if (Date.now() - started > POLL_MAX_MS) {
      throw new Error('任务超时(15 分钟未完成),jobId=' + jobId);
    }
    await sleep(POLL_INTERVAL_MS);
    const poll = await httpRequest('GET', '/v1/jobs/' + encodeURIComponent(jobId));
    if (poll.status !== 200 || !poll.json || poll.json.success !== true) {
      throw new Error(explainHttpError(poll));
    }
    const data = poll.json.data || {};
    if (data.status === 'done') return data;
    if (data.status === 'failed' || data.status === 'error') {
      throw new Error('任务失败: ' + (data.error || data.message || '未知错误'));
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'generate_image',
    description: '用豆包/Dola 生成图片。提交后台任务并等待完成,返回图片 URL 列表。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述提示词' },
        platform: { type: 'string', enum: ['doubao', 'dola'], description: '平台,默认 doubao' },
        ratio: { type: 'string', description: '画面比例,如 1:1 / 16:9 / 9:16,默认 1:1' },
        accountId: { type: 'string', description: '指定账号 ID(可选)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description: '用豆包/Dola 生成视频。提交后台任务并等待完成,返回视频 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频描述提示词' },
        platform: { type: 'string', enum: ['doubao', 'dola'], description: '平台,默认 doubao' },
        ratio: { type: 'string', description: '画面比例,如 16:9 / 9:16,默认 16:9' },
        accountId: { type: 'string', description: '指定账号 ID(可选)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'chat_doubao',
    description: '与豆包进行多轮对话。首轮不传 chatId 会新建会话并返回 chatId;后续把 chatId 带上即可延续上下文。newConversation=true 可强制开新会话。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '本轮要说的话' },
        chatId: { type: 'string', description: '延续会话用的 chatId(首轮留空)' },
        newConversation: { type: 'boolean', description: '是否强制新建会话,默认 false' },
        accountId: { type: 'string', description: '指定账号 ID(可选)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_status',
    description: '查询 lulu 接口状态(是否在线、可用账号数量、额度等)。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_accounts',
    description: '列出 lulu 当前可用的账号。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_jobs',
    description: '列出最近的后台任务及其状态。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数,默认 10' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'generate_image': {
      if (!args.prompt) throw new Error('缺少 prompt');
      const data = await submitAndWait('/v1/images', {
        prompt: args.prompt,
        platform: args.platform || 'doubao',
        ratio: args.ratio || '1:1',
        accountId: args.accountId,
      });
      const urls = (data.results && (data.results.images || data.results.urls)) || data.images || [];
      return textResult(formatMedia('图片', urls, data));
    }
    case 'generate_video': {
      if (!args.prompt) throw new Error('缺少 prompt');
      const data = await submitAndWait('/v1/videos', {
        prompt: args.prompt,
        platform: args.platform || 'doubao',
        ratio: args.ratio || '16:9',
        accountId: args.accountId,
      });
      const urls = (data.results && (data.results.videos || data.results.urls)) || data.videos || [];
      return textResult(formatMedia('视频', urls, data));
    }
    case 'chat_doubao': {
      if (!args.prompt) throw new Error('缺少 prompt');
      const data = await submitAndWait('/v1/messages', {
        prompt: args.prompt,
        chatId: args.chatId,
        newConversation: !!args.newConversation,
        platform: 'doubao',
        accountId: args.accountId,
      });
      const reply = data.reply || (data.results && data.results.reply) || '(无回复)';
      const chatId = data.chatId || (data.results && data.results.chatId) || args.chatId || '';
      let out = reply;
      if (chatId) out += '\n\n[chatId=' + chatId + '](下一轮带上它即可延续对话)';
      return textResult(out);
    }
    case 'get_status': {
      const res = await httpRequest('GET', '/v1/status');
      if (res.status !== 200 || !res.json) throw new Error(explainHttpError(res));
      return textResult(JSON.stringify(res.json.data || res.json, null, 2));
    }
    case 'list_accounts': {
      const res = await httpRequest('GET', '/v1/accounts');
      if (res.status !== 200 || !res.json) throw new Error(explainHttpError(res));
      return textResult(JSON.stringify(res.json.data || res.json, null, 2));
    }
    case 'list_jobs': {
      const limit = args.limit || 10;
      const res = await httpRequest('GET', '/v1/jobs?limit=' + encodeURIComponent(limit));
      if (res.status !== 200 || !res.json) throw new Error(explainHttpError(res));
      return textResult(JSON.stringify(res.json.data || res.json, null, 2));
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

function formatMedia(label, urls, data) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length) {
    return label + '生成完成,但未解析到 URL。原始返回:\n' + JSON.stringify(data, null, 2);
  }
  return label + '生成完成,共 ' + list.length + ' 个:\n' + list.map((u, i) => (i + 1) + '. ' + u).join('\n');
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;

    case 'notifications/initialized':
      return; // 通知,无需回复

    case 'ping':
      if (!isNotification) sendResult(id, {});
      return;

    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      try {
        const result = await callTool(toolName, toolArgs);
        sendResult(id, result);
      } catch (err) {
        // 工具错误按 MCP 约定放到 result.isError,便于模型看到原因
        sendResult(id, {
          content: [{ type: 'text', text: '调用失败: ' + (err && err.message ? err.message : String(err)) }],
          isError: true,
        });
      }
      return;
    }

    default:
      if (!isNotification) sendError(id, -32601, '方法未实现: ' + method);
      return;
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      return; // 忽略非 JSON 行
    }
    Promise.resolve(handleMessage(msg)).catch((err) => {
      const id = msg && msg.id;
      if (id !== undefined && id !== null) {
        sendError(id, -32603, '内部错误: ' + (err && err.message ? err.message : String(err)));
      }
    });
  });
  rl.on('close', () => process.exit(0));
}

main();
