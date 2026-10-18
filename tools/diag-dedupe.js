/* =============================================================================
 * 诊断工具：在真实页面上把"重复合并"的分组结果打出来
 *   · 每组保留了哪条、合并了几条、判定依据是什么
 *   · 每个被折叠地址的来源，便于确认是不是把不同的图合到一起了
 * 用法： node tools/diag-dedupe.js "https://www.pokemon.cn/tcg/product/22850.html"
 * =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEBUG_PORT = 9411;
const TARGET = process.argv[2] || 'https://www.pokemon.cn/tcg/product/22850.html';

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
  async ev(expr, ms = 90000) {
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
    } catch (_) {
      /* 继续 */
    }
    if (Date.now() - t > ms) throw new Error('超时：' + label);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'igp-diag-' + Date.now());
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-diag.log'), 'w');
  const proc = spawn(
    exe,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--load-extension=${ROOT}`,
      `--disable-extensions-except=${ROOT}`,
      '--remote-debugging-port=' + DEBUG_PORT,
      '--window-size=1200,900',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', logF] }
  );
  try {
    // 只认本仓库的 background.js：这台机器上可能还装着别的扩展，
    // 抓第一个 service_worker 会拿到别人家的（曾经因此扫出 0 条）
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 45000, 'sw');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    console.log('扩展实例：', extId, sw.url);
    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);

    const pt = await b.send('Target.createTarget', { url: TARGET, background: false });
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 30000, 'page');
    console.log('页面已打开，等待加载与懒加载…');
    // 真实站点慢：等页面完成加载 + 滚动唤醒懒加载，再开始扫描
    await sleep(4000);
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    const pageReady = await waitFor(
      async () => {
        const t = (await list()).find((x) => x.id === pt.targetId);
        return t && t.webSocketDebuggerUrl ? t : null;
      },
      20000,
      'page ws'
    );
    const page = await conn(pageReady.webSocketDebuggerUrl);
    for (let i = 0; i < 25; i++) {
      const st = await page.ev(
        `return { ready: document.readyState, imgs: document.images.length, scripts: document.scripts.length };`,
        8000
      );
      if (st && st.ready === 'complete' && st.imgs > 0) {
        console.log('页面就绪：', JSON.stringify(st));
        break;
      }
      await page.ev('window.scrollBy(0, 1200); return 1;', 5000);
      await sleep(700);
    }
    await sleep(2000);

    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    await b.send('Target.activateTarget', { targetId: qt.targetId });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl);
    await sleep(2500);

    console.log('扫描…');
    const scanned = await pop.ev(
      `
      await rescan();
      return { ids: allItems.length, cards: document.querySelectorAll('.card').length };`,
      120000
    );
    console.log('扫描结果：', JSON.stringify(scanned));

    // 等缩略图（指纹/MD5 都来自这条链路）
    const fp = await pop.ev(
      `
      for (let i = 0; i < 120 && contentFp.size < Math.min(20, allItems.length); i++) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 2500));
      const withFp = [...contentFp.values()].filter(v => v.fpx).length;
      const withMd5 = [...contentFp.values()].filter(v => v.md5).length;
      return { fp: contentFp.size, withFp, withMd5 };`,
      120000
    );
    console.log('内容指纹：', JSON.stringify(fp));

    for (const level of ['standard', 'strict']) {
      const out = await pop.ev(
        `
        const res = IGPDedupe.dedupe(allItems, { content: contentFp, level: ${JSON.stringify(level)} });
        const groups = res.list.filter(i => i.dupCount > 1).map(i => ({
          keep: i.url,
          name: i.url.split('/').pop().split('?')[0],
          dupCount: i.dupCount,
          reason: i.dupReason,
          w: i.w, h: i.h,
          fpx: (contentFp.get(i.url) || {}).fpx || '',
          urls: i.dupUrls.map(u => u.split('/').pop())
        }));
        return {
          level: ${JSON.stringify(level)},
          total: allItems.length,
          visible: res.list.length,
          hidden: res.hidden,
          groups
        };`,
        120000
      );
      console.log('\n===== 判定等级：' + level + ' =====');
      console.log('扫描 ' + out.total + ' 条 → 显示 ' + out.visible + ' 条，折叠 ' + out.hidden + ' 条');
      for (const g of out.groups) {
        console.log(`\n[${g.reason}] ×${g.dupCount}  保留 ${g.name}  ${g.w}×${g.h}  fpx=${g.fpx || '—'}`);
        console.log('   折叠：' + g.urls.join('\n         '));
      }
    }
  } finally {
    try {
      proc.kill();
    } catch (_) {
      /* ignore */
    }
    fs.closeSync(logF);
  }
  process.exit(0);
})().catch((e) => {
  console.error('诊断失败：', e);
  process.exit(1);
});
