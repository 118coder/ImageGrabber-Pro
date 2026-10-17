/* =============================================================================
 * 生成扩展图标（无第三方依赖，手写 PNG 编码 + 4×4 超采样抗锯齿）
 * 用法： node tools/make-icons.js
 * 图形：圆角渐变底 + 白色"下载箭头入托盘"，16px 下依然清晰。
 * =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- 图形定义
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 返回该采样点的颜色 [r,g,b,a]，坐标 0..1 */
function sample(x, y) {
  // 背景圆角方块
  const bg = inRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.23);
  if (!bg) return [0, 0, 0, 0];
  const t = (x + y) / 2;
  let r = lerp(99, 34, t);
  let g = lerp(102, 211, t);
  let b = lerp(241, 238, t);

  // 白色前景：箭头 + 托盘
  let fg = 0;
  // 箭杆
  if (x >= 0.435 && x <= 0.565 && y >= 0.2 && y <= 0.52) fg = 1;
  // 箭头三角形（近似：两条斜边判定）
  if (y >= 0.42 && y <= 0.63) {
    const half = 0.205 * (1 - (y - 0.42) / 0.21);
    if (Math.abs(x - 0.5) <= half) fg = 1;
  }
  // 托盘（U 形）
  const barTop = 0.7;
  const barBottom = 0.775;
  if (y >= barTop && y <= barBottom && x >= 0.265 && x <= 0.735) fg = 1;
  if (y >= 0.6 && y <= barBottom && ((x >= 0.265 && x <= 0.34) || (x >= 0.66 && x <= 0.735))) fg = 1;

  if (fg) {
    // 前景略微透出底色一层淡边，避免纯白死板
    r = lerp(r, 255, 0.96);
    g = lerp(g, 255, 0.96);
    b = lerp(b, 255, 0.96);
  }
  return [r, g, b, 255];
}

function render(size) {
  const SS = 4; // 每个像素 4x4 采样
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = sample(x, y);
          const alpha = c[3] / 255;
          r += c[0] * alpha;
          g += c[1] * alpha;
          b += c[2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const idx = (py * size + px) * 4;
      if (a > 0) {
        out[idx] = Math.round(r / a);
        out[idx + 1] = Math.round(g / a);
        out[idx + 2] = Math.round(b / a);
      }
      out[idx + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, out);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('已生成', path.relative(path.join(__dirname, '..'), file), fs.statSync(file).size + 'B');
}
