import React from 'react';
import { useStore } from '../store.jsx';
import LiquidGlass from './LiquidGlass.jsx';

// 画布顶部悬浮玻璃药丸:平台切换 + 模式 + 额度 + 账号
export default function TopBar({ onOpenAccounts }) {
  const { platform, platforms, switchPlatform, mode, activeAccount, license, openSettings } = useStore();
  const activeIndex = Math.max(0, platforms.findIndex(p => p.key === platform));
  const activePlatform = platforms.find(p => p.key === platform) || {};
  const requiresAccount = activePlatform.requiresAccount !== false;
  const usesLocalVideoAuth = !requiresAccount && (activePlatform.key === 'orion' || activePlatform.hasVideoApi);
  const usesImageApiMode = !requiresAccount && !usesLocalVideoAuth;
  const accountBadgeTitle = requiresAccount ? '账号管理' : (usesLocalVideoAuth ? 'Orion 本地授权' : 'API 模式');
  const accountBadgeClick = requiresAccount ? onOpenAccounts : (usesLocalVideoAuth ? onOpenAccounts : () => openSettings('imageApi'));

  // 卡密胶囊:电量电池样式(一格一格),不显示具体时长,详情走点击/悬停
  let chip = null;
  if (license && license.hasLicense) {
    let cls = 'ok', level = 4, title = '已授权';
    if (!license.verified) {
      cls = 'bad'; level = 0; title = '未授权,点击激活';
    } else if (license.isPermanent) {
      cls = 'ok'; level = 4; title = '永久授权';
    } else if (license.daysRemaining != null) {
      const d = license.daysRemaining;
      level = d > 30 ? 4 : d > 14 ? 3 : d > 7 ? 2 : 1;
      cls = d <= 3 ? 'bad' : d <= 7 ? 'warn' : 'ok';
      title = '授权剩余约 ' + d + ' 天';
    }
    // 离线宽限期内:整体降级为黄色提示(电量格数保持)
    if (license.offline && license.verified) {
      cls = 'warn';
      title += '(离线宽限中)';
    }
    chip = (
      <button className={'license-chip ' + cls} title={title + ' · 点击查看详情'} onClick={() => openSettings('license')}>
        <span className="license-bat">
          <span className="license-bat-body">
            {[0, 1, 2, 3].map(i => (
              <span key={i} className={'license-bat-seg' + (i < level ? ' on' : '')} />
            ))}
          </span>
          <span className="license-bat-cap" />
        </span>
      </button>
    );
  }

  return (
    <LiquidGlass radius={18} blur={16} strength={32} tint="rgba(255,255,255,0.07)" className="top-pill">
      <div className="seg-switch" style={{ '--seg-count': platforms.length || 1, '--seg-active': activeIndex }}>
        <span className={'seg-thumb' + (platform === 'dola' ? ' dola' : '')} />
        {platforms.map(p => (
          <button key={p.key}
            className={'seg-option' + (p.key === platform ? ' active' : '')}
            onClick={() => switchPlatform(p.key)}
            title={'切换到 ' + p.label}>
            {p.label}
          </button>
        ))}
      </div>
      <span className="mode-label">{mode === 'image' ? '图片生成' : '视频生成'}</span>
      <div className="top-spacer" />
      {chip}
      <button className="account-badge" title={accountBadgeTitle} onClick={accountBadgeClick}>
        <span className="account-avatar">{requiresAccount ? (activeAccount ? String(activeAccount.seq || '?') : '?') : 'API'}</span>
        <span className="account-name">{requiresAccount ? (activeAccount ? activeAccount.displayName : '未配置账号') : (usesLocalVideoAuth ? '本地授权' : (usesImageApiMode ? 'API 模式' : '无需账号'))}</span>
      </button>
    </LiquidGlass>
  );
}

