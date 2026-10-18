/* =============================================================================
 * 防盗链双策略测试：验证「伪装 Referer」和「清空 Referer」两条路都生效
 *
 * 真实站点的防盗链有两种常见实现：
 *   A. 要求 Referer 属于自己域名（否则 403）
 *   B. 把"没有 Referer"当作直接访问而放行（带错 Referer 反而 403）
 * 只做 A 的话，B 类站点会失败；两条都试才能覆盖。
 *
 * 用法： node tools/test-hotlink.js
 * =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8823;
const DEBUG_PORT = 9389;
const HOST = `http://127.0.0.1:${PORT}`;

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
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMG = png(600, 400, [60, 130, 220]);

/** 请求日志：记录每种资源收到的 Referer */
const seen = { needSameOrigin: [], needNoReferer: [], plain: [] };

const server = http.createServer((req, res) => {
  const ref = req.headers.referer || '';
  const url = req.url;

  // A 类：要求 Referer 是自己域名
  if (url.startsWith('/need-same-origin')) {
    seen.needSameOrigin.push(ref || '(none)');
    if (!ref.startsWith(HOST)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('hotlink blocked: bad referer');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(IMG);
    return;
  }

  // B 类：只放行"没有 Referer"的请求（有 Referer 反而拦）
  if (url.startsWith('/need-no-referer')) {
    seen.needNoReferer.push(ref || '(none)');
    if (ref) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('hotlink blocked: referer present');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(IMG);
    return;
  }

  if (url.startsWith('/plain')) {
    seen.plain.push(ref || '(none)');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(IMG);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><body>
    <img src="/need-same-origin-a.png" width="600" height="400">
    <img src="/need-no-referer-b.png" width="600" height="400">
    <img src="/plain-c.png" width="600" height="400">
  </body></html>`);
});

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.j(new Error(m.error.message)) : q.r(m.result); }
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr, ms = 60000) {
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

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-hotlink.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-hl-' + Date.now())}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=' + DEBUG_PORT, '--window-size=1000,700',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'ignore', logF] });

  try {
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 45000, 'sw');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    const swCdp = await conn(sw.webSocketDebuggerUrl, false);
    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);

    const pt = await b.send('Target.createTarget', { url: `${HOST}/`, background: false });
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, 'page');
    await new Promise((r) => setTimeout(r, 2500));

    console.log('[1] A 类：要求 Referer 同域');
    const r1 = await swCdp.ev(`
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => (t.url||'').includes('127.0.0.1:${PORT}'));
      if (!tab) return 'NO_TAB';
      const res = await fetchWithHotlinkRetry(
        '${HOST}/need-same-origin-a.png',
        '${HOST}/',
        () => offscreenCall({ type: 'FETCH', url: '${HOST}/need-same-origin-a.png', wantDataUrl: false, timeout: 20000 })
      );
      return { ok: !!(res && res.ok), size: res && res.size, err: res && res.error };`, 40000);
    console.log('    ', JSON.stringify(r1));
    check('伪装 Referer 后能取到', r1 && r1.ok === true, r1);

    console.log('\n[2] B 类：只放行"无 Referer"');
    const r2 = await swCdp.ev(`
      const res = await fetchWithHotlinkRetry(
        '${HOST}/need-no-referer-b.png',
        '${HOST}/',
        () => offscreenCall({ type: 'FETCH', url: '${HOST}/need-no-referer-b.png', wantDataUrl: false, timeout: 20000 })
      );
      return { ok: !!(res && res.ok), size: res && res.size, err: res && res.error };`, 40000);
    console.log('    ', JSON.stringify(r2));
    check('伪装失败后清空 Referer 能取到', r2 && r2.ok === true, r2);

    console.log('\n[3] 服务器实际收到的 Referer');
    console.log('    A 类:', JSON.stringify(seen.needSameOrigin));
    console.log('    B 类:', JSON.stringify(seen.needNoReferer));
    check('A 类收到过来自本站的 Referer', seen.needSameOrigin.some((r) => r.startsWith(HOST)), seen.needSameOrigin);
    check('B 类收到过空 Referer', seen.needNoReferer.includes('(none)'), seen.needNoReferer);

    console.log('\n[4] 普通图不受影响');
    const r4 = await swCdp.ev(`
      const res = await fetchWithHotlinkRetry(
        '${HOST}/plain-c.png',
        '${HOST}/',
        () => offscreenCall({ type: 'FETCH', url: '${HOST}/plain-c.png', wantDataUrl: false, timeout: 20000 })
      );
      return { ok: !!(res && res.ok), size: res && res.size };`, 40000);
    console.log('    ', JSON.stringify(r4));
    check('无防盗链的图正常取到', r4 && r4.ok === true && r4.size > 0, r4);
    // 页面自身已加载过一次（<img src="/plain-c.png">），测试再取一次 → 共 2 次；
    // 若重试逻辑写错（成功仍继续），这里会是 3 次以上。
    check('成功即停止，不做多余重试（页面 1 次 + 测试 1 次）', seen.plain.length === 2, seen.plain.length);

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
