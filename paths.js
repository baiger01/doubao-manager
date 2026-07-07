// 统一路径解析：兼容开发模式、pkg 打包、Electron 打包。
// 关键原则：代码/静态资源可只读，但 config/data/debug 必须可写。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { atomicWriteJsonFile, ensureJsonFile } = require('./services/json-store');

// 运行模式判定
const isPkg = !!process.pkg;
// Electron：主进程里 process.versions.electron 存在
const isElectron = !!(process.versions && process.versions.electron);
// Electron 是否已打包（app.isPackaged）
let electronPackaged = false;
let electronExeDir = null;
let electronResourcesPath = null;
let electronUserDataDir = null;
if (isElectron) {
  try {
    const { app } = require('electron');
    electronPackaged = app.isPackaged;
    electronExeDir = path.dirname(app.getPath('exe'));
    electronUserDataDir = app.getPath('userData');
    electronResourcesPath = process.resourcesPath; // 打包后资源(app.asar/extra)所在
  } catch (e) { /* 渲染进程或未就绪，忽略 */ }
}

const isPackaged = isPkg || electronPackaged;

// ═══════════════════════════════════════════════════════════
// 用户数据独立存储：固定放 %APPDATA%\lulu-data\（Windows）
// 与应用安装目录/版本完全解耦，更新重装不丢数据。
// ═══════════════════════════════════════════════════════════
const PERSISTENT_DIR_NAME = 'lulu-data';
let persistentRoot;
if (process.platform === 'win32') {
  persistentRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), PERSISTENT_DIR_NAME);
} else {
  persistentRoot = path.join(os.homedir(), '.' + PERSISTENT_DIR_NAME);
}

// 可写数据根目录：
// - 打包模式（Electron/pkg）：使用独立持久目录
// - 开发模式：项目根目录
let dataRoot;
if (isPackaged) {
  dataRoot = persistentRoot;
} else {
  dataRoot = __dirname;
}

// 静态资源(public)与默认配置目录：
// - Electron 打包：随 app 打进 resources（asar 解包或 extraResources）
// - 其它：项目内 __dirname
let assetBase = __dirname;
if (electronPackaged && electronResourcesPath) {
  // electron-builder 用 extraResources 把 public/config 放到 resources/appdata 下
  // 注意不能用 resources/app，因为 Electron 会把该路径劫持到 app.asar
  const candidate = path.join(electronResourcesPath, 'appdata');
  assetBase = fs.existsSync(candidate) ? candidate : __dirname;
}

const paths = {
  isPackaged,
  isElectron,
  dataRoot,
  configFile: path.join(dataRoot, 'config', 'config.json'),
  dataDir: path.join(dataRoot, 'data'),
  accountsFile: path.join(dataRoot, 'data', 'accounts.json'),
  conversationsFile: path.join(dataRoot, 'data', 'conversations.json'),
  profilesDir: path.join(dataRoot, 'data', 'profiles'),
  // 默认下载目录：与用户数据同根，重装/更新不丢。用户可在设置里改成任意目录。
  downloadsDir: path.join(dataRoot, 'downloads'),
  debugDir: path.join(dataRoot, 'debug'),
  publicDir: path.join(assetBase, 'public'),
  // MCP stdio 垫片:被 AI IDE 用 node 拉起,必须是磁盘上可直接执行的文件,
  // 不能藏在 asar 内。打包时经 extraResources 释放到 resources/appdata/mcp。
  mcpServerFile: path.join(assetBase, 'mcp', 'lulu-mcp-server.js'),
  _assetBase: assetBase
};

// 解析实际下载目录：优先用配置里的自定义目录，否则用默认 downloadsDir。
// 始终确保目录存在；自定义目录创建失败则回退默认。
function resolveDownloadDir(customDir) {
  let target = (customDir && String(customDir).trim()) ? String(customDir).trim() : paths.downloadsDir;
  try {
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch (e) {
    try { fs.mkdirSync(paths.downloadsDir, { recursive: true }); } catch (e2) {}
    return paths.downloadsDir;
  }
}

function ensureDirs() {
  for (const d of [paths.dataDir, paths.profilesDir, paths.debugDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 已存在 */ }
  }
  // 首次升级：从旧目录迁移数据
  if (isPackaged) migrateFromOldLocation();
}

// 从旧版数据目录（%APPDATA%\doubao-manager\）迁移到新的独立目录
function migrateFromOldLocation() {
  const oldRoots = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    oldRoots.push(path.join(appdata, 'doubao-manager'));
    oldRoots.push(path.join(appdata, 'lulu'));
  }
  for (const oldRoot of oldRoots) {
    if (!fs.existsSync(oldRoot)) continue;
    if (oldRoot === dataRoot) continue; // 不自迁移
    // 只迁移关键用户数据，不迁移 Electron 缓存
    const migrations = [
      { from: path.join(oldRoot, 'data', 'accounts.json'), to: paths.accountsFile },
      { from: path.join(oldRoot, 'data', 'conversations.json'), to: paths.conversationsFile },
      { from: path.join(oldRoot, 'data', 'profiles'), to: paths.profilesDir },
      { from: path.join(oldRoot, 'config', 'config.json'), to: paths.configFile },
      { from: path.join(oldRoot, 'config', 'license.json'), to: path.join(dataRoot, 'config', 'license.json') },
    ];
    let migrated = false;
    for (const { from, to } of migrations) {
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        // 目标已有内容则跳过（profiles 目录：检查是否非空）
        try {
          const stat = fs.statSync(to);
          if (stat.isDirectory() && fs.readdirSync(to).length > 0) continue;
          if (stat.isFile() && stat.size > 2) continue;
        } catch (e) { continue; }
      }
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (fs.statSync(from).isDirectory()) {
          copyDirSync(from, to);
        } else {
          fs.copyFileSync(from, to);
        }
        migrated = true;
      } catch (e) { /* 迁移失败不阻塞启动 */ }
    }
    if (migrated) {
      // 标记旧目录已迁移，不删除（用户可手动清理）
      try { fs.writeFileSync(path.join(oldRoot, '.migrated-to-lulu-data'), dataRoot); } catch (e) {}
    }
    break; // 只从第一个存在的旧目录迁移
  }
}

// 递归拷贝目录
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// 首次运行：外部无 config.json 时，从内置默认配置释放一份供用户修改
// 已有 config 缺少 license 节时，自动从内置默认补上
function ensureConfig() {
  const defaultCfg = path.join(assetBase, 'config', 'config.json');
  let defaults = {};
  try {
    defaults = JSON.parse(fs.readFileSync(defaultCfg, 'utf-8'));
  } catch (e) {
    defaults = {};
  }
  if (!fs.existsSync(paths.configFile)) {
    try {
      fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
      atomicWriteJsonFile(paths.configFile, defaults, { fs });
    } catch (e) {
      console.error('释放默认配置失败:', e.message);
    }
    return;
  }

  function cloneDefault(value) {
    if (value === undefined) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }

  function fillMissing(target, defaults) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return false;
    let changed = false;
    for (const k of Object.keys(defaults)) {
      if (target[k] === undefined) {
        target[k] = cloneDefault(defaults[k]);
        changed = true;
      } else if (
        target[k] && typeof target[k] === 'object' && !Array.isArray(target[k]) &&
        defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])
      ) {
        changed = fillMissing(target[k], defaults[k]) || changed;
      }
    }
    return changed;
  }

  function migrateLegacyGptImagePlatform(config) {
    const platforms = config && config.platforms;
    if (!platforms || !platforms.gptimage) return false;
    if (!platforms.plus) {
      platforms.plus = cloneDefault(platforms.gptimage);
      platforms.plus.label = 'plus';
    }
    delete platforms.gptimage;
    return true;
  }

  function migrateBundledDisplayNames(config) {
    const platforms = config && config.platforms;
    if (!platforms) return false;
    let changed = false;
    // 旧内置名来自上一版默认配置，不算用户自定义；用户自己改过的其它 label 不覆盖。
    if (platforms.orion && platforms.orion.label === 'Orion 无限视频') {
      platforms.orion.label = 'Orion';
      changed = true;
    }
    return changed;
  }

  // 已有 config 但缺少 license 节时，从内置默认补齐。
  try {
    const existing = ensureJsonFile(paths.configFile, defaults, { fs });
    let changed = false;
    changed = migrateLegacyGptImagePlatform(existing) || changed;
    if (!existing.license) {
      existing.license = defaults.license || {};
      changed = true;
    } else if (defaults.license) {
      for (const k of Object.keys(defaults.license)) {
        if (existing.license[k] === undefined) {
          existing.license[k] = defaults.license[k];
          changed = true;
        }
      }
    }
    // storage 节同样字段级补齐（老用户升级后自动获得下载相关配置）
    if (!existing.storage) {
      existing.storage = defaults.storage || { autoDownload: true, downloadDir: '' };
      changed = true;
    } else if (defaults.storage) {
      for (const k of Object.keys(defaults.storage)) {
        if (existing.storage[k] === undefined) {
          existing.storage[k] = defaults.storage[k];
          changed = true;
        }
      }
    }
    if (!existing.platforms && defaults.platforms) {
      existing.platforms = cloneDefault(defaults.platforms);
      changed = true;
    } else if (defaults.platforms) {
      changed = fillMissing(existing.platforms, defaults.platforms) || changed;
    }
    changed = migrateBundledDisplayNames(existing) || changed;
    if (changed) atomicWriteJsonFile(paths.configFile, existing, { fs });
  } catch (e) { /* 解析失败就不管 */ }
}

function loadConfig() {
  const defaultCfg = path.join(assetBase, 'config', 'config.json');
  let defaults = {};
  try { defaults = JSON.parse(fs.readFileSync(defaultCfg, 'utf-8')); } catch (e) {}
  return ensureJsonFile(paths.configFile, defaults, { fs });
}

module.exports = { ...paths, ensureDirs, ensureConfig, loadConfig, resolveDownloadDir };
