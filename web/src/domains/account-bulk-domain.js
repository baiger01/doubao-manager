import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { normalizeAutoLoginProgressItem } from '../lib/accounts-modal-contract.js';

function parseAutoLoginAccounts(rawText = '') {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const list = [];
  for (const line of lines) {
    const sep = line.includes('|') ? '|' : (line.includes('----') ? '----' : (line.includes(',') ? ',' : ' '));
    const parts = line.split(sep);
    const email = (parts[0] || '').trim();
    const password = (parts.slice(1).join(sep) || '').trim();
    if (email && password) list.push({ email, password });
  }
  return list;
}

export function useAccountBulkDomain({ loadAccounts, showToast }) {
  const [autoLoginState, setAutoLoginState] = useState(null);
  const [importState, setImportState] = useState(null);

  const onAutoLoginProgress = useCallback((data) => {
    if (data.done) {
      setAutoLoginState(s => s ? { ...s, running: false } : s);
      loadAccounts();
      return;
    }
    setAutoLoginState(s => {
      const items = (s && s.items) ? [...s.items] : [];
      const i = (data.index || 1) - 1;
      items[i] = normalizeAutoLoginProgressItem(data);
      return { running: true, total: data.total || items.length, items };
    });
  }, [loadAccounts]);

  const onImportProgress = useCallback((data) => {
    if (data.done) {
      setImportState(s => s ? { ...s, running: false, done: true, summary: data } : { running: false, done: true, summary: data, items: [] });
      loadAccounts();
      return;
    }
    setImportState(s => {
      const items = (s && s.items) ? [...s.items] : [];
      const i = (data.index || 1) - 1;
      items[i] = { name: data.name || '', status: data.status || 'running', message: data.message || '' };
      return { running: true, total: data.total || items.length, items };
    });
  }, [loadAccounts]);

  // 批量自动登录（粘贴 email|password 文本，dola 谷歌登录）
  const startAutoLogin = useCallback(async (plat, rawText) => {
    const list = parseAutoLoginAccounts(rawText || '');
    if (list.length === 0) { showToast('未解析到有效账号(格式: 邮箱|密码)'); return; }
    setAutoLoginState({ running: true, total: list.length, items: list.map(c => ({ email: c.email, status: 'pending', message: '排队中' })) });
    try {
      // 不指定窗口模式,由后端读全局设置(设置→下载页的"登录浏览器窗口")
      const r = await api.autoLogin(plat, list);
      if (!r.success) throw new Error(r.error || '启动失败');
    } catch (e) {
      showToast('自动登录失败: ' + e.message);
      setAutoLoginState(s => s ? { ...s, running: false } : s);
    }
  }, [showToast]);

  const clearAutoLogin = useCallback(() => setAutoLoginState(null), []);

  // 选备份目录(原生对话框);返回选中的目录路径或 ''
  const pickBackupDir = useCallback(async () => {
    try {
      const r = await api.pickBackupDir();
      if (r.success) return r.data.dir;
      if (r.error === 'canceled') return '';
      showToast(r.message || r.error || '选目录失败');
    } catch (e) { showToast('选目录失败: ' + e.message); }
    return '';
  }, [showToast]);

  // 探测备份目录,返回 { total, platforms, hasLocalState } 或 null
  const inspectBackup = useCallback(async (dir) => {
    try {
      const r = await api.inspectBackup(dir);
      if (r.success) return r.data;
      showToast(r.error || '识别失败');
    } catch (e) { showToast('识别失败: ' + e.message); }
    return null;
  }, [showToast]);

  // 开始导入备份;opts:{ platform?, skipExisting?, grab? }
  const startImportBackup = useCallback(async (dir, opts = {}) => {
    if (!dir) { showToast('请先选择备份文件夹'); return; }
    setImportState({ running: true, total: 0, items: [] });
    try {
      const r = await api.importBackup(dir, opts);
      if (!r.success) throw new Error(r.error || '启动失败');
      setImportState(s => ({ ...(s || {}), running: true, total: r.data.total || 0, items: [] }));
    } catch (e) {
      showToast('导入失败: ' + e.message);
      setImportState(s => s ? { ...s, running: false } : null);
    }
  }, [showToast]);

  const clearImport = useCallback(() => setImportState(null), []);

  return {
    autoLoginState,
    importState,
    onAutoLoginProgress,
    onImportProgress,
    startAutoLogin,
    clearAutoLogin,
    pickBackupDir,
    inspectBackup,
    startImportBackup,
    clearImport,
  };
}
