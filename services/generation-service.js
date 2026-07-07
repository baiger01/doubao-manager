const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const appPaths = require('../paths');
const { readJsonFile, atomicWriteJsonFile } = require('./json-store');
const ProxyPolicy = require('./proxy-policy');
const promptBuilder = require('./generation/prompt-builder');
const orionVideo = require('./generation/orion-video-service');

function createChunkedDecoder() {
  let buffer = Buffer.alloc(0);
  let done = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (done) return callback();
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      try {
        while (buffer.length > 0) {
          const nl = buffer.indexOf('\r\n');
          if (nl < 0) break;
          const sizeHex = buffer.slice(0, nl).toString('latin1').trim();
          const size = parseInt(sizeHex, 16);
          if (Number.isNaN(size)) return callback(new Error('无效的 chunked 响应'));
          if (buffer.length < nl + 2 + size + 2) break;
          if (size === 0) {
            done = true;
            buffer = Buffer.alloc(0);
            break;
          }
          const start = nl + 2;
          this.push(buffer.slice(start, start + size));
          buffer = buffer.slice(start + size + 2);
        }
        callback();
      } catch (e) {
        callback(e);
      }
    },
    flush(callback) {
      callback();
    }
  });
}

const IMAGE_STYLE_LABELS = Object.freeze({
  skill_image_styles_portrait: '人像摄影',
  skill_image_styles_film: '电影写真',
  skill_image_styles_chinese: '中国风',
  skill_image_styles_japanese_anime: '动漫',
  skill_image_styles_3d: '3D渲染',
  image_gen_style_cyberpunk: '赛博朋克',
  skill_image_styles_cg: 'CG 动画',
  skill_image_styles_ink_wash_painting: '水墨画',
  skill_image_styles_oil_painting: '油画',
  skill_image_styles_classic: '古典',
  skill_image_styles_watercolor: '水彩画',
  skill_image_styles_cartoon: '卡通',
  skill_image_styles_flat_illustration: '平面插画',
  skill_image_styles_landscape: '风景',
  skill_image_styles_hongkong_anime: '港风动漫',
  skill_image_styles_pixel_style: '像素风格',
  skill_image_styles_fluorescence: '荧光绘画',
  skill_image_styles_colored_pencil: '彩铅画',
  skill_image_styles_figure: '手办',
  skill_image_styles_children_illustration: '儿童绘画',
  skill_image_styles_abstract: '抽象',
  skill_image_styles_sharp_illustration: '锐笔插画',
  skill_image_styles_acg: '二次元',
  skill_image_styles_ink_print: '油墨印刷',
  skill_image_styles_bnw_printing: '版画',
  skill_image_styles_monet: '莫奈',
  skill_image_styles_picasso: '毕加索',
  skill_image_styles_rembrandt: '伦勃朗',
  skill_image_styles_matisse: '马蒂斯',
  skill_image_styles_baroque: '巴洛克',
  skill_image_styles_oldschool: '复古动漫',
  skill_image_styles_picturebook: '绘本'
});

const VIDEO_MOVEMENT_TEMPLATES = Object.freeze({
  fixed: '固定镜头',
  pan: '镜头环绕${subject}拍摄',
  move: '镜头往${direction}移动',
  zoom: '镜头聚焦在${subject}'
});

const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
});

class GenerationService {
  constructor(accountManager, conversationManager, config) {
    this.accounts = accountManager;
    this.conversations = conversationManager;
    this.config = config;
    // vid -> 富 video_model 字符串（含 key_seed + fallback_api），从 chain/single 轮询时暂存，
    // 供去水印 API 直接使用，避免再走贫字段的 get_play_info。
    this._videoModelStash = new Map();
    // 对外 API 的对话会话状态：与 account.session 完全隔离，避免 API 聊天污染 UI 生成的上下文。
    // 结构：chatId -> { chatId, accountId, conversation_id, section_id, last_message_index, createdAt, updatedAt }
    // 持久化到 data/chat-sessions.json，软件重启后外部 IDE 仍能凭 chatId 续聊。
    this._chatSessions = new Map();
    this._loadChatSessions();
  }

  // ===== 对外 API 对话会话状态(与 account.session 隔离)=====
  get _chatSessionsFile() { return path.join(appPaths.dataDir, 'chat-sessions.json'); }

  _loadChatSessions() {
    try {
      const arr = readJsonFile(this._chatSessionsFile, [], { fs });
      if (Array.isArray(arr)) {
        for (const s of arr) { if (s && s.chatId) this._chatSessions.set(s.chatId, s); }
      }
    } catch (e) { /* 首次无文件或解析失败:空表起步 */ }
  }

  _saveChatSessions() {
    try {
      atomicWriteJsonFile(this._chatSessionsFile, [...this._chatSessions.values()], { fs });
    } catch (e) { /* 落盘失败不阻塞对话主流程 */ }
  }

  getChatSession(chatId) { return chatId ? (this._chatSessions.get(chatId) || null) : null; }

  // 暂存某 vid 的富 video_model（去水印 API 需要它里面的 key_seed/fallback_api）
  _stashVideoModel(vid, videoModel) {
    if (!vid || !videoModel) return;
    if (this._videoModelStash.size > 200) this._videoModelStash.clear(); // 防止无限增长
    this._videoModelStash.set(vid, videoModel);
  }

  // 取出并清除某 vid 暂存的 video_model（解析后的对象，失败返回 null）
  _takeVideoModel(vid) {
    const raw = this._videoModelStash.get(vid);
    if (!raw) return null;
    this._videoModelStash.delete(vid);
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // 从富 video_model 里本地解码出无水印直链。
  // 关键发现（已抓包+实测验证）：video_model.video_list.video_N.main_url 是 base64 编码的，
  // 解码后就是带 lr=unwatermarked 的无水印直链，可直接下载（实测 206 + mp4 ftyp 头）。
  // 所谓第三方去水印 API 干的也只是这一步 base64 解码，本地做即可，不依赖外部服务。
  extractCleanUrlFromVideoModel(videoModel) {
    if (!videoModel || typeof videoModel !== 'object') return null;
    const decodeB64 = (b64) => {
      if (!b64 || typeof b64 !== 'string') return null;
      try {
        const url = Buffer.from(b64, 'base64').toString('utf-8');
        return /^https?:\/\//i.test(url) ? url : null;
      } catch (e) { return null; }
    };
    const vlist = videoModel.video_list;
    if (vlist && typeof vlist === 'object') {
      // 优先挑分辨率最高的一档（vheight*vwidth 最大），其次任意可解码的
      const entries = Object.values(vlist).filter(v => v && typeof v === 'object');
      entries.sort((a, b) =>
        ((b.vheight || 0) * (b.vwidth || 0)) - ((a.vheight || 0) * (a.vwidth || 0))
      );
      for (const v of entries) {
        const url = decodeB64(v.main_url) || decodeB64(v.backup_url_1) || decodeB64(v.backup_url);
        if (url) return url;
      }
    }
    // 没有 video_list 时，回退到 fallback_api（本身就带 logo_type=unwatermarked，是个可直接拉流的接口）
    if (typeof videoModel.fallback_api === 'string' && /^https?:\/\//i.test(videoModel.fallback_api)) {
      return videoModel.fallback_api;
    }
    return null;
  }

  // 取账号所属平台的配置（默认 doubao）。兼容旧 config.doubao 结构。
  getPlatformConfig(account) {
    const platform = (account && account.platform) || 'doubao';
    const platforms = this.config.platforms || {};
    return platforms[platform] || platforms.doubao || this.config.doubao || {};
  }

  getPlatformConfigByKey(platform) {
    const platforms = this.config.platforms || {};
    if (platform === 'gptimage' && !platforms.gptimage && platforms.plus) return platforms.plus;
    return platforms[platform] || null;
  }

  isOpenAICompatibleImagePlatform(platform) {
    const pc = this.getPlatformConfigByKey(platform || 'doubao');
    return !!(pc && pc.requiresAccount === false && pc.imageApi && pc.imageApi.type === 'openai-compatible');
  }

  isOrionVideoPlatform(platform) {
    const pc = this.getPlatformConfigByKey(platform || 'orion');
    return !!(pc && pc.requiresAccount === false && orionVideo.isOrionVideoConfig(pc.videoApi));
  }

  normalizeOpenAIImageModel(model) {
    const value = String(model || '').trim();
    if (!value) return '';
    // 用户常写 gpt-image2；该 OpenAI-compatible 服务实际模型名是 gpt-image-2。
    if (value === 'gpt-image2') return 'gpt-image-2';
    return value;
  }

  openAIImageSizeFromRatio(ratio, fallback = '') {
    const explicit = String(fallback || '').trim();
    const m = String(ratio || '').match(/(\d+)\s*[:：]\s*(\d+)/);
    if (!m) return explicit || '1024x1024';
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (!w || !h) return explicit || '1024x1024';
    const explicitSize = explicit.match(/^(\d+)x(\d+)$/i);
    if (explicitSize) {
      const ew = parseInt(explicitSize[1], 10);
      const eh = parseInt(explicitSize[2], 10);
      if (ew && eh) {
        const long = Math.max(ew, eh);
        const short = Math.min(ew, eh);
        if (h > w) return `${short}x${long}`;
        if (w > h) return `${long}x${short}`;
        return `${short}x${short}`;
      }
    }
    if (explicit) return explicit;
    if (h > w) return '1024x1536';
    if (w > h) return '1536x1024';
    return '1024x1024';
  }

  resolveOpenAIImageEndpoint(imageApi) {
    const endpoint = String(imageApi?.endpoint || '').trim();
    if (endpoint) return endpoint;
    const baseUrl = String(imageApi?.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return '';
    if (/\/v1\/images\/generations$/i.test(baseUrl)) return baseUrl;
    return `${baseUrl}/images/generations`;
  }

  resolveOpenAIImageEditEndpoint(imageApi) {
    const explicit = String(imageApi?.editEndpoint || imageApi?.editsEndpoint || '').trim();
    if (explicit) return explicit;
    const endpoint = String(imageApi?.endpoint || '').trim();
    if (/\/images\/generations$/i.test(endpoint)) return endpoint.replace(/\/images\/generations$/i, '/images/edits');
    if (/\/images\/edits$/i.test(endpoint)) return endpoint;
    const baseUrl = String(imageApi?.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return '';
    if (/\/v1\/images\/edits$/i.test(baseUrl)) return baseUrl;
    if (/\/v1\/images\/generations$/i.test(baseUrl)) return baseUrl.replace(/\/images\/generations$/i, '/images/edits');
    return `${baseUrl}/images/edits`;
  }

  supportsOpenAICompatibleReferenceImages(platform, pc) {
    return platform === 'plus' || platform === '4k' || pc?.supportsReferenceImages === true || pc?.imageApi?.supportsReferenceImages === true;
  }

  multipartToken(value) {
    return String(value || 'field').replace(/[\r\n"]/g, '_');
  }

  buildMultipartFormData(fields = {}, files = []) {
    const boundary = '----lulu-' + crypto.randomBytes(12).toString('hex');
    const chunks = [];
    const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));

    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue;
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="${this.multipartToken(name)}"\r\n\r\n`);
      push(value);
      push('\r\n');
    }

    for (const file of files) {
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="${this.multipartToken(file.field || 'image')}"; filename="${this.multipartToken(file.filename)}"\r\n`);
      push(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`);
      push(file.buffer || Buffer.alloc(0));
      push('\r\n');
    }

    push(`--${boundary}--\r\n`);
    return { boundary, body: Buffer.concat(chunks) };
  }

  writeBase64ImageResult(b64, platform = 'plus', outputFormat = '') {
    let raw = String(b64 || '').trim();
    let mime = '';
    const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/);
    if (dataUrlMatch) {
      mime = dataUrlMatch[1];
      raw = dataUrlMatch[2];
    }
    const buffer = Buffer.from(raw, 'base64');
    if (buffer.length === 0) throw new Error('图片 API 返回了空的 base64 数据');

    const fmt = String(outputFormat || '').replace(/^\./, '').toLowerCase();
    const ext = MIME_EXTENSIONS[mime] || (fmt ? `.${fmt === 'jpeg' ? 'jpg' : fmt}` : '.png');
    const dir = appPaths.resolveDownloadDir(this.config.storage && this.config.storage.downloadDir);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const rand = crypto.randomBytes(4).toString('hex');
    const safePlatform = String(platform || 'plus').replace(/[^a-z0-9_-]/gi, '');
    const fileName = `${safePlatform}_image_${stamp}_${rand}${ext}`;
    fs.writeFileSync(path.join(dir, fileName), buffer);
    return 'local://' + fileName;
  }

  parseOpenAIImageResponse(text, platform) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('图片 API 返回的不是 JSON: ' + String(text || '').slice(0, 200));
    }
    if (json.error) {
      const msg = json.error.message || json.error.error || JSON.stringify(json.error).slice(0, 300);
      throw new Error('图片 API 返回错误: ' + msg);
    }
    const items = Array.isArray(json.data) ? json.data : [];
    const images = [];
    for (const item of items) {
      if (!item) continue;
      if (item.url) {
        images.push(String(item.url));
      } else if (item.b64_json) {
        images.push(this.writeBase64ImageResult(item.b64_json, platform, item.output_format || json.output_format));
      }
    }
    if (images.length === 0) throw new Error('图片 API 未返回 url 或 b64_json');
    return {
      images,
      videos: [],
      videoKeys: [],
      quota: null,
      brief: items[0]?.revised_prompt || null,
      usage: json.usage || null
    };
  }

  async generateOpenAICompatibleImage(prompt, options = {}) {
    const platform = options.platform || 'plus';
    const pc = this.getPlatformConfigByKey(platform);
    const imageApi = pc && pc.imageApi;
    const apiKey = String(imageApi?.apiKey || '').trim();
    const model = this.normalizeOpenAIImageModel(options.model || imageApi?.model || 'gpt-image-2');
    if (!apiKey) throw new Error('自定义图片 API 未配置 API Key');
    if (!model) throw new Error('自定义图片 API 未配置模型');
    const requestedCount = parseInt(imageApi.n || options.n || 1, 10);
    const count = Math.min(4, Math.max(1, Number.isFinite(requestedCount) ? requestedCount : 1));
    const imageReferences = Array.isArray(options.imageReferences)
      ? options.imageReferences.filter(ref => ref && ref.dataUrl)
      : [];
    const promptText = this.buildImagePrompt(prompt, options);

    if (imageReferences.length > 0) {
      if (!this.supportsOpenAICompatibleReferenceImages(platform, pc)) {
        throw new Error('自定义图片 API 暂不支持参考图生图');
      }
      const editEndpoint = this.resolveOpenAIImageEditEndpoint(imageApi);
      if (!editEndpoint) throw new Error('自定义图片 API 未配置 image edit endpoint');
      const files = imageReferences.map((ref) => {
        const decoded = this.decodeReferenceImageInput(ref);
        return {
          field: 'image',
          filename: decoded.imageName,
          contentType: decoded.contentType,
          buffer: decoded.imageBuffer
        };
      });
      const repeatCount = platform === 'plus' ? count : 1;
      let completedCount = 0;
      const runReferenceEdit = async () => {
        const fields = {
          ...(imageApi.defaultParams || {}),
          model,
          prompt: promptText,
          size: this.openAIImageSizeFromRatio(options.ratio, imageApi.size)
        };
        if (platform !== 'plus') fields.n = count;
        else delete fields.n;
        if (imageApi.quality) fields.quality = imageApi.quality;
        const multipart = this.buildMultipartFormData(fields, files);
        const result = await this.httpRequest(editEndpoint, 'POST', multipart.body, {
          'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'lulu/2.0.1'
        }, { platform });
        if (result.status < 200 || result.status >= 300) {
          let message = result.text || '';
          try {
            const json = JSON.parse(result.text);
            message = json?.error?.message || json?.message || message;
          } catch (e) {}
          throw new Error(`图片 API HTTP ${result.status}: ${String(message).slice(0, 300)}`);
        }
        const parsed = this.parseOpenAIImageResponse(result.text, platform);
        completedCount += 1;
        if (repeatCount > 1 && typeof options.onProgress === 'function') {
          options.onProgress({ attempt: completedCount, total: repeatCount });
        }
        return parsed;
      };
      const parsedResults = await Promise.all(Array.from({ length: repeatCount }, () => runReferenceEdit()));
      if (parsedResults.length === 1) return parsedResults[0];
      return {
        images: parsedResults.flatMap(item => item.images || []),
        videos: [],
        videoKeys: [],
        quota: null,
        brief: parsedResults.find(item => item.brief)?.brief || null,
        usage: parsedResults.map(item => item.usage).filter(Boolean)
      };
    }

    const endpoint = this.resolveOpenAIImageEndpoint(imageApi);
    if (!endpoint) throw new Error('自定义图片 API 未配置 endpoint');

    const repeatCount = platform === 'plus' ? count : 1;
    let completedCount = 0;
    const runGeneration = async () => {
      const body = {
        ...(imageApi.defaultParams || {}),
        model,
        prompt: promptText,
        size: this.openAIImageSizeFromRatio(options.ratio, imageApi.size)
      };
      if (platform !== 'plus') body.n = count;
      else delete body.n;
      if (imageApi.quality) body.quality = imageApi.quality;
      const result = await this.httpRequest(endpoint, 'POST', Buffer.from(JSON.stringify(body), 'utf8'), {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'lulu/2.0.1'
      }, { platform });
      if (result.status < 200 || result.status >= 300) {
        let message = result.text || '';
        try {
          const json = JSON.parse(result.text);
          message = json?.error?.message || json?.message || message;
        } catch (e) {}
        throw new Error(`图片 API HTTP ${result.status}: ${String(message).slice(0, 300)}`);
      }
      const parsed = this.parseOpenAIImageResponse(result.text, platform);
      completedCount += 1;
      if (repeatCount > 1 && typeof options.onProgress === 'function') {
        options.onProgress({ attempt: completedCount, total: repeatCount });
      }
      return parsed;
    };
    const parsedResults = await Promise.all(Array.from({ length: repeatCount }, () => runGeneration()));
    if (parsedResults.length === 1) return parsedResults[0];
    return {
      images: parsedResults.flatMap(item => item.images || []),
      videos: [],
      videoKeys: [],
      quota: null,
      brief: parsedResults.find(item => item.brief)?.brief || null,
      usage: parsedResults.map(item => item.usage).filter(Boolean)
    };
  }

  async generateOrionVideo(prompt, options = {}) {
    const platform = options.platform || 'orion';
    const pc = this.getPlatformConfigByKey(platform);
    const videoApi = pc && pc.videoApi;
    if (!orionVideo.isOrionVideoConfig(videoApi)) throw new Error('Orion 视频 API 未配置');
    const endpoint = orionVideo.resolveOrionEndpoint(videoApi);
    const orionImages = Array.isArray(options.imageReferences) && options.imageReferences.length > 0
      ? this.saveOrionReferenceImages(options.imageReferences, platform)
      : [];
    const payload = orionVideo.buildOrionGeneratePayload(videoApi, prompt, {
      ...options,
      images: orionImages.length > 0 ? orionImages : options.images
    });
    if (!payload.project_dir) throw new Error('Orion 未配置 projectDir');
    if (!Array.isArray(payload.images) || payload.images.length === 0) throw new Error('Orion 未配置参考图 images');

    const result = await this.httpRequest(endpoint, 'POST', Buffer.from(JSON.stringify(payload), 'utf8'), {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'lulu/2.0.1'
    }, { platform });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(orionVideo.explainOrionGenerationError(result.status, result.text));
    }
    const json = orionVideo.parseJsonResponse(result.text, 'Orion API');
    if (typeof options.onProgress === 'function' && (json.task_id || json.taskId)) {
      options.onProgress({ reply: `Orion 已提交任务 ${json.task_id || json.taskId}，正在等待本地 API 返回结果。` });
    }
    return orionVideo.parseOrionGenerateResult(json, { config: this.config, platform });
  }

  getProxyForAccount(account) {
    const platform = (account && account.platform) || 'doubao';
    return new ProxyPolicy(this.config).getProxy(platform);
  }

  // 平台请求行为差异(数据化):各平台把自己的接口差异写进 config.platforms[x].requestProfile,
  // 共享的构造代码只读这里、不出现平台名硬判断。默认值 = 历史行为(dola 那套),
  // 因此任何未声明 requestProfile 的平台都保持原状,改一个平台不影响其它平台。
  //   preHandleEndpoint   : 图片预处理端点路径
  //   preHandleWithConv   : 预处理请求体是否携带 conversation_id / section_id
  //   sendInputSkill      : 生成请求 ext 是否携带 input_skill(dola 靠它路由到全能模型)
  getRequestProfile(account) {
    const pc = this.getPlatformConfig(account);
    const p = (pc && pc.requestProfile) || {};
    return {
      preHandleEndpoint: p.preHandleEndpoint || '/alice/message/pre_handle_v2',
      preHandleWithConv: p.preHandleWithConv !== false, // 默认带会话字段
      sendInputSkill: p.sendInputSkill !== false        // 默认发送 input_skill
    };
  }

  getPlatformLabel(account) {
    const platform = (account && account.platform) || 'doubao';
    const pc = this.getPlatformConfig(account);
    return pc.label || (platform === 'dola' ? 'Dola' : platform);
  }

  // 把比例转成模型更可靠识别的中文方位描述，避免只给 "9:16" 时模型默认横屏
  ratioOrientationText(ratio) {
    return promptBuilder.ratioOrientationText(ratio);
  }

  buildImagePrompt(prompt, options = {}) {
    return promptBuilder.buildImagePrompt(prompt, options);
  }

  buildVideoPrompt(prompt, options = {}) {
    return promptBuilder.buildVideoPrompt(prompt, options);
  }

  buildVideoMovementText(options = {}) {
    return promptBuilder.buildVideoMovementText(options);
  }

  // 把脚本里按"原始文件名编号"写的图片引用，改写成 dola 实际认的"上传顺序号"引用。
  // 规则：@imageN 的 N = 这张图在 imageReferences(上传顺序)里的位置；
  //       脚本里写的 @图片[X] / @图片【X】 的 X = 原始文件名里的数字。
  // 例：上传顺序 [1.png, 2.png, 5.png, 7.png]
  //     脚本 "@图片[1]为A @图片[2]为B @图片[5]为C @图片[7]为D"
  //  -> "@image1为A @image2为B @image3为C @image4为D"
  // 找不到匹配文件名的引用保持原样；imageReferences 为空时原样返回。
  rewriteImageReferences(prompt, imageReferences) {
    return promptBuilder.rewriteImageReferences(prompt, imageReferences);
  }

  decodeResponseUrl(url) {
    return String(url || '')
      .replace(/\\\//g, '/')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&');
  }

  addUniqueUrl(list, url) {
    const decoded = this.decodeResponseUrl(url);
    if (decoded && !list.includes(decoded)) list.push(decoded);
  }

  extractImageUrls(rawText) {
    const urls = [];
    const text = String(rawText || '');
    const patterns = [
      /image_ori_?raw[\s\S]{0,600}?url["\s:]*\\?"(https?:\\?\/\\?\/[^"\\]+(?:\\.[^"\\]+)*)\\?"/gi,
      /image_ori_?raw[\s\S]{0,600}?url["\s:]*"(https?:\/\/[^"]+)"/gi
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) this.addUniqueUrl(urls, match[1]);
    }
    if (urls.length > 0) return urls;

    const cdnPattern = /https?:\\?\/\\?\/p\d+-flow(?:-imagex)?-sign\.(?:byteimg|ibyteimg|ciciai)\.com[^"\\\s]*/gi;
    let match;
    while ((match = cdnPattern.exec(text)) !== null) {
      const url = this.decodeResponseUrl(match[0]);
      if (
        url &&
        !url.includes('BOT_ICON') &&
        !url.includes('avatar') &&
        !url.includes('icon') &&
        !/_watermark|dld_watermark|pre_watermark|downsize_watermark/.test(url)
      ) {
        this.addUniqueUrl(urls, url);
      }
    }
    return urls;
  }

  // 提取 dola/豆包在 SSE 流里逐字吐出的自然语言回复，原封不动还原。
  // 回复分散在两个通道，按文档顺序合并即为完整原话：
  //   1) CHUNK_DELTA 事件：{"text":"为"}{"text":"您"}... （开头叙述）
  //   2) STREAM_CHUNK 事件：patch_op[].patch_value.content_block[](block_type:10000).content.text_block.text （结尾的模型/耗时/剩余额度）
  // 注意：patch_object:111 的 tts_content 是语音版重复，必须排除。
  extractDolaReply(rawText) {
    const text = String(rawText || '');
    const blocks = text.split(/\r?\n\r?\n/);
    let reply = '';
    for (const blk of blocks) {
      const ev = (blk.match(/^event:\s*(\w+)/m) || [])[1] || '';
      if (ev !== 'CHUNK_DELTA' && ev !== 'STREAM_CHUNK') continue;
      const dm = blk.match(/^data:\s*(\{[\s\S]*\})\s*$/m);
      if (!dm) continue;
      let obj;
      try { obj = JSON.parse(dm[1]); } catch (e) { continue; }
      if (ev === 'CHUNK_DELTA') {
        if (typeof obj.text === 'string') reply += obj.text;
      } else {
        for (const op of (obj.patch_op || [])) {
          const cbs = op.patch_value && op.patch_value.content_block;
          if (!Array.isArray(cbs)) continue;
          for (const cb of cbs) {
            if (cb.block_type === 10000) {
              const t = cb.content && cb.content.text_block && cb.content.text_block.text;
              if (typeof t === 'string') reply += t;
            }
          }
        }
      }
    }
    return reply.trim();
  }

  detectGenerationFailure(responseText, account) {
    const text = String(responseText || '');
    const scopedText = this.extractLatestAssistantMessageText(text) || text;
    const label = this.getPlatformLabel(account);
    let code = '';
    let message = '';

    const codeMatch = scopedText.match(/"ai_creation_res_code"\s*:\s*"?(710\d+)"?/);
    if (codeMatch) code = codeMatch[1];
    const failMatch = scopedText.match(/"fail_code"\s*:\s*(710\d+)/);
    if (!code && failMatch) code = failMatch[1];
    const errorCodeMatch = scopedText.match(/"error_code"\s*:\s*(710\d+)/);
    if (!code && errorCodeMatch) code = errorCodeMatch[1];

    const streamError = scopedText.match(/"error_msg"\s*:\s*"([^"]+)"/);
    if (streamError) message = streamError[1];
    if (!message && scopedText.includes('服务过载')) message = '服务过载，请稍后重试';
    if (!message) {
      const briefMatch = scopedText.match(/"brief"\s*:\s*"([^"]+)"/);
      if (briefMatch && !/^正在|创作|生成中/.test(briefMatch[1])) message = briefMatch[1];
    }

    const toolFailed = /"tool_name"\s*:\s*"image_gen"[\s\S]{0,300}?"status"\s*:\s*5/.test(scopedText)
      || /"status"\s*:\s*5[\s\S]{0,300}?"tool_name"\s*:\s*"image_gen"/.test(scopedText);
    if ((code || message) && (code || toolFailed || /服务过载|STREAM_ERROR|error_msg/.test(scopedText))) {
      const suffix = code ? ` (${code})` : '';
      return new Error(`${label} 图片生成失败: ${message || '平台返回失败'}${suffix}`);
    }
    return null;
  }

  extractLatestAssistantMessageText(responseText) {
    try {
      const json = JSON.parse(responseText);
      const messages = json?.downlink_body?.pull_singe_chain_downlink_body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return '';
      const sorted = [...messages]
        .filter(m => m.user_type === 2)
        .sort((a, b) => (parseInt(b.index_in_conv) || 0) - (parseInt(a.index_in_conv) || 0));
      if (!sorted[0]) return '';
      return JSON.stringify(sorted[0]);
    } catch (e) {
      return '';
    }
  }

  writeCapture(account, stage, details, persistSnapshot = false) {
    if ((account?.platform || 'doubao') !== 'dola') return;
    try {
      const dir = appPaths.debugDir;
      fs.mkdirSync(dir, { recursive: true });
      const safe = {
        time: new Date().toISOString(),
        platform: account.platform || 'dola',
        stage,
        ...details
      };
      fs.writeFileSync(path.join(dir, 'dola-capture-last.json'), JSON.stringify(safe, null, 2), 'utf-8');
      if (persistSnapshot) {
        fs.writeFileSync(path.join(dir, `dola-capture-${Date.now()}-${stage}.json`), JSON.stringify(safe, null, 2), 'utf-8');
      }
    } catch (e) { /* 诊断落盘失败不影响生成 */ }
  }

  summarizeResponse(text) {
    const raw = String(text || '');
    const failure = this.detectGenerationFailure(raw, { platform: 'dola' });
    return {
      bytes: Buffer.byteLength(raw, 'utf8'),
      imageCount: this.extractImageUrls(raw).length,
      hasAck: raw.includes('SSE_ACK'),
      hasCreationBlock: raw.includes('creation_block'),
      hasServiceOverload: raw.includes('服务过载'),
      failure: failure ? failure.message : '',
      preview: raw.replace(/\s+/g, ' ').slice(0, 500)
    };
  }

  // 解析本次生成用哪个账号：优先 options.accountId，其次按 options.platform 取该平台活跃账号，
  // 最后回退到全局活跃账号。生成必须明确平台/账号，避免跨平台串号。
  resolveAccount(options = {}) {
    if (options.accountId) {
      const acc = this.accounts.getById(options.accountId);
      if (acc) return acc;
    }
    if (options.platform && typeof this.accounts.getActiveByPlatform === 'function') {
      const acc = this.accounts.getActiveByPlatform(options.platform);
      if (acc) return acc;
      // 指定了平台却找不到该平台账号：不回退到全局活跃账号，避免串到别的平台
      return null;
    }
    return this.accounts.getActive();
  }

  // 统一构建 query 参数：从平台 defaultParams 取常量 + 注入账号会话字段。
  // extra 可覆盖/补充（如部分端点不需要 fp/web_tab_id）。
  buildQuery(account, extra = {}) {
    const pc = this.getPlatformConfig(account);
    const dp = pc.defaultParams || {};
    const session = account.session || {};
    const deviceId = session.device_id || '';
    const webId = session.web_id || deviceId;
    const aid = session.aid || dp.aid || '497858';

    const params = new URLSearchParams();
    // 平台默认常量
    for (const [k, v] of Object.entries(dp)) params.set(k, v);
    // 账号会话动态字段
    params.set('aid', aid);
    params.set('real_aid', aid);
    if (deviceId) params.set('device_id', deviceId);
    if (webId) { params.set('web_id', webId); params.set('tea_uuid', webId); }
    if (session.fp) params.set('fp', session.fp);
    // 覆盖项
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      params.set(k, v);
    }
    return params;
  }

  // 把响应里的 Set-Cookie 合并回账号存储的 cookie 串，保持登录态新鲜（cookie rotation 保活）。
  // 重要：只新增/更新，绝不删除。raw HTTP 模式下保留多余旧 cookie 无害，
  // 而误删关键鉴权 cookie（sid_guard/sessionid/oauth_token 等）会直接导致"自动登出"，
  // 所以这里忽略一切删除/清空指令（Max-Age=0、空值），只把有效新值写回。
  mergeSetCookies(account, setCookies) {
    if (!account || !Array.isArray(setCookies) || setCookies.length === 0) return;
    const cookieStr = account.session?.cookies || '';
    const jar = new Map();
    // 现有 cookie 入表
    cookieStr.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) jar.set(k, v);
    });
    let changed = false;
    for (const sc of setCookies) {
      // Set-Cookie 形如 "name=value; Path=/; Expires=...; HttpOnly"，只取首段 name=value
      const first = String(sc).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const k = first.slice(0, idx).trim();
      const v = first.slice(idx + 1).trim();
      if (!k) continue;
      // 删除/清空指令一律忽略：不删除已有 cookie，也不用空值覆盖
      const isDeleteOrEmpty = v === '' || v.toLowerCase() === 'deleted'
        || /(?:^|;)\s*max-age\s*=\s*0\b/i.test(sc)
        || /expires=Thu,\s*01 Jan 1970/i.test(sc);
      if (isDeleteOrEmpty) continue;
      if (jar.get(k) !== v) { jar.set(k, v); changed = true; }
    }
    if (!changed) return;
    const merged = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    try {
      this.accounts.update(account.id, { session: { ...account.session, cookies: merged } });
      account.session.cookies = merged;
    } catch (e) { /* 更新失败不影响主流程 */ }
  }

  // 直接 HTTPS 请求，返回完整 SSE 文本
  // extraHeaders: 可覆盖/补充默认头（如 /im/chain/single 需要 Content-Type 带 encoding=utf-8）
  // account: 用于按平台设置 Referer/Origin，以及决定是否走代理（dola 海外版有地区限制，必须走代理）
  httpPost(url, body, cookies, extraHeaders, account) {
    const urlObj = new URL(url);
    const postBuffer = Buffer.from(JSON.stringify(body), 'utf8');
    const origin = `${urlObj.protocol}//${urlObj.hostname}`;
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': postBuffer.length,
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'agw-js-conv': 'str',
      'Referer': `${origin}/chat`,
      'Origin': origin
    }, extraHeaders || {});

    // 代理必须经过平台策略：豆包强制直连，Dola 才允许代理。
    const proxy = this.getProxyForAccount(account);
    if (proxy) {
      return this.httpPostViaProxy(urlObj, postBuffer, headers, proxy);
    }

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, text: data, setCookies: res.headers['set-cookie'] || [] }));
      });
      req.on('error', (e) => reject(new Error('请求失败: ' + e.message)));
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('请求超时')); });
      req.write(postBuffer);
      req.end();
    });
  }

  // 经 HTTP 代理（CONNECT 隧道）发 HTTPS POST。用于 dola 等需绕地区限制的平台。
  httpPostViaProxy(urlObj, postBuffer, headers, proxyUrl) {
    return new Promise((resolve, reject) => {
      const p = new URL(proxyUrl);
      const hostHeader = `${urlObj.hostname}:443`;
      const sock = net.connect(parseInt(p.port) || 8080, p.hostname, () => {
        sock.write(`CONNECT ${hostHeader} HTTP/1.1\r\nHost: ${hostHeader}\r\n\r\n`);
      });
      let connectBuf = '';
      const onConnectData = (chunk) => {
        connectBuf += chunk.toString('latin1');
        if (!connectBuf.includes('\r\n\r\n')) return;
        sock.removeListener('data', onConnectData);
        const statusLine = connectBuf.split('\r\n')[0];
        if (!/ 200 /.test(statusLine)) { sock.destroy(); reject(new Error('代理连接失败: ' + statusLine)); return; }

        const tlsSock = tls.connect({ socket: sock, servername: urlObj.hostname }, () => {
          const headLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
          const reqText = `POST ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\nHost: ${urlObj.hostname}\r\nConnection: close\r\n${headLines}\r\n\r\n`;
          tlsSock.write(reqText);
          tlsSock.write(postBuffer);
        });
        const chunks = [];
        tlsSock.on('data', d => { chunks.push(Buffer.from(d)); });
        tlsSock.on('end', () => {
          const raw = Buffer.concat(chunks);
          // 在 Buffer 层面切分 header/body，避免中文多字节字符导致的偏移错位
          const sep = raw.indexOf('\r\n\r\n');
          const headBuf = sep >= 0 ? raw.slice(0, sep) : Buffer.alloc(0);
          let bodyBuf = sep >= 0 ? raw.slice(sep + 4) : raw;
          const head = headBuf.toString('latin1');
          const statusMatch = head.match(/^HTTP\/[\d.]+ (\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1]) : 0;
          // 处理 chunked 传输编码（按字节解码后再转 UTF-8）
          if (/transfer-encoding:\s*chunked/i.test(head)) {
            bodyBuf = this.decodeChunkedBuffer(bodyBuf);
          }
          // 解析 Set-Cookie（代理响应头里逐行提取）
          const setCookies = [];
          for (const line of head.split('\r\n')) {
            const m = line.match(/^set-cookie:\s*(.+)$/i);
            if (m) setCookies.push(m[1]);
          }
          resolve({ status, text: bodyBuf.toString('utf8'), setCookies });
        });
        tlsSock.on('error', (e) => reject(new Error('代理TLS失败: ' + e.message)));
      };
      sock.on('data', onConnectData);
      sock.on('error', (e) => reject(new Error('代理连接错误: ' + e.message)));
      sock.setTimeout(300000, () => { sock.destroy(); reject(new Error('代理请求超时')); });
    });
  }

  // 解析 chunked 编码的响应体（Buffer 层面，避免多字节字符偏移错位）
  decodeChunkedBuffer(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
      const nl = buf.indexOf('\r\n', i);
      if (nl < 0) break;
      const sizeHex = buf.slice(i, nl).toString('latin1').trim();
      const size = parseInt(sizeHex, 16);
      if (isNaN(size) || size === 0) break;
      const start = nl + 2;
      out.push(buf.slice(start, start + size));
      i = start + size + 2; // 跳过 chunk 数据 + 结尾 \r\n
    }
    return out.length ? Buffer.concat(out) : buf;
  }

  // 构建请求URL（chat/completion）
  buildUrl(account) {
    const pc = this.getPlatformConfig(account);
    const params = this.buildQuery(account, { web_tab_id: uuidv4() });
    return `${pc.baseUrl}${pc.chatEndpoint}?${params.toString()}`;
  }

  buildPlatformUrl(account, endpoint, extra = {}) {
    const pc = this.getPlatformConfig(account);
    const params = this.buildQuery(account, { web_tab_id: uuidv4(), ...extra });
    return `${pc.baseUrl}${endpoint}?${params.toString()}`;
  }

  httpRequest(url, method, bodyBuffer, headers, account) {
    const urlObj = new URL(url);
    const body = bodyBuffer ? Buffer.from(bodyBuffer) : Buffer.alloc(0);
    const requestHeaders = { ...(headers || {}) };
    if (body.length > 0 && requestHeaders['Content-Length'] === undefined && requestHeaders['content-length'] === undefined) {
      requestHeaders['Content-Length'] = body.length;
    }
    const proxy = this.getProxyForAccount(account);
    if (proxy && urlObj.protocol === 'https:') {
      return this.httpRequestViaProxy(urlObj, method, body, requestHeaders, proxy);
    }
    // http:// 也走代理（dola 视频直链是 http，必须经代理才能访问）。
    // 普通 HTTP 代理转发：连代理端口，请求行用绝对 URL。
    if (proxy && urlObj.protocol === 'http:') {
      return this.httpRequestViaProxyPlain(urlObj, method, body, requestHeaders, proxy);
    }
    const client = urlObj.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = client.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: requestHeaders
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
        });
      });
      req.on('error', (e) => reject(new Error('请求失败: ' + e.message)));
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('请求超时')); });
      if (body.length > 0) req.write(body);
      req.end();
    });
  }

  async downloadToFile(url, filePath, headers, account) {
    const urlObj = new URL(url);
    const requestHeaders = { ...(headers || {}) };
    const proxy = this.getProxyForAccount(account);
    if (proxy && urlObj.protocol === 'https:') {
      return this.downloadToFileViaProxy(urlObj, filePath, requestHeaders, proxy);
    }
    if (proxy && urlObj.protocol === 'http:') {
      return this.downloadToFileViaProxyPlain(urlObj, filePath, requestHeaders, proxy);
    }
    const client = urlObj.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = client.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: requestHeaders
      }, async (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          resolve({ status: res.statusCode, headers: res.headers, bytes: 0 });
          return;
        }
        let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; });
        try {
          await pipeline(res, fs.createWriteStream(filePath));
          resolve({ status: res.statusCode, headers: res.headers, bytes });
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', (e) => reject(new Error('请求失败: ' + e.message)));
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('请求超时')); });
      req.end();
    });
  }

  downloadToFileViaProxy(urlObj, filePath, headers, proxyUrl) {
    return new Promise((resolve, reject) => {
      const p = new URL(proxyUrl);
      const hostHeader = `${urlObj.hostname}:443`;
      const sock = net.connect(parseInt(p.port) || 8080, p.hostname, () => {
        sock.write(`CONNECT ${hostHeader} HTTP/1.1\r\nHost: ${hostHeader}\r\n\r\n`);
      });
      let connectBuf = '';
      const onConnectData = (chunk) => {
        connectBuf += chunk.toString('latin1');
        if (!connectBuf.includes('\r\n\r\n')) return;
        sock.removeListener('data', onConnectData);
        const statusLine = connectBuf.split('\r\n')[0];
        if (!/ 200 /.test(statusLine)) { sock.destroy(); reject(new Error('代理连接失败: ' + statusLine)); return; }
        const tlsSock = tls.connect({ socket: sock, servername: urlObj.hostname }, () => {
          const headLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
          const reqText = `GET ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\nHost: ${urlObj.hostname}\r\nConnection: close\r\n${headLines}\r\n\r\n`;
          tlsSock.write(reqText);
        });
        this.writeHttpResponseStreamToFile(tlsSock, filePath).then(resolve, reject);
      };
      sock.on('data', onConnectData);
      sock.on('error', (e) => reject(new Error('代理连接错误: ' + e.message)));
      sock.setTimeout(300000, () => { sock.destroy(); reject(new Error('代理请求超时')); });
    });
  }

  downloadToFileViaProxyPlain(urlObj, filePath, headers, proxyUrl) {
    return new Promise((resolve, reject) => {
      const p = new URL(proxyUrl);
      const requestHeaders = { ...headers, Host: urlObj.host };
      const req = http.request({
        host: p.hostname,
        port: parseInt(p.port) || 8080,
        method: 'GET',
        path: urlObj.href,
        headers: requestHeaders
      }, async (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          resolve({ status: res.statusCode, headers: res.headers, bytes: 0 });
          return;
        }
        let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; });
        try {
          await pipeline(res, fs.createWriteStream(filePath));
          resolve({ status: res.statusCode, headers: res.headers, bytes });
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', (e) => reject(new Error('代理(http)请求失败: ' + e.message)));
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('代理(http)请求超时')); });
      req.end();
    });
  }

  writeHttpResponseStreamToFile(stream, filePath) {
    return new Promise((resolve, reject) => {
      let header = Buffer.alloc(0);
      let parsed = false;
      let out = null;
      let bodySink = null;
      let status = 0;
      const headers = {};
      let bytes = 0;
      let settled = false;

      const cleanup = (err, value) => {
        if (settled) return;
        settled = true;
        stream.removeAllListeners('data');
        stream.removeAllListeners('end');
        stream.removeAllListeners('error');
        if (!bodySink) {
          if (err) reject(err);
          else resolve(value);
          return;
        }
        const finish = () => {
          if (err) reject(err);
          else resolve(value);
        };
        if (out && out !== bodySink) {
          out.once('finish', finish);
          bodySink.end();
        } else {
          bodySink.end(finish);
        }
      };

      stream.on('data', (chunk) => {
        if (!parsed) {
          header = Buffer.concat([header, Buffer.from(chunk)]);
          const sep = header.indexOf('\r\n\r\n');
          if (sep < 0) return;
          const head = header.slice(0, sep).toString('latin1');
          const statusMatch = head.match(/^HTTP\/[\d.]+ (\d+)/);
          status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
          for (const line of head.split('\r\n').slice(1)) {
            const idx = line.indexOf(':');
            if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
          const rest = header.slice(sep + 4);
          parsed = true;
          if (status >= 400) {
            stream.destroy();
            cleanup(null, { status, headers, bytes: 0 });
            return;
          }
          out = fs.createWriteStream(filePath);
          out.on('error', cleanup);
          const isChunked = /chunked/i.test(headers['transfer-encoding'] || '');
          bodySink = isChunked ? createChunkedDecoder() : out;
          if (isChunked) {
            bodySink.on('error', cleanup);
            bodySink.pipe(out);
          }
          if (rest.length > 0) {
            bytes += rest.length;
            bodySink.write(rest);
          }
          return;
        }
        bytes += chunk.length;
        if (bodySink) bodySink.write(chunk);
      });
      stream.on('end', () => cleanup(null, { status, headers, bytes }));
      stream.on('error', cleanup);
    });
  }

  httpRequestViaProxy(urlObj, method, body, headers, proxyUrl) {
    return new Promise((resolve, reject) => {
      const p = new URL(proxyUrl);
      const hostHeader = `${urlObj.hostname}:443`;
      const sock = net.connect(parseInt(p.port) || 8080, p.hostname, () => {
        sock.write(`CONNECT ${hostHeader} HTTP/1.1\r\nHost: ${hostHeader}\r\n\r\n`);
      });
      let connectBuf = '';
      const onConnectData = (chunk) => {
        connectBuf += chunk.toString('latin1');
        if (!connectBuf.includes('\r\n\r\n')) return;
        sock.removeListener('data', onConnectData);
        const statusLine = connectBuf.split('\r\n')[0];
        if (!/ 200 /.test(statusLine)) { sock.destroy(); reject(new Error('代理连接失败: ' + statusLine)); return; }
        const tlsSock = tls.connect({ socket: sock, servername: urlObj.hostname }, () => {
          const requestHeaders = { ...headers };
          if (body.length > 0 && requestHeaders['Content-Length'] === undefined && requestHeaders['content-length'] === undefined) {
            requestHeaders['Content-Length'] = body.length;
          }
          const headLines = Object.entries(requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n');
          const reqText = `${method} ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\nHost: ${urlObj.hostname}\r\nConnection: close\r\n${headLines}\r\n\r\n`;
          tlsSock.write(reqText);
          if (body.length > 0) tlsSock.write(body);
        });
        const chunks = [];
        tlsSock.on('data', d => { chunks.push(Buffer.from(d)); });
        tlsSock.on('end', () => {
          const raw = Buffer.concat(chunks);
          const sep = raw.indexOf('\r\n\r\n');
          const headBuf = sep >= 0 ? raw.slice(0, sep) : Buffer.alloc(0);
          let bodyBuf = sep >= 0 ? raw.slice(sep + 4) : raw;
          const head = headBuf.toString('latin1');
          const statusMatch = head.match(/^HTTP\/[\d.]+ (\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1]) : 0;
          if (/transfer-encoding:\s*chunked/i.test(head)) bodyBuf = this.decodeChunkedBuffer(bodyBuf);
          resolve({ status, headers: {}, buffer: bodyBuf, text: bodyBuf.toString('utf8') });
        });
        tlsSock.on('error', (e) => reject(new Error('代理TLS失败: ' + e.message)));
      };
      sock.on('data', onConnectData);
      sock.on('error', (e) => reject(new Error('代理连接错误: ' + e.message)));
      sock.setTimeout(300000, () => { sock.destroy(); reject(new Error('代理请求超时')); });
    });
  }

  // 通过普通 HTTP 代理转发 http:// 请求（dola 视频直链为 http，且必须经代理）。
  // 与 CONNECT 隧道不同：直接连代理端口，请求行使用绝对 URL，由代理代为请求。
  httpRequestViaProxyPlain(urlObj, method, body, headers, proxyUrl) {
    return new Promise((resolve, reject) => {
      const p = new URL(proxyUrl);
      const requestHeaders = { ...headers };
      requestHeaders['Host'] = urlObj.host;
      if (body.length > 0 && requestHeaders['Content-Length'] === undefined && requestHeaders['content-length'] === undefined) {
        requestHeaders['Content-Length'] = body.length;
      }
      const req = http.request({
        host: p.hostname,
        port: parseInt(p.port) || 8080,
        method,
        path: urlObj.href, // 绝对 URL 让代理转发
        headers: requestHeaders
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
        });
      });
      req.on('error', (e) => reject(new Error('代理(http)请求失败: ' + e.message)));
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('代理(http)请求超时')); });
      if (body.length > 0) req.write(body);
      req.end();
    });
  }

  parseJsonResponse(result, label) {
    try {
      return JSON.parse(result.text || '{}');
    } catch (e) {
      throw new Error(`${label || '接口'} 返回非 JSON: ${(result.text || '').slice(0, 200)}`);
    }
  }

  hmacHex(key, text) {
    return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
  }

  hmacBuffer(key, text) {
    return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
  }

  sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  crc32Hex(value) {
    const table = this.constructor.crc32Table || (this.constructor.crc32Table = (() => {
      const items = new Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        items[i] = c >>> 0;
      }
      return items;
    })());
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
    let crc = 0xffffffff;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }

  formatVolcDate(date = new Date()) {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    return { xDate: iso, shortDate: iso.slice(0, 8) };
  }

  encodeAwsQueryValue(value) {
    return encodeURIComponent(String(value))
      .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  buildAwsQueryString(params = {}, sortKeys = false) {
    const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params || {});
    const filtered = entries.filter(([, value]) => value !== undefined && value !== null);
    if (sortKeys) filtered.sort(([a], [b]) => {
      const left = String(a);
      const right = String(b);
      return left < right ? -1 : (left > right ? 1 : 0);
    });
    const parts = [];
    for (const [key, value] of filtered) {
      const encodedKey = this.encodeAwsQueryValue(key);
      if (!encodedKey) continue;
      if (Array.isArray(value)) {
        const values = value.map(v => this.encodeAwsQueryValue(v));
        if (sortKeys) values.sort();
        for (const encodedValue of values) parts.push(`${encodedKey}=${encodedValue}`);
      } else {
        parts.push(`${encodedKey}=${this.encodeAwsQueryValue(value)}`);
      }
    }
    return parts.join('&');
  }

  inferImagexRegion(uploadHost) {
    const host = String(uploadHost || '');
    const match = host.match(/(?:^|\.)imagex-([a-z0-9-]+-\d+)\./i);
    return match ? match[1] : 'cn-north-1';
  }

  canonicalAwsHeaders(headers = {}) {
    const excluded = new Set([
      'authorization',
      'content-type',
      'content-length',
      'user-agent',
      'presigned-expires',
      'expect',
      'x-amzn-trace-id'
    ]);
    const canonical = [];
    for (const [key, value] of Object.entries(headers || {})) {
      const lowerKey = key.toLowerCase();
      if (!lowerKey.startsWith('x-amz-') && excluded.has(lowerKey)) continue;
      if (value === undefined || value === null) continue;
      canonical.push([lowerKey, String(value).replace(/\s+/g, ' ').trim()]);
    }
    canonical.sort(([a], [b]) => a < b ? -1 : (a > b ? 1 : 0));
    return {
      canonicalHeaders: canonical.map(([key, value]) => `${key}:${value}`).join('\n') + '\n',
      signedHeaders: canonical.map(([key]) => key).join(';')
    };
  }

  buildImagexAwsAuthorization({ method, pathName, query, bodyBuffer, credentials, region = 'cn-north-1', service = 'imagex' }) {
    const accessKey = credentials?.access_key || credentials?.AccessKeyId || credentials?.accessKeyId || credentials?.accessKey;
    const secretKey = credentials?.secret_key || credentials?.SecretAccessKey || credentials?.secretAccessKey || credentials?.secretKey;
    const sessionToken = credentials?.session_token || credentials?.SessionToken || credentials?.sessionToken;
    if (!accessKey || !secretKey) throw new Error('缺少 ImageX 上传签名凭据');

    const { xDate, shortDate } = this.formatVolcDate();
    const body = bodyBuffer ? Buffer.from(bodyBuffer) : Buffer.alloc(0);
    const headers = { 'X-Amz-Date': xDate };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;
    if (method !== 'GET' && body.length > 0) {
      headers['X-Amz-Content-Sha256'] = this.sha256Hex(body);
    }
    const payloadHash = headers['X-Amz-Content-Sha256'] || this.sha256Hex(Buffer.alloc(0));
    const canonicalQueryString = this.buildAwsQueryString(query || {}, true);
    const { canonicalHeaders, signedHeaders } = this.canonicalAwsHeaders(headers);
    const canonicalRequest = [
      method.toUpperCase(),
      pathName || '/',
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');
    const credentialScope = `${shortDate}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      xDate,
      credentialScope,
      this.sha256Hex(Buffer.from(canonicalRequest, 'utf8'))
    ].join('\n');
    const kDate = this.hmacBuffer(`AWS4${secretKey}`, shortDate);
    const kRegion = this.hmacBuffer(kDate, region);
    const kService = this.hmacBuffer(kRegion, service);
    const kSigning = this.hmacBuffer(kService, 'aws4_request');
    const signature = this.hmacHex(kSigning, stringToSign);
    return {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      headers,
      payloadHash,
      sessionToken,
      canonicalQueryString
    };
  }

  buildVolcAuthorization({ method, host, pathName, query, bodyBuffer, credentials, region = 'cn-north-1', service = 'imagex' }) {
    const accessKey = credentials?.access_key || credentials?.AccessKeyId || credentials?.accessKeyId || credentials?.accessKey;
    const secretKey = credentials?.secret_key || credentials?.SecretAccessKey || credentials?.secretAccessKey || credentials?.secretKey;
    const sessionToken = credentials?.session_token || credentials?.SessionToken || credentials?.sessionToken;
    if (!accessKey || !secretKey) throw new Error('缺少 ImageX 上传签名凭据');

    const { xDate, shortDate } = this.formatVolcDate();
    const payloadHash = this.sha256Hex(bodyBuffer || Buffer.alloc(0));
    const canonicalQuery = new URLSearchParams(query || {});
    canonicalQuery.sort();
    const canonicalQueryString = canonicalQuery.toString();
    const signedHeaders = sessionToken
      ? 'host;x-content-sha256;x-date;x-security-token'
      : 'host;x-content-sha256;x-date';
    const canonicalHeaders = [
      `host:${host}`,
      `x-content-sha256:${payloadHash}`,
      `x-date:${xDate}`,
      ...(sessionToken ? [`x-security-token:${sessionToken}`] : [])
    ].join('\n') + '\n';
    const canonicalRequest = [
      method,
      pathName,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');
    const credentialScope = `${shortDate}/${region}/${service}/request`;
    const stringToSign = [
      'HMAC-SHA256',
      xDate,
      credentialScope,
      this.sha256Hex(Buffer.from(canonicalRequest, 'utf8'))
    ].join('\n');
    const kDate = this.hmacBuffer(secretKey, shortDate);
    const kRegion = this.hmacBuffer(kDate, region);
    const kService = this.hmacBuffer(kRegion, service);
    const kSigning = this.hmacBuffer(kService, 'request');
    const signature = this.hmacHex(kSigning, stringToSign);
    return {
      authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      xDate,
      payloadHash,
      sessionToken,
      canonicalQueryString
    };
  }

  decodeReferenceImageInput(input = {}) {
    if (!input.dataUrl || typeof input.dataUrl !== 'string') throw new Error('缺少参考图 dataUrl');
    const match = input.dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error('参考图格式错误，仅支持 data URL');
    const contentType = match[1].toLowerCase();
    if (!contentType.startsWith('image/')) throw new Error('参考图必须是图片');
    const imageBuffer = Buffer.from(match[2], 'base64');
    if (imageBuffer.length === 0) throw new Error('参考图为空');
    const rawName = String(input.name || '').trim() || `reference${MIME_EXTENSIONS[contentType] || '.png'}`;
    const extFromName = path.extname(rawName).toLowerCase();
    const fileExtension = extFromName || MIME_EXTENSIONS[contentType] || '.png';
    const imageName = extFromName ? rawName : `${rawName}${fileExtension}`;
    return { imageBuffer, contentType, imageName, fileExtension };
  }

  getImageDimensions(buffer, contentType) {
    if (contentType === 'image/png' && buffer.length >= 24 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((contentType === 'image/jpeg' || contentType === 'image/jpg') && buffer.length > 4) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) break;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    return { width: 0, height: 0 };
  }

  async prepareReferenceUpload(account) {
    const pc = this.getPlatformConfig(account);
    const sceneId = pc.referenceUploadSceneId || ((account?.platform || 'doubao') === 'dola' ? '4' : '5');
    const url = this.buildPlatformUrl(account, '/alice/resource/prepare_upload');
    const result = await this.httpPost(url, {
      tenant_id: '5',
      scene_id: sceneId,
      resource_type: 2
    }, account.session?.cookies || '', undefined, account);
    if (result.status !== 200) throw new Error(`prepare_upload HTTP ${result.status}: ${result.text.slice(0, 200)}`);
    const json = this.parseJsonResponse(result, 'prepare_upload');
    if (json.code !== 0 || !json.data) throw new Error(`prepare_upload 失败: ${json.msg || json.message || result.text.slice(0, 200)}`);
    return json.data;
  }

  async signedImagexRequest(method, host, params, body, credentials, account) {
    const query = {};
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) query[key] = value;
    }
    const bodyBuffer = method === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body || {}), 'utf8');
    const region = this.inferImagexRegion(host);
    const signed = this.buildImagexAwsAuthorization({
      method,
      pathName: '/top/v1',
      query,
      bodyBuffer,
      credentials,
      region
    });
    const pc = this.getPlatformConfig(account);
    const useUploadHost = /bytevcloudapi\.com$/i.test(host) || (account?.platform || 'doubao') === 'dola';
    const baseUrl = new URL(useUploadHost ? `https://${host}` : (pc.baseUrl || `https://${host}`));
    const requestQueryString = this.buildAwsQueryString(query, false);
    const url = `${baseUrl.origin}/top/v1?${requestQueryString}`;
    const origin = baseUrl.origin;
    const headers = {
      'Authorization': signed.authorization,
      ...signed.headers,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Cookie': account?.session?.cookies || '',
      'Origin': origin,
      'Referer': `${origin}/chat/`
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const result = await this.httpRequest(url, method, bodyBuffer, headers, account);
    const json = this.parseJsonResponse(result, params?.Action || 'top/v1');
    return { status: result.status, json };
  }

  async applyImageUpload(prepareData, imageBuffer, fileExtension, account) {
    const result = await this.signedImagexRequest('GET', prepareData.upload_host || 'imagex.bytedanceapi.com', {
      Action: 'ApplyImageUpload',
      Version: '2018-08-01',
      ServiceId: prepareData.service_id,
      NeedFallback: true,
      FileSize: imageBuffer.length,
      FileExtension: fileExtension,
      s: Math.random().toString(36).slice(2, 13)
    }, null, prepareData.upload_auth_token || {}, account);
    if (result.status !== 200) throw new Error(`ApplyImageUpload HTTP ${result.status}: ${JSON.stringify(result.json || {}).slice(0, 200)}`);
    const uploadAddress = result.json?.Result?.UploadAddress;
    if (!uploadAddress?.StoreInfos?.length || !uploadAddress?.SessionKey) throw new Error('ApplyImageUpload 未返回上传地址');
    return uploadAddress;
  }

  async uploadImageToTos(uploadAddress, imageBuffer, contentType, account, imageName) {
    const storeInfo = uploadAddress.StoreInfos?.[0];
    const uploadHost = uploadAddress.UploadHosts?.[0] || uploadAddress.UploadHost;
    if (!storeInfo?.StoreUri || !storeInfo?.Auth || !uploadHost) throw new Error('TOS 上传地址缺少 StoreUri/Auth/UploadHost');
    const origin = this.getPlatformConfig(account).baseUrl || 'https://www.doubao.com';
    const result = await this.httpRequest(`https://${uploadHost}/upload/v1/${storeInfo.StoreUri}`, 'POST', imageBuffer, {
      'Authorization': storeInfo.Auth,
      'Content-CRC32': this.crc32Hex(imageBuffer),
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': imageBuffer.length,
      'X-Storage-U': '',
      'Origin': origin,
      'Referer': `${origin}/`,
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
    }, account);
    const json = this.parseJsonResponse(result, 'TOS 上传');
    if (result.status !== 200 || json.code !== 2000) throw new Error(`TOS 上传失败: HTTP ${result.status} ${json.message || result.text.slice(0, 200)}`);
    return json;
  }

  async commitImageUpload(prepareData, sessionKey, account) {
    const result = await this.signedImagexRequest('POST', prepareData.upload_host || 'imagex.bytedanceapi.com', {
      Action: 'CommitImageUpload',
      Version: '2018-08-01',
      ServiceId: prepareData.service_id
    }, { SessionKey: sessionKey }, prepareData.upload_auth_token || {}, account);
    if (result.status !== 200) throw new Error(`CommitImageUpload HTTP ${result.status}`);
    const plugin = result.json?.Result?.PluginResult?.[0];
    if (!plugin?.ImageUri) throw new Error('CommitImageUpload 未返回 ImageUri');
    return plugin;
  }

  async preHandleUploadedImage(account, imageUri, imageIdentifier = uuidv4()) {
    const pc = this.getPlatformConfig(account);
    const session = account.session || {};
    const profile = this.getRequestProfile(account);
    const botId = session.bot_id || pc.botId || '7338286299411103781';

    const requestBody = {
      uplink_entity: {
        entity_type: 2,
        entity_content: { image: { key: imageUri } },
        identifier: imageIdentifier
      },
      bot_id: botId,
      local_message_id: uuidv4()
    };
    // 是否携带会话上下文由平台 profile 决定(默认携带=历史行为)。
    // 服务端会话状态按账号取(每账号独立服务端会话;session 是每账号真相源);
    // 平台 UI 会话桶(conv)跨账号共享,不能用它的 cid,否则多账号生成会串号。
    if (profile.preHandleWithConv) {
      const conv = this.conversations.getActive(account.platform || 'doubao', account.id);
      requestBody.conversation_id = session.conversation_id || conv?.doubaoConversationId || '';
      requestBody.section_id = session.section_id || conv?.sectionId || '';
    }
    const url = this.buildPlatformUrl(account, profile.preHandleEndpoint);
    const result = await this.httpPost(url, requestBody, account.session?.cookies || '', undefined, account);
    if (result.status !== 200) throw new Error(`pre_handle HTTP ${result.status}: ${result.text.slice(0, 200)}`);
    const json = this.parseJsonResponse(result, 'pre_handle');
    if (json.code !== 0) throw new Error(`pre_handle 失败: ${json.msg || json.message || result.text.slice(0, 200)}`);
    return json.data?.pre_generate_id || '';
  }

  saveOrionReferenceImages(refs = [], platform = 'orion') {
    const dir = appPaths.resolveDownloadDir(this.config.storage && this.config.storage.downloadDir);
    const safePlatform = String(platform || 'orion').replace(/[^a-z0-9_-]/gi, '') || 'orion';
    const out = [];
    refs.forEach((ref, index) => {
      if (!ref) return;
      const decoded = this.decodeReferenceImageInput(ref);
      const ext = path.extname(decoded.imageName || '').toLowerCase() || decoded.fileExtension || '.png';
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const rand = crypto.randomBytes(4).toString('hex');
      const fileName = safePlatform + '_ref_' + stamp + '_' + index + '_' + rand + ext;
      const fullPath = path.join(dir, fileName);
      fs.writeFileSync(fullPath, decoded.imageBuffer);
      out.push(fullPath);
    });
    return out;
  }
  async uploadReferenceImage(input = {}, options = {}) {
    const account = this.resolveAccount(options);
    if (!account) throw new Error('没有可用账号');
    if (!account.session?.cookies) throw new Error('账号未登录或cookies为空，请重新登录');
    if (!account.session?.device_id) throw new Error('缺少device_id，请重新登录获取');
    const { imageBuffer, contentType, imageName, fileExtension } = this.decodeReferenceImageInput(input);
    const localSize = this.getImageDimensions(imageBuffer, contentType);
    const prepareData = await this.prepareReferenceUpload(account);
    const uploadAddress = await this.applyImageUpload(prepareData, imageBuffer, fileExtension, account);
    await this.uploadImageToTos(uploadAddress, imageBuffer, contentType, account, imageName);
    const plugin = await this.commitImageUpload(prepareData, uploadAddress.SessionKey, account);
    const imageIdentifier = uuidv4();
    const preGenerateId = await this.preHandleUploadedImage(account, plugin.ImageUri, imageIdentifier);
    return {
      imageUri: plugin.ImageUri,
      imageIdentifier,
      imageName,
      imageWidth: plugin.ImageWidth || localSize.width || 0,
      imageHeight: plugin.ImageHeight || localSize.height || 0,
      imageFormat: plugin.ImageFormat || fileExtension.replace(/^\./, ''),
      imageSize: plugin.ImageSize || imageBuffer.length,
      preGenerateId
    };
  }

  shouldSuppressReferenceAspectForVideo(ratio, image) {
    if (!ratio) return false;
    const rm = String(ratio || '').match(/(\d+)\s*[:：]\s*(\d+)/);
    const iw = Number(image?.imageWidth || 0);
    const ih = Number(image?.imageHeight || 0);
    if (!rm || !iw || !ih) return false;
    const rw = parseInt(rm[1], 10);
    const rh = parseInt(rm[2], 10);
    if (!rw || !rh) return false;
    return (rw * ih) !== (rh * iw);
  }
  // 构建请求体 - 使用会话状态
  buildRequestBody(prompt, account, options = {}) {
    const session = account.session || {};
    const conv = this.conversations.getActive(account.platform || 'doubao', account.id);
    const localMessageId = uuidv4();

    // 会话元数据按账号取：每个账号有独立的服务端会话，session 是每账号真相源。
    // 不能用平台 UI 会话桶(conv)的 cid——它跨账号共享，会导致多账号生成串号失败。
    // chatOverride：对外 API 对话专用，用独立会话状态覆盖 account.session，
    // 使 API 多轮对话与 UI 生成的上下文完全隔离(见 _chatSessions)。
    const co = options.chatOverride;
    const conversationId = co ? (co.conversation_id || '') : (session.conversation_id || conv?.doubaoConversationId || '');
    const sectionId = co ? (co.section_id || '') : (session.section_id || conv?.sectionId || '');
    const lastMessageIndex = co ? (co.last_message_index || 0) : (session.last_message_index || conv?.lastMessageIndex || 0);

    const textBlock = {
      block_type: 10000,
      content: {
        text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' },
        pc_event_block: ''
      },
      block_id: uuidv4(),
      parent_id: '',
      meta_info: [],
      append_fields: []
    };

    const imageReferences = Array.isArray(options.imageReferences) && options.imageReferences.length > 0
      ? options.imageReferences
      : (options.imageUri ? [{
          imageUri: options.imageUri,
          imageIdentifier: options.imageIdentifier,
          imageName: options.imageName,
          imageWidth: options.imageWidth,
          imageHeight: options.imageHeight,
          imageFormat: options.imageFormat
        }] : []);

    // 图生视频：附加图片块。真实抓包确认用 block_type:10052 的 attachment_block。
    // attachments 是数组；官方页面只传一张，但接口结构允许我们实验多图。
    const messages = [];
    if (imageReferences.length > 0) {
      messages.push({
        local_message_id: uuidv4(),
        content_block: [{
          block_type: 10052,
          content: {
            attachment_block: {
              attachments: imageReferences.map((image) => ({
                type: 1,
                identifier: image.imageIdentifier || uuidv4(),
                image: {
                  name: image.imageName || 'reference.png',
                  uri: image.imageUri,
                  image_ori: {
                    url: '',
                    width: (options.isVideo && this.shouldSuppressReferenceAspectForVideo(options.ratio, image)) ? 0 : (image.imageWidth || 0),
                    height: (options.isVideo && this.shouldSuppressReferenceAspectForVideo(options.ratio, image)) ? 0 : (image.imageHeight || 0),
                    format: image.imageFormat || '',
                    url_formats: {}
                  }
                },
                parse_state: 0,
                review_state: 1,
                upload_status: 1,
                progress: 100,
                src: ''
              }))
            },
            pc_event_block: ''
          },
          block_id: uuidv4(),
          parent_id: '',
          meta_info: [],
          append_fields: []
        }],
        message_status: 0
      });
    }
    messages.push({
      local_message_id: localMessageId,
      content_block: [textBlock],
      message_status: 0
    });

    const pc = this.getPlatformConfig(account);
    // 新建会话时：client_meta 需带 local_conversation_id，且 last_message_index 为 null（实测，否则 invalid param）
    const isNewConv = !conversationId;
    const clientMeta = {
      bot_id: session.bot_id || pc.botId || '7338286299411103781',
      conversation_id: conversationId,
      last_section_id: sectionId,
      last_message_index: isNewConv ? null : lastMessageIndex
    };
    if (isNewConv) clientMeta.local_conversation_id = 'local_' + Date.now() + Math.floor(Math.random() * 1000);
    const requestBody = {
      client_meta: clientMeta,
      messages,
      option: {
        send_message_scene: '',
        create_time_ms: Date.now(),
        collect_id: '',
        is_audio: false,
        answer_with_suggest: false,
        tts_switch: false,
        need_deep_think: 0,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        disable_sse_cache: false,
        select_text_action: '',
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: uuidv4(),
        start_seq: 0,
        need_create_conversation: !conversationId,
        ...(!conversationId ? { conversation_init_option: { need_ack_conversation: true } } : {}),
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: '',
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: '',
        shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true },
        is_ai_playground: false,
        is_old_user: true,
        recovery_option: {
          is_recovery: false,
          req_create_time_sec: Math.floor(Date.now() / 1000),
          append_sse_event_scene: 0
        },
        message_storage_type: 0
      },
      user_context: [],
      ext: {
        use_deep_think: '0',
        answer_with_suggest: '0',
        fp: session.fp || '',
        sub_conv_firstmet_type: '1',
        collection_id: '',
        ...(!conversationId ? { conversation_init_option: JSON.stringify({ need_ack_conversation: true }) } : {}),
        commerce_credit_config_enable: '0'
      }
    };

    // chat_ability：通过结构化参数下发模型/时长/比例/风格。
    // 两种生成的结构不同，均已抓包验证：
    //   视频：扁平结构 ability_type:17，ability_param = {ratio, model, duration}
    //         真实模型值如 "seedance_v2.0"；duration 5/10 直接生效。
    //   图片：嵌套结构 ability_type:3，ability_param = {ability_param:{style,ratio,model}, ability_type:1}
    //         真实模型值如 "Seedream 4.5" / "Seedream 5.0 Lite"；style 为枚举如 skill_image_styles_portrait。
    if (options.isVideo) {
      const abilityParam = {};
      if (options.ratio) abilityParam.ratio = options.ratio;
      abilityParam.model = options.model || 'seedance_v2.0';
      abilityParam.duration = options.duration || 10;
      requestBody.chat_ability = {
        ability_type: 17,
        ability_param: JSON.stringify(abilityParam)
      };
      // input_skill 是否下发由平台 profile 决定(默认发=历史行为)。
      // dola 靠它路由到「全能视频模型」,否则会被路由到普通模型;
      // 豆包改版后网页端不再发送(抓包确认),通过 config 关闭。
      if (this.getRequestProfile(account).sendInputSkill) {
        requestBody.ext.input_skill = JSON.stringify({ skill_id: '17', skill_type: 17 });
      }
    } else if (options.imageModel || options.imageStyle || options.imageRatio) {
      const inner = {};
      if (options.imageStyle) inner.style = options.imageStyle;
      if (options.imageRatio) inner.ratio = options.imageRatio;
      if (options.imageModel) inner.model = options.imageModel;
      requestBody.chat_ability = {
        ability_type: 3,
        ability_param: JSON.stringify({ ability_param: inner, ability_type: 1 })
      };
      if (this.getRequestProfile(account).sendInputSkill) {
        requestBody.ext.input_skill = JSON.stringify({ skill_id: '3', skill_type: 3, template_key: '' });
      }
    }

    return requestBody;
  }

  // 从 SSE 响应中提取 ack 会话元数据(纯解析,不写任何存储)。
  // 供对外 API 对话(generateMessage)把会话状态写入独立的 _chatSessions,不碰 account.session。
  _extractAckMeta(rawText) {
    const out = { conversation_id: '', section_id: '', last_message_index: 0 };
    const blocks = rawText.split(/\r?\n\r?\n/);
    let ack = null;
    for (const block of blocks) {
      if (!/^event:\s*SSE_ACK\s*$/m.test(block)) continue;
      const m = block.match(/^data:\s*(\{.*\})\s*$/m);
      if (m) { try { ack = JSON.parse(m[1]); break; } catch (e) { /* 下一块 */ } }
    }
    if (ack) {
      const meta = ack.ack_client_meta || {};
      const queryList = ack.query_list || [];
      if (meta.conversation_id) out.conversation_id = meta.conversation_id;
      if (meta.section_id) out.section_id = meta.section_id;
      if (queryList[0]?.message_index) out.last_message_index = queryList[0].message_index + 1;
    }
    return out;
  }

  // 从 SSE 响应中提取会话状态并更新
  updateSessionFromResponse(rawText, account) {
    // 按空行切分 SSE 块（容忍 \r\n），逐块解析，避免依赖脆弱的单行正则
    const blocks = rawText.split(/\r?\n\r?\n/);
    let ack = null;
    for (const block of blocks) {
      if (!/^event:\s*SSE_ACK\s*$/m.test(block)) continue;
      const m = block.match(/^data:\s*(\{.*\})\s*$/m);
      if (m) {
        try { ack = JSON.parse(m[1]); break; } catch (e) { /* 继续找下一个块 */ }
      }
    }
    if (ack) {
      try {
        const meta = ack.ack_client_meta || {};
        const queryList = ack.query_list || [];

        // 服务端会话状态(cid/section/index)按账号写回 session —— 每账号独立，
        // 不能写进平台 UI 会话桶(conv)，否则会用单个账号的 cid 污染整条平台会话，
        // 导致其它账号生成时串号失败。conv 桶只更新 UI 用的 messageCount。
        const conv = this.conversations.getActive(account.platform || 'doubao', account.id);
        if (conv) {
          this.conversations.updateDoubaoMeta(conv.id, {
            messageCount: (conv.messageCount || 0) + 1
          });
        }

        // 账号级会话状态：cid / section / lastIndex 全部按账号存
        const updates = {};
        if (meta.conversation_id) updates.conversation_id = meta.conversation_id;
        if (meta.section_id) updates.section_id = meta.section_id;
        if (queryList[0]?.message_index) updates.last_message_index = queryList[0].message_index + 1;
        if (Object.keys(updates).length > 0) {
          this.accounts.update(account.id, { session: { ...account.session, ...updates } });
        }
      } catch (e) { /* ignore parse error */ }
    }
  }

  // 执行生成请求。遇到限流(710022004 rate limited)自动退避重试，最多 3 次。
  async executeGeneration(body, account, onProgress, opts = {}) {
    const maxRetry = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      try {
        const rawText = await this._executeGenerationOnce(body, account, opts);
        // 初始响应里 dola 已经回话（"正在为你生成…"等），立即原封不动回传，
        // 不必等视频轮询完（可能数十分钟）。失败的话 _executeGenerationOnce 会抛错，不会走到这。
        if (typeof onProgress === 'function') {
          const reply = this.extractDolaReply(rawText);
          if (reply) onProgress({ reply });
        }
        return rawText;
      } catch (e) {
        lastErr = e;
        // 仅对限流退避重试，其它错误立即抛出
        if (/rate limited|710022004/.test(e.message) && attempt < maxRetry) {
          const waitMs = attempt * 8000; // 8s, 16s 递增
          if (typeof onProgress === 'function') {
            onProgress({ attempt, total: maxRetry, note: `被限流，${waitMs / 1000}秒后重试` });
          }
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  // 执行单次生成请求
  async _executeGenerationOnce(body, account, opts = {}) {
    const cookies = account.session?.cookies;
    if (!cookies) {
      throw new Error('账号未登录或cookies为空，请重新登录');
    }
    if (!account.session?.device_id) {
      throw new Error('缺少device_id，请重新登录获取');
    }
    // 注意：conversation_id 不再强制要求。
    // 首次发消息时 conversation_id 为空，buildRequestBody 会将
    // need_create_conversation 置为 true，由服务端创建并随 SSE_ACK 回传。
    if (!account.session?.fp) {
      throw new Error('缺少fp指纹，请重新登录获取');
    }

    const url = this.buildUrl(account);

    // 调试：把本次发出的请求体落盘，便于核对 chat_ability / model / duration 是否正确。
    try {
      const dir = appPaths.debugDir;
      fs.mkdirSync(dir, { recursive: true });
      const ca = body.chat_ability || null;
      const summary = {
        time: new Date().toISOString(),
        chat_ability: ca,
        content_block_types: (body.messages?.[0]?.content_block || []).map(b => b.block_type),
        text: body.messages?.find(m => (m.content_block || []).some(b => b.block_type === 10000))
          ?.content_block.find(b => b.block_type === 10000)?.content?.text_block?.text || ''
      };
      fs.writeFileSync(path.join(dir, 'last_request.json'), JSON.stringify(summary, null, 2));
      fs.writeFileSync(path.join(dir, 'last_request_full.json'), JSON.stringify(body, null, 2));
    } catch (e) { /* 调试落盘失败不影响主流程 */ }

    const result = await this.httpPost(url, body, cookies, undefined, account);
    // 刷新登录态：把服务端轮换的 Set-Cookie 合并回存储，避免 cookie 过期"自动登出"
    if (result.status === 200) this.mergeSetCookies(account, result.setCookies);
    this.writeCapture(account, 'chat-completion', {
      url: `${new URL(url).origin}${new URL(url).pathname}`,
      status: result.status,
      response: this.summarizeResponse(result.text)
    }, true);

    if (result.status !== 200) {
      throw new Error(`HTTP ${result.status}: ${result.text.substring(0, 200)}`);
    }

    // 检查是否有流错误
    if (result.text.includes('STREAM_ERROR')) {
      const errMatch = result.text.match(/"error_code":(\d+),"error_msg":"([^"]+)"/);
      if (errMatch) {
        const platform = (account && account.platform) || 'doubao';
        throw new Error(`${platform}错误 ${errMatch[1]}: ${errMatch[2]}`);
      }
    }

    // 更新会话状态
    // 对外 API 对话(opts.skipSessionUpdate)不写 account.session,
    // 由调用方从返回的 rawText 里自行提取 ack 写入独立的 _chatSessions,避免污染 UI 生成上下文。
    if (!opts.skipSessionUpdate) this.updateSessionFromResponse(result.text, account);

    const generationFailure = this.detectGenerationFailure(result.text, account);
    if (generationFailure) throw generationFailure;

    return result.text;
  }

  // 解析SSE响应
  // type: 'image' 只解析图片；'video' 只解析视频；省略则两者都解析（向后兼容）。
  // 隔离的意义：视频 SSE 里会混入参考图/预览帧/占位块，若不区分会污染 results.images，
  // 导致前端把视频结果当图片渲染。反之亦然。
  parseSSEResponse(rawText, type) {
    const results = { images: [], videos: [], videoKeys: [], quota: null, brief: null };
    let match;

    // ---- 图片解析（type 非 'video' 时执行）----
    if (type !== 'video') {
      results.images = this.extractImageUrls(rawText);

      // 带水印图备选：仅在无水印提取失败时降级，且必须排除所有水印模板
      if (results.images.length === 0) {
        // 国内版域名 byteimg.com / 海外版 ibyteimg.com|ciciai.com，统一匹配
        const imgPattern = /https?:\\?\/\\?\/p\d+-flow(?:-imagex)?-sign[^"\\]*/g;
        const imgMatches = rawText.match(imgPattern) || [];
        results.images = [...new Set(imgMatches.map(u => this.decodeResponseUrl(u)).filter(u =>
          u &&
          !u.includes('BOT_ICON') &&
          !u.includes('avatar') &&
          !u.includes('icon') &&
          // 关键：排除所有带水印模板的 URL（image_ori/image_thumb/image_preview 都是水印版）
          !/_watermark|dld_watermark|pre_watermark|downsize_watermark/.test(u)
        ))];
      }
    }

    // ---- 视频 vid 解析（type 非 'image' 时执行）----
    // 注意：仅在视频已完成并推送 creation_block 时才会出现，
    // 首次 SSE 响应通常只有"正在创作"文本，vid 须由轮询补抓，见 fetchVideoVids。
    if (type !== 'image') {
      const vidPattern = /"vid"\s*:\s*"(v[01][a-zA-Z0-9]+)"/g;
      while ((match = vidPattern.exec(rawText)) !== null) {
        if (!results.videoKeys.includes(match[1])) results.videoKeys.push(match[1]);
      }
    }

    // 直接视频URL —— 真实抓包中无水印视频是 get_play_info 返回的 CDN 直链（含 download=true），
    // SSE 流里不会出现裸 .mp4，故不再用此正则（旧实现会误抓广告/icon，已移除）。

    // 额度 (今日剩余 X 个)
    const quotaMatch = rawText.match(/剩余\s*(\d+)\s*个/);
    if (quotaMatch) results.quota = parseInt(quotaMatch[1]);

    // dola/豆包 的自然语言回复，原封不动还原（合并 CHUNK_DELTA + STREAM_CHUNK 两个通道）
    const reply = this.extractDolaReply(rawText);
    if (reply) results.brief = reply;

    return results;
  }

  // 获取视频无水印地址。各平台端点/请求体/结果结构不同（已抓包验证）：
  //   doubao: /samantha/media/get_play_info + {key,type:'video'} -> data.media_info[0].main_url
  //   dola:   /samantha/video/get_play_info + {vid}              -> data.play_infos[0].main
  // 平台差异由 config.platforms[x].videoPlayInfo 描述。
  async getVideoPlayUrl(videoKey, cookies, account) {
    const pc = this.getPlatformConfig(account);
    const vpi = pc.videoPlayInfo || { endpoint: pc.playInfoEndpoint, bodyMode: 'key', resultPath: 'media_info' };
    const params = this.buildQuery(account || {});
    const url = `${pc.baseUrl}${vpi.endpoint}?${params}`;
    const body = vpi.bodyMode === 'vid' ? { vid: videoKey } : { key: videoKey, type: 'video' };
    const result = await this.httpPost(url, body, cookies, undefined, account);
    try {
      const data = JSON.parse(result.text);
      const arr = data?.data?.[vpi.resultPath];
      if (Array.isArray(arr) && arr[0]) {
        // media_info 用 main_url；play_infos 用 main
        let mainUrl = arr[0].main_url || arr[0].main || null;
        // 豆包去水印:后端 main_url 是带水印层的 CDN 直链,把 lr=xxx 参数替换成
        // 无水印标记(noWatermarkLr,如 video_gen_no_watermark),CDN 即回无水印版。
        mainUrl = this.applyNoWatermarkLr(mainUrl, vpi.noWatermarkLr);
        // 返回具体的 play_info 项供去水印 API 使用（含 key_seed、video_list 等）
        // Dola 去水印 API 期望的 video_info 是单个 play_info 对象，不是外层 data 包裹
        return { url: mainUrl, playInfo: arr[0] };
      }
      // 兼容旧字段名兜底
      const fallbackUrl = this.applyNoWatermarkLr(
        data?.data?.original_media_info?.main_url || null, vpi.noWatermarkLr
      );
      return { url: fallbackUrl, playInfo: data?.data || null };
    } catch (e) {
      return { url: null, playInfo: null };
    }
  }

  // 豆包视频去水印:把播放直链里的 lr=<水印标记> 替换成无水印标记。
  // 豆包后端 main_url 本身就是无水印原始视频的 CDN 地址,水印只是 lr 参数控制的展示层,
  // 换成 video_gen_no_watermark 后拉到的即为无水印 mp4。lr 参数不存在时原样返回。
  applyNoWatermarkLr(url, noWatermarkLr) {
    if (!url || !noWatermarkLr) return url;
    if (/[?&]lr=/.test(url)) {
      return url.replace(/([?&]lr=)[^&]*/g, `$1${noWatermarkLr}`);
    }
    return url;
  }

  // Dola 去水印：将 fplay URL + key_seed 发送到去水印 API，获取无水印下载链接
  // 递归从对象中查找 key_seed 字段（对齐插件 findKeySeed 逻辑）
  _findKeySeed(value, depth = 0, seen = null) {
    if (!value || depth > 8) return '';
    if (!seen) seen = new WeakSet();
    if (typeof value === 'string') {
      const m = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i)
        || value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
      if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
      return '';
    }
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);
    // 直接属性优先
    if (typeof value.key_seed === 'string' && value.key_seed) return value.key_seed;
    if (typeof value.keySeed === 'string' && value.keySeed) return value.keySeed;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 80)) {
        const found = this._findKeySeed(item, depth + 1, seen);
        if (found) return found;
      }
      return '';
    }
    for (const item of Object.values(value).slice(0, 120)) {
      const found = this._findKeySeed(item, depth + 1, seen);
      if (found) return found;
    }
    return '';
  }

  async removeDolaWatermark(fplayUrl, playInfo) {
    const WATERMARK_API = 'http://47.104.150.143:8765/tools/dola/';
    try {
      // 提取 key_seed：优先从 playInfo 递归查找，其次从 URL 中提取
      const keySeed = this._findKeySeed(playInfo) || this._findKeySeed(fplayUrl) || '';

      // 对齐插件逻辑：优先传 video_info，没有时才传 fplay_url（二选一）
      const payload = { referer: 'https://www.dola.com/', mode: 'nowatermark' };
      if (playInfo && typeof playInfo === 'object') {
        payload.video_info = JSON.stringify(playInfo);
      } else if (fplayUrl) {
        payload.fplay_url = fplayUrl;
      }
      if (keySeed) payload.key_seed = keySeed;

      const resp = await new Promise((resolve, reject) => {
        const urlObj = new (require('url').URL)(WATERMARK_API);
        const postData = JSON.stringify(payload);
        const req = http.request({
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 30000
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, text: body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('watermark API timeout')); });
        req.write(postData);
        req.end();
      });

      const data = JSON.parse(resp.text);
      const downloadUrl = data.download_url || data.video_url || data.url || (data.data && data.data.download_url);
      if (downloadUrl) return downloadUrl;
      console.warn('[去水印] API 未返回下载链接, 响应:', resp.text.slice(0, 500));
    } catch (e) {
      console.warn('[去水印] 请求失败:', e.message);
    }
    return null;
  }

  // 拉取会话最新消息（/im/chain/single, cmd:3100），从完成消息里提取视频 vid。
  // 豆包视频是异步的：初始 SSE 只回"正在创作"占位块，vid 要等渲染完成后通过本接口轮询获得。
  // 真实结构（已抓包验证）：
  //   downlink_body.pull_singe_chain_downlink_body.messages[]  （已结构化对象数组）
  //     -> content_block[] -> block_type:2074
  //       -> content.creation_block.creations[] -> type:2 / gen_detail.task_type:6 -> video.vid
  //   图片同样走 2074，但 creation.type:1（无 video.vid）。
  //   messages 里混着历史视频/图片，按 index_in_conv 最大定位本次最新结果。
  pullMessageVids(responseText, afterIndex) {
    let jsonParsed = false;
    try {
      const json = JSON.parse(responseText);
      jsonParsed = true;
      const messages = json?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
      // 按 index_in_conv 降序，最新的在前
      const sorted = [...messages].sort(
        (a, b) => (parseInt(b.index_in_conv) || 0) - (parseInt(a.index_in_conv) || 0)
      );
      for (const msg of sorted) {
        // 只取本次请求之后的消息，避免拿到上一次生成的旧结果
        if (afterIndex != null && (parseInt(msg.index_in_conv) || 0) <= afterIndex) continue;
        const blocks = msg.content_block || (() => {
          try { return JSON.parse(msg.content || '[]'); } catch (e) { return []; }
        })();
        for (const block of blocks) {
          if (block?.block_type !== 2074) continue;
          const creations = block?.content?.creation_block?.creations;
          if (!Array.isArray(creations)) continue;
          for (const creation of creations) {
            // 只认视频 creation（type:2，文生视频 task_type:6 / 图生视频 task_type:2）
            const isVideo = creation?.type === 2 && creation?.video?.vid;
            if (isVideo) {
              const vid = creation.video.vid;
              // 顺手把同一 creation 里的富 video_model（含 key_seed + fallback_api(fplay链接)）暂存，
              // 去水印 API 要的就是这个对象。避免再去调贫字段的 get_play_info（那个没 key_seed，去不掉水印）。
              this._stashVideoModel(vid, creation.video.video_model);
              return [vid];
            }
          }
        }
      }
    } catch (e) { /* JSON 解析失败，走全局兜底 */ }

    // JSON 解析成功但没找到「本次之后」的新视频：说明本次视频还没渲染完，继续轮询。
    // 绝不退回正则兜底——那会抓到响应里第一个 vid（往往是上一次的旧视频），
    // 导致历史会话全部显示成同一个旧/最新视频（已复现的跨会话污染 bug）。
    if (jsonParsed) return [];

    // 仅当响应根本不是合法 JSON（结构异常）时，才用正则兜底取第一个 vid。
    const m = /"vid"\s*:\s*"(v\d[a-zA-Z0-9]+)"/.exec(responseText);
    if (!m) return [];
    const vid = m[1];
    // 兜底也尽量把 video_model 暂存下来（否则解析不出 video_list，去水印就退化成带水印）
    const vm = this._extractVideoModelFromText(responseText);
    if (vm) this._stashVideoModel(vid, vm);
    return [vid];
  }

  // 从原始 chain/single 文本里提取并解开 video_model（含无水印 video_list）。
  // 结构化解析没命中时（消息结构变体/字段层级变化）用这个兜底，保证仍能拿到无水印直链。
  _extractVideoModelFromText(responseText) {
    // 1) 整体当合法 JSON 解析，递归找任意层级的 video_model 字段
    try {
      const json = JSON.parse(responseText);
      const found = this._deepFindVideoModel(json);
      if (found) return found;
    } catch (e) { /* 不是合法 JSON，进入反转义重试 */ }
    // 2) 逐层去转义后重试（应对被多层 JSON 字符串包裹的片段）
    let t = String(responseText || '');
    for (let i = 0; i < 4; i++) {
      t = t.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      try {
        const json = JSON.parse(t);
        const found = this._deepFindVideoModel(json);
        if (found) return found;
      } catch (e) { /* 继续反转义 */ }
    }
    return null;
  }

  // 递归在对象里查找 video_model（字符串则解析），命中带 video_list 的即返回
  _deepFindVideoModel(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return null;
    const vm = obj.video_model;
    if (typeof vm === 'string' && vm.includes('video_list')) {
      try { const o = JSON.parse(vm); if (o && o.video_list) return o; } catch (e) { /* 继续 */ }
    } else if (vm && typeof vm === 'object' && vm.video_list) {
      return vm;
    }
    for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) {
      const f = this._deepFindVideoModel(v, depth + 1);
      if (f) return f;
    }
    return null;
  }

  // 从 chain/single 响应里提取最新一批图片的无水印 URL（image_ori_raw）。
  // 图片 creation：block_type 2074 -> creation_block.creations[] -> type:1 -> image.image_ori_raw.url
  pullMessageImages(responseText) {
    try {
      const json = JSON.parse(responseText);
      const messages = json?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
      const sorted = [...messages].sort(
        (a, b) => (parseInt(b.index_in_conv) || 0) - (parseInt(a.index_in_conv) || 0)
      );
      for (const msg of sorted) {
        if (msg.user_type !== 2 && !msg.sender_id) continue;
        const blocks = msg.content_block || (() => {
          try { return JSON.parse(msg.content || '[]'); } catch (e) { return []; }
        })();
        for (const block of blocks) {
          if (block?.block_type !== 2074) continue;
          const creations = block?.content?.creation_block?.creations;
          if (!Array.isArray(creations)) continue;
          const urls = [];
          for (const creation of creations) {
            // 图片 creation：type:1，无水印取 image.image_ori_raw.url
            if (creation?.type === 1) {
              const u = creation?.image?.image_ori_raw?.url;
              if (u && !urls.includes(u)) urls.push(u);
            }
          }
          if (urls.length > 0) return urls; // 命中最新一条含图的消息即返回
        }
        // 最新助手消息已经完成但不是图片结果时，不再回退到旧消息，避免串历史图。
        return [];
      }
    } catch (e) { /* 走全局兜底 */ }
    // 全局正则兜底：抓 image_ori_raw 的 url
    const urls = [];
    const re = /image_ori_?raw[^}]*?url["\s:]*"(https?:\/\/[^"]+)"/gi;
    let m;
    while ((m = re.exec(responseText)) !== null) {
      if (!urls.includes(m[1])) urls.push(m[1]);
    }
    return urls;
  }

  // 构造 chain/single (cmd:3100) 拉取消息的请求体。pollChainSingle 与 getConversationMaxIndex 共用。
  _buildChainSingleBody(conversationId, account) {
    const pc = this.getPlatformConfig(account);
    return {
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: conversationId,
          anchor_index: 9007199254740991,
          conversation_type: pc.conversationType || 3,
          direction: 1,
          limit: 20,
          ext: {},
          filter: { index_list: [] }
        }
      },
      sequence_id: uuidv4(),
      channel: 2,
      version: '1'
    };
  }

  // 拉一次 chain/single，返回当前会话里最大的 index_in_conv。
  // 用途：提交生成「之前」建立基线——新一轮的视频消息一定落在比这更高的 index 上。
  // 不依赖 SSE_ACK 解析得到的 lastMessageIndex（dola 实测不回该字段，导致基线长期停滞，
  // 轮询会误把上一次已完成的视频当成本次结果，使历史会话全部显示成同一个最新视频）。
  async getConversationMaxIndex(conversationId, cookies, account) {
    try {
      const pc = this.getPlatformConfig(account);
      const qp = this.buildQuery(account || {});
      const url = `${pc.baseUrl}${pc.chainSingleEndpoint}?${qp}`;
      const body = this._buildChainSingleBody(conversationId, account);
      const result = await this.httpPost(url, body, cookies, {
        'Content-Type': 'application/json; encoding=utf-8'
      }, account);
      if (result.status === 200 && result.text) {
        const json = JSON.parse(result.text);
        const messages = json?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
        let max = 0;
        for (const m of messages) {
          const idx = parseInt(m.index_in_conv) || 0;
          if (idx > max) max = idx;
        }
        return max;
      }
    } catch (e) { /* 失败回退 0，由上层用 stored lastMessageIndex 兜底 */ }
    return 0;
  }

  // 通用 chain/single 轮询：每隔 intervalMs 拉一次，用 parser 解析，命中即返回。
  // parser(responseText) 返回数组，非空即视为成功。
  async pollChainSingle(conversationId, cookies, account, parser, opts = {}) {
    const pc = this.getPlatformConfig(account);
    const qp = this.buildQuery(account || {});
    const url = `${pc.baseUrl}${pc.chainSingleEndpoint}?${qp}`;
    const body = this._buildChainSingleBody(conversationId, account);
    const intervalMs = opts.intervalMs || 8000;
    const maxWaitMs = opts.maxWaitMs || 300000;
    const maxAttempts = Math.ceil(maxWaitMs / intervalMs);
    const onProgress = opts.onProgress;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (typeof onProgress === 'function') {
        onProgress({ attempt, total: maxAttempts, elapsedMs: attempt * intervalMs });
      }
      try {
        const result = await this.httpPost(url, body, cookies, {
          'Content-Type': 'application/json; encoding=utf-8'
        }, account);
        this.writeCapture(account, 'chain-single', {
          url: `${new URL(url).origin}${new URL(url).pathname}`,
          status: result.status,
          attempt,
          response: this.summarizeResponse(result.text)
        });
        if (result.status === 200 && result.text) {
          if (result.text.includes('"code":1090') || result.text.includes('not login')) {
            lastError = new Error('账号登录态已失效，请重新登录');
            break;
          }
          const generationFailure = this.detectGenerationFailure(result.text, account);
          if (generationFailure) {
            this.writeCapture(account, 'chain-single-failure', {
              url: `${new URL(url).origin}${new URL(url).pathname}`,
              status: result.status,
              attempt,
              error: generationFailure.message,
              response: this.summarizeResponse(result.text)
            }, true);
            // 平台已明确判定生成失败（如服务过载/审核拒绝），是终态错误，
            // 继续轮询只会反复读到同一条失败消息。立即 break 抛出，避免空等 60 分钟前端一直转圈。
            lastError = generationFailure;
            break;
          }
          const hit = parser(result.text);
          if (hit && hit.length > 0) {
            this.writeCapture(account, 'chain-single-hit', {
              url: `${new URL(url).origin}${new URL(url).pathname}`,
              status: result.status,
              attempt,
              hitCount: hit.length,
              response: this.summarizeResponse(result.text)
            }, true);
            return hit;
          }
          try {
            const dir = appPaths.debugDir;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'chain_single_last.json'), result.text);
          } catch (e) { /* 诊断失败不影响主流程 */ }
        }
      } catch (e) {
        lastError = e;
      }
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, intervalMs));
    }
    if (lastError) throw lastError;
    return [];
  }

  // 轮询拉取视频 vid（视频异步，初响应只有占位）。复用通用轮询器。
  async fetchVideoVids(conversationId, cookies, onProgress, account, afterIndex) {
    return this.pollChainSingle(conversationId, cookies, account,
      (text) => this.pullMessageVids(text, afterIndex),
      { onProgress, maxWaitMs: 3600000, intervalMs: 15000 }); // 视频最长等 60 分钟（dola 视频可能 55 分钟）
  }

  // 把 vid 数组解析为无水印视频 URL
  async resolveVideoUrls(videoKeys, cookies, account) {
    const isDola = (account && account.platform) === 'dola';
    const urls = [];
    for (const vid of videoKeys) {
      try {
        // Dola 无水印核心：轮询 chain/single 时暂存了富 video_model，
        // 其 video_list.video_N.main_url 是 base64 编码的无水印直链，本地解码即可，不依赖第三方。
        if (isDola) {
          const videoModel = this._takeVideoModel(vid);
          if (videoModel) {
            const cleanUrl = this.extractCleanUrlFromVideoModel(videoModel);
            if (cleanUrl && !urls.includes(cleanUrl)) { urls.push(cleanUrl); continue; }
            // 本地解码失败才退而求其次：试第三方去水印 API
            const fplay = videoModel.fallback_api || '';
            const apiUrl = await this.removeDolaWatermark(fplay, videoModel);
            if (apiUrl && !urls.includes(apiUrl)) { urls.push(apiUrl); continue; }
          }
        }

        const result = await this.getVideoPlayUrl(vid, cookies, account);
        const playUrl = result?.url || result;
        const playInfo = result?.playInfo || null;

        // Dola 平台：get_play_info 返回的是带水印链接，尽量再过一次去水印 API
        if (isDola) {
          if (!playUrl && !playInfo) continue;
          const cleanUrl = await this.removeDolaWatermark(playUrl, playInfo);
          const finalUrl = cleanUrl || playUrl;
          if (finalUrl && !urls.includes(finalUrl)) urls.push(finalUrl);
        } else {
          if (!playUrl) continue;
          if (!urls.includes(playUrl)) urls.push(playUrl);
        }
      } catch (e) { /* 单个失败不影响其他 */ }
    }
    return urls;
  }

  // 主动查询单个账号的额度（拉 chain/single 最新消息，从文本中提取"剩余 X 个"）
  async queryAccountQuota(account) {
    if (!account || !account.session?.cookies) return null;
    const pc = this.getPlatformConfig(account);
    const conv = this.conversations.getActive(account.platform || 'doubao', account.id);
    const conversationId = account.session?.conversation_id || conv?.doubaoConversationId;
    if (!conversationId) return null;

    try {
      const qp = this.buildQuery(account);
      const url = `${pc.baseUrl}${pc.chainSingleEndpoint}?${qp}`;
      const body = {
        cmd: 3100,
        uplink_body: {
          pull_singe_chain_uplink_body: {
            conversation_id: conversationId,
            anchor_index: 9007199254740991,
            conversation_type: pc.conversationType || 3,
            direction: 1,
            limit: 10,
            ext: {},
            filter: { index_list: [] }
          }
        },
        sequence_id: require('uuid').v4(),
        channel: 2,
        version: '1'
      };
      const result = await this.httpPost(url, body, account.session.cookies, {
        'Content-Type': 'application/json; encoding=utf-8'
      }, account);
      if (result.status === 200) {
        // 顺带刷新登录态，保活 cookie
        this.mergeSetCookies(account, result.setCookies);
        if (result.text) {
          const quotaMatch = result.text.match(/剩余\s*(\d+)\s*个/);
          if (quotaMatch) return parseInt(quotaMatch[1]);
        }
      }
    } catch (e) {
      // 查询失败不影响启动
    }
    return null;
  }

  // 启动时主动查询所有账号的额度
  async queryAllQuotas() {
    const accounts = this.accounts.getAll().filter(a => a.session?.cookies);
    for (const account of accounts) {
      try {
        const quota = await this.queryAccountQuota(account);
        if (quota !== null) {
          this.accounts.updateQuota(account.id, { videoRemaining: quota });
        }
      } catch (e) { /* 单个失败不影响其他 */ }
    }
  }

  // 对外 API 纯文本对话(多轮)。与 UI 生成的会话上下文完全隔离:
  //   - 会话状态存在独立的 _chatSessions(chatId 维度),不写 account.session
  //   - buildRequestBody 不传任何生成参数 => 无 chat_ability => 纯对话请求体
  //   - 传入 chatId 续聊已有对话;不传或 newConversation 则新建,返回新 chatId
  // options: { chatId?, newConversation?, platform?, accountId?, onProgress? }
  // 返回: { reply, chatId, conversationId, quota }
  async generateMessage(prompt, options = {}) {
    const account = this.resolveAccount(options);
    if (!account) throw new Error('没有可用账号');
    if (!prompt || !String(prompt).trim()) throw new Error('缺少对话内容');

    // 解析/新建 chat 会话。newConversation 强制开新对话(丢弃传入 chatId 的历史)。
    let sess = (!options.newConversation && options.chatId) ? this.getChatSession(options.chatId) : null;
    if (sess && sess.accountId && sess.accountId !== account.id) {
      // 传入的 chatId 属于别的账号:不跨账号复用服务端会话,退化为新建
      sess = null;
    }
    const chatId = (sess && sess.chatId) || ('chat_' + uuidv4());

    // 续聊时用会话存储里的 cid;新建时为空(触发 need_create_conversation)。
    const chatOverride = {
      conversation_id: sess?.conversation_id || '',
      section_id: sess?.section_id || '',
      last_message_index: sess?.last_message_index || 0
    };

    // 续聊已有会话:SSE_ACK 主要在新建时才回,续聊时 message_index 可能停滞,
    // 故先拉一次真实最大 index 作为基线(与视频生成同一做法,见 getConversationMaxIndex)。
    if (chatOverride.conversation_id) {
      try {
        const liveMax = await this.getConversationMaxIndex(chatOverride.conversation_id, account.session?.cookies, account);
        if (liveMax > 0) chatOverride.last_message_index = liveMax;
      } catch (e) { /* 拉取失败沿用存储值 */ }
    }

    // 纯对话请求体:不传 isVideo / image* 参数 => buildRequestBody 不附加 chat_ability
    const body = this.buildRequestBody(String(prompt), account, { chatOverride });

    // skipSessionUpdate:不写 account.session,由这里把 ack 写入独立 _chatSessions
    const rawText = await this.executeGeneration(body, account, options.onProgress, { skipSessionUpdate: true });

    const reply = this.extractDolaReply(rawText) || '';
    const parsed = this.parseSSEResponse(rawText, 'message');
    const ack = this._extractAckMeta(rawText);

    // 写回独立会话存储:新建时用 ack 的 cid;续聊时 ack 可能不回 cid,保留原 cid。
    const now = new Date().toISOString();
    const merged = {
      chatId,
      accountId: account.id,
      conversation_id: ack.conversation_id || chatOverride.conversation_id || '',
      section_id: ack.section_id || chatOverride.section_id || '',
      last_message_index: ack.last_message_index || chatOverride.last_message_index || 0,
      createdAt: sess?.createdAt || now,
      updatedAt: now
    };
    this._chatSessions.set(chatId, merged);
    this._saveChatSessions();

    return {
      reply,
      brief: reply,
      chatId,
      conversationId: merged.conversation_id,
      quota: parsed.quota
    };
  }

  // 文生图 / 参考图生图
  async generateImage(prompt, options = {}) {
    if (this.isOpenAICompatibleImagePlatform(options.platform)) {
      return this.generateOpenAICompatibleImage(prompt, options);
    }

    const account = this.resolveAccount(options);
    if (!account) throw new Error('没有可用账号');

    // 带图生图:与图生视频对齐,先把脚本里 @图片[文件名编号] 改写成 @image{上传顺序号}。
    // 无参考图时 rewriteImageReferences 原样返回,不影响纯文生图。
    const rewritten = this.rewriteImageReferences(prompt, options.imageReferences);
    const genPrompt = this.buildImagePrompt(rewritten, options);
    // 把前端参数映射为图片 chat_ability 字段（ability_type:3 嵌套结构）
    const body = this.buildRequestBody(genPrompt, account, {
      ...options,
      imageModel: options.model,
      imageStyle: options.style,
      imageRatio: options.ratio
    });
    const rawText = await this.executeGeneration(body, account, options.onProgress);
    const results = this.parseSSEResponse(rawText, 'image');

    if (results.quota !== null) {
      this.accounts.updateQuota(account.id, { imageRemaining: results.quota });
    }

    // 异步兜底：部分平台（如 dola）初始 SSE 只回"正在创作"占位，没有图片 URL，
    // 需轮询 chain/single 拿渲染完成的 image_ori_raw。doubao 同步返回时此处直接跳过。
    if (results.images.length === 0) {
      const conv = this.conversations.getActive(account.platform || 'doubao', account.id);
      const convId = account.session?.conversation_id || conv?.doubaoConversationId;
      if (convId) {
        try {
          const imgs = await this.pollChainSingle(
            convId, account.session.cookies, account,
            (text) => this.pullMessageImages(text),
            { onProgress: options.onProgress, maxWaitMs: 600000, intervalMs: 10000 } // 图片最长等 10 分钟
          );
          if (imgs.length > 0) results.images = imgs;
        } catch (e) {
          if (/生成失败|服务过载|710\d+|登录态已失效/.test(e.message)) throw e;
          // 普通网络瞬断保留空结果，前端提示未返回结果。
        }
      }
    }
    return results;
  }

  // 文生视频
  async generateVideo(prompt, options = {}) {
    if (this.isOrionVideoPlatform(options.platform)) {
      return this.generateOrionVideo(prompt, options);
    }
    const account = this.resolveAccount(options);
    if (!account) throw new Error('没有可用账号');

    // 记录发送前的 message_index，用于轮询时过滤掉旧消息
    const convBefore = this.conversations.getActive(account.platform || 'doubao', account.id);
    const afterIndex = account.session?.last_message_index || convBefore?.lastMessageIndex || 0;
    // 发送「之前」拉一次会话，拿到当前真实最大 index 作为轮询基线。
    // 比 stored lastMessageIndex 可靠（dola 不回 SSE_ACK，stored 值长期停滞会导致误取旧视频）。
    // 必须在 executeGeneration 之前取——之后取会把本次的占位视频消息也算进基线，反而被过滤掉。
    let baseIndex = afterIndex || 0;
    {
      const cidBefore = account.session?.conversation_id || convBefore?.doubaoConversationId;
      if (cidBefore) {
        const liveMax = await this.getConversationMaxIndex(cidBefore, account.session.cookies, account);
        baseIndex = Math.max(liveMax, baseIndex);
      }
    }

    // 豆包靠文本关键词 + chat_ability 一起路由：文本里也带比例/镜头提示，
    // chat_ability 只承载模型、时长、比例。
    const genPrompt = this.buildVideoPrompt(prompt, options);
    const body = this.buildRequestBody(genPrompt, account, {
      ...options,
      isVideo: true,
      duration: options.duration || 10,
      model: options.model || 'seedance_v2.0',
      ratio: options.ratio
    });
    const rawText = await this.executeGeneration(body, account, options.onProgress);
    const results = this.parseSSEResponse(rawText, 'video');

    if (results.quota !== null) {
      this.accounts.updateQuota(account.id, { videoRemaining: results.quota });
    }

    // 视频是异步的：初始 SSE 通常只有"正在创作"占位块，vid 要轮询 /im/chain/single 拿。
    // 若初始 SSE 已带回 vid（极少数快路径），直接用；否则启动轮询。
    if (results.videoKeys.length === 0) {
      const conv = this.conversations.getActive(account.platform || 'doubao', account.id);
      const convId = account.session?.conversation_id || conv?.doubaoConversationId;
      if (convId) {
        const vids = await this.fetchVideoVids(convId, account.session.cookies, options.onProgress, account, baseIndex);
        results.videoKeys = vids;
      }
    }

    // 用 vid 去水印
    if (results.videoKeys.length > 0) {
      results.videos = await this.resolveVideoUrls(results.videoKeys, account.session.cookies, account);
    }
    return results;
  }

  // 图生视频
  async generateImageToVideo(prompt, imageUri, options = {}) {
    const account = this.resolveAccount(options);
    if (!account) throw new Error('没有可用账号');

    // 记录发送前的 message_index，用于轮询时过滤掉旧消息
    const convBefore = this.conversations.getActive(account.platform || 'doubao', account.id);
    const afterIndex = account.session?.last_message_index || convBefore?.lastMessageIndex || 0;
    // 同文生视频：发送前拉一次会话，以真实最大 index 作为轮询基线，避免误取上一次旧视频。
    let baseIndex = afterIndex || 0;
    {
      const cidBefore = account.session?.conversation_id || convBefore?.doubaoConversationId;
      if (cidBefore) {
        const liveMax = await this.getConversationMaxIndex(cidBefore, account.session.cookies, account);
        baseIndex = Math.max(liveMax, baseIndex);
      }
    }

    // 同文生视频：必须带"生成视频"关键词，否则会被路由成图片生成
    // 先把脚本里 @图片[文件名编号] 改写成 dola 认的 @image{上传顺序号}
    const rewritten = this.rewriteImageReferences(prompt || '基于这张图片生成视频', options.imageReferences);
    const base = rewritten || '基于这张图片生成视频';
    const genPrompt = this.buildVideoPrompt(base, options);
    const body = this.buildRequestBody(genPrompt, account, {
      ...options,
      isVideo: true,
      duration: options.duration || 10,
      model: options.model || 'seedance_v2.0',
      ratio: options.ratio,
      imageUri,
      imageReferences: options.imageReferences,
      imageName: options.imageName,
      imageIdentifier: options.imageIdentifier,
      imageWidth: options.imageWidth,
      imageHeight: options.imageHeight,
      imageFormat: options.imageFormat
    });
    const rawText = await this.executeGeneration(body, account, options.onProgress);
    const results = this.parseSSEResponse(rawText, 'video');

    if (results.quota !== null) {
      this.accounts.updateQuota(account.id, { videoRemaining: results.quota });
    }

    if (results.videoKeys.length === 0) {
      const conv = this.conversations.getActive(account.platform || 'doubao', account.id);
      const convId = account.session?.conversation_id || conv?.doubaoConversationId;
      if (convId) {
        const vids = await this.fetchVideoVids(convId, account.session.cookies, options.onProgress, account, baseIndex);
        results.videoKeys = vids;
      }
    }

    if (results.videoKeys.length > 0) {
      results.videos = await this.resolveVideoUrls(results.videoKeys, account.session.cookies, account);
    }
    return results;
  }
}

module.exports = GenerationService;





