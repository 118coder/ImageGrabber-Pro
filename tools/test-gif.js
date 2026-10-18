/* =============================================================================
 * GIF 动图预览测试
 *   · GIF 缩略图必须是原始 image/gif 数据（保留动画），而不是 canvas 抽出的静态 WebP
 *   · 卡片带 "GIF" 标签；普通 PNG 不受影响
 *   · 页面已加载的 GIF 通过页面缓存读取，不重复请求
 * 用法： node tools/test-gif.js
 * ============================================================================= */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8839;
const DEBUG_PORT = 9403;
const GIF = fs.readFileSync(path.join(__dirname, 'fixtures', 'anim.gif'));
const GIF_DATA_URL = 'data:image/gif;base64,' + GIF.toString('base64');
const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
let gifHits = 0;

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([l, tb, data, c]);
}
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255 / w) & 255; raw[o + 1] = (y * 255 / h) & 255; raw[o + 2] = 120;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(600, 400);

const server = http.createServer((req, res) => {
  if (/anim\.gif/.test(req.url)) {
    gifHits++;
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=600' });
    res.end(GIF);
    return;
  }
  if (/tiny\.gif|tracker\.gif|pixel\.gif/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=600' });
    res.end(TINY_GIF);
    return;
  }
  if (/still\.png/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' });
    res.end(PNG);
    return;
  }
  if (/favicon\.ico/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' });
    res.end(PNG);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><head>
    <link rel="preload" as="image" href="/tracker.gif">
  </head><title>GIF 预览测试</title><body style="margin:0">
    <img src="/anim.gif" width="240" height="160">
    <img src="/still.png" width="600" height="400">
    <img src="/tiny.gif" width="1" height="1">
    <div style="width:1px;height:1px;background-image:url('/pixel.gif')"></div>
  </body>`);
});

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map(); this.exc = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.j(new Error(m.error.message)) : q.r(m.result); }
      if (m.method === 'Runtime.exceptionThrown') this.exc.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr, ms = 40000) {
    const res = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }),
      new Promise((r) => setTimeout(() => r({ __t: true }), ms))
    ]);
    if (res.__t) return { __timeout: ms };
    if (res.exceptionDetails) return { __err: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
    return res.result.value;
  }
}
async function conn(url, browser) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const c = new CDP(ws);
  if (!browser) { await c.send('Runtime.enable'); await c.send('Page.enable').catch(() => {}); }
  return c;
}
const list = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
async function waitFor(fn, ms, label) {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    if (Date.now() - t > ms) throw new Error('超时：' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 260) : '')); }
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-gif.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-gif-' + Date.now())}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=' + DEBUG_PORT, '--window-size=1000,760',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'ignore', logF] });

  try {
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /background\.js/.test(t.url)), 45000, 'sw');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);

    const pt = await b.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/`, background: false });
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, 'page');
    await sleep(2000);

    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    await b.send('Target.activateTarget', { targetId: qt.targetId });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl, false);
    await sleep(2500);

    const out = await pop.ev(`
      await rescan();
      const t0 = Date.now();
      for (;;) {
        const g = [...document.querySelectorAll('.card')].find(c => c.dataset.url.includes('anim.gif'));
        const img = g && g.querySelector('img');
        if ((img && img.naturalWidth > 0 && g.querySelector('.tag').textContent === 'GIF') || Date.now() - t0 > 15000) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const rows = [...document.querySelectorAll('.card')].map(card => {
        const img = card.querySelector('.thumb img');
        const tag = card.querySelector('.tag');
        const fullSrc = img ? String(img.getAttribute('src') || '') : '';
        let hash = 5381;
        for (let i = 0; i < fullSrc.length; i++) hash = ((hash << 5) + hash + fullSrc.charCodeAt(i)) | 0;
        return { url: card.dataset.url, tag: tag.textContent, tagClass: tag.className,
                 src: fullSrc.slice(0, 40),
                 srcLen: fullSrc.length, srcHash: (hash >>> 0).toString(16),
                 natural: img ? [img.naturalWidth, img.naturalHeight] : null,
                 complete: img ? img.complete : null,
                 thumbClass: card.querySelector('.thumb').className };
      });
      const gifCard = rows.find(r => r.url.includes('anim.gif'));
      const pngCard = rows.find(r => r.url.includes('still.png'));
      return { cards: rows.length, gifCard, pngCard,
               defaultUrls: rows.map(r => r.url),
               tinyAll: allItems.filter(i => /tiny\\.gif|tracker\\.gif|pixel\\.gif/.test(i.url))
                 .map(i => ({ url: i.url, kind: i.kind, w: i.w, h: i.h })),
               broken: brokenThumbs.size, fallbacks: document.querySelectorAll('.thumb .ph').length };`, 40000);
    console.log('实测：', JSON.stringify(out, null, 2));

    // 切到「全部尺寸 + GIF 动图」：1×1 与未知尺寸的 GIF 应重新出现
    const gifOnly = await pop.ev(`
      const min = document.getElementById('minSize');
      min.value = '0';
      min.dispatchEvent(new Event('change', { bubbles: true }));
      const type = document.getElementById('typeFilter');
      type.value = 'gif';
      type.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
      return [...document.querySelectorAll('.card')].map(c => ({
        url: c.dataset.url,
        tag: c.querySelector('.tag').textContent,
        nw: c.querySelector('.thumb img') ? c.querySelector('.thumb img').naturalWidth : 0
      }));`, 30000);
    console.log('GIF 类型筛选：', JSON.stringify(gifOnly));

    console.log('');
    check('抓到了 GIF 和普通 PNG', out.cards >= 2 && !!out.gifCard && !!out.pngCard, { cards: out.cards });
    check('GIF 缩略图是原始 image/gif（保留动画）', /^data:image\/gif/.test(out.gifCard.src), out.gifCard);
    check(
      'GIF 动图字节逐字节完整（不是静态首帧重编码）',
      out.gifCard.srcLen === GIF_DATA_URL.length && out.gifCard.srcHash === hashString(GIF_DATA_URL),
      { len: out.gifCard.srcLen, expect: GIF_DATA_URL.length, hash: out.gifCard.srcHash }
    );
    check('GIF 确实加载出像素', out.gifCard.natural && out.gifCard.natural[0] > 0 && out.gifCard.complete === true, out.gifCard);
    check('GIF 卡片带 GIF 标签', out.gifCard.tag === 'GIF' && /gif/.test(out.gifCard.tagClass), out.gifCard);
    check('普通 PNG 不受影响（非 GIF 数据）', /^data:image\/(webp|png)/.test(out.pngCard.src), out.pngCard);
    check('普通 PNG 标签仍是图片', out.pngCard.tag === '图片', out.pngCard);
    check('页面已加载的 GIF 不重复下载', gifHits === 1, { gifHits });
    check('没有误判失效', out.broken === 0 && out.fallbacks === 0, out);

    const defaultTiny = out.defaultUrls.filter((u) => /tiny|tracker|pixel/.test(u));
    const gifOnlyTiny = gifOnly.filter((r) => /tiny|tracker|pixel/.test(r.url));
    check('默认尺寸筛选隐藏 1×1 / 未知尺寸 GIF', defaultTiny.length === 0, { defaultTiny, urls: out.defaultUrls });
    check('扫描结果仍保留这些小 GIF（切回全部尺寸可看）', out.tinyAll.length >= 3, out.tinyAll);
    check('全部尺寸 + GIF 类型筛选能找回小 GIF', gifOnlyTiny.length >= 3, { gifOnlyTiny, gifOnly });
    check('GIF 类型筛选只保留 GIF', gifOnly.length >= 4 && gifOnly.every((r) => /\.gif(?:[?#]|$)/.test(r.url)), gifOnly);

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
