import React from 'react';
import { useStore } from '../store.jsx';
import LiquidGlass from './LiquidGlass.jsx';
import {
  ADD_ACCOUNT_MAIN_CLASS,
  ADD_ACCOUNT_MAIN_LABEL,
  AUTO_LOGIN_HINT,
  AUTO_LOGIN_KEPT_BROWSER_BADGE_LABEL,
  getAccountlessPlatformHint,
  getAutoLoginTarget,
  getAutoLoginMessageTitle,
  getDefaultAddAccountPlatform,
  platformRequiresAccount,
  shouldShowOrionAuthActions,
  shouldShowKeptBrowserBadge,
  shouldShowPlatformAddAccount,
} from '../lib/accounts-modal-contract.js';

export default function AccountsModal({ open, onClose }) {
  const {
    platform, platforms, accounts, loginForm,
    startAddAccount, clearPlatformAccounts, activateAccount, reloginAccount,
    openAccount, deleteAccount, confirmLogin, cancelLogin,
    openOrionLogin, exportOrionBrowserCookies, refreshOrionAuthStatus, saveOrionCookie,
    orionAuthState,
    autoLoginState, startAutoLogin, clearAutoLogin,
    importState, pickBackupDir, inspectBackup, startImportBackup, clearImport,
    license, openSettings,
  } = useStore();

  const [autoOpen, setAutoOpen] = React.useState(false);
  const [autoText, setAutoText] = React.useState('');

  // 导入备份面板状态
  const [importOpen, setImportOpen] = React.useState(false);
  const [importDir, setImportDir] = React.useState('');
  const [importInfo, setImportInfo] = React.useState(null); // {total,platforms,hasLocalState}
  const [importGrab, setImportGrab] = React.useState(false);
  const [inspecting, setInspecting] = React.useState(false);
  const [orionCookieText, setOrionCookieText] = React.useState('');

  const hasOrionAuth = platforms.some(shouldShowOrionAuthActions);
  React.useEffect(() => {
    if (open && hasOrionAuth) refreshOrionAuthStatus();
  }, [open, hasOrionAuth, refreshOrionAuthStatus]);

  if (!open) return null;

  const running = autoLoginState && autoLoginState.running;
  const importing = importState && importState.running;
  const autoLoginTarget = getAutoLoginTarget(platforms);
  const autoLoginPlatform = autoLoginTarget.key;
  const autoLoginLabel = autoLoginTarget.label;
  const canAddAccounts = platforms.some(platformRequiresAccount);

  const chooseDir = async () => {
    const dir = await pickBackupDir();
    if (!dir) return;
    setImportDir(dir);
    setImportInfo(null);
    setInspecting(true);
    const info = await inspectBackup(dir);
    setInspecting(false);
    setImportInfo(info);
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <LiquidGlass radius={24} blur={26} strength={36} tint="rgba(248,246,252,0.97)" className="modal-panel">
        <div className="modal-header">
          <h3>账号管理</h3>
          <div className="modal-header-actions">
            {canAddAccounts && (
              <button className={ADD_ACCOUNT_MAIN_CLASS} onClick={() => startAddAccount(getDefaultAddAccountPlatform(platform, platforms))}>
                {ADD_ACCOUNT_MAIN_LABEL}
              </button>
            )}
            <button className="btn-auto-login" onClick={() => setImportOpen(v => !v)}>
              {importOpen ? '收起导入' : '导入账号备份'}
            </button>
            <button className="btn-auto-login" onClick={() => setAutoOpen(v => !v)}>
              {autoOpen ? '收起批量登录' : '批量自动登录'}
            </button>
            <button className="btn-modal-close" onClick={onClose}>&times;</button>
          </div>
        </div>

        {license && license.hasLicense && (
          <button className="acc-license-bar" onClick={() => { onClose(); openSettings('license'); }} title="查看授权详情">
            <span className={'acc-lic-dot ' + (!license.verified ? 'bad' : license.offline ? 'warn' : 'ok')} />
            <span className="acc-lic-text">
              {!license.verified ? '未授权'
                : license.isPermanent ? '永久授权'
                : license.daysRemaining != null ? `授权剩余 ${license.daysRemaining} 天`
                : '已授权'}
              {license.offline ? '(离线宽限中)' : ''}
            </span>
            <span className="acc-lic-arrow">详情 ›</span>
          </button>
        )}

        {importOpen && (
          <div className="auto-login-panel">
            <div className="import-pick-row">
              <button className="btn-save" onClick={chooseDir} disabled={importing}>选择备份文件夹</button>
              <span className="import-dir" title={importDir}>{importDir || '未选择'}</span>
            </div>
            {inspecting && <div className="auto-login-hint">正在识别备份...</div>}
            {importInfo && (
              <div className="import-info">
                共识别到 <b>{importInfo.total}</b> 个账号
                {importInfo.platforms && Object.keys(importInfo.platforms).length > 0 && (
                  <span>（{Object.entries(importInfo.platforms).map(([p, n]) => `${p}:${n}`).join('、')}）</span>
                )}
                {!importInfo.hasLocalState && <span className="import-warn"> · 缺少 Local State,登录态可能无法解密</span>}
              </div>
            )}
            <label className="import-check">
              <input type="checkbox" checked={importGrab} disabled={importing}
                onChange={e => setImportGrab(e.target.checked)} />
              <span>导入后立即抓取登录态（逐个开浏览器，较慢；仅在导出备份的原机器上有效）</span>
            </label>
            <div className="auto-login-hint">
              登录态由 Windows 加密（DPAPI）绑定原机器与用户，只有在<b>制作备份的那台电脑、同一 Windows 账户</b>下导入才能解密使用；换机导入会显示未登录。
            </div>
            <div className="auto-login-actions">
              <button className="btn-save" disabled={importing || !importInfo || !importInfo.total}
                onClick={() => startImportBackup(importDir, { grab: importGrab })}>
                {importing ? '正在导入...' : '开始导入'}
              </button>
              {importState && !importing && (
                <button className="btn-cancel" onClick={clearImport}>清除结果</button>
              )}
            </div>
            {importState && importState.summary && (
              <div className="import-summary">
                导入完成：成功 {importState.summary.imported || 0}，跳过 {importState.summary.skipped || 0}，失败 {importState.summary.failed || 0}
              </div>
            )}
            {importState && importState.items && importState.items.length > 0 && (
              <div className="auto-login-progress">
                {importState.items.map((it, i) => (
                  <div key={i} className={'auto-login-item ' + (it.status || '')}>
                    <span className="ali-dot" />
                    <span className="ali-email" title={it.name}>{it.name}</span>
                    <span className="ali-msg">{it.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {autoOpen && (
          <div className="auto-login-panel">
            <div className="auto-login-row">
              <span className="auto-login-label">平台</span>
              <select className="auto-login-select" value={autoLoginPlatform} disabled>
                <option value={autoLoginPlatform}>{autoLoginLabel}</option>
              </select>
            </div>
            <textarea className="auto-login-textarea"
              placeholder={'每行一个账号,格式:\n邮箱|密码\nname@example.com|password123'}
              value={autoText}
              onChange={e => setAutoText(e.target.value)}
              disabled={running}
              rows={6} />
            <div className="auto-login-hint">{AUTO_LOGIN_HINT}；窗口模式按「设置 → 下载 → 登录浏览器窗口」执行，逐个串行处理。</div>
            <div className="auto-login-actions">
              <button className="btn-save" disabled={running || !autoText.trim()}
                onClick={() => startAutoLogin(autoLoginPlatform, autoText)}>
                {running ? '正在登录...' : '开始自动登录'}
              </button>
              {autoLoginState && !running && (
                <button className="btn-cancel" onClick={clearAutoLogin}>清除结果</button>
              )}
            </div>
            {autoLoginState && autoLoginState.items && (
              <div className="auto-login-progress">
                {autoLoginState.items.map((it, i) => (
                  <div key={i} className={'auto-login-item ' + (it.status || '')}>
                    <span className="ali-dot" />
                    <span className="ali-email" title={it.email}>{it.email}</span>
                    {shouldShowKeptBrowserBadge(it) && <span className="ali-badge" title="浏览器已保留在失败页面">{AUTO_LOGIN_KEPT_BROWSER_BADGE_LABEL}</span>}
                    <span className="ali-msg" title={getAutoLoginMessageTitle(it)}>{it.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="account-list">
          {platforms.length === 0 ? (
            <div className="account-empty">暂未添加账号</div>
          ) : platforms.map(p => {
            const accts = accounts.filter(a => a.platform === p.key);
            return (
              <div key={p.key} className="acc-group">
                <div className="acc-group-title">
                  <span>{p.label}</span>
                  <div className="acc-group-actions">
                    {accts.length > 0 && (
                      <button className="btn-clear-platform" title="清空该平台所有账号"
                        onClick={() => clearPlatformAccounts(p.key)}>清空</button>
                    )}
                    {shouldShowPlatformAddAccount(p) && (
                      <button className="btn-add-platform" onClick={() => startAddAccount(p.key)}>+ 添加</button>
                    )}
                    {shouldShowOrionAuthActions(p) && (
                      <>
                        <button className="btn-add-platform btn-orion-auth" onClick={openOrionLogin}>打开授权</button>
                        <button className="btn-add-platform btn-orion-auth" onClick={exportOrionBrowserCookies}>回传登录态</button>
                      </>
                    )}
                  </div>
                </div>
                {accts.length === 0 ? (
                  <div className="account-empty">
                    {platformRequiresAccount(p) ? '该平台暂无账号' : getAccountlessPlatformHint(p)}
                  </div>
                ) : accts.map(acc => (
                  <AccountItem key={acc.id} acc={acc}
                    onActivate={() => activateAccount(acc.id)}
                    onOpen={() => openAccount(acc.id)}
                    onRelogin={() => reloginAccount(acc.id)}
                    onDelete={() => deleteAccount(acc.id)} />
                ))}
                {shouldShowOrionAuthActions(p) && (
                  <div className={'orion-auth-panel ' + (orionAuthState?.status || 'idle')}>
                    <div className="orion-auth-status">
                      <span className={'orion-auth-dot ' + (orionAuthState?.authenticated ? 'ok' : 'warn')} />
                      <div>
                        <div className="orion-auth-title">
                          {orionAuthState?.authenticated ? 'Orion 登录态可用' : 'Orion 登录态待确认'}
                        </div>
                        <div className="orion-auth-message">{orionAuthState?.message || '未检查 Orion 登录态'}</div>
                        {orionAuthState?.action && <div className="orion-auth-action">{orionAuthState.action}</div>}
                      </div>
                    </div>
                    <div className="orion-auth-help">
                      登录窗口里如果一直停在「正在登录」，先在手机端确认；还不跳转就改用手机号验证码登录。页面真正进入后，再点「回传登录态」。
                    </div>
                    <div className="orion-auth-actions">
                      <button className="btn-add-platform btn-orion-auth" onClick={refreshOrionAuthStatus}>检查状态</button>
                      <button className="btn-add-platform btn-orion-auth" onClick={openOrionLogin}>打开授权</button>
                      <button className="btn-add-platform btn-orion-auth" onClick={exportOrionBrowserCookies}>回传登录态</button>
                    </div>
                    <label className="orion-cookie-label">手动 Cookie 兜底</label>
                    <textarea className="orion-cookie-input"
                      value={orionCookieText}
                      onChange={e => setOrionCookieText(e.target.value)}
                      placeholder="从已登录请求复制完整 Cookie header，例如 sessionid=...; sid_tt=...; uid_tt=..." />
                    <div className="orion-auth-actions">
                      <button className="btn-add-platform btn-orion-auth" disabled={!orionCookieText.trim()}
                        onClick={() => saveOrionCookie(orionCookieText)}>
                        保存手动 Cookie
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {loginForm && (
          <div className="account-form">
            <div className="form-title">{loginForm.title}</div>
            <div className="login-hint"><p>{loginForm.hint}</p></div>
            <div className="form-actions">
              <button className="btn-save" disabled={loginForm.busy}
                onClick={() => confirmLogin(loginForm.accountId)}>
                {loginForm.busy ? '正在获取登录态...' : '已登录,确认保存'}
              </button>
              <button className="btn-cancel" onClick={() => cancelLogin(loginForm.accountId)}>取消</button>
            </div>
          </div>
        )}
      </LiquidGlass>
    </div>
  );
}

function AccountItem({ acc, onActivate, onOpen, onRelogin, onDelete }) {
  const isExhausted = acc.status === 'quota_exhausted';
  const quotaText = (acc.quota?.videoRemaining != null) ? `${acc.quota.videoRemaining}次` : '--';
  const cls = acc.isActive ? 'active' : (isExhausted ? 'exhausted' : '');
  return (
    <div className={'account-item ' + cls}>
      <div className="acc-dot" />
      <div className="acc-info">
        <div className="acc-name" title={acc.name}>{acc.displayName || acc.name}</div>
        <div className="acc-meta">
          <span className="acc-email" title={acc.name}>{acc.name}</span>
          {acc.session?.device_id ? <span className="acc-device"> · device ...{acc.session.device_id.slice(-4)}</span> : <span className="acc-device"> · 未登录</span>}
        </div>
      </div>
      <div className={'acc-quota' + (isExhausted ? ' exhausted' : '')}>{quotaText}</div>
      <div className="acc-actions">
        {!acc.isActive && <button className="btn-activate" title="激活使用" onClick={onActivate}>&#10003;</button>}
        <button className="btn-open" title="打开网页(挂登录态)" onClick={onOpen}>&#128279;</button>
        <button className="btn-relogin" title="重新登录" onClick={onRelogin}>&#8634;</button>
        <button className="btn-del" title="删除" onClick={onDelete}>&#10005;</button>
      </div>
    </div>
  );
}
