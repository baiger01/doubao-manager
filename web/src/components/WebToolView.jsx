import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { getWebTool } from '../lib/webTools.jsx';
import LiquidGlass from './LiquidGlass.jsx';

// 仅 Electron 内置 <webview> 能加载第三方站点(普通 iframe 会被 X-Frame-Options 拒绝)
const isElectron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);

// 通用内置小浏览器:加载指定网页工具,带后退/前进/刷新/主页/地址栏
export default function WebToolView({ toolKey }) {
  const { setView, splitView, setSplitView, webviewReloadNonce } = useStore();
  const tool = getWebTool(toolKey);
  const homeUrl = tool?.url || 'about:blank';
  const webviewRef = useRef(null);
  const [url, setUrl] = useState(homeUrl);
  const [loading, setLoading] = useState(true);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  // 绑定/解绑豆包账号后,store 自增 webviewReloadNonce;此处仅对支持绑定的工具(豆包对话)重载页面,
  // 让新注入的登录态生效。首次挂载(nonce=0)不触发。
  const firstNonce = useRef(webviewReloadNonce);
  useEffect(() => {
    if (webviewReloadNonce === firstNonce.current) return;
    if (!tool?.bindable) return;
    try { webviewRef.current?.loadURL(homeUrl); } catch {}
  }, [webviewReloadNonce, tool, homeUrl]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !isElectron) return;

    const syncNav = () => {
      try {
        setCanBack(wv.canGoBack());
        setCanForward(wv.canGoForward());
        setUrl(wv.getURL() || homeUrl);
      } catch {}
    };
    const onStart = () => setLoading(true);
    const onStop = () => { setLoading(false); syncNav(); };
    const onNavigate = () => syncNav();

    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    return () => {
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
    };
  }, [homeUrl]);

  const goBack = () => { try { webviewRef.current?.goBack(); } catch {} };
  const goForward = () => { try { webviewRef.current?.goForward(); } catch {} };
  const reload = () => { try { webviewRef.current?.reload(); } catch {} };
  const goHome = () => { try { webviewRef.current?.loadURL(homeUrl); } catch {} };
  const openExternal = () => {
    if (isElectron) { try { webviewRef.current?.loadURL(homeUrl); } catch {} }
    else { window.open(homeUrl, '_blank', 'noopener'); }
  };

  if (!tool) return null;

  return (
    <div className="webtool-view">
      <LiquidGlass radius={14} blur={20} strength={32} tint="rgba(255,255,255,0.07)" className="webtool-bar">
        <div className="webtool-nav">
          <button className="webtool-nav-btn" onClick={goBack} disabled={!canBack} title="后退">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button className="webtool-nav-btn" onClick={goForward} disabled={!canForward} title="前进">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
          <button className="webtool-nav-btn" onClick={reload} title="刷新">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          </button>
          <button className="webtool-nav-btn" onClick={goHome} title="主页">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></svg>
          </button>
        </div>

        <div className="webtool-title">{tool.icon()}<span>{tool.label}</span></div>

        <div className={'webtool-url' + (loading ? ' loading' : '')}>
          <span className="webtool-lock">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          </span>
          <span className="webtool-url-text">{url}</span>
          {loading && <span className="webtool-spinner" />}
        </div>

        <div className="webtool-actions">
          <button className={'webtool-nav-btn' + (splitView ? ' active' : '')} onClick={() => setSplitView(v => !v)} title={splitView ? '退出分屏' : '分屏(并排显示生成台)'}>
            {splitView ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>
            )}
          </button>
          <button className="webtool-nav-btn" onClick={openExternal} title={isElectron ? '回到主页' : '用系统浏览器打开'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" /></svg>
          </button>
          <button className="webtool-nav-btn webtool-close" onClick={() => setView('studio')} title="关闭,返回生成台">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </LiquidGlass>

      <div className="webtool-frame">
        {isElectron ? (
          <webview
            ref={webviewRef}
            src={homeUrl}
            partition={tool.partition}
            allowpopups="true"
            style={{ width: '100%', height: '100%', border: 'none', display: 'flex' }}
          />
        ) : (
          <div className="webtool-fallback">
            <span className="webtool-fallback-icon">{tool.icon()}</span>
            <div className="webtool-fallback-title">{tool.label} 需要在桌面应用中打开</div>
            <div className="webtool-fallback-desc">浏览器预览模式下无法内嵌第三方页面(受 X-Frame-Options 限制)。<br />打包成 exe 后即可在内置浏览器中直接使用 {tool.label}。</div>
            <button className="webtool-fallback-btn" onClick={openExternal}>用系统浏览器打开 {tool.label}</button>
          </div>
        )}
      </div>
    </div>
  );
}
