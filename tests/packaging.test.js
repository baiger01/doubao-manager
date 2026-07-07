const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');

function loadCommonJsModule(filePath, overrides = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const module = { exports: {} };
  const dirname = path.dirname(filePath);
  const filename = filePath;

  function localRequire(request) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) {
      return overrides[request];
    }
    if (request.startsWith('./') || request.startsWith('../')) {
      const resolved = require.resolve(path.resolve(dirname, request));
      return require(resolved);
    }
    return require(request);
  }

  const context = vm.createContext({
    module,
    exports: module.exports,
    require: localRequire,
    __dirname: dirname,
    __filename: filename,
    console,
    Buffer,
    URL,
    fetch,
    setTimeout,
    clearTimeout,
    process: overrides.process || process
  });

  const wrapped = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
  const compiled = vm.runInContext(wrapped, context, { filename });
  compiled(module.exports, localRequire, module, filename, dirname);
  return module.exports;
}

test('packaged build stores data in fixed lulu-data directory independent of app install path', () => {
  const pathsModulePath = path.resolve(__dirname, '..', 'paths.js');
  const fakeProcess = {
    pkg: undefined,
    platform: 'win32',
    execPath: 'C:\\Program Files\\lulu\\lulu.exe',
    resourcesPath: 'C:\\Program Files\\lulu\\resources',
    versions: { electron: '31.7.7' },
    env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }
  };
  const fakeElectron = {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === 'exe') return fakeProcess.execPath;
        if (name === 'userData') return 'C:\\Users\\tester\\AppData\\Roaming\\doubao-manager';
        throw new Error(`unexpected app.getPath(${name})`);
      }
    }
  };

  const paths = loadCommonJsModule(pathsModulePath, {
    electron: fakeElectron,
    process: fakeProcess
  });

  assert.equal(paths.dataRoot, 'C:\\Users\\tester\\AppData\\Roaming\\lulu-data');
  assert.equal(paths.configFile, 'C:\\Users\\tester\\AppData\\Roaming\\lulu-data\\config\\config.json');
  assert.equal(paths.profilesDir, 'C:\\Users\\tester\\AppData\\Roaming\\lulu-data\\data\\profiles');
});

test('dev mode uses project directory as dataRoot', () => {
  const pathsModulePath = path.resolve(__dirname, '..', 'paths.js');

  // 不传 electron override，不设 process.pkg → 走开发模式
  const paths = loadCommonJsModule(pathsModulePath, {});

  assert.equal(paths.dataRoot, path.resolve(__dirname, '..'));
  assert.equal(paths.isPackaged, false);
});

test('electron-builder files include application entrypoint package metadata', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  const files = packageJson.build.files || [];

  assert.ok(files.includes('package.json'), 'package.json must be packaged so Electron can resolve main');
  assert.ok(files.includes('electron-main.js'), 'Electron main entry must be packaged');
  assert.ok(files.includes('server.js'), 'embedded server entry must be packaged');
  assert.ok(files.includes('paths.js'), 'runtime path resolver must be packaged');
});

test('build target is nsis installer', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  const win = packageJson.build.win;

  assert.ok(win, 'build.win config must exist');
  const targets = win.target;
  assert.ok(Array.isArray(targets), 'build.win.target should be an array');
  assert.ok(targets.some(t => (typeof t === 'string' ? t : t.target) === 'nsis'), 'must build nsis installer');
});

test('dist script exists and sets cache environment variables', () => {
  const distScriptPath = path.resolve(__dirname, '..', 'scripts', 'dist.ps1');
  assert.ok(fs.existsSync(distScriptPath), 'dist.ps1 build script should exist');

  const distScript = fs.readFileSync(distScriptPath, 'utf8');
  assert.match(distScript, /ELECTRON_CACHE/, 'dist script should set ELECTRON_CACHE');
  assert.match(distScript, /ELECTRON_BUILDER_CACHE/, 'dist script should set ELECTRON_BUILDER_CACHE');
});

test('dist script leaves only one public installer in dist-electron', () => {
  const distScriptPath = path.resolve(__dirname, '..', 'scripts', 'dist.ps1');
  const distScript = fs.readFileSync(distScriptPath, 'utf8');

  assert.match(distScript, /Get-ChildItem\s+-LiteralPath\s+\$finalDir\s+-Filter\s+"lulu-setup\*"/);
  assert.match(distScript, /Remove-Item[\s\S]+stale installer/i);
  assert.match(distScript, /Get-ChildItem\s+-LiteralPath\s+\$distDir\s+-Filter\s+"lulu-setup\*"/);
  assert.match(distScript, /Remove-Item[\s\S]+temporary installer/i);
});

test('electron main saves manual downloads into the configured app download directory', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'electron-main.js'), 'utf8');

  assert.match(source, /will-download/);
  assert.match(source, /setSavePath/);
  assert.match(source, /resolveDownloadDir/);
  assert.match(source, /serverInfo\.app\.locals\.downloadDir/);
});

test('proxy route persists config through the writable runtime config path', async () => {
  const routeModulePath = path.resolve(__dirname, '..', 'routes', 'proxy.js');
  const writes = [];
  const fakeFs = {
    writeFileSync(filePath, content, encoding) {
      writes.push({ filePath, content, encoding });
    }
  };

  const buildProxyRouter = loadCommonJsModule(routeModulePath, {
    fs: fakeFs,
    '../paths': { configFile: 'D:\\RuntimeData\\config\\config.json' }
  });

  const config = {
    platforms: {
      dola: {
        baseUrl: 'https://www.dola.com',
        chatEndpoint: '/chat/completion'
      }
    }
  };

  const router = buildProxyRouter(config, {
    httpPostViaProxy: async () => ({ status: 200, text: 'ok' })
  });

  const app = express();
  app.use(express.json());
  app.use(router);

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'dola',
        proxy: 'http://127.0.0.1:7897'
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath, 'D:\\RuntimeData\\config\\config.json');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test('ensureConfig replaces a corrupt runtime config with bundled defaults', () => {
  const pathsModulePath = path.resolve(__dirname, '..', 'paths.js');
  const dataRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-config-'));
  const resourcesRoot = path.join(dataRoot, 'resources');
  const assetBase = path.join(resourcesRoot, 'appdata');
  const runtimeConfig = path.join(dataRoot, 'lulu-data', 'config', 'config.json');
  const bundledConfig = path.join(assetBase, 'config', 'config.json');
  fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
  fs.mkdirSync(path.dirname(bundledConfig), { recursive: true });
  fs.writeFileSync(runtimeConfig, '{"server":', 'utf-8');
  fs.writeFileSync(bundledConfig, JSON.stringify({
    server: { port: 9527, host: '127.0.0.1' },
    storage: { autoDownload: true, downloadDir: '' },
    license: { graceHours: 24 }
  }), 'utf-8');

  const fakeFs = {
    ...fs,
    existsSync(target) {
      if (target === assetBase) return true;
      return fs.existsSync(target);
    }
  };
  const fakeProcess = {
    ...process,
    pkg: undefined,
    platform: 'win32',
    versions: { electron: '31.7.7' },
    env: { APPDATA: dataRoot },
    resourcesPath: resourcesRoot,
    execPath: path.join(dataRoot, 'lulu.exe')
  };
  const fakeElectron = {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === 'exe') return fakeProcess.execPath;
        if (name === 'userData') return path.join(dataRoot, 'electron-user-data');
        throw new Error(`unexpected app.getPath(${name})`);
      }
    }
  };

  const paths = loadCommonJsModule(pathsModulePath, {
    fs: fakeFs,
    electron: fakeElectron,
    process: fakeProcess
  });

  paths.ensureConfig();

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')).server, { port: 9527, host: '127.0.0.1' });
  assert.equal(fs.readFileSync(paths.configFile + '.corrupt', 'utf-8'), '{"server":');
});

test('ensureConfig merges new default platforms into an existing runtime config', () => {
  const pathsModulePath = path.resolve(__dirname, '..', 'paths.js');
  const dataRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-platform-merge-'));
  const resourcesRoot = path.join(dataRoot, 'resources');
  const assetBase = path.join(resourcesRoot, 'appdata');
  const runtimeConfig = path.join(dataRoot, 'lulu-data', 'config', 'config.json');
  const bundledConfig = path.join(assetBase, 'config', 'config.json');
  fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
  fs.mkdirSync(path.dirname(bundledConfig), { recursive: true });
  fs.writeFileSync(runtimeConfig, JSON.stringify({
    server: { port: 9527 },
    storage: { autoDownload: true },
    platforms: {
      doubao: { label: '用户豆包配置', baseUrl: 'https://www.doubao.com' }
    }
  }), 'utf-8');
  fs.writeFileSync(bundledConfig, JSON.stringify({
    server: { port: 9527 },
    storage: { autoDownload: true, downloadDir: '' },
    license: { graceHours: 24 },
    platforms: {
      doubao: { label: '默认豆包配置' },
      plus: {
        label: 'plus',
        requiresAccount: false,
        imageApi: { type: 'openai-compatible', endpoint: 'http://example.test/v1/images/generations', model: 'gpt-image-2' },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image2' }]
      },
      '4k': {
        label: '4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: {
          type: 'openai-compatible',
          baseUrl: 'https://5988.de5.net/v1',
          model: 'gpt-image-2',
          size: '3840x2160',
          quality: 'high'
        },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image-2' }]
      }
    }
  }), 'utf-8');

  const fakeFs = {
    ...fs,
    existsSync(target) {
      if (target === assetBase) return true;
      return fs.existsSync(target);
    }
  };
  const fakeProcess = {
    ...process,
    pkg: undefined,
    platform: 'win32',
    versions: { electron: '31.7.7' },
    env: { APPDATA: dataRoot },
    resourcesPath: resourcesRoot,
    execPath: path.join(dataRoot, 'lulu.exe')
  };
  const fakeElectron = {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === 'exe') return fakeProcess.execPath;
        if (name === 'userData') return path.join(dataRoot, 'electron-user-data');
        throw new Error(`unexpected app.getPath(${name})`);
      }
    }
  };

  const paths = loadCommonJsModule(pathsModulePath, {
    fs: fakeFs,
    electron: fakeElectron,
    process: fakeProcess
  });

  paths.ensureConfig();

  const merged = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'));
  assert.equal(merged.platforms.doubao.label, '用户豆包配置');
  assert.equal(merged.platforms.plus.requiresAccount, false);
  assert.equal(merged.platforms.plus.imageApi.model, 'gpt-image-2');
  assert.equal(merged.platforms['4k'].requiresAccount, false);
  assert.equal(merged.platforms['4k'].supportsVideo, false);
  assert.equal(merged.platforms['4k'].imageApi.baseUrl, 'https://5988.de5.net/v1');
  assert.equal(merged.platforms['4k'].imageApi.size, '3840x2160');
  assert.equal(merged.platforms['4k'].imageApi.quality, 'high');
});

test('ensureConfig migrates legacy gptimage platform to plus without exposing the old key', () => {
  const pathsModulePath = path.resolve(__dirname, '..', 'paths.js');
  const dataRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-gptimage-migrate-'));
  const resourcesRoot = path.join(dataRoot, 'resources');
  const assetBase = path.join(resourcesRoot, 'appdata');
  const runtimeConfig = path.join(dataRoot, 'lulu-data', 'config', 'config.json');
  const bundledConfig = path.join(assetBase, 'config', 'config.json');
  fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
  fs.mkdirSync(path.dirname(bundledConfig), { recursive: true });
  fs.writeFileSync(runtimeConfig, JSON.stringify({
    server: { port: 9527 },
    platforms: {
      gptimage: {
        label: 'GPT Image',
        requiresAccount: false,
        imageApi: {
          type: 'openai-compatible',
          endpoint: 'http://legacy.example/v1/images/generations',
          apiKey: 'sk-legacy',
          model: 'gpt-image-2'
        },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image2' }]
      }
    }
  }), 'utf-8');
  fs.writeFileSync(bundledConfig, JSON.stringify({
    server: { port: 9527 },
    platforms: {
      plus: {
        label: 'plus',
        requiresAccount: false,
        imageApi: {
          type: 'openai-compatible',
          endpoint: 'http://default.example/v1/images/generations',
          apiKey: 'sk-default',
          model: 'gpt-image-2'
        },
        imageModels: [{ value: 'gpt-image-2', label: 'gpt-image2' }]
      }
    }
  }), 'utf-8');

  const fakeFs = {
    ...fs,
    existsSync(target) {
      if (target === assetBase) return true;
      return fs.existsSync(target);
    }
  };
  const fakeProcess = {
    ...process,
    pkg: undefined,
    platform: 'win32',
    versions: { electron: '31.7.7' },
    env: { APPDATA: dataRoot },
    resourcesPath: resourcesRoot,
    execPath: path.join(dataRoot, 'lulu.exe')
  };
  const fakeElectron = {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === 'exe') return fakeProcess.execPath;
        if (name === 'userData') return path.join(dataRoot, 'electron-user-data');
        throw new Error(`unexpected app.getPath(${name})`);
      }
    }
  };

  const paths = loadCommonJsModule(pathsModulePath, {
    fs: fakeFs,
    electron: fakeElectron,
    process: fakeProcess
  });

  paths.ensureConfig();

  const merged = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'));
  assert.equal(merged.platforms.plus.label, 'plus');
  assert.equal(merged.platforms.plus.imageApi.endpoint, 'http://legacy.example/v1/images/generations');
  assert.equal(merged.platforms.plus.imageApi.apiKey, 'sk-legacy');
  assert.equal(merged.platforms.gptimage, undefined);
});

test('ensureConfig does not fill empty image API keys from bundled defaults or replace a custom key', () => {
  const pathsModulePath = path.resolve(__dirname, '..', 'paths.js');
  const dataRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-4k-key-merge-'));
  const resourcesRoot = path.join(dataRoot, 'resources');
  const assetBase = path.join(resourcesRoot, 'appdata');
  const runtimeConfig = path.join(dataRoot, 'lulu-data', 'config', 'config.json');
  const bundledConfig = path.join(assetBase, 'config', 'config.json');
  fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
  fs.mkdirSync(path.dirname(bundledConfig), { recursive: true });
  fs.writeFileSync(runtimeConfig, JSON.stringify({
    server: { port: 9527 },
    platforms: {
      '4k': {
        label: '4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: {
          type: 'openai-compatible',
          baseUrl: 'https://5988.de5.net/v1',
          apiKey: '',
          model: 'gpt-image-2',
          size: '3840x2160',
          quality: 'high'
        }
      },
      keep4k: {
        label: 'keep4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: {
          type: 'openai-compatible',
          baseUrl: 'https://5988.de5.net/v1',
          apiKey: 'user-custom-key',
          model: 'gpt-image-2'
        }
      }
    }
  }), 'utf-8');
  fs.writeFileSync(bundledConfig, JSON.stringify({
    server: { port: 9527 },
    platforms: {
      '4k': {
        label: '4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: {
          type: 'openai-compatible',
          baseUrl: 'https://5988.de5.net/v1',
          apiKey: 'bundled-default-key',
          model: 'gpt-image-2',
          size: '3840x2160',
          quality: 'high'
        }
      },
      keep4k: {
        label: 'keep4k',
        requiresAccount: false,
        supportsVideo: false,
        imageApi: {
          type: 'openai-compatible',
          baseUrl: 'https://5988.de5.net/v1',
          apiKey: 'bundled-should-not-win',
          model: 'gpt-image-2'
        }
      }
    }
  }), 'utf-8');

  const fakeFs = {
    ...fs,
    existsSync(target) {
      if (target === assetBase) return true;
      return fs.existsSync(target);
    }
  };
  const fakeProcess = {
    ...process,
    pkg: undefined,
    platform: 'win32',
    versions: { electron: '31.7.7' },
    env: { APPDATA: dataRoot },
    resourcesPath: resourcesRoot,
    execPath: path.join(dataRoot, 'lulu.exe')
  };
  const fakeElectron = {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === 'exe') return fakeProcess.execPath;
        if (name === 'userData') return path.join(dataRoot, 'electron-user-data');
        throw new Error(`unexpected app.getPath(${name})`);
      }
    }
  };

  const paths = loadCommonJsModule(pathsModulePath, {
    fs: fakeFs,
    electron: fakeElectron,
    process: fakeProcess
  });

  paths.ensureConfig();

  const merged = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'));
  assert.equal(merged.platforms['4k'].imageApi.apiKey, '');
  assert.equal(merged.platforms.keep4k.imageApi.apiKey, 'user-custom-key');
});

test('ensureConfig migrates bundled Orion legacy display name without replacing custom labels', () => {
  const pathsModulePath = path.resolve(__dirname, '..', 'paths.js');
  const dataRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lulu-orion-label-migrate-'));
  const resourcesRoot = path.join(dataRoot, 'resources');
  const assetBase = path.join(resourcesRoot, 'appdata');
  const runtimeConfig = path.join(dataRoot, 'lulu-data', 'config', 'config.json');
  const bundledConfig = path.join(assetBase, 'config', 'config.json');
  fs.mkdirSync(path.dirname(runtimeConfig), { recursive: true });
  fs.mkdirSync(path.dirname(bundledConfig), { recursive: true });
  fs.writeFileSync(runtimeConfig, JSON.stringify({
    server: { port: 9527 },
    platforms: {
      orion: {
        label: 'Orion 无限视频',
        requiresAccount: false,
        videoApi: { type: 'orion-local', endpoint: 'http://127.0.0.1:8787/generate' }
      },
      customOrion: {
        label: '我的 Orion',
        requiresAccount: false,
        videoApi: { type: 'orion-local', endpoint: 'http://127.0.0.1:8787/generate' }
      }
    }
  }), 'utf-8');
  fs.writeFileSync(bundledConfig, JSON.stringify({
    server: { port: 9527 },
    platforms: {
      orion: {
        label: 'Orion',
        requiresAccount: false,
        videoApi: { type: 'orion-local', endpoint: 'http://127.0.0.1:8787/generate' }
      },
      customOrion: {
        label: '默认 Orion',
        requiresAccount: false,
        videoApi: { type: 'orion-local', endpoint: 'http://127.0.0.1:8787/generate' }
      }
    }
  }), 'utf-8');

  const fakeFs = {
    ...fs,
    existsSync(target) {
      if (target === assetBase) return true;
      return fs.existsSync(target);
    }
  };
  const fakeProcess = {
    ...process,
    pkg: undefined,
    platform: 'win32',
    versions: { electron: '31.7.7' },
    env: { APPDATA: dataRoot },
    resourcesPath: resourcesRoot,
    execPath: path.join(dataRoot, 'lulu.exe')
  };
  const fakeElectron = {
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === 'exe') return fakeProcess.execPath;
        if (name === 'userData') return path.join(dataRoot, 'electron-user-data');
        throw new Error(`unexpected app.getPath(${name})`);
      }
    }
  };

  const paths = loadCommonJsModule(pathsModulePath, {
    fs: fakeFs,
    electron: fakeElectron,
    process: fakeProcess
  });

  paths.ensureConfig();

  const merged = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'));
  assert.equal(merged.platforms.orion.label, 'Orion');
  assert.equal(merged.platforms.customOrion.label, '我的 Orion');
});
