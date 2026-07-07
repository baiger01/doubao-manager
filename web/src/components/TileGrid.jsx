import React, { useMemo } from 'react';

// 浅色留白方格背景(参考 7ai.cool 截图自实现)
// 设计要点:
//  - 中心大片留白(瓷砖透明),内容清晰可读
//  - 瓷砖只在四周边缘显现,越靠边越实
//  - 透明度 / 动画延迟由"距中心距离"决定 => 确定性径向波纹,非随机乱闪
//  - 彩色光晕(蓝 左下 / 粉紫 右 / 橙 右上)由底层渐变提供,瓷砖只做柔光遮罩
export default function TileGrid({ cols = 26, rows = 15 }) {
  const tiles = useMemo(() => {
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const maxD = Math.hypot(cx, cy);
    const list = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // 归一化距中心距离 0(中心)~1(角落)
        const d = Math.hypot(c - cx, r - cy) / maxD;
        // 边缘渐显:中心 0.45 半径内基本透明,越向外越实
        const reveal = Math.max(0, (d - 0.42) / 0.58);
        const base = +(reveal * reveal * 0.5).toFixed(3); // 二次曲线,中心更干净
        list.push({
          base,
          // 径向延迟:从中心向外扩散的流动波
          delay: +(d * 2.6).toFixed(2),
          // 每格呼吸周期略有差异,避免整片同步,更自然
          dur: +(5 + reveal * 3).toFixed(2),
        });
      }
    }
    return list;
  }, [cols, rows]);

  return (
    <div className="tile-grid">
      <div className="tile-grid-color" />
      <div
        className="tile-grid-cells"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
      >
        {tiles.map((t, i) => (
          <span
            key={i}
            className="tile-cell"
            style={{ '--tile-base': t.base, animationDelay: `${t.delay}s`, animationDuration: `${t.dur}s` }}
          />
        ))}
      </div>
    </div>
  );
}
