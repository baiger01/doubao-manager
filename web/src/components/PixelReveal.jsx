import React, { useEffect, useMemo, useRef, useState } from 'react';

// 圆角马赛克瓷砖揭示动画(移植自 7ai.cool)
// 图片进入视口后,切成 rows×cols 小方块随机延迟逐块淡入,再从灰度转彩色,最后切回整图
export default function PixelReveal({ src, alt, rows = 5, cols = 4, onZoom }) {
  const ref = useRef(null);
  const proxyTried = useRef(false);
  const [inView, setInView] = useState(false);
  const [colored, setColored] = useState(false);
  const [done, setDone] = useState(false);
  const [broken, setBroken] = useState(false);
  const [curSrc, setCurSrc] = useState(src);

  const fadeMs = 400;      // 单块淡入时长
  const maxDelay = 400;    // 随机延迟上限
  const colorDelay = 500;  // 灰度->彩色延迟

  const tiles = useMemo(
    () => Array.from({ length: rows * cols }, (_, i) => ({
      row: Math.floor(i / cols),
      col: i % cols,
      delay: Math.random() * maxDelay,
    })),
    [rows, cols]
  );

  // 进入视口触发
  useEffect(() => {
    if (!ref.current) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setInView(true); io.disconnect(); } },
      { rootMargin: '-50px' }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  // 灰度转彩色
  useEffect(() => {
    if (!inView) return;
    const t = setTimeout(() => setColored(true), colorDelay);
    return () => clearTimeout(t);
  }, [inView]);

  // 动画结束,切回整图
  useEffect(() => {
    if (!inView) return;
    const total = maxDelay + fadeMs + colorDelay + 600;
    const t = setTimeout(() => setDone(true), total);
    return () => clearTimeout(t);
  }, [inView]);

  // src 变化时同步 curSrc 并重置代理回退标记（历史会话切换复用实例时避免显示旧图）
  useEffect(() => {
    proxyTried.current = false;
    setCurSrc(src);
    setBroken(false);
  }, [src]);

  // 图片失败:本地文件(/api/media/local)失败直接标损坏；远程 CDN 失败先回退代理通道
  const handleError = () => {
    const isLocal = typeof src === 'string' && src.startsWith('/api/media/local');
    if (!isLocal && !proxyTried.current) {
      proxyTried.current = true;
      setCurSrc('/api/media/image?url=' + encodeURIComponent(src));
    } else {
      setBroken(true);
    }
  };

  if (broken) {
    return <div className="pixel-reveal broken" ref={ref} />;
  }

  return (
    <div
      className="pixel-reveal"
      ref={ref}
      onClick={() => curSrc && onZoom && onZoom(curSrc)}
    >
      <img
        src={curSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={handleError}
        style={{ visibility: done ? 'visible' : 'hidden' }}
      />
      {!done && (
        <div
          className="pixel-grid"
          style={{
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
          }}
        >
          {tiles.map((t, i) => (
            <div
              key={i}
              className="pixel-tile"
              style={{
                backgroundImage: `url(${curSrc})`,
                backgroundSize: `${cols * 100}% ${rows * 100}%`,
                backgroundPosition: `${(t.col / (cols - 1)) * 100}% ${(t.row / (rows - 1)) * 100}%`,
                opacity: inView ? 1 : 0,
                filter: colored ? 'grayscale(0)' : 'grayscale(1)',
                transition: `opacity ${fadeMs}ms ease ${t.delay}ms, filter 400ms ease ${colorDelay}ms`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
