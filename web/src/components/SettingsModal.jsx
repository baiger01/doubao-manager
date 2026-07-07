import React, { useEffect, useState, useRef } from 'react';
import { useStore } from '../store.jsx';
import LiquidGlass from './LiquidGlass.jsx';
import { api } from '../lib/api.js';
import {
  BROWSER_WINDOW_MODE_OPTIONS,
  PROXY_SETTINGS,
  SETTINGS_TABS,
  getImageApiPlatforms,
  getPreferredImageApiPlatform,
  getRenderableImageApiPlatforms,
} from '../lib/settings-ui-contract.js';

const TYPE_LABEL = { day: '天卡', week: '周卡', month: '月卡', master: '永久(内置)', year: '年卡' };

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return iso; }
}

function maskKey(key) {
  if (!key) return '—';
  if (key.length <= 8) return key;
  return key.slice(0, 4) + '****' + key.slice(-4);
}

// ===== 下载设置 =====
function DownloadPane({ showToast }) {
  const [loading, setLoading] = useState(true);
  const [autoDownload, setAutoDownload] = useState(true);
  const [downloadDir, setDownloadDir] = useState('');
  const [effectiveDir, setEffectiveDir] = useState('');
  const [defaultDir, setDefaultDir] = useState('');
  const [canPickDir, setCanPickDir] = useState(false);
  const [browserWindowMode, setBrowserWindowMode] = useState('background');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getSettings().then(r => {
      if (r.success) {
        setAutoDownload(r.data.autoDownload);
        setDownloadDir(r.data.downloadDir || '');
        setEffectiveDir(r.data.effectiveDir || '');
        setDefaultDir(r.data.defaultDir || '');
        setCanPickDir(!!r.data.canPickDir);
        if (r.data.browserWindowMode) setBrowserWindowMode(r.data.browserWindowMode);
      }
    }).finally(() => setLoading(false));
  }, []);

  const pickDir = async () => {
    const r = await api.pickDownloadDir();
    if (r.success && r.data?.dir) setDownloadDir(r.data.dir);
    else if (r.error === 'no_native') showToast('请直接在输入框填写目录路径');
  };
  const openDir = async () => {
    const r = await api.openDownloadDir();
    if (!r.success) showToast('打开目录失败: ' + (r.error || ''));
  };
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveSettings({ autoDownload, downloadDir, browserWindowMode });
      if (r.success) { setEffectiveDir(r.data.effectiveDir || ''); showToast('设置已保存'); }
      else showToast('保存失败: ' + (r.error || ''));
    } finally { setSaving(false); }
  };

  if (loading) return <div className="settings-loading">加载中...</div>;

  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-label">
            <span className="settings-title">自动下载到本地</span>
            <span className="settings-desc">生成完成后把无水印结果保存到本地，避免链接过期后丢失</span>
          </div>
          <button className={'toggle-switch' + (autoDownload ? ' on' : '')} onClick={() => setAutoDownload(v => !v)} role="switch" aria-checked={autoDownload}>
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">下载目录</span>
          <span className="settings-desc">留空则使用默认目录</span>
        </div>
        <div className="settings-dir-row">
          <input className="settings-dir-input" type="text" value={downloadDir} placeholder={defaultDir || '默认目录'} onChange={(e) => setDownloadDir(e.target.value)} />
          {canPickDir && <button className="settings-btn" onClick={pickDir}>浏览</button>}
        </div>
        <div className="settings-effective">
          当前生效目录：<span>{effectiveDir || defaultDir}</span>
          <button className="settings-link" onClick={openDir}>打开</button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">登录浏览器窗口</span>
          <span className="settings-desc">自动登录 / 抓取登录态时,浏览器窗口的显示方式</span>
        </div>
        <div className="settings-radio-group">
          {BROWSER_WINDOW_MODE_OPTIONS.map(opt => (
            <button
              key={opt.key}
              type="button"
              className={'settings-radio-item' + (browserWindowMode === opt.key ? ' active' : '')}
              onClick={() => setBrowserWindowMode(opt.key)}
              role="radio"
              aria-checked={browserWindowMode === opt.key}
            >
              <span className="settings-radio-dot" />
              <span className="settings-radio-body">
                <span className="settings-radio-title">{opt.title}</span>
                <span className="settings-radio-desc">{opt.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-pane-footer">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? '保存中...' : '保存'}</button>
      </div>
    </div>
  );
}

// ===== 代理设置(Dola 专用)=====
function ProxyPane({ showToast }) {
  const [loading, setLoading] = useState(true);
  const [proxy, setProxy] = useState('');
  const [mode, setMode] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const load = () => {
    setLoading(true);
    api.getProxy(PROXY_SETTINGS.platform).then(r => {
      if (r.success) {
        setProxy(r.data.proxy || '');
        setMode(r.data.mode || 'auto');
      }
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true);
    setStatus('');
    try {
      const nextMode = proxy.trim() ? 'manual' : 'none';
      const r = await api.saveProxy(PROXY_SETTINGS.platform, proxy.trim(), nextMode);
      if (r.success) {
        setMode(r.data.mode || nextMode);
        setProxy(r.data.proxy || '');
        showToast('Dola 代理已保存');
      } else {
        showToast('保存失败: ' + (r.error || ''));
      }
    } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true);
    setStatus('正在测试 Dola 代理...');
    try {
      const r = await api.testProxy(PROXY_SETTINGS.platform, proxy.trim());
      if (r.success) {
        setStatus(r.data?.message || '代理可用');
        showToast('Dola 代理可用');
      } else {
        setStatus(r.error || '代理不可用');
        showToast('代理不可用: ' + (r.error || ''));
      }
    } finally { setBusy(false); }
  };

  const detect = async () => {
    setBusy(true);
    setStatus('正在自动检测本地代理...');
    try {
      const r = await api.detectProxy(PROXY_SETTINGS.platform);
      if (r.success) {
        setProxy(r.data.proxy || '');
        setMode(r.data.mode || 'auto');
        setStatus('已检测并保存: ' + (r.data.proxy || ''));
        showToast('已自动检测并保存 Dola 代理');
      } else {
        setStatus(r.error || '未检测到可用代理');
        showToast(r.error || '未检测到可用代理');
      }
    } finally { setBusy(false); }
  };

  const clear = async () => {
    setBusy(true);
    setStatus('');
    try {
      const r = await api.saveProxy(PROXY_SETTINGS.platform, '', 'none');
      if (r.success) {
        setProxy('');
        setMode('none');
        showToast('已关闭 Dola 代理');
      } else {
        showToast('关闭失败: ' + (r.error || ''));
      }
    } finally { setBusy(false); }
  };

  if (loading) return <div className="settings-loading">加载中...</div>;

  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">平台代理隔离</span>
          <span className="settings-desc">{PROXY_SETTINGS.directPlatformLabel}，不读取也不保存任何代理；只有 Dola 会使用这里的代理。</span>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">Dola 代理</span>
          <span className="settings-desc">支持 HTTP 代理，例如 http://127.0.0.1:7897；留空则 Dola 临时直连。</span>
        </div>
        <input className="settings-dir-input" type="text" value={proxy}
          placeholder="http://127.0.0.1:7897"
          onChange={(e) => setProxy(e.target.value)} />
        <div className="settings-effective">当前模式：{mode === 'auto' ? '自动检测' : mode === 'manual' ? '手动代理' : 'Dola 直连'}</div>
      </div>

      <div className="settings-pane-footer">
        <button className="btn-secondary" onClick={detect} disabled={busy}>{busy ? '处理中...' : '自动检测代理'}</button>
        <button className="btn-secondary" onClick={test} disabled={busy || !proxy.trim()}>测试</button>
        <button className="btn-secondary" onClick={clear} disabled={busy}>关闭 Dola 代理</button>
        <button className="btn-primary" onClick={save} disabled={busy}>保存</button>
      </div>

      {status && <p className="settings-hint">{status}</p>}
    </div>
  );
}

// ===== 自定义图片 API 渠道 =====
function ImageApiPane({ showToast }) {
  const { platform: activePlatform, platforms } = useStore();
  const imagePlatforms = getImageApiPlatforms(platforms);
  const preferredPlatform = getPreferredImageApiPlatform(activePlatform, platforms);
  const [selectedPlatform, setSelectedPlatform] = useState(preferredPlatform);
  const [loading, setLoading] = useState(true);
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [maskedKey, setMaskedKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState('gpt-image-2');
  const [size, setSize] = useState('');
  const [quality, setQuality] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedPlatform && preferredPlatform) setSelectedPlatform(preferredPlatform);
  }, [preferredPlatform, selectedPlatform]);

  useEffect(() => {
    if (!selectedPlatform) return;
    setLoading(true);
    api.getImageApiConfig(selectedPlatform).then(r => {
      if (r.success) {
        const d = r.data || {};
        if (d.platform && d.platform !== selectedPlatform) setSelectedPlatform(d.platform);
        setEndpoint(d.endpoint || '');
        setModel(d.model || 'gpt-image-2');
        setSize(d.size || '');
        setQuality(d.quality || '');
        setHasKey(!!d.hasKey);
        setMaskedKey(d.maskedKey || '');
      }
    }).finally(() => setLoading(false));
  }, [selectedPlatform]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        platform: selectedPlatform,
        endpoint: endpoint.trim(),
        model: model.trim() || 'gpt-image-2',
        size: size.trim(),
        quality: quality.trim()
      };
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      const r = await api.saveImageApiConfig(payload);
      if (r.success) {
        const d = r.data || {};
        setEndpoint(d.endpoint || endpoint.trim());
        setModel(d.model || payload.model);
        setSize(d.size || payload.size);
        setQuality(d.quality || payload.quality);
        setHasKey(!!d.hasKey);
        setMaskedKey(d.maskedKey || (apiKey ? maskField(apiKey) : maskedKey));
        setApiKey('');
        showToast(`${d.label || selectedPlatform} 图片 API 配置已保存`);
      } else {
        showToast('保存失败: ' + (r.error || ''));
      }
    } finally { setSaving(false); }
  };

  if (loading) return <div className="settings-loading">加载中...</div>;

  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">图片 API 渠道</span>
          <span className="settings-desc">plus 是旧接口；4k 使用 https://5988.de5.net/v1，默认 3840x2160 high。</span>
        </div>
        <select className="settings-dir-input" value={selectedPlatform} onChange={(e) => setSelectedPlatform(e.target.value)}>
          {getRenderableImageApiPlatforms(platforms).map(p => (
            <option key={p.key} value={p.key}>{p.label || p.key}</option>
          ))}
        </select>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">自定义图片 API</span>
          <span className="settings-desc">OpenAI-compatible；可填 base_url（如 /v1）或完整 /images/generations endpoint。</span>
        </div>
        <input className="settings-dir-input" type="text" value={endpoint}
          placeholder={selectedPlatform === '4k' ? 'https://5988.de5.net/v1' : 'http://23.148.180.82:3002/v1/images/generations'}
          onChange={(e) => setEndpoint(e.target.value)} />
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">API Key</span>
          <span className="settings-desc">{hasKey ? `已配置(${maskedKey}),留空则不修改` : '尚未配置'}</span>
        </div>
        <input className="settings-dir-input" type="password" value={apiKey}
          placeholder={hasKey ? '••••••(留空保持不变)' : 'sk-...'}
          onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">模型</span>
          <span className="settings-desc">界面可填 gpt-image2；保存后会自动使用服务实际模型名 gpt-image-2。</span>
        </div>
        <input className="settings-dir-input" type="text" value={model}
          placeholder="gpt-image-2"
          onChange={(e) => setModel(e.target.value)} />
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">尺寸 size</span>
          <span className="settings-desc">留空则按比例自动映射；4k 渠道默认 3840x2160。</span>
        </div>
        <input className="settings-dir-input" type="text" value={size}
          placeholder={selectedPlatform === '4k' ? '3840x2160' : '留空自动'}
          onChange={(e) => setSize(e.target.value)} />
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">质量 quality</span>
          <span className="settings-desc">例如 high；留空则不发送 quality 字段。</span>
        </div>
        <input className="settings-dir-input" type="text" value={quality}
          placeholder={selectedPlatform === '4k' ? 'high' : '留空'}
          onChange={(e) => setQuality(e.target.value)} />
      </div>

      <div className="settings-pane-footer">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? '保存中...' : '保存'}</button>
      </div>
      <p className="settings-hint">说明：该平台无需添加账号，只支持图片生成；接口返回 b64_json 时会自动保存成本地图片。</p>
    </div>
  );
}

// ===== 授权(卡密)=====
function LicensePane({ showToast }) {
  const { license, refreshLicense, verifyLicenseNow } = useStore();
  const [verifying, setVerifying] = useState(false);

  useEffect(() => { refreshLicense(); }, [refreshLicense]);

  const doVerify = async () => {
    setVerifying(true);
    try {
      const r = await verifyLicenseNow();
      if (r.success) showToast(r.offline ? '当前离线，使用宽限期通过' : '验证成功');
      else showToast(r.message || '验证失败');
    } finally { setVerifying(false); }
  };

  const d = license;
  if (!d) return <div className="settings-loading">加载中...</div>;

  const statusText = !d.verified ? '未授权'
    : d.offline ? `离线宽限中（剩 ${d.graceRemainingHours ?? 0} 小时）`
    : '已验证（在线）';
  const statusCls = !d.verified ? 'bad' : d.offline ? 'warn' : 'ok';
  const remainText = d.isPermanent ? '永久有效'
    : (d.daysRemaining != null ? `剩余 ${d.daysRemaining} 天` : '—');

  return (
    <div className="settings-pane-inner">
      <div className={'license-status-card ' + statusCls}>
        <div className="lsc-head">
          <span className="lsc-type">{TYPE_LABEL[d.type] || d.type || '未知'}</span>
          <span className={'lsc-badge ' + statusCls}>{statusText}</span>
        </div>
        <div className="lsc-remain">{remainText}</div>
        <div className="lsc-grid">
          <div><label>卡号</label><span>{maskKey(d.key)}</span></div>
          <div><label>激活时间</label><span>{fmtTime(d.activatedAt)}</span></div>
          <div><label>到期时间</label><span>{d.isPermanent ? '永久' : fmtTime(d.expiresAt)}</span></div>
          <div><label>最近验证</label><span>{fmtTime(d.lastVerified)}</span></div>
        </div>
      </div>
      <div className="settings-pane-footer">
        <button className="btn-secondary" onClick={doVerify} disabled={verifying}>{verifying ? '验证中...' : '立即重新验证'}</button>
      </div>
      <p className="settings-hint">提示：短暂断网不会影响使用，软件会在联网后自动校验；离线超过宽限期才需要重新联网验证。</p>
    </div>
  );
}

// ===== 对外 API 接口 =====
function ApiAccessPane({ showToast }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    api.getApiAccess().then(r => { if (r.success) setData(r.data); }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const toggle = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await api.saveApiAccess({ enabled: !data.enabled });
      if (r.success) { setData(d => ({ ...d, enabled: r.data.enabled })); showToast(r.data.enabled ? '对外 API 已开启' : '对外 API 已关闭'); }
    } finally { setBusy(false); }
  };
  const regen = async () => {
    setBusy(true);
    try {
      const r = await api.regenApiToken();
      if (r.success) { setData(d => ({ ...d, token: r.data.token, createdAt: r.data.createdAt })); showToast('已重新生成 Token'); }
    } finally { setBusy(false); }
  };
  const copy = (text) => {
    try { navigator.clipboard.writeText(text); showToast('已复制'); } catch (e) { showToast('复制失败'); }
  };

  if (loading || !data) return <div className="settings-loading">加载中...</div>;

  const curlExample = `curl -X POST "${data.baseUrl}/v1/images" \\
  -H "Authorization: Bearer ${data.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"一只赛博朋克猫","platform":"doubao"}'`;

  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-label">
            <span className="settings-title">开放对外 API</span>
            <span className="settings-desc">开启后，外部 AI IDE / agent 可凭 Token 调用本软件的生成能力</span>
          </div>
          <button className={'toggle-switch' + (data.enabled ? ' on' : '')} onClick={toggle} disabled={busy} role="switch" aria-checked={data.enabled}>
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label"><span className="settings-title">访问地址</span></div>
        <div className="api-token-row">
          <input className="settings-dir-input" type="text" readOnly value={data.baseUrl} />
          <button className="settings-btn" onClick={() => copy(data.baseUrl)}>复制</button>
        </div>
        {data.lanHints?.length > 0 && (
          <div className="settings-effective">局域网：{data.lanHints.join('  ')}</div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">API Token</span>
          <span className="settings-desc">放在请求头 Authorization: Bearer &lt;token&gt;。请妥善保管，泄露后可重新生成。</span>
        </div>
        <div className="api-token-row">
          <input className="settings-dir-input api-token-input" type="text" readOnly value={data.token} />
          <button className="settings-btn" onClick={() => copy(data.token)}>复制</button>
          <button className="settings-btn" onClick={regen} disabled={busy}>重新生成</button>
        </div>
        <div className="settings-effective">最近使用：{fmtTime(data.lastUsedAt)}</div>
      </div>

      <div className="settings-section">
        <div className="settings-label"><span className="settings-title">调用示例</span></div>
        <pre className="api-curl"><code>{curlExample}</code></pre>
        <button className="settings-link" onClick={() => copy(curlExample)}>复制示例</button>
        <div className="api-endpoints">
          <div className="settings-title" style={{ marginTop: 8 }}>可用端点</div>
          <ul>
            <li><code>GET /v1/status</code> 平台/账号/额度</li>
            <li><code>POST /v1/images</code> 文生图 → 返回 jobId</li>
            <li><code>POST /v1/videos</code> 文生视频 → 返回 jobId</li>
            <li><code>POST /v1/image-to-video</code> 图生视频</li>
            <li><code>GET /v1/jobs/:id</code> 查询任务结果</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ===== 内置浏览器(豆包对话 webview 账号绑定)=====
function BrowserBindingPane({ showToast }) {
  const { reloadWebviews } = useStore();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    api.getWebviewBinding().then(r => { if (r.success) setData(r.data); }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const bind = async (accountId) => {
    setBusy(true);
    try {
      const r = await api.setWebviewBinding(accountId);
      if (r.success) {
        setData(d => ({ ...d, boundAccountId: r.data.boundAccountId }));
        reloadWebviews(); // 让已打开的「豆包对话」重载,使新登录态生效
        showToast(accountId ? '已绑定,内置「豆包对话」将自动登录' : '已解绑');
      } else {
        showToast('操作失败: ' + (r.error || ''));
      }
    } finally { setBusy(false); }
  };

  if (loading || !data) return <div className="settings-loading">加载中...</div>;

  if (!data.supported) {
    return (
      <div className="settings-pane-inner">
        <p className="settings-hint">内置浏览器免登录仅在桌面应用(exe)中可用,浏览器预览模式不支持。</p>
      </div>
    );
  }

  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">绑定豆包账号到内置「豆包对话」</span>
          <span className="settings-desc">绑定后,左栏内置浏览器打开「豆包对话」会自动带上该账号的登录态,无需重复登录。</span>
        </div>
      </div>

      <div className="settings-section">
        {data.accounts.length === 0 ? (
          <p className="settings-hint">暂无已登录的豆包账号。请先在账号管理里添加并登录一个豆包账号。</p>
        ) : (
          <div className="bind-account-list">
            <label className={'bind-account-item' + (!data.boundAccountId ? ' active' : '')}>
              <input type="radio" name="bind-acc" checked={!data.boundAccountId} disabled={busy}
                onChange={() => bind('')} />
              <span className="bind-acc-name">不绑定(独立登录)</span>
            </label>
            {data.accounts.map(a => (
              <label key={a.id} className={'bind-account-item' + (data.boundAccountId === a.id ? ' active' : '')}>
                <input type="radio" name="bind-acc" checked={data.boundAccountId === a.id} disabled={busy}
                  onChange={() => bind(a.id)} />
                <span className="bind-acc-name">{a.name}</span>
                {data.boundAccountId === a.id && <span className="bind-acc-badge">已绑定</span>}
              </label>
            ))}
          </div>
        )}
      </div>

      <p className="settings-hint">提示:切换绑定会清空内置浏览器原有登录态并写入所选账号的;若账号登录态过期,请重新登录该账号后再次绑定。</p>
    </div>
  );
}

// ===== MCP 接入(供 Claude / Codex 等 AI IDE 一键接入)=====
function McpPane({ showToast }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fmt, setFmt] = useState('claude'); // claude | codex

  const load = () => {
    setLoading(true);
    api.getMcpConfig().then(r => { if (r.success) setData(r.data); }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // MCP 与对外 API 共用同一个开关(MCP 垫片本质是转发到 /ext)
  const toggle = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await api.saveApiAccess({ enabled: !data.enabled });
      if (r.success) {
        setData(d => ({ ...d, enabled: r.data.enabled }));
        showToast(r.data.enabled ? 'MCP 已开启' : 'MCP 已关闭');
      }
    } finally { setBusy(false); }
  };
  const copy = (text) => {
    try { navigator.clipboard.writeText(text); showToast('已复制'); } catch (e) { showToast('复制失败'); }
  };

  if (loading || !data) return <div className="settings-loading">加载中...</div>;

  const snippet = fmt === 'codex' ? data.snippets.codex : data.snippets.claude;
  const snippetHint = fmt === 'codex'
    ? '粘贴到 ~/.codex/config.toml'
    : '粘贴到 Claude 配置的 mcpServers 节点(如 claude_desktop_config.json 或项目 .mcp.json)';

  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-label">
            <span className="settings-title">开启 MCP 接入</span>
            <span className="settings-desc">开启后,Claude / Codex 等支持 MCP 的 AI IDE 可直接调用本软件的生成与对话能力。与对外 API 共用同一开关和 Token。</span>
          </div>
          <button className={'toggle-switch' + (data.enabled ? ' on' : '')} onClick={toggle} disabled={busy} role="switch" aria-checked={data.enabled}>
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

      {!data.serverExists && (
        <p className="settings-hint" style={{ color: '#f59e0b' }}>
          注意:未找到 MCP 垫片文件({data.serverPath})。开发环境下正常,打包后会随程序释放。
        </p>
      )}

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">配置片段</span>
          <span className="settings-desc">{snippetHint}</span>
        </div>
        <div className="mcp-fmt-switch">
          <button className={'settings-btn' + (fmt === 'claude' ? ' active' : '')} onClick={() => setFmt('claude')}>Claude (JSON)</button>
          <button className={'settings-btn' + (fmt === 'codex' ? ' active' : '')} onClick={() => setFmt('codex')}>Codex (TOML)</button>
        </div>
        <pre className="api-curl"><code>{snippet}</code></pre>
        <button className="settings-link" onClick={() => copy(snippet)}>复制配置</button>
      </div>

      <div className="settings-section">
        <div className="settings-label"><span className="settings-title">可用工具</span></div>
        <div className="api-endpoints">
          <ul>
            <li><code>generate_image</code> 文生图</li>
            <li><code>generate_video</code> 文生视频</li>
            <li><code>chat_doubao</code> 豆包多轮对话(带 chatId 续聊)</li>
            <li><code>get_status</code> 查询状态/额度</li>
            <li><code>list_accounts</code> 列出账号</li>
            <li><code>list_jobs</code> 列出任务</li>
          </ul>
        </div>
      </div>

      <p className="settings-hint">
        提示:配置后重启对应的 AI IDE 即可看到 lulu 工具。使用期间请保持 lulu 运行且本开关开启,否则 IDE 侧会连接失败。
      </p>
    </div>
  );
}

// ===== 外观(背景 + 字体色调 + 玻璃材质切换)=====
function AppearancePane() {
  const { background, setBackground, textTone, setTextTone, glassMode, setGlassMode } = useStore();
  const OPTIONS = [
    { key: 'tiles', title: '方格瓷砖', desc: '浅色留白 + 四角彩色光晕,呼吸流动的方格背景(默认)' },
    { key: 'dots', title: '交互式点阵', desc: '暗色点阵,鼠标经过时点阵凸起并伴随柔光' },
  ];
  const TONES = [
    { key: 'dark', title: '黑色字体', desc: '深色文字,适合浅色背景(方格瓷砖)' },
    { key: 'light', title: '白色字体', desc: '浅色文字,适合暗色背景(交互式点阵)' },
  ];
  const GLASS = [
    { key: 'liquid', title: '液态玻璃', desc: '边缘色散折射,苹果 Liquid Glass 质感(默认)' },
    { key: 'frosted', title: '雾蒙玻璃', desc: '磨砂高斯模糊,朦胧通透,更省性能' },
    { key: 'none', title: '全普通(无玻璃)', desc: '关闭一切模糊与折射,纯不透明面板,最省性能' },
  ];
  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">背景样式</span>
          <span className="settings-desc">切换主界面背景,选择后立即生效并记忆</span>
        </div>
        <div className="bg-option-list">
          {OPTIONS.map(o => (
            <button
              key={o.key}
              className={'bg-option' + (background === o.key ? ' active' : '')}
              onClick={() => setBackground(o.key)}
            >
              <span className={'bg-option-preview bg-preview-' + o.key} />
              <span className="bg-option-text">
                <span className="bg-option-title">{o.title}</span>
                <span className="bg-option-desc">{o.desc}</span>
              </span>
              {background === o.key && <span className="bg-option-check">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">字体颜色</span>
          <span className="settings-desc">一键切换全局文字黑 / 白,配合背景选择更清晰</span>
        </div>
        <div className="bg-option-list">
          {TONES.map(t => (
            <button
              key={t.key}
              className={'bg-option' + (textTone === t.key ? ' active' : '')}
              onClick={() => setTextTone(t.key)}
            >
              <span className={'bg-option-preview tone-preview-' + t.key} />
              <span className="bg-option-text">
                <span className="bg-option-title">{t.title}</span>
                <span className="bg-option-desc">{t.desc}</span>
              </span>
              {textTone === t.key && <span className="bg-option-check">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">玻璃材质</span>
          <span className="settings-desc">对话栏 / 顶部栏 / 侧边栏等所有玻璃面板一键切换,立即生效</span>
        </div>
        <div className="bg-option-list">
          {GLASS.map(g => (
            <button
              key={g.key}
              className={'bg-option' + (glassMode === g.key ? ' active' : '')}
              onClick={() => setGlassMode(g.key)}
            >
              <span className={'bg-option-preview glass-preview-' + g.key} />
              <span className="bg-option-text">
                <span className="bg-option-title">{g.title}</span>
                <span className="bg-option-desc">{g.desc}</span>
              </span>
              {glassMode === g.key && <span className="bg-option-check">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ===== Claude 对话配置(Base URL + API Key + 拉取/选择模型)=====
function ClaudePane({ showToast }) {
  const { loadClaudeConfig } = useStore();
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState('https://api.anthropic.com');
  const [apiKey, setApiKey] = useState('');       // 空=不改;有值=新 key
  const [maskedKey, setMaskedKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [maxTokens, setMaxTokens] = useState(4096);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getClaudeConfig().then(r => {
      if (r.success) {
        const d = r.data;
        setBaseUrl(d.baseUrl || 'https://api.anthropic.com');
        setMaskedKey(d.maskedKey || '');
        setHasKey(!!d.hasKey);
        setModels(d.models || []);
        setModel(d.model || '');
        setMaxTokens(d.maxTokens || 4096);
        setSystemPrompt(d.systemPrompt || '');
      }
    }).finally(() => setLoading(false));
  }, []);

  // 拉取模型:带上当前输入的 baseUrl/apiKey(未改则传空,后端用已存的)
  const doFetchModels = async () => {
    setFetching(true);
    try {
      const r = await api.fetchClaudeModels({ baseUrl, apiKey });
      if (r.success) {
        const list = r.data.models || [];
        setModels(list);
        setHasKey(true);
        if (apiKey) { setMaskedKey(maskField(apiKey)); }
        if (r.data.model) setModel(r.data.model);
        else if (list[0] && !model) setModel(list[0].id);
        showToast(`已获取 ${list.length} 个模型(${r.data.apiStyle === 'openai' ? 'OpenAI 兼容' : 'Anthropic'} 协议)`);
      } else {
        showToast(r.message || r.error || '获取模型失败');
      }
    } catch (e) {
      showToast('获取模型失败: ' + e.message);
    } finally { setFetching(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = { baseUrl, model, maxTokens, systemPrompt };
      if (apiKey) payload.apiKey = apiKey; // 仅在填了新 key 时提交
      const r = await api.saveClaudeConfig(payload);
      if (r.success) {
        showToast('Claude 配置已保存');
        setApiKey('');
        loadClaudeConfig(); // 同步全局(对话视图的 configured 状态)
      } else {
        showToast('保存失败: ' + (r.error || ''));
      }
    } finally { setSaving(false); }
  };

  if (loading) return <div className="settings-loading">加载中...</div>;

  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">Base URL</span>
          <span className="settings-desc">Claude 官方为 https://api.anthropic.com;使用中转站请填其地址(支持 OpenAI 兼容格式)</span>
        </div>
        <input className="settings-dir-input" type="text" value={baseUrl}
          placeholder="https://api.anthropic.com"
          onChange={(e) => setBaseUrl(e.target.value)} />
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">API Key</span>
          <span className="settings-desc">{hasKey ? `已配置(${maskedKey}),留空则不修改` : '尚未配置'}</span>
        </div>
        <input className="settings-dir-input" type="password" value={apiKey}
          placeholder={hasKey ? '••••••(留空保持不变)' : 'sk-...'}
          onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">模型</span>
          <span className="settings-desc">先点「获取模型」拉取列表,再选择要使用的模型</span>
        </div>
        <div className="settings-dir-row">
          <ClaudeModelSelect models={models} value={model} onChange={setModel} />
          <button className="settings-btn" onClick={doFetchModels} disabled={fetching}>
            {fetching ? '获取中...' : '获取模型'}
          </button>
        </div>
        {models.length === 0 && <div className="settings-effective">尚未获取到模型</div>}
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">最大输出 Tokens</span>
          <span className="settings-desc">单次回复的最大长度上限</span>
        </div>
        <input className="settings-dir-input" type="number" value={maxTokens} min={256} max={200000}
          onChange={(e) => setMaxTokens(parseInt(e.target.value) || 4096)} />
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <span className="settings-title">系统提示词(可选)</span>
          <span className="settings-desc">设定 Claude 的角色 / 风格,对所有对话生效</span>
        </div>
        <textarea className="settings-dir-input settings-textarea" rows={3} value={systemPrompt}
          placeholder="例如:你是一个专业的中文写作助手..."
          onChange={(e) => setSystemPrompt(e.target.value)} />
      </div>

      <div className="settings-pane-footer">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? '保存中...' : '保存'}</button>
      </div>
    </div>
  );
}

// key 脱敏(前端拉取后本地显示用,与后端 maskKey 规则一致)
function maskField(k) {
  if (!k) return '';
  if (k.length <= 10) return k.slice(0, 2) + '****';
  return k.slice(0, 6) + '****' + k.slice(-4);
}

// Claude 模型下拉(自绘,适配暗色主题,与 InputPod 的 PodSelect 同风格)
function ClaudeModelSelect({ models, value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const cur = models.find(m => m.id === value);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className={'claude-model-select' + (open ? ' open' : '')} ref={rootRef}>
      <button type="button" className="claude-model-btn" onClick={() => setOpen(o => !o)} disabled={models.length === 0}>
        <span className="claude-model-val">{cur ? (cur.label || cur.id) : (models.length ? '选择模型' : '请先获取模型')}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && models.length > 0 && (
        <div className="claude-model-menu">
          {models.map(m => (
            <button key={m.id} type="button"
              className={'claude-model-opt' + (m.id === value ? ' active' : '')}
              onClick={() => { onChange(m.id); setOpen(false); }}>
              {m.label || m.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== 关于 =====
function AboutPane() {
  return (
    <div className="settings-pane-inner">
      <div className="settings-section">
        <div className="settings-label"><span className="settings-title">lulu 创作管理工作台</span><span className="settings-desc">版本 {__APP_VERSION__}</span></div>
      </div>
      <p className="settings-hint">多平台 AI 图片 / 视频生成管理工具。支持账号管理、会话历史、无水印下载、内置浏览器与对外 API。</p>
    </div>
  );
}

const TABS = SETTINGS_TABS;

export default function SettingsModal() {
  const { settingsOpen, setSettingsOpen, settingsTab, setSettingsTab, showToast } = useStore();
  if (!settingsOpen) return null;
  const close = () => setSettingsOpen(false);
  const tab = settingsTab || 'download';

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <LiquidGlass radius={24} blur={26} strength={36} tint="rgba(248,246,252,0.97)" className="modal-panel settings-modal settings-modal-tabs">
        <div className="modal-header">
          <h3>设置</h3>
          <div className="modal-header-actions">
            <button className="btn-modal-close" onClick={close}>&times;</button>
          </div>
        </div>

        <div className="settings-tabbed">
          <div className="settings-nav">
            {TABS.map(t => (
              <button key={t.key} className={'settings-nav-item' + (tab === t.key ? ' active' : '')} onClick={() => setSettingsTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="settings-pane">
            {tab === 'download' && <DownloadPane showToast={showToast} />}
            {tab === 'proxy' && <ProxyPane showToast={showToast} />}
            {tab === 'imageApi' && <ImageApiPane showToast={showToast} />}
            {tab === 'appearance' && <AppearancePane />}
            {tab === 'claude' && <ClaudePane showToast={showToast} />}
            {tab === 'browser' && <BrowserBindingPane showToast={showToast} />}
            {tab === 'license' && <LicensePane showToast={showToast} />}
            {tab === 'api' && <ApiAccessPane showToast={showToast} />}
            {tab === 'mcp' && <McpPane showToast={showToast} />}
            {tab === 'about' && <AboutPane />}
          </div>
        </div>
      </LiquidGlass>
    </div>
  );
}
