/* 整页图库 viewer.html 真机冒烟
 *   · 走真实右键入口的数据路径：后台采集 → session handoff → 打开图库
 *   · 验证新 UI 下列表渲染、卡片选择、失效筛选与基础配色
 * 用法： node tools/test-viewer.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8835;
const DEBUG_PORT = 9395;

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
      raw[o] = (x * 3 + seed * 17) & 255;
      raw[o + 1] = (y * 5 + seed * 31) & 255;
      raw[o + 2] = (x * y + seed * 7) & 255;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMG = png(600, 400, 4);

/**
 * 高频细棋盘图：缩到 9×8 采样后对比度几乎为 0。
 * 这类图不会被"画面一致"查重合并——本用例要测的是渲染与调度，
 * 卡片被合并掉就测不到东西了。（原来的固定 IMG 会被正确判为重复）
 */
function noisePng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const v = (((x >> 1) + (y >> 1) + seed) & 1) ? 240 : 20;
      raw[o] = v;
      raw[o + 1] = v;
      raw[o + 2] = v;
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
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}


const server = http.createServer((req, res) => {
  if (/missing/.test(req.url)) { res.writeHead(404); res.end('404'); return; }
  const vm = /\/v(\d+)\.png/.exec(req.url);
  if (vm) {
    // 每个地址给一张画面不同的图：内容相同的话会被查重合并，测的就不是图库渲染了
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(noisePng(600, 400, Number(vm[1])));
    return;
  }
  if (/\.png/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(IMG); return; }
  const imgs = Array.from({ length: 12 }, (_, i) => `<img src="/v${i}.png" width="600" height="400">`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><title>图库来源页</title><body style="margin:0">${imgs}<img src="/missing.png" width="600" height="400"></body>`);
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

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
const isDark = (s) => (s.match(/\d+/g) || []).map(Number).reduce((a, v, i) => a + v * [0.299, 0.587, 0.114][i], 0) < 120;

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-viewer.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-vw-' + Date.now())}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=' + DEBUG_PORT, '--window-size=1400,900',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'ignore', logF] });

  try {
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 45000, 'sw');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);

    const pt = await b.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/`, background: false });
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, 'page');
    await new Promise((r) => setTimeout(r, 3000));

    // 走真实右键入口的数据路径：后台采集 → 写 handoff → 打开图库
    const swCdp = await conn(sw.webSocketDebuggerUrl, false);
    const prep = await swCdp.ev(`
      const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${PORT}/*' });
      const tab = tabs[0];
      if (!tab) return { ok: false, error: 'no tab' };
      const r = await collectAll(tab.id, { deep: true, thorough: false, scripts: true, budgetMs: 400 });
      await chrome.storage.session.set({ igp_handoff_smoke: {
        items: r.items || [], pageUrl: r.pageUrl, pageTitle: r.pageTitle, tabId: tab.id, ts: Date.now()
      }});
      return { ok: r.ok, count: (r.items || []).length, title: r.pageTitle };`);
    console.log('handoff:', JSON.stringify(prep));
    await new Promise((r) => setTimeout(r, 300));

    const vt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/viewer.html?id=smoke`, background: true });
    const vT = await waitFor(async () => (await list()).find((t) => t.id === vt.targetId), 20000, 'viewer');
    const v = await conn(vT.webSocketDebuggerUrl, false);
    await v.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 4000));

    const out = await v.ev(`
      const t0 = Date.now();
      for (;;) {
        const imgs = [...document.querySelectorAll('.thumb img')];
        const ok = imgs.filter(i => i.naturalWidth > 0).length;
        if (ok >= 5 || Date.now() - t0 > 15000) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const cards = [...document.querySelectorAll('.card')];
      const card = cards[0];
      const before = { cards: cards.length, loaded: [...document.querySelectorAll('.thumb img')].filter(i=>i.naturalWidth>0).length,
                       pageInfo: document.getElementById('pageInfo').textContent.slice(0, 50),
                       gridW: Math.round(document.getElementById('grid').getBoundingClientRect().width),
                       thumbH: Math.round((document.querySelector('.thumb')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height),
                       theme: document.documentElement.dataset.theme, styles: getComputedStyle(document.getElementById('q')).color };
      card.click();
      await new Promise(r => setTimeout(r, 60));
      const sel = { selected: card.classList.contains('selected'), checked: card.querySelector('input').checked,
                    stat: document.getElementById('stat').textContent, disabled: document.getElementById('dlSel').disabled };
      const box = card.querySelector('input');
      box.click();
      await new Promise(r => setTimeout(r, 60));
      const unsel = { selected: card.classList.contains('selected'), checked: box.checked, selectedSize: selected.size };
      const brokenBefore = document.querySelectorAll('.thumb .ph').length;
      const cb = document.getElementById('hideBroken');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const hidden = { before: before.cards, after: document.querySelectorAll('.card').length, broken: brokenBefore,
                       remainingPh: document.querySelectorAll('.thumb .ph').length };
      cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
      return { before, sel, unsel, hidden };`);
    console.log('  实测：', JSON.stringify(out));

    console.log('');
    check('后台能按真实路径采集并写 handoff', prep && prep.ok === true && prep.count >= 12, prep);
    check('图库渲染出全部卡片', out.before.cards >= 12, out.before);
    check('来源页标题正确带入', /图库来源页/.test(out.before.pageInfo || ''), out.before.pageInfo);
    check('缩略图真的加载出像素', out.before.loaded >= 10, out.before.loaded);
    check('图库网格横向铺满', out.before.gridW > 1000, out.before.gridW);
    check('缩略图沿用放大后的高度', out.before.thumbH >= 120, out.before.thumbH);
    check('默认浅色且搜索框文字为深色', out.before.theme === 'light' && isDark(out.before.styles), out.before);
    check('点卡片能选中并激活下载', out.sel.selected && out.sel.checked && !out.sel.disabled, out.sel);
    check('点复选框只切换一次', !out.unsel.selected && !out.unsel.checked && out.unsel.selectedSize === 0, out.unsel);
    check(
      '隐藏失效按数量筛掉卡片且不留占位',
      out.hidden.after === out.hidden.before - out.hidden.broken && out.hidden.remainingPh === 0,
      out.hidden
    );
    check('没有运行时异常', v.exc.length === 0, v.exc.slice(0, 3));

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
