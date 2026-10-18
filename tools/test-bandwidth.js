/* =============================================================================
 * 带宽测试：验证缩略图复用页面已加载的图片，而不是重新下载一遍。
 *
 * 背景：Chromium 的 HTTP 缓存按顶层站点分区，扩展 offscreen 文档属于
 * chrome-extension:// 分区，和网页分区隔离——早期实现打开面板时会把页面上
 * 已加载过的图片完整重下一遍。现在改由页面内内容脚本读取已加载元素的像素。
 *
 * 判据：服务端在面板阶段收到的图片字节数应接近 0。
 * 用法： node tools/test-bandwidth.js
 * =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8817;
const DEBUG_PORT = 9379;
const N = 12;              // 图片数量（同时验证并发池）
const W = 1600, H = 1200;  // 每张尺寸（做成难压缩的噪声图，体积接近真实照片）

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
function noisePng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let s = seed * 7919;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      raw[o] = s & 255;
      raw[o + 1] = (s >> 8) & 255;
      raw[o + 2] = (s >> 16) & 255;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
const IMGS = [];
for (let i = 0; i < N; i++) IMGS.push(noisePng(W, H, i + 1));
const TOTAL = IMGS.reduce((a, b) => a + b.length, 0);
console.log(`测试页：${N} 张 ${W}x${H}，合计 ${(TOTAL / 1048576).toFixed(2)} MB`);

// 服务端统计：这是最可靠的量测点——不管请求来自页面、offscreen 还是缓存回源
const served = { phase: 'page', page: { reqs: 0, bytes: 0 }, popup: { reqs: 0, bytes: 0 } };
const server = http.createServer((req, res) => {
  const m = /\/pic(\d+)\.png/.exec(req.url);
  if (m) {
    const buf = IMGS[Number(m[1]) % N];
    const bucket = served[served.phase];
    bucket.reqs++;
    bucket.bytes += buf.length;
    const ref = req.headers.referer || '(none)';
    const src = /chrome-extension:/.test(ref) ? 'offscreen' : (/127\.0\.0\.1/.test(ref) ? 'page' : 'direct');
    bucket.by = bucket.by || {};
    bucket.by[src + '|' + ref.slice(0, 40)] = (bucket.by[src + '|' + ref.slice(0, 40)] || 0) + 1;
    // 给每个响应打 ETag，浏览器下次就会用条件请求验证，可据此分辨"是否真的重新传了正文"
    const etag = '"v1-' + m[1] + '"';
    const inm = req.headers['if-none-match'];
    if (inm === etag) {
      bucket.notModified = (bucket.notModified || 0) + 1;
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=3600' });
      res.end();
      return;
    }
    bucket.fullBody = (bucket.fullBody || 0) + 1;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, ETag: etag, 'Cache-Control': 'public, max-age=3600' });
    res.end(buf);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><body style="margin:0">${Array.from({ length: N }, (_, i) => `<img src="/pic${i}.png" width="800" height="600" style="display:block">`).join('')}</body></html>`);
});

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map();
    this.imgBytes = 0; this.imgReqs = 0; this.fromCache = 0;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.j(new Error(m.error.message)) : q.r(m.result); }
      if (m.method === 'Network.requestWillBeSent' && /\.png/.test(m.params.request.url)) {
        this.imgReqs++;
        this.imgUrls = this.imgUrls || new Set();
        this.imgUrls.add(m.params.request.url.split('/').pop());
      }
      if (m.method === 'Network.responseReceived' && /\.png/.test(m.params.response.url)) {
        const r = m.params.response;
        if (r.fromDiskCache || r.fromMemoryCache) this.fromCache++;
      }
      if (m.method === 'Network.loadingFinished') {
        const t = this.reqType && this.reqType[m.params.requestId];
        if (t) this.imgBytes += m.params.encodedDataLength || 0;
      }
    });
  }
  async trackRequests() {
    // 记录哪些 requestId 是图片
    await this.send('Network.enable').catch(() => {});
    this.reqType = this.reqType || {};
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Network.requestWillBeSent' && /\.png/.test(m.params.request.url)) this.reqType[m.params.requestId] = 'img';
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
  await c.trackRequests();
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

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 200) : ''));
  }
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-measure.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-ms-' + Date.now())}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=' + DEBUG_PORT, '--window-size=1000,700',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'ignore', logF] });

  try {
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 45000, 'sw');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);

    const pt = await b.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/`, background: false });
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, 'page');
    await new Promise((r) => setTimeout(r, 4000));

    console.log('\n--- 页面阶段结束（图片已全部加载并进入 HTTP 缓存）---');
    served.phase = 'popup';

    // 打开面板：开始监听扩展侧的图片请求
    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl, false);
    await new Promise((r) => setTimeout(r, 2500));

    const t0 = Date.now();
    const st = await pop.ev(`
      await rescan();
      const t0 = Date.now();
      for (;;) {
        const imgs = [...document.querySelectorAll('.thumb img')];
        const ok = imgs.filter(i => i.naturalWidth > 0).length;
        if (ok >= ${N} || Date.now() - t0 > 25000) break;
        await new Promise(r => setTimeout(r, 200));
      }
      // 直接问一次后台缩略图通道，看它走的是哪条路
      let via = null;
      try {
        const probeItem = allItems.find(i => i.url.indexOf('/pic') !== -1);
        const probe = await sendBg({ type: 'IGP_THUMB', url: probeItem ? probeItem.url : '',
          pageUrl: pageUrl, tabId, frameId: 0, maxSide: 256 });
        via = probe && (probe.via || probe.error);
      } catch (e) { via = 'ERR ' + e.message; }
      return { cards: document.querySelectorAll('.card').length,
               loaded: [...document.querySelectorAll('.thumb img')].filter(i => i.naturalWidth > 0).length,
               waited: Date.now() - t0, thumbVia: via };`, 40000);
    const elapsed = Date.now() - t0;
    console.log('\n[服务端视角]');
    console.log('  页面阶段: ' + served.page.reqs + ' 次请求, ' + (served.page.bytes / 1048576).toFixed(2) + ' MB');
    console.log('  面板阶段: ' + served.popup.reqs + ' 次请求, ' + (served.popup.bytes / 1048576).toFixed(2) + ' MB');

    console.log('\n[面板阶段]');
    
    console.log('  加载结果:', JSON.stringify(st));
    console.log('  总耗时:', elapsed, 'ms');

    const ratio = served.popup.bytes / TOTAL;
    console.log('\n结论：面板阶段额外下载了 ' + (ratio * 100).toFixed(1) + '% 的图片数据');

    console.log('');
    check('缩略图复用页面已加载的图片（额外下载 < 1%）', ratio < 0.01, { ratio: ratio.toFixed(4), bytes: served.popup.bytes });
    check('缩略图来源是已加载元素 / 页面缓存', st.thumbVia === 'element' || st.thumbVia === 'page-cache', st.thumbVia);
    check('所有图片都生成了缩略图', st.loaded >= N, { loaded: st.loaded, expect: N });
    check('面板打开到出齐缩略图 < 3 秒', elapsed < 3000, elapsed);
    check('页面阶段是完整下载（对照基准）', served.page.bytes === TOTAL, { got: served.page.bytes, expect: TOTAL });

    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
