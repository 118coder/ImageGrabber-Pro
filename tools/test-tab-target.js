/* 验证 resolveTargetTab 三级回退（所有 stub 都在页面上下文里做） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8809;
const DEBUG_PORT = 9355;

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
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 70; raw[o + 1] = 140; raw[o + 2] = 230; } }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(800, 600);

const server = http.createServer((req, res) => {
  if (/\.png/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><body>${Array.from({ length: 6 }, (_, i) => `<img src="/t${i}.png" width="800" height="600">`).join('')}</body></html>`);
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
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}
async function conn(url, browser) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  const c = new CDP(ws);
  if (!browser) await c.send('Runtime.enable');
  return c;
}
const list = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
async function waitFor(fn, ms, label) {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    if (Date.now() - t > ms) throw new Error('timeout ' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
}

// 在页面里执行：临时替换 chrome.tabs.query，跑 resolveTargetTab，再还原
const withStub = (filterBody) => `
  const orig = chrome.tabs.query;
  chrome.tabs.query = function (q) {
    const real = orig.apply(chrome.tabs, arguments);
    return Promise.resolve(real).then((list) => (${filterBody})(q, list));
  };
  let out;
  try { out = await resolveTargetTab(); } finally { chrome.tabs.query = orig; }
  return out ? { id: out.id, url: out.url } : null;
`;

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-tab.log'), 'w');
  const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-tab-' + Date.now())}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    `--remote-debugging-port=${DEBUG_PORT}`, '--window-size=1000,700',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'ignore', logF] });

  try {
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 45000, 'sw');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);

    const pt = await b.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/`, background: false });
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, 'page');
    await new Promise((r) => setTimeout(r, 2000));

    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl, false);
    await new Promise((r) => setTimeout(r, 3000));

    console.log('[A] 正常：currentWindow 里就有网页');
    const a = await pop.ev('const t = await resolveTargetTab(); return t ? {id:t.id,url:t.url} : null;');
    console.log('    ', JSON.stringify(a));
    check('找到测试页', !!a && /127\.0\.0\.1/.test(a.url), a);

    console.log('\n[B] 模拟弹窗成独立窗口：currentWindow 里只有扩展页');
    const bres = await pop.ev(withStub(`(q, list) => (q && q.currentWindow) ? list.filter((t) => /^chrome-extension:/.test(t.url || '')) : list`));
    console.log('    ', JSON.stringify(bres));
    check('第 2 级回退找到网页（不再返回扩展页）', !!bres && /127\.0\.0\.1/.test(bres.url), bres);

    console.log('\n[C] 模拟连 lastFocusedWindow 也只有扩展页');
    const cres = await pop.ev(withStub(`(q, list) => (q && (q.currentWindow || q.lastFocusedWindow)) ? list.filter((t) => /^chrome-extension:/.test(t.url || '')) : list`));
    console.log('    ', JSON.stringify(cres));
    check('第 3 级全浏览器兜底找到网页', !!cres && /127\.0\.0\.1/.test(cres.url), cres);

    console.log('\n[D] 模拟一个网页都没有');
    const dres = await pop.ev(
      'const orig = chrome.tabs.query;' +
      "chrome.tabs.query = function () { return Promise.resolve([{ id: 1, url: 'chrome-extension://x/src/popup.html' }]); };" +
      'let out; try { out = await resolveTargetTab(); } finally { chrome.tabs.query = orig; }' +
      'return out;');
    console.log('    ', JSON.stringify(dres));
    check('返回 null 而不是扩展页', dres === null, dres);

    console.log('\n[E] 无网页时点扫描：应给出明确原因而不是笼统"没有图片"');
    const eres = await pop.ev(
      'const orig = chrome.tabs.query;' +
      "chrome.tabs.query = function () { return Promise.resolve([{ id: 1, url: 'chrome-extension://x/src/popup.html' }]); };" +
      'let out; try { await rescan(); await new Promise(r=>setTimeout(r,400));' +
      '  out = { emptyHidden: document.getElementById("empty").hidden,' +
      '          emptyText: document.getElementById("emptyText").textContent.slice(0, 80) };' +
      '} finally { chrome.tabs.query = orig; }' +
      'return out;');
    console.log('    ', JSON.stringify(eres));
    check('空状态确实显示', eres.emptyHidden === false, eres);
    check('文案说明"找不到标签页"，不是"没有找到图片"', /找不到/.test(eres.emptyText), eres.emptyText);

    console.log('\n[F] 恢复后能正常扫描');
    const fres = await pop.ev('await rescan(); await new Promise(r=>setTimeout(r,800));' +
      'return { allItems: allItems.length, viewItems: viewItems.length, cards: document.querySelectorAll(".card").length,' +
      '         count: document.getElementById("count").textContent };');
    console.log('    ', JSON.stringify(fres));
    check('扫描到 6 张以上', fres.allItems >= 6, fres);
    check('卡片渲染出来', fres.cards >= 6, fres);

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
