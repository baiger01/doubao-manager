import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import LiquidGlass from './LiquidGlass.jsx';

export default function LicenseGate() {
  const { licenseGate, activateLicense } = useStore();
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (!licenseGate) return null;

  const doActivate = async () => {
    const k = key.trim();
    if (!k) { setErr('请输入卡密'); return; }
    setBusy(true); setErr('');
    try {
      const res = await activateLicense(k);
      if (!res.success) setErr(res.message || '激活失败');
    } catch (e) {
      setErr('网络错误,请检查网络连接');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="license-gate">
      <LiquidGlass radius={28} blur={30} strength={40} tint="rgba(255,255,255,0.08)" className="license-card">
        <div className="license-title">软件授权验证</div>
        <p className="license-desc">请输入卡密激活后使用</p>
        <input className="license-input" type="text" placeholder="请输入卡密 (XXXX-XXXX-XXXX)"
          autoComplete="off" value={key} autoFocus
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doActivate(); }} />
        <div className="license-error">{err}</div>
        <button className="license-btn" disabled={busy} onClick={doActivate}>{busy ? '验证中...' : '激活'}</button>
        <div className="license-footer">一卡一机绑定,激活后不可换机</div>
      </LiquidGlass>
    </div>
  );
}
