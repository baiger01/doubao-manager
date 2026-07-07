const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appPaths = require('../paths');
const GenerationService = require('../services/generation-service');

function createService() {
  appPaths.debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dou-manager-test-'));
  const account = {
    id: 'acc-dola',
    platform: 'dola',
    session: {
      cookies: 'sid=secret',
      device_id: 'device-1',
      web_id: 'web-1',
      fp: 'fp-1',
      conversation_id: 'conv-dola',
      bot_id: 'bot-dola',
      section_id: 'sec-dola'
    }
  };
  const accounts = {
    getById(id) { return id === account.id ? account : null; },
    getActiveByPlatform(platform) { return platform === 'dola' ? account : null; },
    getActive() { return account; },
    update() {},
    updateQuota() {}
  };
  const conversations = {
    getActive(platform, accountId) {
      if (platform !== 'dola' || accountId !== 'acc-dola') return null;
      return { id: 'local-conv', platform, accountId, doubaoConversationId: 'conv-dola', sectionId: 'sec-dola' };
    },
    updateDoubaoMeta() {}
  };
  const config = {
    platforms: {
      dola: {
        baseUrl: 'https://www.dola.com',
        chatEndpoint: '/chat/completion',
        chainSingleEndpoint: '/im/chain/single',
        botId: 'bot-dola',
        conversationType: 3,
        defaultParams: { aid: '495671' }
      }
    }
  };
  return { service: new GenerationService(accounts, conversations, config), account };
}



test('generation prompt helpers live in a focused prompt builder module', () => {
  const promptBuilder = require('../services/generation/prompt-builder');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'generation-service.js'), 'utf8');

  assert.equal(promptBuilder.ratioOrientationText('9:16'), '竖屏9:16画面');
  assert.equal(promptBuilder.ratioOrientationText('16:9'), '横屏16:9画面');
  assert.equal(promptBuilder.ratioOrientationText('1:1'), '方形1:1画面');
  assert.equal(promptBuilder.buildImagePrompt('小猫', { style: 'skill_image_styles_portrait', ratio: '3:4' }), '生成图片：小猫，人像摄影，竖屏3:4画面');
  assert.equal(promptBuilder.buildVideoPrompt('小猫跳舞', { ratio: '16:9', movement: 'pan', movementSubject: '小猫' }), '生成视频：小猫跳舞，镜头环绕小猫拍摄，横屏16:9画面');
  assert.equal(
    promptBuilder.rewriteImageReferences('让@图片[1]和@图片【5】互动', [{ imageName: '001.png' }, { imageName: '5.jpg' }]),
    '让@image1和@image2互动'
  );
  assert.match(source, /promptBuilder\.buildImagePrompt/);
  assert.match(source, /promptBuilder\.buildVideoPrompt/);
  assert.match(source, /promptBuilder\.rewriteImageReferences/);
});

test('image-to-video request keeps explicit video ratio instead of leaking reference image dimensions', () => {
  const { service, account } = createService();
  const body = service.buildRequestBody('生成视频：测试', account, {
    isVideo: true,
    ratio: '9:16',
    duration: 10,
    model: 'seedance_v2.0',
    imageReferences: [{
      imageUri: 'tos://ref-image',
      imageIdentifier: 'img-1',
      imageName: 'landscape.png',
      imageWidth: 1600,
      imageHeight: 900,
      imageFormat: 'png'
    }]
  });

  const attachment = body.messages[0].content_block[0].content.attachment_block.attachments[0];
  assert.equal(JSON.parse(body.chat_ability.ability_param).ratio, '9:16');
  assert.equal(attachment.image.image_ori.width, 0);
  assert.equal(attachment.image.image_ori.height, 0);
});

test('image-to-video keeps reference dimensions when they already match the selected ratio', () => {
  const { service, account } = createService();
  const body = service.buildRequestBody('生成视频：测试', account, {
    isVideo: true,
    ratio: '9:16',
    duration: 10,
    model: 'seedance_v2.0',
    imageReferences: [{
      imageUri: 'tos://ref-image',
      imageIdentifier: 'img-1',
      imageName: 'portrait.png',
      imageWidth: 900,
      imageHeight: 1600,
      imageFormat: 'png'
    }]
  });

  const attachment = body.messages[0].content_block[0].content.attachment_block.attachments[0];
  assert.equal(attachment.image.image_ori.width, 900);
  assert.equal(attachment.image.image_ori.height, 1600);
});
test('image request still keeps reference image dimensions when not generating video', () => {
  const { service, account } = createService();
  const body = service.buildRequestBody('生成图片：测试', account, {
    imageRatio: '9:16',
    imageReferences: [{
      imageUri: 'tos://ref-image',
      imageIdentifier: 'img-1',
      imageName: 'landscape.png',
      imageWidth: 1600,
      imageHeight: 900,
      imageFormat: 'png'
    }]
  });

  const attachment = body.messages[0].content_block[0].content.attachment_block.attachments[0];
  assert.equal(attachment.image.image_ori.width, 1600);
  assert.equal(attachment.image.image_ori.height, 900);
});

test('parseSSEResponse decodes escaped Dola image_ori_raw urls', () => {
  const { service } = createService();
  const rawText = String.raw`event: CHUNK_DELTA
data: {"content":{"creation_block":{"creations":[{"type":1,"image":{"image_ori_raw":{"url":"https:\/\/p3-flow-imagex-sign.ibyteimg.com\/tos-maliva-i-a9rns2rl98\/rc_gen_image\/abc.jpeg~tplv-a9rns2rl98-image_raw_b.png?x-signature=a%2Fb"}}}}]}}}`;

  const result = service.parseSSEResponse(rawText, 'image');

  assert.deepEqual(result.images, [
    'https://p3-flow-imagex-sign.ibyteimg.com/tos-maliva-i-a9rns2rl98/rc_gen_image/abc.jpeg~tplv-a9rns2rl98-image_raw_b.png?x-signature=a%2Fb'
  ]);
});

test('extractDolaReply merges CHUNK_DELTA and STREAM_CHUNK text into the original reply', () => {
  const { service } = createService();
  const rawText = [
    'event: CHUNK_DELTA\ndata: {"text":"正在为您"}',
    'event: CHUNK_DELTA\ndata: {"text":"生成视频。"}',
    // tts_content 是语音版重复，必须被忽略
    'event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":111,"patch_type":1,"patch_value":{"tts_content":"正在"}}]}',
    'event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"今日剩余 5 个额度。"}}}]}}]}'
  ].join('\n\n');

  assert.equal(service.extractDolaReply(rawText), '正在为您生成视频。今日剩余 5 个额度。');
});

test('parseSSEResponse fills brief with the full Dola reply', () => {
  const { service } = createService();
  const rawText = [
    'event: CHUNK_DELTA\ndata: {"text":"好的，正在为你创作。"}',
    'event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":1,"patch_type":1,"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"今日剩余 3 个视频生成额度。"}}}]}}]}'
  ].join('\n\n');

  const result = service.parseSSEResponse(rawText, 'video');
  assert.equal(result.brief, '好的，正在为你创作。今日剩余 3 个视频生成额度。');
});

test('extractCleanUrlFromVideoModel decodes base64 main_url into the unwatermarked direct link', () => {
  const { service } = createService();
  const cleanUrl = 'http://v16-dola.dola.com/video/tos/mya/abc/?lr=unwatermarked&br=2628';
  const videoModel = {
    fallback_api: 'https://vod-urls.byteintlapi.com/video/fplay/1/abc/v123?logo_type=unwatermarked',
    video_list: {
      video_1: {
        vwidth: 720, vheight: 1280,
        main_url: Buffer.from(cleanUrl, 'utf-8').toString('base64')
      }
    }
  };
  assert.equal(service.extractCleanUrlFromVideoModel(videoModel), cleanUrl);
});

test('extractCleanUrlFromVideoModel prefers highest resolution and falls back to fallback_api', () => {
  const { service } = createService();
  const lowUrl = 'http://v16-dola.dola.com/low/?lr=unwatermarked';
  const highUrl = 'http://v16-dola.dola.com/high/?lr=unwatermarked';
  const videoModel = {
    video_list: {
      video_1: { vwidth: 360, vheight: 640, main_url: Buffer.from(lowUrl).toString('base64') },
      video_2: { vwidth: 1080, vheight: 1920, main_url: Buffer.from(highUrl).toString('base64') }
    }
  };
  assert.equal(service.extractCleanUrlFromVideoModel(videoModel), highUrl);

  // 没有 video_list 时回退到 fallback_api
  const fb = 'https://vod-urls.byteintlapi.com/video/fplay/1/x/v9?logo_type=unwatermarked';
  assert.equal(service.extractCleanUrlFromVideoModel({ fallback_api: fb }), fb);
});

test('pullMessageVids stashes video_model so resolveVideoUrls returns unwatermarked url without get_play_info', async () => {
  const { service, account } = createService();
  const cleanUrl = 'http://v16-dola.dola.com/video/tos/mya/xyz/?lr=unwatermarked';
  const videoModel = {
    video_list: { video_1: { vwidth: 720, vheight: 1280, main_url: Buffer.from(cleanUrl).toString('base64') } }
  };
  const chainResponse = JSON.stringify({
    downlink_body: { pull_singe_chain_downlink_body: { messages: [{
      index_in_conv: '10',
      content_block: [{
        block_type: 2074,
        content: { creation_block: { creations: [{
          type: 2,
          video: { vid: 'v0test123', video_model: JSON.stringify(videoModel) }
        }] } }
      }]
    }] } }
  });

  const vids = service.pullMessageVids(chainResponse, 0);
  assert.deepEqual(vids, ['v0test123']);

  // get_play_info 返回带水印链接，不该被使用
  let getPlayCalled = false;
  service.getVideoPlayUrl = async () => { getPlayCalled = true; return { url: 'WATERMARKED', playInfo: {} }; };
  const urls = await service.resolveVideoUrls(vids, 'sid=secret', account);
  assert.deepEqual(urls, [cleanUrl]);
  assert.equal(getPlayCalled, false);
});

test('pullMessageVids does not return a stale prior video when no new video exists above afterIndex', () => {
  const { service } = createService();
  // 会话里只有一个早已完成的旧视频（index_in_conv=7）。本次提交后基线 afterIndex=7，
  // 新视频还没渲染出来。必须返回 []（继续轮询），绝不能把旧视频当成本次结果回传。
  const oldVideoModel = { video_list: { video_1: { vwidth: 720, vheight: 1280, main_url: Buffer.from('http://old/?lr=unwatermarked').toString('base64') } } };
  const chainResponse = JSON.stringify({
    downlink_body: { pull_singe_chain_downlink_body: { messages: [{
      index_in_conv: '7',
      content_block: [{
        block_type: 2074,
        content: { creation_block: { creations: [{
          type: 2,
          video: { vid: 'v0OLDSTALE', video_model: JSON.stringify(oldVideoModel) }
        }] } }
      }]
    }] } }
  });
  // 基线 = 旧视频自己的 index：不应再次返回它
  assert.deepEqual(service.pullMessageVids(chainResponse, 7), []);
  // 更高的基线同样返回空
  assert.deepEqual(service.pullMessageVids(chainResponse, 99), []);
  // 基线更低时（确实有新视频）才返回
  assert.deepEqual(service.pullMessageVids(chainResponse, 6), ['v0OLDSTALE']);
});

test('getConversationMaxIndex returns the largest index_in_conv from chain/single', async () => {
  const { service, account } = createService();
  service.httpPost = async () => ({
    status: 200,
    text: JSON.stringify({
      downlink_body: { pull_singe_chain_downlink_body: { messages: [
        { index_in_conv: '3' }, { index_in_conv: '7' }, { index_in_conv: '5' }
      ] } }
    })
  });
  const max = await service.getConversationMaxIndex('conv123', 'sid=x', account);
  assert.equal(max, 7);
});


test('pollChainSingle rejects Dola platform generation failures from captured response', async () => {
  const { service, account } = createService();
  service.httpPost = async () => ({
    status: 200,
    text: JSON.stringify({
      downlink_body: {
        pull_singe_chain_downlink_body: {
          messages: [{
            index_in_conv: '7',
            content_block: [{
              block_type: 10000,
              content: { text_block: { text: '服务过载，请稍后重试' } }
            }],
            ext: {
              ai_creation_res_code: '710082003',
              ai_creation_tool_list: JSON.stringify([
                { tool_name: 'image_gen', status: 5, fail_code: 710082003 }
              ])
            },
            brief: '服务过载，请稍后重试'
          }]
        }
      },
      status_code: 0
    })
  });

  await assert.rejects(
    () => service.pollChainSingle('conv-dola', 'sid=secret', account, () => [], { maxWaitMs: 1, intervalMs: 1 }),
    /Dola.*710082003|服务过载/
  );
});

test('pullMessageImages does not return older images when latest Dola reply failed', () => {
  const { service } = createService();
  const response = JSON.stringify({
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            index_in_conv: '9',
            user_type: 2,
            content_block: [{ block_type: 10000, content: { text_block: { text: '服务过载，请稍后重试' } } }],
            ext: { ai_creation_res_code: '710082003' },
            brief: '服务过载，请稍后重试'
          },
          {
            index_in_conv: '5',
            user_type: 2,
            content_block: [{
              block_type: 2074,
              content: {
                creation_block: {
                  creations: [{
                    type: 1,
                    image: { image_ori_raw: { url: 'https://p3-flow-imagex-sign.ibyteimg.com/old.png' } }
                  }]
                }
              }
            }]
          }
        ]
      }
    }
  });

  assert.deepEqual(service.pullMessageImages(response), []);
});

test('pollChainSingle returns latest image even when older Dola messages contain failures', async () => {
  const { service, account } = createService();
  service.httpPost = async () => ({
    status: 200,
    text: JSON.stringify({
      downlink_body: {
        pull_singe_chain_downlink_body: {
          messages: [
            {
              index_in_conv: '11',
              user_type: 2,
              content_block: [{
                block_type: 2074,
                content: {
                  creation_block: {
                    creations: [{
                      type: 1,
                      image: { image_ori_raw: { url: 'https://p3-flow-imagex-sign.ibyteimg.com/new.png' } }
                    }]
                  }
                }
              }]
            },
            {
              index_in_conv: '7',
              user_type: 2,
              content_block: [{ block_type: 10000, content: { text_block: { text: '服务过载，请稍后重试' } } }],
              ext: { ai_creation_res_code: '710082003' },
              brief: '服务过载，请稍后重试'
            }
          ]
        }
      },
      status_code: 0
    })
  });

  const urls = await service.pollChainSingle(
    'conv-dola',
    'sid=secret',
    account,
    (text) => service.pullMessageImages(text),
    { maxWaitMs: 1, intervalMs: 1 }
  );

  assert.deepEqual(urls, ['https://p3-flow-imagex-sign.ibyteimg.com/new.png']);
});

test('generateImage surfaces Dola polling failures instead of completing empty', async () => {
  const { service } = createService();
  service.executeGeneration = async () => 'event: CHUNK_DELTA\ndata: {"text":"正在创作"}\n\n';
  service.pollChainSingle = async () => {
    throw new Error('Dola 图片生成失败: 服务过载，请稍后重试 (710082003)');
  };

  await assert.rejects(
    () => service.generateImage('小猫', { platform: 'dola', accountId: 'acc-dola' }),
    /服务过载|710082003/
  );
});

test('generateImage sends official Doubao image style, ratio, and model parameters', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => {
    capturedBody = body;
    return 'ok';
  };
  service.parseSSEResponse = () => ({ images: ['https://example.com/image.png'], videos: [], videoKeys: [], quota: null, brief: null });

  await service.generateImage('一只小猫坐在竹林旁', {
    platform: 'dola',
    accountId: 'acc-dola',
    ratio: '9:16',
    style: 'skill_image_styles_ink_wash_painting',
    model: 'Seedream 4.5'
  });

  const text = capturedBody.messages[0].content_block.find((block) => block.block_type === 10000).content.text_block.text;
  const abilityParam = JSON.parse(capturedBody.chat_ability.ability_param);

  assert.equal(text, '生成图片：一只小猫坐在竹林旁，水墨画，竖屏9:16画面');
  assert.deepEqual(abilityParam, {
    ability_param: {
      style: 'skill_image_styles_ink_wash_painting',
      ratio: '9:16',
      model: 'Seedream 4.5'
    },
    ability_type: 1
  });
});

test('generateImage uses official skill pack style labels in prompt text', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => {
    capturedBody = body;
    return 'ok';
  };
  service.parseSSEResponse = () => ({ images: ['https://example.com/image.png'], videos: [], videoKeys: [], quota: null, brief: null });

  await service.generateImage('点子感', {
    platform: 'dola',
    accountId: 'acc-dola',
    ratio: '16:9',
    style: 'skill_image_styles_cg',
    model: 'Seedream 5.0 Lite'
  });

  const text = capturedBody.messages[0].content_block.find((block) => block.block_type === 10000).content.text_block.text;
  const abilityParam = JSON.parse(capturedBody.chat_ability.ability_param);

  assert.equal(text, '生成图片：点子感，CG 动画，横屏16:9画面');
  assert.equal(abilityParam.ability_param.style, 'skill_image_styles_cg');
});

test('generateImage attaches reference images as a 10052 block for image-with-reference generation', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => {
    capturedBody = body;
    return 'ok';
  };
  service.parseSSEResponse = () => ({ images: ['https://example.com/image.png'], videos: [], videoKeys: [], quota: null, brief: null });

  await service.generateImage('帮我把@图片[1]和@图片[2]合成像素图', {
    platform: 'dola',
    accountId: 'acc-dola',
    ratio: '9:16',
    model: 'Seedream 5.0 Lite',
    imageReferences: [
      { imageUri: 'tos-cn-i-a9rns2rl98/a.jpg', imageIdentifier: 'id-1', imageName: '1.jpg', imageWidth: 768, imageHeight: 432, imageFormat: 'jpg' },
      { imageUri: 'tos-cn-i-a9rns2rl98/b.png', imageIdentifier: 'id-2', imageName: '2.png', imageWidth: 512, imageHeight: 512, imageFormat: 'png' }
    ]
  });

  // 消息结构:第一条 10052 附件块,第二条 10000 文本块(与真实抓包一致)
  assert.deepEqual(
    capturedBody.messages.map((m) => m.content_block.map((b) => b.block_type)),
    [[10052], [10000]]
  );
  const attachments = capturedBody.messages[0].content_block[0].content.attachment_block.attachments;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].image.uri, 'tos-cn-i-a9rns2rl98/a.jpg');
  assert.equal(attachments[1].image.uri, 'tos-cn-i-a9rns2rl98/b.png');
  // 文本里的 @图片[N] 已改写成 @imageN(按上传顺序),且仍是图片 ability_type:3
  const text = capturedBody.messages[1].content_block.find((b) => b.block_type === 10000).content.text_block.text;
  assert.match(text, /@image1.*@image2/);
  assert.equal(capturedBody.chat_ability.ability_type, 3);
});

test('generateImage uses plus OpenAI-compatible image API without requiring an account', async () => {
  const accounts = {
    getById() { return null; },
    getActiveByPlatform() { return null; },
    getActive() { return null; },
    updateQuota() {}
  };
  const conversations = { getActive() { return null; }, updateDoubaoMeta() {} };
  const service = new GenerationService(accounts, conversations, {
    platforms: {
      plus: {
        label: 'plus',
        requiresAccount: false,
        imageApi: {
          type: 'openai-compatible',
          endpoint: 'http://example.test/v1/images/generations',
          apiKey: 'sk-test',
          model: 'gpt-image-2'
        }
      }
    }
  });

  let captured = null;
  service.httpRequest = async (url, method, bodyBuffer, headers, account) => {
    captured = {
      url,
      method,
      body: JSON.parse(Buffer.from(bodyBuffer).toString('utf8')),
      headers,
      account
    };
    return {
      status: 200,
      text: JSON.stringify({
        data: [{ url: 'https://cdn.example.test/generated.png' }],
        usage: { total_tokens: 12 }
      })
    };
  };

  const result = await service.generateImage('一只猫', {
    platform: 'plus',
    ratio: '9:16',
    model: 'gpt-image2'
  });

  assert.deepEqual(result.images, ['https://cdn.example.test/generated.png']);
  assert.equal(captured.url, 'http://example.test/v1/images/generations');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body.model, 'gpt-image-2');
  assert.equal(captured.body.size, '1024x1536');
  assert.match(captured.body.prompt, /一只猫/);
  assert.equal(captured.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(captured.account, { platform: 'plus' });
});

test('generateImage repeats plus text generations instead of sending n in JSON', async () => {
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {
      platforms: {
        plus: {
          label: 'plus',
          requiresAccount: false,
          imageApi: {
            type: 'openai-compatible',
            endpoint: 'http://example.test/v1/images/generations',
            apiKey: 'sk-test',
            model: 'gpt-image-2'
          }
        }
      }
    }
  );

  const calls = [];
  service.httpRequest = async (url, method, bodyBuffer, headers, account) => {
    const body = JSON.parse(Buffer.from(bodyBuffer).toString('utf8'));
    calls.push({ url, method, body, headers, account });
    if ('n' in body) {
      return { status: 400, text: JSON.stringify({ error: { message: "Unknown parameter: 'tools[0].n'." } }) };
    }
    return {
      status: 200,
      text: JSON.stringify({ data: [{ url: `https://cdn.example.test/plus-text-${calls.length}.png` }] })
    };
  };

  const result = await service.generateImage('海边自拍', {
    platform: 'plus',
    ratio: '9:16',
    n: 4
  });

  assert.deepEqual(result.images, [
    'https://cdn.example.test/plus-text-1.png',
    'https://cdn.example.test/plus-text-2.png',
    'https://cdn.example.test/plus-text-3.png',
    'https://cdn.example.test/plus-text-4.png'
  ]);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.url, 'http://example.test/v1/images/generations');
    assert.equal(call.method, 'POST');
    assert.equal(call.body.model, 'gpt-image-2');
    assert.equal(call.body.size, '1024x1536');
    assert.equal(call.body.n, undefined);
  }
});

test('generateImage sends plus reference images as OpenAI-compatible multipart edits', async () => {
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {
      platforms: {
        plus: {
          label: 'plus',
          requiresAccount: false,
          imageApi: {
            type: 'openai-compatible',
            endpoint: 'http://example.test/v1/images/generations',
            apiKey: 'sk-test',
            model: 'gpt-image-2'
          }
        }
      }
    }
  );

  let captured = null;
  service.httpRequest = async (url, method, bodyBuffer, headers, account) => {
    captured = {
      url,
      method,
      body: Buffer.from(bodyBuffer),
      headers,
      account
    };
    return {
      status: 200,
      text: JSON.stringify({ data: [{ url: 'https://cdn.example.test/edited-plus.png' }] })
    };
  };

  const result = await service.generateImage('照着参考图换成像素风', {
    platform: 'plus',
    ratio: '9:16',
    imageReferences: [
      {
        dataUrl: 'data:image/png;base64,' + Buffer.from('plus-ref-png').toString('base64'),
        name: 'plus.png'
      }
    ]
  });

  const multipart = captured.body.toString('utf8');

  assert.deepEqual(result.images, ['https://cdn.example.test/edited-plus.png']);
  assert.equal(captured.url, 'http://example.test/v1/images/edits');
  assert.equal(captured.method, 'POST');
  assert.match(captured.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.equal(captured.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(captured.account, { platform: 'plus' });
  assert.match(multipart, /name="model"\r\n\r\ngpt-image-2/);
  assert.match(multipart, /name="prompt"\r\n\r\n生成图片：照着参考图换成像素风/);
  assert.match(multipart, /name="size"\r\n\r\n1024x1536/);
  assert.match(multipart, /name="image"; filename="plus\.png"\r\nContent-Type: image\/png/);
  assert.match(multipart, /plus-ref-png/);
});

test('generateImage repeats plus reference edits instead of sending n in multipart', async () => {
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {
      platforms: {
        plus: {
          label: 'plus',
          requiresAccount: false,
          imageApi: {
            type: 'openai-compatible',
            endpoint: 'http://example.test/v1/images/generations',
            apiKey: 'sk-test',
            model: 'gpt-image-2'
          }
        }
      }
    }
  );

  const calls = [];
  service.httpRequest = async (url, method, bodyBuffer, headers, account) => {
    calls.push({
      url,
      method,
      body: Buffer.from(bodyBuffer).toString('utf8'),
      headers,
      account
    });
    return {
      status: 200,
      text: JSON.stringify({ data: [{ url: `https://cdn.example.test/edited-plus-${calls.length}.png` }] })
    };
  };

  const result = await service.generateImage('照着参考图生成四张变化图', {
    platform: 'plus',
    ratio: '1:1',
    n: 4,
    imageReferences: [
      {
        dataUrl: 'data:image/png;base64,' + Buffer.from('plus-ref-a').toString('base64'),
        name: 'a.png'
      },
      {
        dataUrl: 'data:image/jpeg;base64,' + Buffer.from('plus-ref-b').toString('base64'),
        name: 'b.jpg'
      }
    ]
  });

  assert.deepEqual(result.images, [
    'https://cdn.example.test/edited-plus-1.png',
    'https://cdn.example.test/edited-plus-2.png',
    'https://cdn.example.test/edited-plus-3.png',
    'https://cdn.example.test/edited-plus-4.png'
  ]);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.url, 'http://example.test/v1/images/edits');
    assert.equal(call.method, 'POST');
    assert.doesNotMatch(call.body, /name="n"\r\n\r\n/);
    assert.match(call.body, /name="model"\r\n\r\ngpt-image-2/);
    assert.match(call.body, /name="size"\r\n\r\n1024x1024/);
    assert.match(call.body, /name="image"; filename="a\.png"\r\nContent-Type: image\/png/);
    assert.match(call.body, /name="image"; filename="b\.jpg"\r\nContent-Type: image\/jpeg/);
  }
});

test('generateImage starts repeated plus reference edits concurrently', async () => {
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {
      platforms: {
        plus: {
          label: 'plus',
          requiresAccount: false,
          imageApi: {
            type: 'openai-compatible',
            endpoint: 'http://example.test/v1/images/generations',
            apiKey: 'sk-test',
            model: 'gpt-image-2'
          }
        }
      }
    }
  );

  const calls = [];
  service.httpRequest = async () => {
    const callNo = calls.length + 1;
    calls.push(callNo);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (calls.length < 4) throw new Error(`only ${calls.length} plus edit request started`);
    return {
      status: 200,
      text: JSON.stringify({ data: [{ url: `https://cdn.example.test/parallel-plus-${callNo}.png` }] })
    };
  };

  const result = await service.generateImage('照着参考图并发生成四张变化图', {
    platform: 'plus',
    ratio: '1:1',
    n: 4,
    imageReferences: [
      {
        dataUrl: 'data:image/png;base64,' + Buffer.from('plus-ref-a').toString('base64'),
        name: 'a.png'
      }
    ]
  });

  assert.deepEqual(result.images, [
    'https://cdn.example.test/parallel-plus-1.png',
    'https://cdn.example.test/parallel-plus-2.png',
    'https://cdn.example.test/parallel-plus-3.png',
    'https://cdn.example.test/parallel-plus-4.png'
  ]);
});

test('generateImage respects selected ratio for 4k OpenAI-compatible image defaults', async () => {
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {
      platforms: {
        '4k': {
          label: '4k',
          requiresAccount: false,
          supportsVideo: false,
          imageApi: {
            type: 'openai-compatible',
            baseUrl: 'https://5988.de5.net/v1',
            apiKey: 'sk-4k-test',
            model: 'gpt-image-2',
            size: '3840x2160',
            quality: 'high'
          }
        }
      }
    }
  );

  let captured = null;
  service.httpRequest = async (url, method, bodyBuffer, headers, account) => {
    captured = {
      url,
      method,
      body: JSON.parse(Buffer.from(bodyBuffer).toString('utf8')),
      headers,
      account
    };
    return {
      status: 200,
      text: JSON.stringify({ data: [{ url: 'https://cdn.example.test/paris-4k.png' }] })
    };
  };

  const result = await service.generateImage('法国巴黎街道', { platform: '4k', ratio: '1:1', n: 9 });

  assert.deepEqual(result.images, ['https://cdn.example.test/paris-4k.png']);
  assert.equal(captured.url, 'https://5988.de5.net/v1/images/generations');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body.model, 'gpt-image-2');
  assert.equal(captured.body.size, '2160x2160');
  assert.equal(captured.body.quality, 'high');
  assert.equal(captured.body.n, 4);
  assert.match(captured.body.prompt, /法国巴黎街道/);
  assert.equal(captured.headers.Authorization, 'Bearer sk-4k-test');
  assert.deepEqual(captured.account, { platform: '4k' });
});

test('openAIImageSizeFromRatio derives portrait 4k size from selected ratio', () => {
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {}
  );

  assert.equal(service.openAIImageSizeFromRatio('9:16', '3840x2160'), '2160x3840');
  assert.equal(service.openAIImageSizeFromRatio('16:9', '3840x2160'), '3840x2160');
  assert.equal(service.openAIImageSizeFromRatio('1:1', '3840x2160'), '2160x2160');
});

test('generateImage sends 4k reference images as OpenAI-compatible multipart edits', async () => {
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {
      platforms: {
        '4k': {
          label: '4k',
          requiresAccount: false,
          supportsVideo: false,
          imageApi: {
            type: 'openai-compatible',
            baseUrl: 'https://5988.de5.net/v1',
            apiKey: 'sk-4k-test',
            model: 'gpt-image-2',
            size: '3840x2160',
            quality: 'high'
          }
        }
      }
    }
  );

  let captured = null;
  service.httpRequest = async (url, method, bodyBuffer, headers, account) => {
    captured = {
      url,
      method,
      body: Buffer.from(bodyBuffer),
      headers,
      account
    };
    return {
      status: 200,
      text: JSON.stringify({ data: [{ url: 'https://cdn.example.test/edited-4k.png' }] })
    };
  };

  const result = await service.generateImage('把这张图增强成电影质感', {
    platform: '4k',
    ratio: '1:1',
    n: 2,
    imageReferences: [
      {
        dataUrl: 'data:image/png;base64,' + Buffer.from('first-ref-png').toString('base64'),
        name: '1.png'
      },
      {
        dataUrl: 'data:image/jpeg;base64,' + Buffer.from('second-ref-jpg').toString('base64'),
        name: '2.jpg'
      }
    ]
  });

  const multipart = captured.body.toString('utf8');

  assert.deepEqual(result.images, ['https://cdn.example.test/edited-4k.png']);
  assert.equal(captured.url, 'https://5988.de5.net/v1/images/edits');
  assert.equal(captured.method, 'POST');
  assert.match(captured.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.equal(captured.headers.Authorization, 'Bearer sk-4k-test');
  assert.deepEqual(captured.account, { platform: '4k' });
  assert.match(multipart, /name="model"\r\n\r\ngpt-image-2/);
  assert.match(multipart, /name="prompt"\r\n\r\n生成图片：把这张图增强成电影质感/);
  assert.match(multipart, /name="n"\r\n\r\n2/);
  assert.match(multipart, /name="size"\r\n\r\n2160x2160/);
  assert.match(multipart, /name="quality"\r\n\r\nhigh/);
  assert.match(multipart, /name="image"; filename="1\.png"\r\nContent-Type: image\/png/);
  assert.match(multipart, /name="image"; filename="2\.jpg"\r\nContent-Type: image\/jpeg/);
  assert.match(multipart, /first-ref-png/);
  assert.match(multipart, /second-ref-jpg/);
});

test('OpenAI-compatible image API b64_json responses are materialized as local images', async () => {
  appPaths.debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dou-manager-gptimage-debug-'));
  appPaths.downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dou-manager-gptimage-downloads-'));
  const pngBytes = Buffer.from('not-a-real-png-but-test-bytes');
  const service = new GenerationService(
    { getById() { return null; }, getActiveByPlatform() { return null; }, getActive() { return null; }, updateQuota() {} },
    { getActive() { return null; }, updateDoubaoMeta() {} },
    {
      storage: { downloadDir: appPaths.downloadsDir },
      platforms: {
        gptimage: {
          requiresAccount: false,
          imageApi: {
            type: 'openai-compatible',
            endpoint: 'http://example.test/v1/images/generations',
            apiKey: 'sk-test',
            model: 'gpt-image-2'
          }
        }
      }
    }
  );
  service.httpRequest = async () => ({
    status: 200,
    text: JSON.stringify({
      data: [{ b64_json: pngBytes.toString('base64') }],
      output_format: 'png'
    })
  });

  const result = await service.generateImage('红色方块', { platform: 'gptimage', ratio: '1:1' });

  assert.equal(result.images.length, 1);
  assert.match(result.images[0], /^local:\/\/gptimage_image_/);
  const fileName = result.images[0].replace('local://', '');
  assert.equal(fs.readFileSync(path.join(appPaths.downloadsDir, fileName)).toString(), pngBytes.toString());
});

test('generateVideo sends official Doubao video ratio, duration, and model parameters', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => {
    capturedBody = body;
    return 'ok';
  };
  service.parseSSEResponse = () => ({ images: [], videos: [], videoKeys: ['v0123'], quota: null, brief: null });
  service.resolveVideoUrls = async () => ['https://example.com/video.mp4'];

  await service.generateVideo('小猫动起来,然后跳舞', {
    platform: 'dola',
    accountId: 'acc-dola',
    ratio: '21:9',
    duration: 10,
    model: 'seedance_v2.0'
  });

  const text = capturedBody.messages[0].content_block.find((block) => block.block_type === 10000).content.text_block.text;
  const abilityParam = JSON.parse(capturedBody.chat_ability.ability_param);

  assert.equal(text, '生成视频：小猫动起来,然后跳舞，横屏21:9画面');
  assert.deepEqual(capturedBody.chat_ability, {
    ability_type: 17,
    ability_param: JSON.stringify({
      ratio: '21:9',
      model: 'seedance_v2.0',
      duration: 10
    })
  });
  assert.deepEqual(abilityParam, {
    ratio: '21:9',
    model: 'seedance_v2.0',
    duration: 10
  });
});

test('generateVideo uses Orion local video API without a login account', async () => {
  appPaths.downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dou-manager-orion-downloads-'));
  const config = {
    storage: { downloadDir: appPaths.downloadsDir },
    platforms: {
      orion: {
        label: 'Orion',
        requiresAccount: false,
        supportsImage: false,
        supportsVideo: true,
        imageModels: [],
        videoModels: [{ value: 'orion-project1', label: 'Orion 项目1 15s' }],
        videoApi: {
          type: 'orion-local',
          endpoint: 'http://127.0.0.1:8787/generate',
          projectDir: 'F:\\丫够燥的\\dou管理\\项目1\\项目1',
          images: ['1.png', '3.png', '10.png', '15.png', '16.png', '17.png'],
          outputDir: 'E:\\Documents\\New project\\douyin_orion_video_pipeline\\output',
          cookieFile: 'E:\\Documents\\New project\\douyin_orion_video_pipeline\\orion_cookie.json',
          pollSeconds: 900,
          pollInterval: 10,
          download: true
        }
      }
    }
  };
  const accounts = {
    getById() { return null; },
    getActiveByPlatform() { return null; },
    getActive() { return null; },
    updateQuota() { throw new Error('orion should not update account quota'); }
  };
  const conversations = { getActive() { return null; }, updateDoubaoMeta() {} };
  const service = new GenerationService(accounts, conversations, config);
  const calls = [];
  const progress = [];
  service.httpRequest = async (url, method, body, headers) => {
    calls.push({ url, method, body: JSON.parse(Buffer.from(body).toString('utf8')), headers });
    return {
      status: 200,
      text: JSON.stringify({
        task_id: 'wf-orion-1',
        video_result: { video_url: 'https://orion.example/video.mp4' },
        download: { path: 'E:\\Documents\\New project\\douyin_orion_video_pipeline\\output\\api_generated_video_wf-orion-1_15s.mp4' },
        result_path: 'E:\\Documents\\New project\\douyin_orion_video_pipeline\\output\\api_generate_result_1.json'
      })
    };
  };

  const result = await service.generateVideo('无限生成视频脚本', {
    platform: 'orion',
    duration: 15,
    model: 'orion-project1',
    onProgress: (payload) => progress.push(payload)
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/generate');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, {
    project_dir: 'F:\\丫够燥的\\dou管理\\项目1\\项目1',
    images: ['1.png', '3.png', '10.png', '15.png', '16.png', '17.png'],
    duration: 15,
    prompt: '无限生成视频脚本',
    poll: true,
    poll_seconds: 900,
    poll_interval: 10,
    download: true,
    output_dir: 'E:\\Documents\\New project\\douyin_orion_video_pipeline\\output',
    cookie_file: 'E:\\Documents\\New project\\douyin_orion_video_pipeline\\orion_cookie.json'
  });
  assert.deepEqual(result.videos, ['https://orion.example/video.mp4']);
  assert.deepEqual(result.videoKeys, ['wf-orion-1']);
  assert.equal(result.quota, null);
  assert.match(result.brief, /Orion.*wf-orion-1/);
  assert.deepEqual(progress, [{ reply: 'Orion 已提交任务 wf-orion-1，正在等待本地 API 返回结果。' }]);
});

test('generateVideo sends uploaded reference images to Orion local API as local file paths', async () => {
  const config = {
    storage: { downloadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orion-ref-out-')) },
    platforms: {
      orion: {
        label: 'Orion',
        requiresAccount: false,
        supportsImage: false,
        supportsVideo: true,
        imageModels: [],
        videoModels: [{ value: 'orion-project1', label: 'Orion 项目1 15s' }],
        videoApi: {
          type: 'orion-local',
          endpoint: 'http://127.0.0.1:8787/generate',
          projectDir: 'F:\\丫够燥的\\dou管理\\项目1\\项目1',
          images: ['1.png'],
          outputDir: 'E:\\Documents\\New project\\douyin_orion_video_pipeline\\output'
        }
      }
    }
  };
  const service = new GenerationService({
    getById() { return null; },
    getActiveByPlatform() { return null; },
    getActive() { return null; },
    updateQuota() {}
  }, { getActive() { return null; }, updateDoubaoMeta() {} }, config);
  let captured = null;
  service.httpRequest = async (_url, _method, body) => {
    captured = JSON.parse(Buffer.from(body).toString('utf8'));
    return {
      status: 200,
      text: JSON.stringify({ task_id: 'wf-orion-ref-1', video_result: { video_url: 'https://orion.example/ref.mp4' } })
    };
  };

  await service.generateVideo('带图生成', {
    platform: 'orion',
    duration: 15,
    imageReferences: [{
      name: 'ref-a.png',
      dataUrl: 'data:image/png;base64,' + Buffer.from('orion-ref-a').toString('base64')
    }]
  });

  assert.equal(Array.isArray(captured.images), true);
  assert.equal(captured.images.length, 1);
  assert.match(captured.images[0], /orion_ref_/i);
  assert.equal(fs.existsSync(captured.images[0]), true);
  assert.equal(fs.readFileSync(captured.images[0], 'utf8'), 'orion-ref-a');
});
test('generateVideo explains Orion login failures with auth-panel guidance', async () => {
  const config = {
    platforms: {
      orion: {
        label: 'Orion',
        requiresAccount: false,
        supportsImage: false,
        supportsVideo: true,
        imageModels: [],
        videoModels: [{ value: 'orion-project1', label: 'Orion 项目1 15s' }],
        videoApi: {
          type: 'orion-local',
          endpoint: 'http://127.0.0.1:8787/generate',
          projectDir: 'F:\\丫够燥的\\dou管理\\项目1\\项目1',
          images: ['1.png']
        }
      }
    }
  };
  const service = new GenerationService({
    getById() { return null; },
    getActiveByPlatform() { return null; },
    getActive() { return null; },
    updateQuota() {}
  }, { getActive() { return null; }, updateDoubaoMeta() {} }, config);

  service.httpRequest = async () => ({
    status: 500,
    text: JSON.stringify({
      error: "ValueError('not logged in: no sessionid/sid_tt/uid_tt cookie found; complete Douyin login in the opened login page, then retry export')"
    })
  });

  await assert.rejects(
    () => service.generateVideo('测试', { platform: 'orion', duration: 15 }),
    /Orion 登录未完成.*账号管理.*回传登录态.*手动 Cookie/s
  );
});

test('generateVideo explains Chinese Orion user-not-logged-in failures with auth-panel guidance', async () => {
  const config = {
    platforms: {
      orion: {
        label: 'Orion',
        requiresAccount: false,
        supportsImage: false,
        supportsVideo: true,
        imageModels: [],
        videoModels: [{ value: 'orion-project1', label: 'Orion 项目1 15s' }],
        videoApi: {
          type: 'orion-local',
          endpoint: 'http://127.0.0.1:8787/generate',
          projectDir: 'F:\\丫够燥的\\dou管理\\项目1\\项目1',
          images: ['1.png']
        }
      }
    }
  };
  const service = new GenerationService({
    getById() { return null; },
    getActiveByPlatform() { return null; },
    getActive() { return null; },
    updateQuota() {}
  }, { getActive() { return null; }, updateDoubaoMeta() {} }, config);

  service.httpRequest = async () => ({
    status: 500,
    text: JSON.stringify({
      error: 'RuntimeError("upload failed: {\\\'err_msg\\\': \\\'用户未登录\\\', \\\'err_no\\\': 10010}")'
    })
  });

  await assert.rejects(
    () => service.generateVideo('测试', { platform: 'orion', duration: 15 }),
    /Orion 登录未完成.*账号管理.*回传登录态.*手动 Cookie/s
  );
});

test('generateImageToVideo keeps official attachment block and appends video ratio to prompt', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => {
    capturedBody = body;
    return 'ok';
  };
  service.parseSSEResponse = () => ({ images: [], videos: [], videoKeys: ['v0456'], quota: null, brief: null });
  service.resolveVideoUrls = async () => ['https://example.com/ref-video.mp4'];

  await service.generateImageToVideo('小猫动起来,然后跳舞', 'tos-cn-i-a9rns2rl98/ref.png', {
    platform: 'dola',
    accountId: 'acc-dola',
    ratio: '21:9',
    duration: 5,
    model: 'seedance_v2.0',
    imageName: 'ref.png',
    imageIdentifier: 'upload-identifier-1'
  });

  const blocks = capturedBody.messages.flatMap((message) => message.content_block);
  const text = blocks.find((block) => block.block_type === 10000).content.text_block.text;
  const attachment = blocks.find((block) => block.block_type === 10052);
  const abilityParam = JSON.parse(capturedBody.chat_ability.ability_param);

  assert.equal(text, '生成视频：小猫动起来,然后跳舞，横屏21:9画面');
  assert.equal(capturedBody.messages.length, 2);
  assert.deepEqual(capturedBody.messages.map((message) => message.content_block.map((block) => block.block_type)), [[10052], [10000]]);
  assert.ok(attachment, 'missing official 10052 attachment block');
  assert.equal(attachment.content.attachment_block.attachments[0].identifier, 'upload-identifier-1');
  assert.equal(attachment.content.attachment_block.attachments[0].image.uri, 'tos-cn-i-a9rns2rl98/ref.png');
  assert.deepEqual(abilityParam, {
    ratio: '21:9',
    model: 'seedance_v2.0',
    duration: 5
  });
});

test('generateImageToVideo can send multiple uploaded reference images as attachments', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => {
    capturedBody = body;
    return 'ok';
  };
  service.parseSSEResponse = () => ({ images: [], videos: [], videoKeys: ['v0789'], quota: null, brief: null });
  service.resolveVideoUrls = async () => ['https://example.com/multi-ref-video.mp4'];

  await service.generateImageToVideo('两张图融合成一个镜头', 'tos-mya-i-uo7y4d541q/ref-a.png', {
    platform: 'dola',
    accountId: 'acc-dola',
    ratio: '9:16',
    duration: 5,
    model: 'seedance_v2.0',
    imageReferences: [
      {
        imageUri: 'tos-mya-i-uo7y4d541q/ref-a.png',
        imageIdentifier: 'identifier-a',
        imageName: 'a.png',
        imageWidth: 512,
        imageHeight: 512,
        imageFormat: 'png'
      },
      {
        imageUri: 'tos-mya-i-uo7y4d541q/ref-b.png',
        imageIdentifier: 'identifier-b',
        imageName: 'b.png',
        imageWidth: 768,
        imageHeight: 512,
        imageFormat: 'png'
      }
    ]
  });

  const attachmentBlock = capturedBody.messages[0].content_block[0];
  const attachments = attachmentBlock.content.attachment_block.attachments;

  assert.equal(capturedBody.messages.length, 2);
  assert.equal(attachmentBlock.block_type, 10052);
  assert.deepEqual(attachments.map((item) => item.identifier), ['identifier-a', 'identifier-b']);
  assert.deepEqual(attachments.map((item) => item.image.uri), [
    'tos-mya-i-uo7y4d541q/ref-a.png',
    'tos-mya-i-uo7y4d541q/ref-b.png'
  ]);
  assert.equal(attachments[0].image.image_ori.width, 0);
  assert.equal(attachments[0].image.image_ori.height, 0);
  assert.equal(attachments[1].image.image_ori.width, 0);
  assert.equal(attachments[1].image.image_ori.height, 0);
});

test('generateImageToVideo sends input_skill=17 so Dola routes to the 全能 video model', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => { capturedBody = body; return 'ok'; };
  service.parseSSEResponse = () => ({ images: [], videos: [], videoKeys: ['v1'], quota: null, brief: null });
  service.resolveVideoUrls = async () => ['https://example.com/a.mp4'];
  await service.generateImageToVideo('一只猫跳舞', 'tos-mya-i-uo7y4d541q/cat.png', {
    platform: 'dola', accountId: 'acc-dola', ratio: '9:16', duration: 5, model: 'seedance_v2.0',
    imageName: 'cat.png', imageIdentifier: 'id-cat'
  });
  assert.equal(capturedBody.ext.input_skill, JSON.stringify({ skill_id: '17', skill_type: 17 }));
  assert.equal(capturedBody.chat_ability.ability_type, 17);
});

test('generateVideo also sends input_skill=17 for text-to-video', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => { capturedBody = body; return 'ok'; };
  service.parseSSEResponse = () => ({ images: [], videos: [], videoKeys: ['v2'], quota: null, brief: null });
  service.resolveVideoUrls = async () => ['https://example.com/b.mp4'];
  await service.generateVideo('海边日落', {
    platform: 'dola', accountId: 'acc-dola', ratio: '16:9', duration: 5, model: 'seedance_v2.0'
  });
  assert.equal(capturedBody.ext.input_skill, JSON.stringify({ skill_id: '17', skill_type: 17 }));
});

// requestProfile 隔离:豆包声明了自己的 profile,其请求行为与 dola 独立,改一个不影响另一个。
function createDoubaoService() {
  appPaths.debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dou-manager-db-test-'));
  const account = {
    id: 'acc-db', platform: 'doubao',
    session: { cookies: 'sid=s', device_id: 'd1', web_id: 'w1', fp: 'fp', bot_id: 'bot-db' }
  };
  const accounts = {
    getById(id) { return id === account.id ? account : null; },
    getActiveByPlatform(p) { return p === 'doubao' ? account : null; },
    getActive() { return account; }, update() {}, updateQuota() {}
  };
  const conversations = { getActive() { return null; }, updateDoubaoMeta() {} };
  const config = { platforms: { doubao: {
    baseUrl: 'https://www.doubao.com', chatEndpoint: '/chat/completion',
    chainSingleEndpoint: '/im/chain/single', botId: 'bot-db', conversationType: 3,
    defaultParams: { aid: '497858' },
    requestProfile: {
      preHandleEndpoint: '/alice/message/pre_handle_v2_without_conv',
      preHandleWithConv: false, sendInputSkill: false
    }
  } } };
  return { service: new GenerationService(accounts, conversations, config), account };
}

test('doubao requestProfile: pre_handle uses without_conv endpoint and omits conversation fields', async () => {
  const { service, account } = createDoubaoService();
  let captured = null;
  service.httpPost = async (url, body) => {
    captured = { url, body };
    return { status: 200, text: JSON.stringify({ code: 0, data: { pre_generate_id: 'pg1' } }) };
  };
  const id = await service.preHandleUploadedImage(account, 'tos-cn-i-a9rns2rl98/x.png', 'id-x');
  assert.equal(id, 'pg1');
  assert.ok(captured.url.includes('/alice/message/pre_handle_v2_without_conv'));
  assert.equal(captured.body.conversation_id, undefined);
  assert.equal(captured.body.section_id, undefined);
  assert.equal(captured.body.bot_id, 'bot-db');
});

test('doubao requestProfile: video request omits input_skill (web no longer sends it)', () => {
  const { service, account } = createDoubaoService();
  const body = service.buildRequestBody('一只猫', account, {
    isVideo: true, ratio: '9:16', model: 'seedance_v2.0_mini', duration: 5
  });
  assert.equal(body.ext.input_skill, undefined);
  assert.equal(body.chat_ability.ability_type, 17);
});

test('generation proxy policy keeps doubao direct even if config contains a proxy', () => {
  const { service, account } = createDoubaoService();
  service.config.platforms.doubao.proxy = 'http://127.0.0.1:7897';

  assert.equal(service.getProxyForAccount(account), '');
});

test('generation proxy policy allows configured Dola proxy', () => {
  const { service, account } = createService();
  service.config.platforms.dola.proxy = 'http://127.0.0.1:7897';

  assert.equal(service.getProxyForAccount(account), 'http://127.0.0.1:7897');
});

test('generateVideo appends selected official movement text without adding it to chat ability', async () => {
  const { service } = createService();
  let capturedBody = null;
  service.executeGeneration = async (body) => {
    capturedBody = body;
    return 'ok';
  };
  service.parseSSEResponse = () => ({ images: [], videos: [], videoKeys: ['v0789'], quota: null, brief: null });
  service.resolveVideoUrls = async () => ['https://example.com/move-video.mp4'];

  await service.generateVideo('小猫跳舞', {
    platform: 'dola',
    accountId: 'acc-dola',
    ratio: '16:9',
    duration: 5,
    model: 'seedance_v2.0',
    movement: 'pan',
    movementSubject: '小猫'
  });

  const text = capturedBody.messages[0].content_block.find((block) => block.block_type === 10000).content.text_block.text;
  const abilityParam = JSON.parse(capturedBody.chat_ability.ability_param);

  assert.equal(text, '生成视频：小猫跳舞，镜头环绕小猫拍摄，横屏16:9画面');
  assert.deepEqual(abilityParam, {
    ratio: '16:9',
    model: 'seedance_v2.0',
    duration: 5
  });
});

test('uploadReferenceImage follows official prepare, apply, upload, commit, and pre-handle flow', async () => {
  const { service } = createService();
  const calls = [];
  service.httpPost = async (url, body) => {
    calls.push({ type: 'httpPost', url, body });
    if (url.includes('/alice/resource/prepare_upload')) {
      return {
        status: 200,
        text: JSON.stringify({
          code: 0,
          data: {
            service_id: 'a9rns2rl98',
            upload_host: 'imagex.bytedanceapi.com',
            upload_auth_token: {
              access_key: 'AK_TEST',
              secret_key: 'SK_TEST',
              session_token: 'STS_TEST'
            }
          }
        })
      };
    }
    if (url.includes('/alice/message/pre_handle_v2')) {
      return {
        status: 200,
        text: JSON.stringify({ code: 0 })
      };
    }
    throw new Error('unexpected httpPost ' + url);
  };
  service.signedImagexRequest = async (method, host, params, body, credentials) => {
    calls.push({ type: 'signedImagexRequest', method, host, params, body, credentials });
    if (params.Action === 'ApplyImageUpload') {
      return {
        status: 200,
        json: {
          Result: {
            UploadAddress: {
              StoreInfos: [{
                StoreUri: 'tos-cn-i-a9rns2rl98/ref.png',
                Auth: 'SpaceKey/a9rns2rl98/auth',
                UploadID: 'upload-1'
              }],
              UploadHosts: ['tos-lq-x.bytedancevod.com'],
              SessionKey: 'session-key-1'
            }
          }
        }
      };
    }
    if (params.Action === 'CommitImageUpload') {
      return {
        status: 200,
        json: {
          Result: {
            PluginResult: [{
              ImageUri: 'tos-cn-i-a9rns2rl98/ref.png',
              ImageWidth: 572,
              ImageHeight: 572,
              ImageFormat: 'png',
              ImageSize: 7
            }]
          }
        }
      };
    }
    throw new Error('unexpected signed action ' + params.Action);
  };
  service.uploadImageToTos = async (uploadAddress, imageBuffer, contentType, account, imageName) => {
    calls.push({ type: 'uploadImageToTos', uploadAddress, imageBuffer, contentType, account, imageName });
    return { code: 2000, data: { crc32: '7bd5c66f' } };
  };

  const result = await service.uploadReferenceImage({
    dataUrl: 'data:image/png;base64,' + Buffer.from('pngdata').toString('base64'),
    name: 'ref.png'
  }, {
    platform: 'dola',
    accountId: 'acc-dola'
  });

  assert.equal(result.imageUri, 'tos-cn-i-a9rns2rl98/ref.png');
  assert.equal(result.imageName, 'ref.png');
  assert.equal(result.imageWidth, 572);
  assert.equal(result.imageHeight, 572);
  assert.equal(result.imageFormat, 'png');
  assert.match(result.imageIdentifier, /^[0-9a-f-]{36}$/);
  assert.equal(result.preGenerateId, '');
  assert.deepEqual(calls.map((call) => call.type), [
    'httpPost',
    'signedImagexRequest',
    'uploadImageToTos',
    'signedImagexRequest',
    'httpPost'
  ]);
  assert.equal(calls[1].params.Action, 'ApplyImageUpload');
  assert.equal(calls[1].params.FileExtension, '.png');
  assert.equal(calls[1].params.FileSize, 7);
  assert.equal(calls[3].params.Action, 'CommitImageUpload');
  assert.deepEqual(calls[3].body, { SessionKey: 'session-key-1' });
  assert.ok(calls[4].url.includes('/alice/message/pre_handle_v2'));
  assert.equal(calls[4].body.uplink_entity.identifier, result.imageIdentifier);
  // dola 未声明 requestProfile,走默认 profile:旧端点 pre_handle_v2 + 携带会话上下文字段。
  // (豆包在 config 里声明 requestProfile 切到 _without_conv 且不带会话,互不影响)
  assert.equal(calls[4].body.conversation_id, 'conv-dola');
  assert.equal(calls[4].body.bot_id, 'bot-dola');
  assert.equal(calls[4].body.section_id, 'sec-dola');
  assert.equal(calls[4].body.uplink_entity.entity_content.image.key, 'tos-cn-i-a9rns2rl98/ref.png');
});

test('prepareReferenceUpload uses Dola official reference image scene id', async () => {
  const { service, account } = createService();
  let capturedBody = null;
  service.httpPost = async (url, body) => {
    capturedBody = body;
    return {
      status: 200,
      text: JSON.stringify({
        code: 0,
        data: {
          service_id: 'uo7y4d541q',
          upload_host: 'imagex-ap-southeast-1.bytevcloudapi.com',
          upload_auth_token: {}
        }
      })
    };
  };

  await service.prepareReferenceUpload(account);

  assert.equal(capturedBody.scene_id, '4');
  assert.equal(capturedBody.tenant_id, '5');
  assert.equal(capturedBody.resource_type, 2);
});

test('signedImagexRequest matches browser AWS4 ImageX GET signing and platform top endpoint', async () => {
  const { service, account } = createService();
  let captured = null;
  service.formatVolcDate = () => ({ xDate: '20260624T010203Z', shortDate: '20260624' });
  service.httpRequest = async (url, method, bodyBuffer, headers) => {
    captured = { url, method, bodyBuffer, headers };
    return { status: 200, text: '{}' };
  };

  await service.signedImagexRequest('GET', 'imagex-ap-southeast-1.bytevcloudapi.com', {
    Action: 'ApplyImageUpload',
    Version: '2018-08-01',
    ServiceId: 'uo7y4d541q',
    NeedFallback: true,
    FileSize: 68,
    FileExtension: '.png',
    s: 'abc123'
  }, null, {
    access_key: 'AK_TEST',
    secret_key: 'SK_TEST',
    session_token: 'STS_TEST'
  }, account);

  assert.equal(captured.method, 'GET');
  assert.equal(captured.url, 'https://imagex-ap-southeast-1.bytevcloudapi.com/top/v1?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=uo7y4d541q&NeedFallback=true&FileSize=68&FileExtension=.png&s=abc123');
  assert.equal(captured.headers['X-Amz-Date'], '20260624T010203Z');
  assert.equal(captured.headers['x-amz-security-token'], 'STS_TEST');
  assert.equal(captured.headers.Cookie, 'sid=secret');
  assert.ok(!('X-Date' in captured.headers));
  assert.ok(!('X-Content-Sha256' in captured.headers));
  assert.match(captured.headers.Authorization, /^AWS4-HMAC-SHA256 /);
  assert.match(captured.headers.Authorization, /Credential=AK_TEST\/20260624\/ap-southeast-1\/imagex\/aws4_request/);
  assert.match(captured.headers.Authorization, /SignedHeaders=x-amz-date;x-amz-security-token/);
});

test('signedImagexRequest signs ImageX POST body hash without signing content-type', async () => {
  const { service, account } = createService();
  let captured = null;
  service.formatVolcDate = () => ({ xDate: '20260624T010203Z', shortDate: '20260624' });
  service.httpRequest = async (url, method, bodyBuffer, headers) => {
    captured = { url, method, bodyBuffer, headers };
    return { status: 200, text: '{}' };
  };

  await service.signedImagexRequest('POST', 'imagex.bytedanceapi.com', {
    Action: 'CommitImageUpload',
    Version: '2018-08-01',
    ServiceId: 'a9rns2rl98'
  }, { SessionKey: 'session-key-1' }, {
    access_key: 'AK_TEST',
    secret_key: 'SK_TEST',
    session_token: 'STS_TEST'
  }, account);

  const bodyHash = service.sha256Hex(Buffer.from(JSON.stringify({ SessionKey: 'session-key-1' }), 'utf8'));

  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.equal(captured.headers['X-Amz-Content-Sha256'], bodyHash);
  assert.match(captured.headers.Authorization, /Credential=AK_TEST\/20260624\/cn-north-1\/imagex\/aws4_request/);
  assert.match(captured.headers.Authorization, /SignedHeaders=x-amz-content-sha256;x-amz-date;x-amz-security-token/);
  assert.doesNotMatch(captured.headers.Authorization, /content-type/);
});

test('uploadImageToTos sends official CRC32 header for the uploaded bytes', async () => {
  const { service, account } = createService();
  let captured = null;
  service.httpRequest = async (url, method, bodyBuffer, headers) => {
    captured = { url, method, bodyBuffer, headers };
    return {
      status: 200,
      text: JSON.stringify({ code: 2000, data: { crc32: '352441c2' } })
    };
  };

  await service.uploadImageToTos({
    StoreInfos: [{
      StoreUri: 'tos-cn-i-a9rns2rl98/ref.png',
      Auth: 'SpaceKey/a9rns2rl98/auth'
    }],
    UploadHosts: ['tos-lq-x.bytedancevod.com']
  }, Buffer.from('abc'), 'image/png', account, 'ref.png');

  assert.equal(service.crc32Hex(Buffer.from('abc')), '352441c2');
  assert.equal(captured.headers['Content-CRC32'], '352441c2');
  assert.equal(captured.headers['X-Storage-U'], '');
  assert.equal(captured.headers.Authorization, 'SpaceKey/a9rns2rl98/auth');
});

// 回归：多账号共享平台会话桶时，请求体必须用「账号自己的」服务端会话 ID（session），
// 不能用平台 UI 会话桶(conv)的 cid——否则切到其它 dola 小号生成会串号失败。
test('buildRequestBody uses per-account session conversation_id, not the shared platform bucket cid', () => {
  const { service, account } = createService();
  // 平台会话桶给一个「别的账号」的 cid（模拟合并后桶里残留的他人会话 ID）
  service.conversations = {
    getActive() {
      return { id: 'platform-bucket', platform: 'dola', accountId: '', doubaoConversationId: 'OTHER-ACCOUNT-CID', sectionId: 'OTHER-SEC', lastMessageIndex: 999 };
    },
    updateDoubaoMeta() {}
  };
  // 本账号 session 才是真相源
  account.session.conversation_id = 'my-own-conv';
  account.session.section_id = 'my-own-sec';
  account.session.last_message_index = 7;

  const body = service.buildRequestBody('画一只猫', account, { imageModel: 'm', imageRatio: '1:1' });

  assert.equal(body.client_meta.conversation_id, 'my-own-conv', '必须用账号自己的 conversation_id');
  assert.equal(body.client_meta.last_section_id, 'my-own-sec', '必须用账号自己的 section_id');
  assert.equal(body.client_meta.last_message_index, 7, '必须用账号自己的 last_message_index');
});

test('decodeChunkedBuffer handles multiple response chunks', () => {
  const { service } = createService();
  const body = Buffer.from('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n');

  assert.equal(service.decodeChunkedBuffer(body).toString('utf8'), 'Wikipedia');
});

test('applyNoWatermarkLr 把豆包视频直链的 lr 参数换成无水印标记', () => {
  const { service } = createService();
  // 典型豆包 main_url:含 lr=video_gen_watermark 水印展示参数
  const watermarked = 'https://v-cdn.doubao.com/obj/v0abc.mp4?lr=video_gen_watermark&x=1';
  const clean = service.applyNoWatermarkLr(watermarked, 'video_gen_no_watermark');
  assert.equal(clean, 'https://v-cdn.doubao.com/obj/v0abc.mp4?lr=video_gen_no_watermark&x=1');

  // 多个 lr 参数都要替换
  const multi = service.applyNoWatermarkLr('https://x/y?lr=a&lr=b', 'video_gen_no_watermark');
  assert.equal(multi, 'https://x/y?lr=video_gen_no_watermark&lr=video_gen_no_watermark');

  // lr 在开头(? 后第一个)
  const head = service.applyNoWatermarkLr('https://x/y?lr=wm', 'video_gen_no_watermark');
  assert.equal(head, 'https://x/y?lr=video_gen_no_watermark');
});

test('applyNoWatermarkLr 无 lr 参数或缺参时原样返回', () => {
  const { service } = createService();
  // 无 lr 参数:原样返回
  assert.equal(service.applyNoWatermarkLr('https://x/y?a=1', 'video_gen_no_watermark'), 'https://x/y?a=1');
  // 未配置 noWatermarkLr(如 Dola):不动
  assert.equal(service.applyNoWatermarkLr('https://x/y?lr=wm', ''), 'https://x/y?lr=wm');
  assert.equal(service.applyNoWatermarkLr('https://x/y?lr=wm', undefined), 'https://x/y?lr=wm');
  // 空 url
  assert.equal(service.applyNoWatermarkLr(null, 'x'), null);
});





