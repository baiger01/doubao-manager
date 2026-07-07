import { api } from './api.js';
import { copyImageToClipboard, downloadMedia } from './util.js';

export const COPY_TIMEOUT_MS = 15000;

export function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || '操作超时')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function copyImageToClipboardWithTimeout(url, timeoutMs = COPY_TIMEOUT_MS) {
  return withTimeout(copyImageToClipboard(url), timeoutMs, '复制超时，请重试');
}

export async function saveMediaWithDirectoryChoice(url, options = {}) {
  const mediaLabel = options.mediaLabel || '媒体';
  const showToast = typeof options.showToast === 'function' ? options.showToast : null;

  try {
    const picked = await api.pickDownloadDir();
    if (!picked || !picked.success) {
      const message = picked?.message || picked?.error || '选择下载目录失败';
      if (showToast) showToast(message);
      return { success: false, error: message };
    }

    const dir = picked.data?.dir || '';
    if (!dir) {
      if (showToast) showToast('已取消下载');
      return { success: false, canceled: true };
    }

    return await downloadMedia(url, {
      dir,
      onSuccess(data) {
        const target = data?.path || dir;
        if (showToast) showToast(`${mediaLabel}已保存到 ${target}`);
      },
      onError(err) {
        if (showToast) showToast('下载失败: ' + (err?.message || err));
      }
    });
  } catch (err) {
    if (showToast) showToast('下载失败: ' + (err?.message || err));
    return { success: false, error: err };
  }
}
