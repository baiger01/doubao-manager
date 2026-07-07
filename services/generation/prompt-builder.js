const IMAGE_STYLE_LABELS = Object.freeze({
  skill_image_styles_portrait: '人像摄影',
  skill_image_styles_film: '电影写真',
  skill_image_styles_chinese: '中国风',
  skill_image_styles_japanese_anime: '动漫',
  skill_image_styles_3d: '3D渲染',
  image_gen_style_cyberpunk: '赛博朋克',
  skill_image_styles_cg: 'CG 动画',
  skill_image_styles_ink_wash_painting: '水墨画',
  skill_image_styles_oil_painting: '油画',
  skill_image_styles_classic: '古典',
  skill_image_styles_watercolor: '水彩画',
  skill_image_styles_cartoon: '卡通',
  skill_image_styles_flat_illustration: '平面插画',
  skill_image_styles_landscape: '风景',
  skill_image_styles_hongkong_anime: '港风动漫',
  skill_image_styles_pixel_style: '像素风格',
  skill_image_styles_fluorescence: '荧光绘画',
  skill_image_styles_colored_pencil: '彩铅画',
  skill_image_styles_figure: '手办',
  skill_image_styles_children_illustration: '儿童绘画',
  skill_image_styles_abstract: '抽象',
  skill_image_styles_sharp_illustration: '锐笔插画',
  skill_image_styles_acg: '二次元',
  skill_image_styles_ink_print: '油墨印刷',
  skill_image_styles_bnw_printing: '版画',
  skill_image_styles_monet: '莫奈',
  skill_image_styles_picasso: '毕加索',
  skill_image_styles_rembrandt: '伦勃朗',
  skill_image_styles_matisse: '马蒂斯',
  skill_image_styles_baroque: '巴洛克',
  skill_image_styles_oldschool: '复古动漫',
  skill_image_styles_picturebook: '绘本'
});

const VIDEO_MOVEMENT_TEMPLATES = Object.freeze({
  fixed: '固定镜头',
  pan: '镜头环绕${subject}拍摄',
  move: '镜头往${direction}移动',
  zoom: '镜头聚焦在${subject}'
});

// 把比例转成模型更可靠识别的中文方位描述，避免只给 "9:16" 时模型默认横屏
function ratioOrientationText(ratio) {
  const m = String(ratio || '').match(/(\d+)\s*[:：]\s*(\d+)/);
  if (!m) return '';
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  if (!w || !h) return '';
  if (h > w) return `竖屏${w}:${h}画面`;
  if (w > h) return `横屏${w}:${h}画面`;
  return `方形${w}:${h}画面`;
}

function buildImagePrompt(prompt, options = {}) {
  const parts = [`生成图片：${prompt}`];
  const styleLabel = IMAGE_STYLE_LABELS[options.style];
  if (styleLabel) parts.push(styleLabel);
  const ratioText = ratioOrientationText(options.ratio);
  if (ratioText) parts.push(ratioText);
  return parts.join('，');
}

function buildVideoPrompt(prompt, options = {}) {
  const rawPrompt = String(prompt || '').trim();
  const base = /生成视频|视频/.test(rawPrompt) ? rawPrompt : `生成视频：${rawPrompt}`;
  const parts = [base];
  const movement = buildVideoMovementText(options);
  if (movement) parts.push(movement);
  const ratioText = ratioOrientationText(options.ratio);
  if (ratioText) parts.push(ratioText);
  return parts.join('，');
}

function buildVideoMovementText(options = {}) {
  const movement = options.movement || '';
  if (!movement || movement === 'auto') return '';
  if (movement === 'fixed') return VIDEO_MOVEMENT_TEMPLATES.fixed;
  if (movement === 'pan') {
    const subject = String(options.movementSubject || options.subject || '').trim();
    return subject ? VIDEO_MOVEMENT_TEMPLATES.pan.replace('${subject}', subject) : '';
  }
  if (movement === 'move') {
    const direction = String(options.movementDirection || options.direction || '').trim();
    return direction ? VIDEO_MOVEMENT_TEMPLATES.move.replace('${direction}', direction) : '';
  }
  if (movement === 'zoom') {
    const subject = String(options.movementSubject || options.subject || '').trim();
    return subject ? VIDEO_MOVEMENT_TEMPLATES.zoom.replace('${subject}', subject) : '';
  }
  return String(movement).trim();
}

// 把脚本里按"原始文件名编号"写的图片引用，改写成 dola 实际认的"上传顺序号"引用。
function rewriteImageReferences(prompt, imageReferences) {
  const text = String(prompt || '');
  if (!Array.isArray(imageReferences) || imageReferences.length === 0) return text;

  const numToPos = new Map();
  imageReferences.forEach((ref, i) => {
    const name = String((ref && ref.imageName) || '');
    const stem = name.replace(/\.[^.]+$/, '');
    const m = stem.match(/\d+/);
    if (m) {
      const num = String(parseInt(m[0], 10));
      if (!numToPos.has(num)) numToPos.set(num, i + 1);
    }
  });
  if (numToPos.size === 0) return text;

  return text.replace(/@图片\s*[\[【]\s*(\d+)\s*[\]】]/g, (full, x) => {
    const num = String(parseInt(x, 10));
    const pos = numToPos.get(num);
    return pos ? `@image${pos}` : full;
  });
}

module.exports = {
  IMAGE_STYLE_LABELS,
  VIDEO_MOVEMENT_TEMPLATES,
  ratioOrientationText,
  buildImagePrompt,
  buildVideoPrompt,
  buildVideoMovementText,
  rewriteImageReferences,
};
