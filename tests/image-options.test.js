const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OFFICIAL_IMAGE_STYLES = [
  ['人像摄影', 'skill_image_styles_portrait'],
  ['电影写真', 'skill_image_styles_film'],
  ['中国风', 'skill_image_styles_chinese'],
  ['动漫', 'skill_image_styles_japanese_anime'],
  ['3D渲染', 'skill_image_styles_3d'],
  ['赛博朋克', 'image_gen_style_cyberpunk'],
  ['CG 动画', 'skill_image_styles_cg'],
  ['水墨画', 'skill_image_styles_ink_wash_painting'],
  ['油画', 'skill_image_styles_oil_painting'],
  ['古典', 'skill_image_styles_classic'],
  ['水彩画', 'skill_image_styles_watercolor'],
  ['卡通', 'skill_image_styles_cartoon'],
  ['平面插画', 'skill_image_styles_flat_illustration'],
  ['风景', 'skill_image_styles_landscape'],
  ['港风动漫', 'skill_image_styles_hongkong_anime'],
  ['像素风格', 'skill_image_styles_pixel_style'],
  ['荧光绘画', 'skill_image_styles_fluorescence'],
  ['彩铅画', 'skill_image_styles_colored_pencil'],
  ['手办', 'skill_image_styles_figure'],
  ['儿童绘画', 'skill_image_styles_children_illustration'],
  ['抽象', 'skill_image_styles_abstract'],
  ['锐笔插画', 'skill_image_styles_sharp_illustration'],
  ['二次元', 'skill_image_styles_acg'],
  ['油墨印刷', 'skill_image_styles_ink_print'],
  ['版画', 'skill_image_styles_bnw_printing'],
  ['莫奈', 'skill_image_styles_monet'],
  ['毕加索', 'skill_image_styles_picasso'],
  ['伦勃朗', 'skill_image_styles_rembrandt'],
  ['马蒂斯', 'skill_image_styles_matisse'],
  ['巴洛克', 'skill_image_styles_baroque'],
  ['复古动漫', 'skill_image_styles_oldschool'],
  ['绘本', 'skill_image_styles_picturebook']
];

test('image UI exposes official Doubao image ratios and style values from skill pack', () => {
  // 选项已迁移到 React 前端的 web/src/lib/options.js,以该文件为准
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'lib', 'options.js'), 'utf8');

  for (const ratio of ['1:1', '2:3', '3:4', '4:3', '9:16', '16:9']) {
    assert.match(src, new RegExp(`'${ratio}'`), `missing image ratio ${ratio}`);
  }

  for (const [label, value] of OFFICIAL_IMAGE_STYLES) {
    assert.match(src, new RegExp(`value:\\s*'${value}',\\s*label:\\s*'${label}'`), `missing official style ${label}=${value}`);
  }
});

test('platform config exposes official Seedream image models with official default first', () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config', 'config.json'), 'utf8'));

  for (const platform of ['doubao', 'dola']) {
    const models = config.platforms[platform].imageModels.map((model) => model.value);
    assert.deepEqual(models, ['Seedream 4.5', 'Seedream 5.0 Lite', 'Seedream 4.0']);
  }
});
