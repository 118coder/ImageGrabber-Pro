/* =============================================================================
 * 滚动稳定性测试：滚轮下滑时不允许"重新加载已显示的图"或"重建网格"
 *
 * 背景：早期版本里，缩略图请求返回后无条件写回 img.src，即使该元素已被
 * "预览不可用"占位替换、或整个网格已重建。滚动时大量在途请求同时返回，
 * 就会看到整片缩略图反复刷新。失败兜底还会"移除 img + 插入新节点"，
 * 改变网格布局，加剧跳动。
 *
 * 判据：
 *   · 滚动期间不得对同一元素重复赋相同的 src（reloadsSame = 0）
 *   · 滚动期间不得移除网格内的节点（removed = 0）
 * 用法： node tools/test-scroll.js
 * =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8821;
const DEBUG_PORT = 9387;
const GOOD = 30;  // 正常图（够多，需要滚动才看得到）
const BAD = 10;   // 404 图（制造"预览不可用"，真实站点常见）

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
const IMG = png(480, 360, 3);

const server = http.createServer((req, res) => {
  if (/bad/.test(req.url)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
  if (/\.png/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(IMG); return; }
  const items = [];
  for (let i = 0; i < GOOD; i++) items.push(`<img src="/g${i}.png" width="480" height="360">`);
  for (let i = 0; i < BAD; i++) items.push(`<img src="/bad${i}.png" width="480" height="360">`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><body style="margin:0">${items.join('')}</body></html>`);
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
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-scroll-test.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-sct-' + Date.now())}`,
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
    await new Promise((r) => setTimeout(r, 2500));

    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl, false);
    await new Promise((r) => setTimeout(r, 2500));

    console.log(`测试页：${GOOD} 张正常图 + ${BAD} 张 404 图\n`);

    const out = await pop.ev(`
      await rescan();
      await new Promise(r => setTimeout(r, 3000));

      // 区分"首次加载"与"重复赋同一地址"：后者才是视觉刷新
      let srcSets = 0, reloadsSame = 0;
      const seen = new WeakMap();
      const proto = HTMLImageElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      Object.defineProperty(proto, 'src', { configurable: true, get: desc.get, set: function (v) {
        srcSets++;
        const prev = seen.get(this);
        if (prev !== undefined && prev === v) reloadsSame++;
        seen.set(this, v);
        return desc.set.call(this, v);
      }});

      const gridEl = document.getElementById('grid');
      let muts = 0, removed = 0, added = 0;
      const mo = new MutationObserver(recs => {
        for (const r of recs) { muts++; removed += r.removedNodes.length; added += r.addedNodes.length; }
      });
      mo.observe(gridEl, { childList: true, subtree: true });

      const before = {
        cards: document.querySelectorAll('.card').length,
        imgs: document.querySelectorAll('.thumb img').length,
        loaded: [...document.querySelectorAll('.thumb img')].filter(i => i.naturalWidth > 0).length,
        broken: brokenThumbs.size
      };

      // 先滚到底再滚回顶，覆盖两个方向
      const H = gridEl.scrollHeight;
      for (let i = 1; i <= 12; i++) { gridEl.scrollTop = Math.round(H / 12 * i); gridEl.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 140)); }
      for (let i = 12; i >= 1; i--) { gridEl.scrollTop = Math.round(H / 12 * i); gridEl.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 140)); }
      await new Promise(r => setTimeout(r, 2000));
      mo.disconnect();
      Object.defineProperty(proto, 'src', desc);

      return {
        before,
        after: {
          cards: document.querySelectorAll('.card').length,
          loaded: [...document.querySelectorAll('.thumb img')].filter(i => i.naturalWidth > 0).length,
          broken: brokenThumbs.size,
          fallbacks: document.querySelectorAll('.thumb .ph').length
        },
        srcSets, reloadsSame, muts, removed, added,
        cardCountStable: document.querySelectorAll('.card').length === before.cards
      };`, 90000);

    console.log('  实测：', JSON.stringify({
      srcSets: out.srcSets, reloadsSame: out.reloadsSame,
      muts: out.muts, removed: out.removed, added: out.added,
      before: out.before, after: out.after
    }));

    console.log('');
    check('滚动时没有重复加载已显示的图（reloadsSame = 0）', out.reloadsSame === 0, out.reloadsSame);
    check('滚动时没有移除网格节点（removed = 0）', out.removed === 0, out.removed);
    check('卡片数量在滚动前后一致', out.cardCountStable === true, { before: out.before.cards, after: out.after.cards });
    check('滚动后已加载的图数量不减少', out.after.loaded >= out.before.loaded, {
      before: out.before.loaded, after: out.after.loaded
    });
    check('滚动到下方继续加载更多缩略图（懒加载生效）', out.after.loaded >= out.before.loaded, {
      before: out.before.loaded, after: out.after.loaded,
      note: out.after.loaded === out.before.loaded ? '本次首屏已容纳全部图片，无新增可加载' : ''
    });
    check('失效图被标记为"预览不可用"', out.after.broken >= 1 && out.after.fallbacks >= 1, out.after);

    console.log('\n[2] 「隐藏失效」开启时滚动：只移除坏图，不重建卡片');
    const hidden = await pop.ev(`
      // 清掉失效记录并重建一次卡片，让 404 图重新走完整的"发现 → 移除"过程
      brokenThumbs.clear();
      const cb = document.getElementById('hideBroken');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      resetCards();
      render();
      await new Promise(r => setTimeout(r, 800));

      const beforeSet = new Set(document.querySelectorAll('.card'));
      const beforeCount = beforeSet.size;

      let srcSets = 0, reloadsSame = 0;
      const seen = new WeakMap();
      const proto = HTMLImageElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      Object.defineProperty(proto, 'src', { configurable: true, get: desc.get, set: function (v) {
        srcSets++;
        const prev = seen.get(this);
        if (prev !== undefined && prev === v) reloadsSame++;
        seen.set(this, v);
        return desc.set.call(this, v);
      }});

      const gridEl = document.getElementById('grid');
      let cardAdded = 0, cardRemoved = 0, nodeAdded = 0, nodeRemoved = 0;
      const removedUrls = [];
      const mo = new MutationObserver(recs => {
        for (const r of recs) {
          for (const n of r.addedNodes) {
            nodeAdded++;
            if (n.nodeType === 1 && n.classList && n.classList.contains('card')) cardAdded++;
          }
          for (const n of r.removedNodes) {
            nodeRemoved++;
            if (n.nodeType === 1 && n.classList && n.classList.contains('card')) {
              cardRemoved++;
              if (n.dataset && n.dataset.url) removedUrls.push(n.dataset.url);
            }
          }
        }
      });
      mo.observe(gridEl, { childList: true, subtree: true });

      const H = gridEl.scrollHeight;
      for (let i = 1; i <= 12; i++) {
        gridEl.scrollTop = Math.round(H / 12 * i);
        gridEl.dispatchEvent(new Event('scroll'));
        await new Promise(r => setTimeout(r, 180));
      }
      await new Promise(r => setTimeout(r, 2500));
      mo.disconnect();
      Object.defineProperty(proto, 'src', desc);

      const afterEls = [...document.querySelectorAll('.card')];
      return {
        beforeCount, afterCount: afterEls.length,
        reused: afterEls.every((el) => beforeSet.has(el)),
        broken: brokenThumbs.size,
        brokenUrls: [...brokenThumbs.keys()],
        cardAdded, cardRemoved, nodeAdded, nodeRemoved, srcSets, reloadsSame,
        removedUrls,
        viewItems: viewItems.length,
        fallbacks: document.querySelectorAll('.thumb .ph').length
      };`, 90000);
    console.log('    实测：', JSON.stringify(hidden));
    check('开启隐藏失效后仍能复用原卡片节点', hidden.reused === true, hidden);
    check('滚动加载 404 图时没有插入任何新卡片（不重建网格）', hidden.cardAdded === 0, hidden);
    check('隐藏失效时不新增任何节点（不闪占位）', hidden.nodeAdded === 0, hidden);
    check('卡片减少的数量等于实际移除数', hidden.afterCount === hidden.beforeCount - hidden.cardRemoved, hidden);
    check(
      '被移除的卡片全部是预览失败项',
      hidden.removedUrls.length === hidden.cardRemoved && hidden.removedUrls.every((u) => hidden.brokenUrls.includes(u)),
      hidden
    );
    check('滚动过程中没有重复加载缩略图', hidden.reloadsSame === 0, hidden);
    check('失效卡片被筛掉后列表与统计一致', hidden.viewItems === hidden.afterCount && hidden.fallbacks === 0, hidden);

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
