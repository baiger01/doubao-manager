const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appPaths = require('../paths');
const MediaDownloader = require('../services/media-downloader');

// 创建临时下载目录（通过 storage.downloadDir 注入，resolveDownloadDir 会优先用它）
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dou-dl-test-'));
}

// 构造一个 mock generationService.httpRequest，按预设返回
function mockGen(responder) {
  return { httpRequest: async (url, method, body, headers, account) => responder(url, account) };
}

test('downloadOne: 优先使用流式 downloadToFile，避免整文件进入内存', async () => {
  const dir = tmpDir();
  let httpRequestCalled = false;
  let streamedTo = '';
  const gen = {
    async httpRequest() {
      httpRequestCalled = true;
      return { status: 200, headers: {}, buffer: Buffer.from('SHOULD_NOT_USE') };
    },
    async downloadToFile(url, filePath) {
      streamedTo = filePath;
      fs.writeFileSync(filePath, Buffer.from('STREAMED_MP4'));
      return { status: 200, headers: { 'content-type': 'video/mp4' }, bytes: 12 };
    }
  };
  const dl = new MediaDownloader(gen, { storage: { autoDownload: true, downloadDir: dir } });

  const out = await dl.downloadOne('https://v.example.com/video', { platform: 'dola', accountId: 'acc1', type: 'video' });

  assert.equal(httpRequestCalled, false);
  assert.ok(out.startsWith('local://') && out.endsWith('.mp4'));
  assert.equal(fs.existsSync(streamedTo), false);
  assert.equal(fs.readFileSync(path.join(dir, out.slice('local://'.length)), 'utf-8'), 'STREAMED_MP4');
});

test('downloadOne: 成功下载视频写入本地并返回 local:// 标识', async () => {
  const dir = tmpDir();
  const buf = Buffer.from('FAKE_MP4_DATA');
  const gen = mockGen(() => ({ status: 200, headers: { 'content-type': 'video/mp4' }, buffer: buf }));
  const dl = new MediaDownloader(gen, { storage: { autoDownload: true, downloadDir: dir } });

  const out = await dl.downloadOne('https://v.example.com/x/video/abc?a=1', { platform: 'dola', accountId: 'acc1', type: 'video' });
  assert.ok(out.startsWith('local://'), '应返回 local:// 标识');
  assert.ok(out.endsWith('.mp4'), '视频应推断为 .mp4');
  const fname = out.slice('local://'.length);
  assert.ok(fs.existsSync(path.join(dir, fname)), '文件应已写入下载目录');
  assert.equal(fs.readFileSync(path.join(dir, fname)).toString(), 'FAKE_MP4_DATA');
});

test('guessExt: 从 content-type 与 URL 正确推断扩展名', () => {
  const dl = new MediaDownloader(mockGen(() => ({})), {});
  assert.equal(dl.guessExt('image', 'http://x/a.png', 'image/png'), '.png');
  assert.equal(dl.guessExt('image', 'http://x/a', 'image/jpeg'), '.jpg');
  assert.equal(dl.guessExt('image', 'http://x/a.webp', ''), '.webp');
  assert.equal(dl.guessExt('video', 'http://x/a', 'video/mp4'), '.mp4');
  assert.equal(dl.guessExt('video', 'http://x/a.webm', ''), '.webm');
  // 都无信息时按 type 兜底
  assert.equal(dl.guessExt('image', 'http://x/noext', ''), '.jpg');
  assert.equal(dl.guessExt('video', 'http://x/noext', ''), '.mp4');
});

test('downloadOne: HTTP 失败时降级保留原链接', async () => {
  const dir = tmpDir();
  const original = 'https://v.example.com/x/video/fail';
  const gen = mockGen(() => ({ status: 502, headers: {}, buffer: Buffer.alloc(0) }));
  const dl = new MediaDownloader(gen, { storage: { autoDownload: true, downloadDir: dir } });
  const out = await dl.downloadOne(original, { platform: 'doubao', type: 'video' });
  assert.equal(out, original, '失败应返回原链接兜底');
});

test('downloadOne: httpRequest 抛异常时降级保留原链接', async () => {
  const dir = tmpDir();
  const original = 'https://v.example.com/x/throw';
  const gen = mockGen(() => { throw new Error('boom'); });
  const dl = new MediaDownloader(gen, { storage: { downloadDir: dir } });
  const out = await dl.downloadOne(original, { platform: 'dola', type: 'image' });
  assert.equal(out, original);
});

test('downloadOne: 已是 local:// 标识时原样跳过不重复下载', async () => {
  const dir = tmpDir();
  let called = false;
  const gen = mockGen(() => { called = true; return { status: 200, headers: {}, buffer: Buffer.from('x') }; });
  const dl = new MediaDownloader(gen, { storage: { downloadDir: dir } });
  const out = await dl.downloadOne('local://already.mp4', { platform: 'dola', type: 'video' });
  assert.equal(out, 'local://already.mp4');
  assert.equal(called, false, '本地标识不应触发下载');
});

test('downloadUrls: autoDownload 关闭时原样返回不下载', async () => {
  const dir = tmpDir();
  let called = false;
  const gen = mockGen(() => { called = true; return { status: 200, headers: {}, buffer: Buffer.from('x') }; });
  const dl = new MediaDownloader(gen, { storage: { autoDownload: false, downloadDir: dir } });
  const urls = ['https://a/1.mp4', 'https://a/2.mp4'];
  const out = await dl.downloadUrls(urls, { platform: 'dola', type: 'video' });
  assert.deepEqual(out, urls);
  assert.equal(called, false, '关闭自动下载后不应下载');
});

test('downloadUrls: 批量混合 - 成功转本地，失败保留原链接', async () => {
  const dir = tmpDir();
  const gen = mockGen((url) => {
    if (url.includes('good')) return { status: 200, headers: { 'content-type': 'image/png' }, buffer: Buffer.from('IMG') };
    return { status: 404, headers: {}, buffer: Buffer.alloc(0) };
  });
  const dl = new MediaDownloader(gen, { storage: { autoDownload: true, downloadDir: dir } });
  const out = await dl.downloadUrls(['https://a/good.png', 'https://a/bad.png'], { platform: 'doubao', type: 'image' });
  assert.ok(out[0].startsWith('local://') && out[0].endsWith('.png'));
  assert.equal(out[1], 'https://a/bad.png');
});

test('isEnabled: 未配置 storage 时默认开启', () => {
  const dl = new MediaDownloader(mockGen(() => ({})), {});
  assert.equal(dl.isEnabled(), true);
});
