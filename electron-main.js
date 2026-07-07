// Electron 主进程：启动内置 express 服务，再开应用窗口加载本地页面。
// 用户看到的是一个独立桌面窗口，不弹浏览器、不弹命令行。
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// 崩溃日志：写到 exe 旁边的 crash.log
const logFile = path.join(path.dirname(process.execPath), 'crash.log');
function crashLog(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}
const env = process.env || {};
crashLog(`process starting. execPath=${process.execPath}`);
crashLog(`PORTABLE_EXECUTABLE_DIR=${env.PORTABLE_EXECUTABLE_DIR || 'NOT SET'}`);
crashLog(`cwd=${typeof process.cwd === 'function' ? process.cwd() : 'UNKNOWN'}`);
process.on('uncaughtException', (err) => {
  crashLog('uncaughtException: ' + err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  crashLog('unhandledRejection: ' + (reason && reason.stack || reason));
});

const { app, BrowserWindow, shell, dialog, session } = require('electron');
const { createElectronNativeBridge } = require('./services/native-bridge');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  crashLog('second instance detected; quitting before server start');
  app.quit();
}

let mainWindow = null;
let serverInfo = null;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function probeServer(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const client = String(url).startsWith('https:') ? https : http;
    let req = null;
    try {
      req = client.get(url, (res) => {
        try { res.resume(); } catch (e) {}
        finish(true);
      });
      req.on('error', () => finish(false));
      if (typeof req.setTimeout === 'function') {
        req.setTimeout(timeoutMs, () => {
          finish(false);
          try { req.destroy(); } catch (e) {}
        });
      }
    } catch (e) {
      finish(false);
    }
  });
}

async function waitForServerReady(url, options = {}) {
  const timeoutMs = options.timeoutMs || parsePositiveInt(env.LULU_READY_TIMEOUT_MS, 45000);
  const intervalMs = options.intervalMs || parsePositiveInt(env.LULU_READY_INTERVAL_MS, 250);
  const requestTimeoutMs = options.requestTimeoutMs || parsePositiveInt(env.LULU_READY_REQUEST_TIMEOUT_MS, 1500);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    if (await probeServer(url, requestTimeoutMs)) {
      crashLog(`server ready after ${attempts} probe(s): ${url}`);
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  throw new Error(`本地服务 ${url} 在 ${Math.ceil(timeoutMs / 1000)} 秒内没有响应`);
}

function sanitizeDownloadFilename(filename) {
  const raw = path.basename(String(filename || 'download')) || 'download';
  const parsed = path.parse(raw);
  const name = (parsed.name || 'download').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120) || 'download';
  const ext = (parsed.ext || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 20);
  return name + ext;
}

function uniqueDownloadPath(dir, filename) {
  const safe = sanitizeDownloadFilename(filename);
  const parsed = path.parse(safe);
  let candidate = path.join(dir, safe);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${i++}${parsed.ext}`);
  }
  return candidate;
}

function installDownloadHandler(electronSession) {
  if (!electronSession || electronSession.__luluDownloadHandlerInstalled) return;
  electronSession.__luluDownloadHandlerInstalled = true;
  electronSession.on('will-download', (event, item) => {
    try {
      const appPaths = require('./paths');
      const dir = appPaths.resolveDownloadDir(serverInfo.app.locals.downloadDir);
      item.setSavePath(uniqueDownloadPath(dir, item.getFilename()));
    } catch (e) {
      crashLog('set download save path failed: ' + e.message);
    }
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'lulu',
    backgroundColor: '#1a1633',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await waitForServerReady(serverInfo.url);
  await mainWindow.loadURL(serverInfo.url);

  // 自动打开 DevTools 开关:默认关闭,仅当环境变量 OPEN_DEVTOOLS=1 时才在启动时打开。
  // (原逻辑保留:仍限定非 portable 模式;F12 依旧可随时手动开关。)
  if (env.OPEN_DEVTOOLS === '1' && !env.PORTABLE_EXECUTABLE_DIR) {
    mainWindow.webContents.openDevTools({ mode: 'detach', activate: true });
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    crashLog('electron ready; starting server');
    try {
      const { start } = require('./server');
      serverInfo = await start();
      // 注入 Electron 原生能力，供 settings 路由弹原生选目录框 / 打开目录
      try {
        if (serverInfo.app) {
          serverInfo.app.locals.nativeBridge = createElectronNativeBridge({ dialog, shell, session });
          // 手动点击下载时也使用应用设置里的下载目录；设置为桌面就直接落桌面。
          installDownloadHandler(session.defaultSession);
          // 启动即把已绑定的豆包账号登录态重新注入 webview 分区,
          // 否则因 session cookie 关进程失效,用户每次启动都得手动再绑一次。
          // await 确保 cookie 在窗口(及 webview)加载前就位。
          if (typeof serverInfo.app.locals.reinjectWebviewBinding === 'function') {
            try {
              const r = await serverInfo.app.locals.reinjectWebviewBinding();
              crashLog('reinject webview binding: ' + JSON.stringify(r));
            } catch (e) { crashLog('reinject webview binding failed: ' + e.message); }
          }
        }
      } catch (e) { crashLog('inject native failed: ' + e.message); }
      crashLog('server started: ' + serverInfo.url);
    } catch (err) {
      crashLog('server start failed: ' + (err && err.stack || err));
      dialog.showErrorBox('启动失败', '内置服务启动失败：\n' + err.message);
      app.quit();
      return;
    }

    try {
      await createWindow();
      crashLog('main window loaded');
    } catch (err) {
      crashLog('window create failed: ' + (err && err.stack || err));
      dialog.showErrorBox('启动失败', '窗口加载失败：\n' + err.message + '\n\n日志文件：' + logFile);
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  try { if (serverInfo && serverInfo.cleanup) serverInfo.cleanup(); } catch (e) {}
  app.quit();
});

app.on('before-quit', () => {
  try { if (serverInfo && serverInfo.cleanup) serverInfo.cleanup(); } catch (e) {}
});
