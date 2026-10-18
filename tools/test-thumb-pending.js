/* =============================================================================
 * 慢图阻塞测试：页面里大图还在下载时，不能拖住其它已加载图片的缩略图
 *
 * 背景：内容脚本对大图会 await img.decode()，后台缩略图并发只有 4。若前几张
 * 大图一直没下载完，这四个槽会被占住，后续小图全部排队，面板表现为一片空白。
 * 期望：未加载完的图立即返回 pending，弹窗稍后重试；已加载的图马上出缩略图。
 * 用法： node tools/test-thumb-pending.js
 * ============================================================================= */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8837;
const SLOW_PORT = 8838;
const DEBUG_PORT = 9401;
const SLOW = 6;
const FAST = 8;
const DELAY = 8000;

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
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 4 + seed * 17) & 255;
      raw[o + 1] = (y * 3 + seed * 31) & 255;
      raw[o + 2] = (x * y + seed * 7) & 255;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMG = png(800, 600, 9);
const hits = {};
const server = http.createServer((req, res) => {
  const fm = /\/fast(\d+)\.png/.exec(req.url);
  if (fm) {
    const key = 'fast' + fm[1];
    hits[key] = (hits[key] || 0) + 1;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' });
    res.end(IMG);
    return;
  }
  // 慢图放到独立 origin，避免 6 条 HTTP/1.1 连接把快图的下载也堵住
  const slow = Array.from({ length: SLOW }, (_, i) =>
    `<img src="http://127.0.0.1:${SLOW_PORT}/slow${i}.png" width="800" height="600" crossorigin="anonymous">`
  ).join('');
  const fast = Array.from({ length: FAST }, (_, i) => `<img src="/fast${i}.png" width="800" height="600">`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><title>慢图阻塞测试</title><body style="margin:0">${slow}${fast}</body>`);
});

const slowServer = http.createServer((req, res) => {
  const m = /\/slow(\d+)\.png/.exec(req.url);
  if (!m) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const key = 'slow' + m[1];
  hits[key] = (hits[key] || 0) + 1;
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=600',
      'Access-Control-Allow-Origin': `http://127.0.0.1:${PORT}`,
      'Access-Control-Allow-Credentials': 'true'
    });
    res.end(IMG);
  }, DELAY);
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
  await new Promise((r) => slowServer.listen(SLOW_PORT, '127.0.0.1', r));
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-pending.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-pd-' + Date.now())}`,
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
    const pT = await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, 'page');
    const page = await conn(pT.webSocketDebuggerUrl, false);

    // 页面 DOM 就绪、慢图还在下载时立即打开面板
    await waitFor(async () => {
      const s = await page.ev(`return { ready: document.readyState, n: document.images.length };`, 8000);
      return s && s.n >= SLOW + FAST && s.ready !== 'loading';
    }, 20000, 'dom ready');
    console.log(`页面已就绪：${SLOW} 张慢图仍在下载（${DELAY}ms 后返回），${FAST} 张快图`);

    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    await b.send('Target.activateTarget', { targetId: qt.targetId });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl, false);

    await waitFor(async () => {
      const n = await pop.ev(`return document.querySelectorAll('.card').length;`, 8000);
      return typeof n === 'number' && n >= SLOW + FAST;
    }, 20000, 'cards');
    await sleep(1500);

    const early = await pop.ev(`
      const rows = [...document.querySelectorAll('.card')].map(card => {
        const name = card.dataset.url.split('/').pop();
        const img = card.querySelector('.thumb img');
        const thumb = card.querySelector('.thumb');
        return { name, nw: img ? img.naturalWidth : 0,
                 loading: thumb.classList.contains('is-loading'),
                 spinner: getComputedStyle(thumb, '::after').content !== 'none',
                 broken: brokenThumbs.has(card.dataset.url) };
      });
      return {
        fastLoaded: rows.filter(r => r.name.startsWith('fast') && r.nw > 0).length,
        fastTotal: rows.filter(r => r.name.startsWith('fast')).length,
        slowLoading: rows.filter(r => r.name.startsWith('slow') && r.loading).length,
        slowSpinners: rows.filter(r => r.name.startsWith('slow') && r.spinner).length,
        slowBroken: rows.filter(r => r.name.startsWith('slow') && r.broken).length,
        cards: rows.length
      };`, 20000);
    console.log('\n1.5 秒时：', JSON.stringify(early));
    check('面板拿到全部卡片', early.cards === SLOW + FAST, early);
    check('慢图仍在下载时，快图缩略图不被阻塞', early.fastLoaded >= FAST - 1, early);
    check('慢图保持"加载中"，不被误判失效', early.slowLoading >= SLOW - 1 && early.slowBroken === 0, early);
    check('等待中的缩略图有旋转加载指示', early.slowSpinners >= SLOW - 1, early);

    // 等慢图下载完，所有缩略图都应补齐
    const done = await pop.ev(`
      const t0 = Date.now();
      for (;;) {
        const imgs = [...document.querySelectorAll('.thumb img')].filter(i => i.naturalWidth > 0);
        if (imgs.length >= ${SLOW + FAST} || Date.now() - t0 > 20000) break;
        await new Promise(r => setTimeout(r, 300));
      }
      return { loaded: [...document.querySelectorAll('.thumb img')].filter(i => i.naturalWidth > 0).length,
               fallbacks: document.querySelectorAll('.thumb .ph').length,
               broken: brokenThumbs.size };`, 30000);
    console.log('\n慢图完成后：', JSON.stringify(done));
    check('慢图下载完后全部缩略图补齐', done.loaded >= SLOW + FAST, done);
    check('过程中没有把正常图判为失效', done.broken === 0 && done.fallbacks === 0, done);

    const badHits = Object.entries(hits).filter(([, n]) => n > 1);
    console.log('\n服务器命中：', JSON.stringify(hits));
    check('每张图只从服务器下载一次（缩略图复用页面缓存）', badHits.length === 0, badHits);

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
    slowServer.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
