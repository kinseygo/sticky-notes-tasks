// make-icon.js — 生成应用图标 assets/icon.png（黄色便签纸 + 右上折角 + 文字行）
// 纯 Node 实现，无第三方依赖：手动构造 PNG（RGBA）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 512, H = 512;
// electron-builder 要求 Windows 图标 >= 512，按 256 设计稿等比缩放
const S = W / 256;
const px = Buffer.alloc(W * H * 4, 0);

// 将颜色按源透明度 alpha 混合到 (x,y)
function over(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 4;
  const da = px[i + 3] / 255, sa = a / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

// 点是否在圆角矩形内
function inRR(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRR(x0, y0, x1, y1, r, [cr, cg, cb, ca]) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++)
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++)
      if (inRR(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) over(x, y, cr, cg, cb, ca);
}

function fillTri(p1, p2, p3, [cr, cg, cb, ca]) {
  const minx = Math.floor(Math.min(p1[0], p2[0], p3[0])), maxx = Math.ceil(Math.max(p1[0], p2[0], p3[0]));
  const miny = Math.floor(Math.min(p1[1], p2[1], p3[1])), maxy = Math.ceil(Math.max(p1[1], p2[1], p3[1]));
  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  for (let y = miny; y <= maxy; y++)
    for (let x = minx; x <= maxx; x++) {
      const px0 = x + 0.5, py0 = y + 0.5;
      const d1 = sign(px0, py0, p1[0], p1[1], p2[0], p2[1]);
      const d2 = sign(px0, py0, p2[0], p2[1], p3[0], p3[1]);
      const d3 = sign(px0, py0, p3[0], p3[1], p1[0], p1[1]);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0, hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) over(x, y, cr, cg, cb, ca);
    }
}

// ---- 绘制 ----
const X0 = 30 * S, Y0 = 22 * S, X1 = 226 * S, Y1 = 234 * S, R = 16 * S, F = 46 * S;
// 投影
fillRR(X0, Y0 + 6 * S, X1, Y1 + 6 * S, R, [0, 0, 0, 70]);
// 便签主体（黄色）
fillRR(X0, Y0, X1, Y1, R, [255, 214, 64, 255]);
// 右上折角（浅色三角）
fillTri([X1 - F, Y0], [X1 + 1, Y0], [X1 + 1, Y0 + F + 1], [255, 240, 168, 255]);
// 折角下的阴影线
fillTri([X1 - F, Y0], [X1 - F + 10 * S, Y0], [X1, Y0 + F], [0, 0, 0, 28]);
// 三条“文字”线
fillRR(X0 + 26 * S, Y0 + 66 * S, X0 + 158 * S, Y0 + 80 * S, 7 * S, [232, 178, 38, 255]);
fillRR(X0 + 26 * S, Y0 + 98 * S, X0 + 130 * S, Y0 + 112 * S, 7 * S, [232, 178, 38, 230]);
fillRR(X0 + 26 * S, Y0 + 130 * S, X0 + 100 * S, Y0 + 144 * S, 7 * S, [232, 178, 38, 200]);

// ---- PNG 编码 ----
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // 位深
ihdr[9] = 6;  // 颜色类型 RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // 每行 filter = None
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.png'), png);
console.log('已生成 assets/icon.png (' + png.length + ' bytes)');
