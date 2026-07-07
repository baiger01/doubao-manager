import React, { useId, useRef, useState, useLayoutEffect, useMemo } from 'react';
import { useStore } from '../store.jsx';

/**
 * 真·液态玻璃容器(参考 inspira-ui / Apple Liquid Glass)。
 * 原理:ResizeObserver 实测尺寸 → 生成一张 RGB 位移贴图(红右渐变 + 蓝下渐变 + 中心高光),
 * 用 feImage 载入,再用三条 feDisplacementMap 分别对 R/G/B 通道施加不同 scale(色散),
 * feColorMatrix 拆通道、feBlend(screen)合并、feGaussianBlur 收边,
 * 最后把整套滤镜挂到根节点的 backdrop-filter 上 → 背景发生真实折射色散。
 * 仅 Chromium 内核可用(本应用为 Electron,满足)。
 *
 * 兼容旧 API:radius / blur / strength / tint / className / style / onClick。
 *   strength → 位移强度(scale = -strength*3)
 *   blur     → 位移贴图高光的模糊半径
 *   tint     → 玻璃底色(半透明,露出背后折射)
 * 额外高级 props:border/lightness/alpha/blend/rOffset/gOffset/bOffset/displace。
 */
// 把任意 rgb/rgba 白色系底色换成暗色底(保留原透明度);白字模式用
function toDarkTint(tint) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(tint || '');
  if (!m) return tint;
  const a = m[4] != null ? parseFloat(m[4]) : 1;
  // 高不透明面板(如账号/设置弹窗 0.97):换成近纯暗色实底
  if (a >= 0.6) return `rgba(26, 21, 38, ${a})`;
  // 低透明度轻玻璃(顶栏/侧栏 0.06~0.08):加深一点点,让白字可读又不糊背景
  const boosted = Math.min(0.9, a + 0.28);
  return `rgba(20, 16, 32, ${boosted})`;
}

export default function LiquidGlass({
  children,
  radius = 20,
  blur = 14,
  strength = 60,
  tint = 'rgba(255,255,255,0.06)',
  border = 0.07,
  lightness = 50,
  alpha = 0.93,
  blend = 'difference',
  rOffset = 0,
  gOffset = 3,
  bOffset = 6,
  displace = 0.7,
  className = '',
  style = {},
  onClick,
  ...rest
}) {
  const uid = useId().replace(/[:]/g, '');
  const filterId = `lg-${uid}`;
  const rootRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const { glassMode, textTone } = useStore();

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      let w = 0, h = 0;
      if (e.borderBoxSize && e.borderBoxSize.length) {
        w = e.borderBoxSize[0].inlineSize;
        h = e.borderBoxSize[0].blockSize;
      } else if (e.contentRect) {
        w = e.contentRect.width;
        h = e.contentRect.height;
      }
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = -(strength * 1.1);
  const liquid = glassMode === 'liquid' || glassMode == null;
  const frosted = glassMode === 'frosted' || glassMode === 'blur'; // 兼容旧值 blur
  const plain = glassMode === 'none';

  // RGB 位移贴图(以 data URI 形式给 feImage)。仅液态模式需要。
  const dataUri = useMemo(() => {
    if (!liquid) return '';
    const { w, h } = size;
    if (w <= 0 || h <= 0) return '';
    const b = Math.min(w, h) * (border * 0.5);
    const svg = `
      <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="red" x1="100%" y1="0%" x2="0%" y2="0%">
            <stop offset="0%" stop-color="#0000"/>
            <stop offset="100%" stop-color="red"/>
          </linearGradient>
          <linearGradient id="blue" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#0000"/>
            <stop offset="100%" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="${w}" height="${h}" fill="black"></rect>
        <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="url(#red)" />
        <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="url(#blue)" style="mix-blend-mode: ${blend}" />
        <rect x="${b}" y="${b}" width="${w - b * 2}" height="${h - b * 2}" rx="${radius}" fill="hsl(0 0% ${lightness}% / ${alpha})" style="filter:blur(${blur}px)" />
      </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }, [liquid, size, radius, border, blend, lightness, alpha, blur]);

  const ready = liquid && !!dataUri;
  // backdrop:液态=色散滤镜;雾蒙=厚磨砂高斯模糊;全普通=无
  const backdrop = ready
    ? `url(#${filterId})`
    : frosted
      ? `blur(${blur}px) saturate(140%)`
      : liquid
        ? `blur(${blur}px) saturate(140%)`   // 液态贴图未就绪时的临时降级
        : 'none';                             // 全普通:不加任何滤镜
  // 字体切成白色时,原本的白色系 tint 会让白字看不见 → 自动换成暗色底(沿用原透明度)
  const tunedTint = textTone === 'light' ? toDarkTint(tint) : tint;
  // 全普通模式下 tint 通常是半透明的,直接透出背景会花;叠一层不透明底色(随字体色调变)
  const bg = plain ? 'var(--glass-solid, rgba(255,255,255,0.96))' : tunedTint;

  return (
    <div
      ref={rootRef}
      className={`liquid-glass lg-${plain ? 'none' : frosted ? 'frosted' : 'liquid'} ${className}`}
      onClick={onClick}
      style={{
        '--lg-radius': `${radius}px`,
        background: bg,
        backdropFilter: backdrop,
        WebkitBackdropFilter: backdrop,
        ...style,
      }}
      {...rest}
    >
      {/* 位移滤镜定义(三通道色散);blur 模式不注入 */}
      {ready && (
      <svg className="lg-filter-defs" aria-hidden="true">
        <defs>
          <filter id={filterId} colorInterpolationFilters="sRGB">
            <feImage x="0" y="0" width="100%" height="100%" href={dataUri} result="map" />
            <feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="B" scale={scale + rOffset} result="dispRed" />
            <feColorMatrix in="dispRed" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
            <feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="B" scale={scale + gOffset} result="dispGreen" />
            <feColorMatrix in="dispGreen" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
            <feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="B" scale={scale + bOffset} result="dispBlue" />
            <feColorMatrix in="dispBlue" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
            <feBlend in="red" in2="green" mode="screen" result="rg" />
            <feBlend in="rg" in2="blue" mode="screen" result="output" />
            <feGaussianBlur in="output" stdDeviation={displace} />
          </filter>
        </defs>
      </svg>
      )}

      {/* 内容 */}
      <div className="lg-content">{children}</div>
    </div>
  );
}
