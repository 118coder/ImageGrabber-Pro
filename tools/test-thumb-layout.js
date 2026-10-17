/* =============================================================================
 * 缩略图与布局专项验证（真机 headless Edge）
 * 覆盖：
 *   1. 卡片不被裁切：卡片高度 ≥ 缩略图高度 + 名称行
 *   2. 缩略图是降采样过的：naturalWidth 远小于原图，dataURL 体积远小于原图
 *   3. 尺寸滑块只改视图：拖动后 DOM 元素不变、图片 src 不变（不重新加载）
 * 用法： node tools/test-thumb-layout.js
 * =========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8805;
const DEBUG_PORT = 9345;

// ---------------------------------------------------------------- 造一张大图
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([l, tb, data, c]);
}
/** 噪声图：压缩率低，接近真实照片的体积 */
function bigPng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 7 + y * 13) & 255;
      raw[o + 1] = (x * 3 + y * 29) & 255;
      raw[o + 2] = (x * 11 + y * 5) & 255;
    }
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const BIG = bigPng(2400, 1600);

const server = http.createServer((req, res) => {
  if (/\.png/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': BIG.length });
    res.end(BIG);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!DOCTYPE html><html><body>${Array.from(
      { length: 8 },
      (_, i) => `<img src="/huge${i}.png" width="2400" height="1600">`
    ).join('')}</body></html>`
  );
});

// ---------------------------------------------------------------- CDP
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.p = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const q = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? q.j(new Error(m.error.message)) : q.r(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}
async function conn(url, browser) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const c = new CDP(ws);
  if (!browser) {
    await c.send('Runtime.enable');
    await c.send('Page.enable').catch(() => {});
  }
  return c;
}
const list = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
async function waitFor(fn, ms, label) {
  const t = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {}
    if (Date.now() - t > ms) throw new Error('超时：' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-thumb-layout.log'), 'w');
  const proc = spawn(
    exe,
    [
      '--headless=new',
      `--user-data-dir=${path.join(os.tmpdir(), 'igp-tl-' + Date.now())}`,
      `--load-extension=${ROOT}`,
      `--disable-extensions-except=${ROOT}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--window-size=1000,700',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', logF] }
  );

  try {
    const sw = await waitFor(
      async () => (await list()).find((t) => t.type === 'service_worker' && /background\.js/.test(t.url)),
      45000,
      '扩展 Service Worker'
    );
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    const b = await conn(
      (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl,
      true
    );
    const pt = await b.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/`, background: false });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, '测试页');
    await new Promise((r) => setTimeout(r, 2500));

    const qt = await b.send('Target.createTarget', {
      url: `chrome-extension://${extId}/src/popup.html`,
      background: false
    });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, '弹窗');
    const pop = await conn(qT.webSocketDebuggerUrl, false);
    await new Promise((r) => setTimeout(r, 2200));

    console.log(`\n原图：2400×1600，${(BIG.length / 1048576).toFixed(2)} MB\n`);

    console.log('[1] 卡片不再被裁切');
    const geo = await pop.ev(`
      await rescan();
      // 等前几张缩略图出像素
      const t0 = Date.now();
      let imgs = [];
      for (;;) {
        imgs = [...document.querySelectorAll('.thumb img')];
        if (imgs.filter(i => i.naturalWidth > 0).length >= 3 || Date.now() - t0 > 20000) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const card = document.querySelector('.card');
      const thumb = card.querySelector('.thumb');
      const name = card.querySelector('.name');
      const cr = card.getBoundingClientRect();
      const tr = thumb.getBoundingClientRect();
      const nr = name.getBoundingClientRect();
      return {
        cardH: Math.round(cr.height), thumbH: Math.round(tr.height), nameH: Math.round(nr.height),
        thumbW: Math.round(tr.width), cardW: Math.round(cr.width),
        overflow: getComputedStyle(card).overflow,
        // 缩略图底边必须落在卡片内部（没被裁掉）
        thumbInsideCard: tr.bottom <= cr.bottom + 0.5,
        nameBelowThumb: nr.top >= tr.bottom - 0.5
      };`);
    console.log('    几何：', JSON.stringify(geo));
    check('卡片高度 ≥ 缩略图 + 文件名行', geo.cardH >= geo.thumbH + geo.nameH - 2, geo);
    check('缩略图完整落在卡片内（未裁切）', geo.thumbInsideCard === true, geo);
    check('文件名行在缩略图下方', geo.nameBelowThumb === true, geo);
    check('缩略图宽度撑满卡片内宽', Math.abs(geo.thumbW - (geo.cardW - 2)) <= 2, geo);

    console.log('\n[2] 缩略图是降采样的小图');
    const thumbInfo = await pop.ev(`
      const imgs = [...document.querySelectorAll('.thumb img')].filter(i => i.naturalWidth > 0);
      const sample = imgs.slice(0, 3).map(i => ({
        w: i.naturalWidth, h: i.naturalHeight,
        dataLen: String(i.getAttribute('src')).length
      }));
      return { count: imgs.length, sample };
    `);
    console.log('    缩略图：', JSON.stringify(thumbInfo));
    check('缩略图数量 ≥ 3', thumbInfo.count >= 3, thumbInfo.count);
    check(
      '缩略图边长远小于原图（≤512px）',
      thumbInfo.sample.every((s) => Math.max(s.w, s.h) <= 512),
      thumbInfo.sample
    );
    check(
      '缩略图 dataURL 体积远小于原图（< 原图 5%）',
      thumbInfo.sample.every((s) => s.dataLen < BIG.length * 0.05),
      thumbInfo.sample.map((s) => s.dataLen)
    );

    console.log('\n[3] 尺寸滑块只改视图，不重新加载');
    const resize = await pop.ev(`
      const imgs = [...document.querySelectorAll('.thumb img')];
      const beforeEls = imgs;
      const beforeSrc = imgs.map(i => i.getAttribute('src'));
      const beforeW = imgs.map(i => i.naturalWidth);
      // 模拟拖动到最大
      document.getElementById('thumbSize').value = '260';
      document.getElementById('thumbSize').dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const afterEls = [...document.querySelectorAll('.thumb img')];
      const afterSrc = afterEls.map(i => i.getAttribute('src'));
      const card = document.querySelector('.card').getBoundingClientRect();
      const thumb = document.querySelector('.thumb').getBoundingClientRect();
      const vars = getComputedStyle(document.documentElement);
      return {
        sameElements: afterEls.length === beforeEls.length && afterEls.every((el, i) => el === beforeEls[i]),
        sameSrc: afterSrc.length === beforeSrc.length && afterSrc.every((s, i) => s === beforeSrc[i]),
        cardH: Math.round(card.height), thumbH: Math.round(thumb.height),
        cssThumbH: vars.getPropertyValue('--thumb-h').trim(),
        cssCardMin: vars.getPropertyValue('--card-min').trim(),
        sliderLabel: document.getElementById('thumbSizeVal').textContent
      };
    `);
    console.log('    拖动后：', JSON.stringify(resize));
    check('DOM 元素没有被重建', resize.sameElements === true, resize);
    check('图片 src 完全没变（没有重新请求）', resize.sameSrc === true, resize);
    check('缩略图随滑块变大', resize.thumbH >= 250, resize);
    check('CSS 变量已更新', resize.cssThumbH === '260px', resize);
    check('滑块数值同步显示', resize.sliderLabel === '260', resize);

    console.log('\n[4] 缩小回去');
    const shrink = await pop.ev(`
      document.getElementById('thumbSize').value = '80';
      document.getElementById('thumbSize').dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const card = document.querySelector('.card').getBoundingClientRect();
      const thumb = document.querySelector('.thumb').getBoundingClientRect();
      return { cardH: Math.round(card.height), thumbH: Math.round(thumb.height) };
    `);
    console.log('    缩小后：', JSON.stringify(shrink));
    check('缩略图随滑块变小', shrink.thumbH <= 84, shrink);
    check('卡片高度跟着变', shrink.cardH < resize.cardH, shrink);
    check('缩略图依然完整显示', shrink.thumbH >= 70, shrink);

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try {
      proc.kill();
    } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常：', e.message);
  try {
    console.error(fs.readFileSync(path.join(os.tmpdir(), 'igp-thumb-layout.log'), 'utf8').slice(-1500));
  } catch (_) {}
  process.exit(1);
});
