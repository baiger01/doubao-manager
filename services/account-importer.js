const fs = require('fs');
const path = require('path');
const paths = require('../paths');

// 递归拷贝目录:优先 Node 16.7+ 的 fs.cpSync,回退手写递归。
function copyDir(src, dest) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dest, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else { try { fs.copyFileSync(s, d); } catch (_) {} }
  }
}

function dirHasFiles(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    return fs.readdirSync(dir).length > 0;
  } catch { return false; }
}

/**
 * 账号备份导入器。
 *
 * 兼容 doubao-account-switcher 的 "account-login-backup" 格式:
 *   <backup>/
 *     manifest.json           { product, type:'account-login-backup', version }
 *     accounts.json           { accounts:[{ id, phone, name, platform, ... }] }
 *     electron-user-data/
 *       Local State           ← Chromium os_crypt cookie 密钥(DPAPI 加密,绑原机器/用户)
 *       Partitions/<platform>-<id>/
 *                             ← 每账号一个 Electron partition:Network/Cookies、Local Storage ...
 *
 * lulu 侧存储是 Chrome --user-data-dir 结构(cookie 在 <profile>/Default/Network/Cookies),
 * 与 partition 仅差一层 Default/。导入即:
 *   1) accountManager.add() 建账号记录,拿到新 uuid + profileDir
 *   2) 备份 Partitions/<platform>-<id>/*  →  <profileDir>/Default/
 *   3) 备份 electron-user-data/Local State →  <profileDir>/Local State
 * 之后在原机器上,Chrome 用同一 DPAPI 密钥即可解出登录态。
 *
 * 注意:cookie 密文由 Windows DPAPI 加密,只有在"导出这份备份的那台机器 + 同一 Windows 用户"下
 * 才能被 Chrome 解开。跨机器/跨用户导入后 cookie 无效(表现为未登录),这是 Chromium 机制,无法绕过。
 */
class AccountImporter {
  constructor(accountManager, browserManager) {
    this.accountManager = accountManager;
    this.browserManager = browserManager;
  }

  // 探测备份目录布局。允许用户选到外层备份目录,或直接选到 electron-user-data。
  // 返回 { ok, error?, accountsFile, partitionsDir, localStateFile, accounts:[...] }
  inspect(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return { ok: false, error: '目录不存在' };
    }

    // 定位 electron-user-data:可能就是所选目录,也可能是其子目录
    let eudDir = path.join(rootDir, 'electron-user-data');
    if (!fs.existsSync(path.join(eudDir, 'Partitions'))) {
      if (fs.existsSync(path.join(rootDir, 'Partitions'))) eudDir = rootDir;
    }
    const partitionsDir = path.join(eudDir, 'Partitions');
    if (!fs.existsSync(partitionsDir)) {
      return { ok: false, error: '未找到 Partitions 目录,请选择包含 electron-user-data 的备份文件夹' };
    }

    // accounts.json 一般在 rootDir;若选到 electron-user-data,则往上找一层
    let accountsFile = path.join(rootDir, 'accounts.json');
    if (!fs.existsSync(accountsFile)) {
      const up = path.join(path.dirname(eudDir), 'accounts.json');
      if (fs.existsSync(up)) accountsFile = up;
    }

    let accounts = [];
    if (fs.existsSync(accountsFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        accounts = Array.isArray(parsed) ? parsed : (parsed.accounts || []);
      } catch (e) {
        return { ok: false, error: 'accounts.json 解析失败: ' + e.message };
      }
    } else {
      // 无 accounts.json:从 partition 目录名反推(doubao-<id> / dola-<id>)
      accounts = fs.readdirSync(partitionsDir)
        .filter(n => fs.statSync(path.join(partitionsDir, n)).isDirectory())
        .map(n => {
          const m = /^([a-z0-9]+)-(.+)$/i.exec(n);
          return m ? { id: m[2], platform: m[1], name: '' } : null;
        })
        .filter(Boolean);
    }

    const localStateFile = path.join(eudDir, 'Local State');
    return {
      ok: true,
      accountsFile: fs.existsSync(accountsFile) ? accountsFile : '',
      partitionsDir,
      localStateFile: fs.existsSync(localStateFile) ? localStateFile : '',
      accounts,
    };
  }

  // partition 目录名规则:<platform>-<id>。做多种回退匹配以增强健壮性。
  resolvePartitionDir(partitionsDir, acc) {
    const platform = acc.platform || 'doubao';
    const candidates = [
      `${platform}-${acc.id}`,
      String(acc.id || ''),
    ];
    for (const c of candidates) {
      if (!c) continue;
      const p = path.join(partitionsDir, c);
      if (fs.existsSync(p)) return p;
    }
    // 最后兜底:目录名以 -<id> 结尾
    if (acc.id) {
      try {
        const hit = fs.readdirSync(partitionsDir).find(n => n.endsWith('-' + acc.id) || n === acc.id);
        if (hit) return path.join(partitionsDir, hit);
      } catch (_) {}
    }
    return '';
  }

  /**
   * 执行导入。
   * @param {string} rootDir 备份目录
   * @param {object} opts { platform? 强制平台, skipExisting? 按名去重, grab? 立即抓明文cookie }
   * @param {function} onProgress ({ index,total,name,status,message }) => void
   * @returns {Promise<{success, imported, skipped, failed, total}>}
   */
  async import(rootDir, opts = {}, onProgress = () => {}) {
    const info = this.inspect(rootDir);
    if (!info.ok) return { success: false, error: info.error };

    const list = info.accounts;
    const total = list.length;
    if (total === 0) return { success: false, error: '备份中没有账号' };

    let imported = 0, skipped = 0, failed = 0;

    for (let i = 0; i < total; i++) {
      const acc = list[i] || {};
      const platform = opts.platform || acc.platform || 'doubao';
      const name = String(acc.name || acc.phone || acc.id || '导入账号').trim();
      const idx = i + 1;
      const emit = (status, message) => onProgress({ index: idx, total, name, status, message });

      try {
        // 按平台+备注名去重
        if (opts.skipExisting !== false) {
          const dup = this.accountManager.getAllByPlatform(platform).find(a => a.name === name);
          if (dup) { skipped++; emit('skip', '同名账号已存在,跳过'); continue; }
        }

        const srcPartition = this.resolvePartitionDir(info.partitionsDir, acc);
        if (!srcPartition || !dirHasFiles(srcPartition)) {
          failed++; emit('error', '备份中缺少该账号的登录数据目录'); continue;
        }

        // 1) 建账号记录,拿到新 uuid + profileDir
        const account = this.accountManager.add({ name, platform });
        const profileDir = account.profileDir || path.join(paths.profilesDir, account.id);

        // 2) 拷 partition → <profile>/Default
        emit('running', '拷贝登录数据...');
        const defaultDir = path.join(profileDir, 'Default');
        fs.mkdirSync(defaultDir, { recursive: true });
        copyDir(srcPartition, defaultDir);

        // 3) 拷 Local State(cookie 解密密钥)→ <profile>/Local State
        if (info.localStateFile) {
          try { fs.copyFileSync(info.localStateFile, path.join(profileDir, 'Local State')); } catch (_) {}
        }

        // 4) 可选:立即启动浏览器抓明文 cookie(需原机器 DPAPI 可解),让账号可直接用于生成
        if (opts.grab) {
          try {
            emit('running', '抓取登录态...');
            // 抓 cookie 用全局窗口模式(config.storage.browserWindowMode),默认 background(后台无头)
            const cfgMode = this.browserManager.config && this.browserManager.config.storage && this.browserManager.config.storage.browserWindowMode;
            const windowMode = ['visible', 'background', 'headless'].includes(cfgMode) ? cfgMode : 'background';
            await this.browserManager.launchForLogin(account.id, platform, { windowMode });
            const data = await this.browserManager.grabCookiesAndParams(account.id);
            if (data && data.cookies) {
              const pc = this.accountManager.getPlatformConfig(platform);
              const aid = (pc.defaultParams && pc.defaultParams.aid) || '497858';
              this.accountManager.update(account.id, {
                status: 'active',
                browser: this.browserManager.getAccountBrowserState(account.id),
                session: {
                  cookies: data.cookies,
                  device_id: data.device_id || '',
                  web_id: data.web_id || '',
                  user_id: data.user_id || '',
                  fp: data.fp || '',
                  conversation_id: data.conversation_id || '',
                  aid,
                  bot_id: pc.botId || '',
                },
              });
              emit('ok', '导入成功(已登录)');
            } else {
              emit('ok', '已导入,但未抓到登录态(可能非原机器,cookie 无法解密)');
            }
          } catch (e) {
            emit('ok', '已导入,登录态抓取失败: ' + (e.message || ''));
          } finally {
            try { this.browserManager.close(account.id); } catch (_) {}
          }
        } else {
          emit('ok', '已导入(登录数据已就位)');
        }

        imported++;
      } catch (e) {
        try {
          const dup = this.accountManager.getAllByPlatform(platform).find(a => a.name === name);
          if (dup) {
            try { this.browserManager.close(dup.id); } catch (_) {}
            try {
              const profileDir = dup.profileDir || dup.browser?.profileDir || path.join(paths.profilesDir, dup.id);
              if (profileDir && fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
            } catch (_) {}
            try { this.accountManager.remove(dup.id); } catch (_) {}
          }
        } catch (_) {}
        failed++;
        emit('error', e.message || '导入失败');
      }
    }

    return { success: true, imported, skipped, failed, total };
  }
}

module.exports = AccountImporter;
