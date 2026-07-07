// 比例字符串 "16:9" -> CSS aspect-ratio "16/9"
export function ratioToCss(ratio) {
  const [w, h] = String(ratio || '1:1').split(':').map(Number);
  return `${w || 1}/${h || 1}`;
}

// 本地媒体标识 local://文件名 -> 后端本地文件服务地址；其它(远程 CDN URL)原样返回。
export function resolveMediaUrl(url) {
  if (typeof url === 'string' && url.startsWith('local://')) {
    return '/api/media/local?f=' + encodeURIComponent(url.slice('local://'.length));
  }
  return url;
}

// 失败图片回退到代理通道(逐字移植自原 window.onResultImageError)
export function onResultImageError(img) {
  if (!img || img.dataset.proxyTried === '1') {
    const card = img?.closest('.result-card');
    if (card) card.classList.add('img-broken');
    return;
  }
  img.dataset.proxyTried = '1';
  img.dataset.originalSrc = img.src;
  img.src = '/api/media/image?url=' + encodeURIComponent(img.src);
}

// 把媒体地址转成「强制下载」的后端端点地址(带 Content-Disposition: attachment)。
// 支持三种入参:local://文件名、/api/media/local?f=、以及远程 CDN 原始 url。
export function buildDownloadUrl(url) {
  const s = String(url || '');
  if (s.startsWith('local://')) {
    return '/api/media/download?f=' + encodeURIComponent(s.slice('local://'.length));
  }
  if (s.startsWith('/api/media/local')) {
    try {
      const f = new URLSearchParams(s.split('?')[1] || '').get('f') || '';
      if (f) return '/api/media/download?f=' + encodeURIComponent(f);
    } catch (e) { /* ignore */ }
  }
  // 已经是代理地址 /api/media/image?url=XXX,剥出原始 url
  if (s.startsWith('/api/media/image')) {
    try {
      const u = new URLSearchParams(s.split('?')[1] || '').get('url') || '';
      if (u) return '/api/media/download?url=' + encodeURIComponent(u);
    } catch (e) { /* ignore */ }
  }
  // 远程 CDN 原始地址
  return '/api/media/download?url=' + encodeURIComponent(s);
}

// 后端直存 URL：比触发浏览器下载更稳定，能保证落到应用设置或本次选择的下载目录。
export function buildSaveUrl(url, dir) {
  const base = buildDownloadUrl(url).replace('/api/media/download?', '/api/media/save?');
  const pickedDir = String(dir || '').trim();
  return pickedDir ? `${base}&dir=${encodeURIComponent(pickedDir)}` : base;
}

// 点击下载：优先调用后端保存到设置的下载目录；失败时才退回浏览器附件下载。
export function downloadMedia(url, handlers = {}) {
  const onSuccess = typeof handlers.onSuccess === 'function' ? handlers.onSuccess : null;
  const onError = typeof handlers.onError === 'function' ? handlers.onError : null;
  const fallbackBrowserDownload = () => {
      const href = buildDownloadUrl(url);
      const a = document.createElement('a');
      a.href = href;
      a.download = '';
      a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} }, 0);
  };

  return fetch(buildSaveUrl(url, handlers.dir))
    .then(async (resp) => {
      let payload = null;
      try { payload = await resp.json(); } catch (e) {}
      if (!resp.ok || !payload || !payload.success) {
        throw new Error((payload && payload.error) || ('HTTP ' + resp.status));
      }
      if (onSuccess) onSuccess(payload.data);
      return payload;
    })
    .catch((err) => {
      if (onError) onError(err);
      else fallbackBrowserDownload();
      return { success: false, error: err };
    });
}

// 把媒体地址转成「同源可 fetch」地址:本地文件直读、远程 CDN 走图片代理。
// 走同源代理后 canvas 不会被跨域污染(tainted),才能 toBlob 读出像素写进剪贴板。
export function buildProxyUrl(url) {
  const s = String(url || '');
  if (s.startsWith('local://')) {
    return '/api/media/local?f=' + encodeURIComponent(s.slice('local://'.length));
  }
  // 已经是同源相对地址(/api/media/local、/api/media/image 等)直接用
  if (s.startsWith('/')) return s;
  // 远程 CDN 原始地址 → 走图片代理保证同源
  return '/api/media/image?url=' + encodeURIComponent(s);
}

// 把任意图片 blob 经 canvas 转成 image/png(剪贴板 ClipboardItem 在多数环境只稳定接受 png)。
function blobToPng(blob) {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        canvas.toBlob(b => {
          URL.revokeObjectURL(objUrl);
          b ? resolve(b) : reject(new Error('图片转码失败'));
        }, 'image/png');
      } catch (e) { URL.revokeObjectURL(objUrl); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('图片解码失败')); };
    img.src = objUrl;
  });
}

// 把图片复制到系统剪贴板(可在别处直接粘贴)。localhost 为安全上下文,Clipboard API 可用。
export async function copyImageToClipboard(url) {
  if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持剪贴板复制');
  }
  const resp = await fetch(buildProxyUrl(url));
  if (!resp.ok) throw new Error('图片获取失败(' + resp.status + ')');
  const srcBlob = await resp.blob();
  const pngBlob = srcBlob.type === 'image/png' ? srcBlob : await blobToPng(srcBlob);
  await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': pngBlob })]);
}

export function fmtTime(t) {
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function fmtElapsed(sec) {
  return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
}

// 参考图文件名 -> 展示用 "图片[N]" 标签
export function refFileLabel(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const m = stem.match(/\d+/);
  return m ? `图片[${parseInt(m[0], 10)}]` : (stem || '未命名');
}
