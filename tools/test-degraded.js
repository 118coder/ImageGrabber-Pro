/* =============================================================================
 * 降级场景测试：模拟"所有站点都扫不到图"的各种坏环境，
 * 断言弹窗必须显示可读原因，绝不能停在"空白无提示"。
 * 用法： node tools/test-degraded.js
 * =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8811;
const DEBUG_PORT = 9373;

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
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 80; raw[o + 1] = 150; raw[o + 2] = 220; } }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(600, 400);

const server = http.createServer((req, res) => {
  if (/\.png/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><body>${Array.from({ length: 5 }, (_, i) => `<img src="/d${i}.png" width="600" height="400">`).join('')}</body></html>`);
});

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map(); this.logs = []; this.exc = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.j(new Error(m.error.message)) : q.r(m.result); }
      if (m.method === 'Runtime.consoleAPICalled') this.logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      if (m.method === 'Runtime.exceptionThrown') this.exc.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr, ms = 30000) {
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
function check(n, c, x) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 300) : '')); }
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-degraded.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-dg-' + Date.now())}`,
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
    await new Promise((r) => setTimeout(r, 2500));

    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl, false);
    await new Promise((r) => setTimeout(r, 2500));

    // 先确认基线正常
    console.log('[0] 基线与自检');
    const base = await pop.ev('await rescan(); await new Promise(r=>setTimeout(r,600));' +
      'return { allItems: allItems.length, cards: document.querySelectorAll(".card").length,' +
      '         chip: document.getElementById("count").textContent };');
    check('正常环境能扫到图', base.allItems >= 5, base);

    const diag = await pop.ev('const d = await runSelfCheck(); return d;');
    check('自检接口可用', diag && diag.ok === true, diag);
    check('自检报告包含扩展版本', !!diag.version, diag.version);
    check('自检报告包含内容脚本状态', typeof diag.scripts === 'string' || Array.isArray(diag.scripts), diag.scripts);

    // ---- 场景 1：后台永远不响应
    console.log('\n[1] 后台采集永久无响应 → 必须提示超时，不能空白');
    const s1 = await pop.ev(`
      const orig = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function (msg, cb) {
        if (msg && msg.type === 'IGP_COLLECT') return; // 永不回调
        return orig.apply(chrome.runtime, arguments);
      };
      let out;
      try {
        await rescan();
        await new Promise(r => setTimeout(r, 300));
        out = {
          chip: document.getElementById('count').textContent,
          cards: document.querySelectorAll('.card').length,
          emptyHidden: document.getElementById('empty').hidden,
          text: document.getElementById('emptyText').textContent.slice(0, 90),
          spinning: document.getElementById('rescan').classList.contains('spin')
        };
      } finally { chrome.runtime.sendMessage = orig; }
      return out;`, 40000);
    console.log('    ', JSON.stringify(s1));
    check('超时后空状态可见（不是空白）', s1.emptyHidden === false, s1);
    check('提示里说明了超时', /超时|过慢/.test(s1.text), s1.text);
    check('刷新按钮不再转圈', s1.spinning === false, s1);

    // ---- 场景 2：后台返回失败
    console.log('\n[2] 后台返回扫描失败 → 显示具体错误');
    const s2 = await pop.ev(`
      const orig = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function (msg, cb) {
        if (msg && msg.type === 'IGP_COLLECT') { cb({ ok: false, error: '模拟：页面脚本无响应' }); return; }
        return orig.apply(chrome.runtime, arguments);
      };
      let out;
      try {
        await rescan();
        await new Promise(r => setTimeout(r, 300));
        out = { emptyHidden: document.getElementById('empty').hidden,
                text: document.getElementById('emptyText').textContent.slice(0, 90) };
      } finally { chrome.runtime.sendMessage = orig; }
      return out;`, 30000);
    console.log('    ', JSON.stringify(s2));
    check('失败原因显示出来', s2.emptyHidden === false && /模拟|无响应/.test(s2.text), s2);

    // ---- 场景 3：后台返回 0 张
    console.log('\n[3] 扫到 0 张 → 给出排查建议');
    const s3 = await pop.ev(`
      const orig = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function (msg, cb) {
        if (msg && msg.type === 'IGP_COLLECT') { cb({ ok: true, items: [], stats: { ms: 3, frames: 1 } }); return; }
        return orig.apply(chrome.runtime, arguments);
      };
      let out;
      try {
        await rescan();
        await new Promise(r => setTimeout(r, 300));
        out = { chip: document.getElementById('count').textContent,
                emptyHidden: document.getElementById('empty').hidden,
                text: document.getElementById('emptyText').textContent.slice(0, 100) };
      } finally { chrome.runtime.sendMessage = orig; }
      return out;`, 30000);
    console.log('    ', JSON.stringify(s3));
    check('0 张时徽标显示 0', s3.chip === '0', s3);
    check('0 张时给出可操作建议', s3.emptyHidden === false && /深度|彻底|滚动/.test(s3.text), s3);

    // ---- 场景 4：某条数据缺字段（渲染不能整片崩掉）
    console.log('\n[4] 脏数据（url 缺失/异常）→ 跳过该条，其余照常渲染');
    const s4 = await pop.ev(`
      const orig = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function (msg, cb) {
        if (msg && msg.type === 'IGP_COLLECT') {
          cb({ ok: true, items: [
            { url: 'http://x/a.png', kind: 'img', w: 500, h: 400, alt: '' },
            { kind: 'img', w: 100, h: 100 },           // 缺 url
            null,                                       // 空条目
            { url: 'http://x/b.png', kind: 'img' },    // 缺尺寸
            { url: 'http://x/c.png', kind: 'weird' }   // 未知类型
          ], stats: { ms: 5, frames: 1 } });
          return;
        }
        return orig.apply(chrome.runtime, arguments);
      };
      let out;
      try {
        await rescan();
        await new Promise(r => setTimeout(r, 500));
        out = { allItems: allItems.length, cards: document.querySelectorAll('.card').length,
                emptyHidden: document.getElementById('empty').hidden };
      } finally { chrome.runtime.sendMessage = orig; }
      return out;`, 30000);
    console.log('    ', JSON.stringify(s4));
    check('脏数据不会让整个面板崩掉', s4.cards >= 1, s4);

    // ---- 场景 5：恢复后仍能正常工作
    console.log('\n[5] 恢复正常后可用');
    const s5 = await pop.ev('await rescan(); await new Promise(r=>setTimeout(r,800));' +
      'return { allItems: allItems.length, cards: document.querySelectorAll(".card").length };');
    console.log('    ', JSON.stringify(s5));
    check('恢复正常后重新扫到图', s5.allItems >= 5, s5);

    console.log('\n[控制台异常]');
    if (!pop.exc.length) console.log('  （无）');
    pop.exc.slice(0, 8).forEach((l) => console.log('  ' + String(l).split('\n')[0]));

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n测试异常：', e.message); process.exit(1); });
