const fs = require('fs');
const path = require('path');
const { atomicWriteJsonFile } = require('./json-store');

class BrowserRuntime {
  constructor(options = {}) {
    this.dialog = options.dialog || null;
    this.processRef = options.processRef || process;
    this.config = options.config || {};
    this.configFile = options.configFile || '';
    this.getPreferredPath = options.getPreferredPath || (() => this.config?.browser?.chromePath || '');
    this.savePreferredPath = options.savePreferredPath || ((chromePath) => this.persistPreferredPath(chromePath));
  }

  getCandidatePaths() {
    const localAppData = this.processRef.env.LOCALAPPDATA || '';
    return [
      { path: this.processRef.env.CHROME_PATH || '', source: 'env' },
      { path: this.getPreferredPath() || '', source: 'config' },
      { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', source: 'filesystem' },
      { path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', source: 'filesystem' },
      { path: localAppData ? path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') : '', source: 'filesystem' }
    ].filter(item => item.path);
  }

  findChromeExecutable() {
    const candidates = this.getCandidatePaths();
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.path)) continue;
      return candidate;
    }
    return null;
  }

  async ensureChromeAvailable() {
    const found = this.findChromeExecutable();
    if (found) return found;

    const selected = await this.promptManualSelection();
    if (!selected) {
      throw new Error('未检测到 Chrome，且未选择 chrome.exe');
    }

    this.savePreferredPath(selected);
    return { path: selected, source: 'manual' };
  }

  persistPreferredPath(chromePath) {
    this.config.browser = this.config.browser || {};
    this.config.browser.chromePath = chromePath;
    if (!this.configFile) return;
    atomicWriteJsonFile(this.configFile, this.config, { fs });
  }

  async promptManualSelection() {
    if (!this.dialog || typeof this.dialog.showMessageBox !== 'function' || typeof this.dialog.showOpenDialog !== 'function') {
      return null;
    }

    const result = await this.dialog.showMessageBox({
      type: 'warning',
      buttons: ['选择 chrome.exe', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '缺少 Chrome',
      message: '当前机器未检测到 Chrome，请手动选择本机的 chrome.exe。'
    });
    if (result.response !== 0) return null;

    const pick = await this.dialog.showOpenDialog({
      title: '选择 chrome.exe',
      properties: ['openFile'],
      filters: [
        { name: 'Chrome', extensions: ['exe'] }
      ]
    });
    if (pick.canceled || !pick.filePaths?.length) return null;
    return pick.filePaths[0];
  }
}

module.exports = BrowserRuntime;
