import React, { useState, useEffect, useRef } from 'react';
import { StoreProvider, useStore } from './store.jsx';
import NavRail from './components/NavRail.jsx';
import Canvas from './components/Canvas.jsx';
import TopBar from './components/TopBar.jsx';
import InputPod from './components/InputPod.jsx';
import AccountsModal from './components/AccountsModal.jsx';
import Lightbox from './components/Lightbox.jsx';
import ImageContextMenu from './components/ImageContextMenu.jsx';
import AskDialog from './components/AskDialog.jsx';
import LicenseGate from './components/LicenseGate.jsx';
import TileGrid from './components/TileGrid.jsx';
import DotField from './components/DotField.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import WebToolView from './components/WebToolView.jsx';
import ClaudeChat from './components/ClaudeChat.jsx';
import LogPanel from './components/LogPanel.jsx';

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

// 圆角方格瓷砖背景组件见 ./components/TileGrid.jsx

function Shell() {
  const [accountsOpen, setAccountsOpen] = useState(false);
  const { view, splitView, splitRatio, setSplitRatio, background, textTone } = useStore();
  // 记录已打开过的网页工具:一旦打开就常驻挂载,切换只显隐,绝不卸载 webview,
  // 这样页面滚动位置、表单输入、登录态都完整保留。
  const [openedTools, setOpenedTools] = useState([]);
  const stageRef = useRef(null);
  const studioRef = useRef(null);
  const bottomRef = useRef(null);
  const draggingRef = useRef(false);
  const dragRatioRef = useRef(splitRatio);

  // 动态对齐:实时测量底部输入舱高度,写入 --pod-h,供 .canvas 底部留白用 calc 计算,
  // 这样无论输入舱展开多高,滚到底时最后一排结果都不会被浮动输入舱遮挡。
  useEffect(() => {
    const el = bottomRef.current;
    const target = studioRef.current;
    if (!el || !target || typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      target.style.setProperty('--pod-h', `${Math.ceil(el.offsetHeight)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // claude/logs 视图不是 webview,不纳入 openedTools 常驻挂载
    if (view !== 'studio' && view !== 'claude' && view !== 'logs' && !openedTools.includes(view)) {
      setOpenedTools(prev => [...prev, view]);
    }
  }, [view, openedTools]);

  // 分屏:仅当打开了网页工具(view 为 webview 类)且开启分屏时生效;claude/logs 视图不参与分屏
  const splitActive = splitView && view !== 'studio' && view !== 'claude' && view !== 'logs';

  // 拖拽分隔条调整比例(生成台占比)。拖拽过程中直接改 DOM width,绕过 React 全树重渲染
  // 与 localStorage 写盘;仅松手时 commit 一次 state 持久化,避免每帧卡顿。
  useEffect(() => {
    if (!splitActive) return;
    const onMove = (e) => {
      if (!draggingRef.current || !stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      // 工作台在右栏:鼠标越靠左,工作台占比越大
      let r = (rect.right - e.clientX) / rect.width;
      r = Math.min(0.8, Math.max(0.2, r));
      dragRatioRef.current = r;
      if (studioRef.current) studioRef.current.style.width = `${r * 100}%`;
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove('col-resizing');
      // 松手时一次性 commit:同步 React state + 持久化
      setSplitRatio(dragRatioRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [splitActive, setSplitRatio]);

  const startDrag = () => {
    dragRatioRef.current = splitRatio;
    draggingRef.current = true;
    document.body.classList.add('col-resizing');
  };

  // studio 面板:分屏时作为右栏(定宽 + order:3),否则全屏(非当前视图隐藏)
  const studioStyle = splitActive
    ? { position: 'relative', width: `${splitRatio * 100}%`, flex: 'none', order: 3 }
    : (view === 'studio' ? undefined : { display: 'none' });

  return (
    <div className={'app-shell tone-' + (textTone || 'dark')}>
      {/* 背景:方格瓷砖(默认) 或 交互式点阵,由设置切换 */}
      {background === 'dots' ? (
        <div className="bg-dotfield">
          <DotField
            gradientFrom="rgba(168, 85, 247, 0.55)"
            gradientTo="rgba(129, 140, 248, 0.38)"
            glowColor="rgba(139, 92, 246, 0.30)"
          />
        </div>
      ) : (
        <TileGrid />
      )}
      <div className="bg-orbs">
        <span className="orb orb-1" />
        <span className="orb orb-2" />
        <span className="orb orb-3" />
      </div>

      <NavRail
        onOpenAccounts={() => setAccountsOpen(true)}
        accountsOpen={accountsOpen}
      />

      <main className={'stage' + (splitActive ? ' stage-split' : '')} ref={stageRef}>
        {/* 生成台:始终挂载,仅在非 studio 视图隐藏(保留滚动/结果状态);分屏时作为左栏 */}
        <div className="stage-studio" style={studioStyle} ref={studioRef}>
          <div className="stage-top">
            <TopBar onOpenAccounts={() => setAccountsOpen(true)} />
          </div>

          <Canvas />

          <div className="stage-bottom" ref={bottomRef}>
            <InputPod />
          </div>
        </div>

        {/* 分屏拖拽分隔条 */}
        {splitActive && (
          <div className="split-divider" style={{ order: 2 }} onMouseDown={startDrag} title="拖拽调整比例">
            <span className="split-divider-grip" />
          </div>
        )}

        {/* 内置网页工具(Gemini/ChatGPT/豆包对话):打开后常驻挂载,切换仅显隐,保留登录态与页面状态;分屏时作为左栏 */}
        {openedTools.map(k => {
          const visible = view === k;
          const hostStyle = splitActive && visible
            ? { position: 'relative', flex: 1, minWidth: 0, order: 1 }
            : (visible ? undefined : { display: 'none' });
          return (
            <div key={k} className="webtool-host" style={hostStyle}>
              <WebToolView toolKey={k} />
            </div>
          );
        })}

        {/* Claude 文本对话:API 接入的独立对话视图(非 webview),仅当前视图时渲染 */}
        {view === 'claude' && (
          <div className="webtool-host">
            <ClaudeChat />
          </div>
        )}

        {view === 'logs' && (
          <div className="webtool-host">
            <LogPanel />
          </div>
        )}
      </main>

      <AccountsModal open={accountsOpen} onClose={() => setAccountsOpen(false)} />

      <Lightbox />
      <ImageContextMenu />
      <AskDialog />
      <LicenseGate />
      <SettingsModal />
    </div>
  );
}
