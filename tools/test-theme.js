/* =============================================================================
 * 主题与「隐藏失效」真机验证
 *   1. 深色/浅色主题切换后，实际计算出的背景/文字颜色确实变了，且对比度可读
 *   2. 浅色主题底下确实是纯白
 *   3. 切换主题不重新请求图片（DOM 与 src 不变）
 *   4. 「隐藏失效」能把预览失败的条目筛掉，关闭后恢复
 *   5. 主题选择能持久化（重新打开面板后保持）
 * 用法： node tools/test-theme.js
 * =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8813;
const DEBUG_PORT = 9375;

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
/** 深色图片：用来验证浅色主题下能看清 */
function darkPng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 12; raw[o + 1] = 14; raw[o + 2] = 20;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = darkPng(500, 400);

const server = http.createServer((req, res) => {
  // 构造"预览不可用"：这两张必须是 404，否则测不到失效筛选
  if (/missing/.test(req.url)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (/\.png/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  // 最后两张故意指向不存在的地址，用来制造"预览不可用"
  res.end(`<!DOCTYPE html><body>
    ${Array.from({ length: 4 }, (_, i) => `<img src="/ok${i}.png" width="500" height="400">`).join('')}
    <img src="/missing-1.png" width="500" height="400">
    <img src="/missing-2.png" width="500" height="400">
  </body></html>`);
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
function check(n, c, x) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 260) : '')); }
}
const rgb = (s) => (s.match(/\d+/g) || []).map(Number);
const isWhite = (s) => { const [r, g, b] = rgb(s); return r === 255 && g === 255 && b === 255; };
const isDark = (s) => { const [r, g, b] = rgb(s); return r * 0.299 + g * 0.587 + b * 0.114 < 60; };
const isLight = (s) => { const [r, g, b] = rgb(s); return r * 0.299 + g * 0.587 + b * 0.114 > 200; };
/** 相对亮度对比度 */
function contrast(fg, bg) {
  const lum = (s) => {
    const [r, g, b] = rgb(s).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(fg), b2 = lum(bg);
  const hi = Math.max(a, b2), lo = Math.min(a, b2);
  return (hi + 0.05) / (lo + 0.05);
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-theme.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${path.join(os.tmpdir(), 'igp-th-' + Date.now())}`,
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

    const openPopup = async () => {
      const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
      const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
      const pop = await conn(qT.webSocketDebuggerUrl, false);
      await new Promise((r) => setTimeout(r, 2500));
      return { pop, targetId: qt.targetId };
    };

    let { pop, targetId } = await openPopup();

    console.log('[1] 基线：扫描并等缩略图出结果');
    const base = await pop.ev(`
      await rescan();
      const t0 = Date.now();
      for (;;) {
        const imgs = [...document.querySelectorAll('.thumb img')];
        const ok = imgs.filter(i => i.naturalWidth > 0).length;
        const bad = document.querySelectorAll('.thumb .ph').length;
        if ((ok >= 3 && bad >= 1) || Date.now() - t0 > 15000) break;
        await new Promise(r => setTimeout(r, 300));
      }
      return { allItems: allItems.length, cards: document.querySelectorAll('.card').length,
               loaded: [...document.querySelectorAll('.thumb img')].filter(i => i.naturalWidth > 0).length,
               broken: document.querySelectorAll('.thumb .ph').length,
               brokenMap: brokenThumbs.size, theme: state.theme };`);
    console.log('    ', JSON.stringify(base));
    check('扫到 6 张以上（含 favicon）', base.allItems >= 6, base);
    check('至少有 1 张预览失败（用于测试筛选）', base.broken >= 1, base);
    // 1.0.0 起默认是浅色：纯白底更利于辨识深色图片
    check('默认主题是浅色', base.theme === 'light', base.theme);

    console.log('\n[2] 默认（浅色）下的实际颜色');
    const dark = await pop.ev(`
      const body = getComputedStyle(document.body);
      const card = document.querySelector('.card');
      const cs = getComputedStyle(card);
      return { bodyBg: body.backgroundColor, bodyFg: body.color,
               cardBg: cs.backgroundColor, cardBorder: cs.borderTopColor,
               emptyBg: getComputedStyle(document.getElementById('text')||document.body).backgroundColor,
               dataTheme: document.documentElement.dataset.theme };`);
    console.log('    ', JSON.stringify(dark));
    check('data-theme 标记为 light', dark.dataTheme === 'light', dark);
    check('默认背景是纯白', isWhite(dark.bodyBg), dark.bodyBg);
    check('默认文字是深色', isDark(dark.bodyFg), dark.bodyFg);
    check('默认对比度达到 WCAG AA（≥ 4.5）', contrast(dark.bodyFg, dark.bodyBg) >= 4.5, contrast(dark.bodyFg, dark.bodyBg).toFixed(2));

    console.log('\n[2c] 表单文字可读性（浅色，重点防系统深色主题染色）');
    const form = await pop.ev(`
      const q = document.getElementById('q');
      const qs = getComputedStyle(q);
      const ss = getComputedStyle(document.querySelector('.search-box'));
      const controls = ['minSize', 'typeFilter', 'sort'].map(id => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return { id, color: cs.color, bg: cs.backgroundColor,
                 fill: cs.webkitTextFillColor, scheme: cs.colorScheme, opacity: cs.opacity };
      });
      return {
        search: { color: qs.color, bg: ss.backgroundColor, fill: qs.webkitTextFillColor, scheme: qs.colorScheme },
        placeholder: getComputedStyle(q, '::placeholder').color,
        controls,
        rootScheme: getComputedStyle(document.documentElement).colorScheme
      };`);
    console.log('    ', JSON.stringify(form));
    for (const c of form.controls) {
      check(`${c.id} 文字对比度 ≥ 4.5`, contrast(c.color, c.bg) >= 4.5, c);
      check(`${c.id} 文字填充色与 color 一致`, c.fill === c.color, c);
    }
    check('搜索框文字对比度 ≥ 4.5', contrast(form.search.color, form.search.bg) >= 4.5, form.search);
    check('搜索占位文字对比度 ≥ 4.5', contrast(form.placeholder, form.search.bg) >= 4.5, { ph: form.placeholder, bg: form.search.bg });
    check(
      '表单 color-scheme 锁定 light（不受系统深色主题影响）',
      form.rootScheme === 'light' && form.controls.every((c) => c.scheme === 'light') && form.search.scheme === 'light',
      form
    );

    console.log('\n[2b] 手动切到深色主题');
    const darkTheme = await pop.ev(`
      applyTheme('dark');
      await new Promise(r => setTimeout(r, 500));
      const body = getComputedStyle(document.body);
      return { bodyBg: body.backgroundColor, bodyFg: body.color,
               dataTheme: document.documentElement.dataset.theme };`);
    console.log('    ', JSON.stringify(darkTheme));
    check('能切到深色', darkTheme.dataTheme === 'dark' && isDark(darkTheme.bodyBg), darkTheme);
    check('深色下文字是浅色', isLight(darkTheme.bodyFg), darkTheme.bodyFg);
    const darkForm = await pop.ev(`
      const sel = getComputedStyle(document.getElementById('minSize'));
      const q = getComputedStyle(document.getElementById('q'));
      const sb = getComputedStyle(document.querySelector('.search-box'));
      return { selColor: sel.color, selBg: sel.backgroundColor, selScheme: sel.colorScheme,
               searchColor: q.color, searchBg: sb.backgroundColor,
               placeholder: getComputedStyle(document.getElementById('q'), '::placeholder').color };`);
    console.log('    ', JSON.stringify(darkForm));
    check('深色下下拉文字对比度 ≥ 4.5', contrast(darkForm.selColor, darkForm.selBg) >= 4.5, darkForm);
    check('深色下搜索占位对比度 ≥ 4.5', contrast(darkForm.placeholder, darkForm.searchBg) >= 4.5, darkForm);
    check('深色下表单 color-scheme 为 dark', darkForm.selScheme === 'dark', darkForm.selScheme);

    console.log('\n[3] 切回浅色主题');
    const light = await pop.ev(`
      const imgsBefore = [...document.querySelectorAll('.thumb img')];
      const srcBefore = imgsBefore.map(i => i.getAttribute('src'));
      applyTheme('light');
      await new Promise(r => setTimeout(r, 600));
      const body = getComputedStyle(document.body);
      const card = document.querySelector('.card');
      const cs = getComputedStyle(card);
      const imgsAfter = [...document.querySelectorAll('.thumb img')];
      const srcAfter = imgsAfter.map(i => i.getAttribute('src'));
      return {
        bodyBg: body.backgroundColor, bodyFg: body.color,
        cardBg: cs.backgroundColor, cardBorder: cs.borderTopColor,
        dataTheme: document.documentElement.dataset.theme,
        sameElements: imgsAfter.length === imgsBefore.length && imgsAfter.every((el, i) => el === imgsBefore[i]),
        sameSrc: srcAfter.length === srcBefore.length && srcAfter.every((s, i) => s === srcBefore[i]),
        thumbBg: getComputedStyle(document.querySelector('.thumb')).backgroundColor
      };`);
    console.log('    ', JSON.stringify(light));
    check('data-theme 标记为 light', light.dataTheme === 'light', light);
    check('浅色主题页面背景是纯白', isWhite(light.bodyBg), light.bodyBg);
    check('浅色主题卡片背景是纯白', isWhite(light.cardBg), light.cardBg);
    check('浅色主题文字是深色', isDark(light.bodyFg), light.bodyFg);
    check('正文对比度达到 WCAG AA（≥ 4.5）', contrast(light.bodyFg, light.bodyBg) >= 4.5, contrast(light.bodyFg, light.bodyBg).toFixed(2));
    check('切换主题没有重建图片元素', light.sameElements === true, light);
    check('切换主题没有重新加载图片', light.sameSrc === true, light);

    console.log('\n[4] 「隐藏失效」筛选');
    const hide = await pop.ev(`
      const before = document.querySelectorAll('.card').length;
      const brokenCount = brokenThumbs.size;
      const cb = document.getElementById('hideBroken');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const after = document.querySelectorAll('.card').length;
      const remainingPh = document.querySelectorAll('.thumb .ph').length;
      const stat = document.getElementById('stat').textContent;
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const restored = document.querySelectorAll('.card').length;
      return { before, brokenCount, after, remainingPh, stat, restored, checked: cb.checked };`);
    console.log('    ', JSON.stringify(hide));
    check('开启后卡片数减少', hide.after < hide.before, hide);
    check('减少的数量等于预览失败数', hide.before - hide.after === hide.brokenCount, hide);
    check('列表里不再有"预览不可用"占位', hide.remainingPh === 0, hide);
    check('统计行随之更新', /共 \d+ 张/.test(hide.stat), hide.stat);
    check('关闭后条目恢复', hide.restored === hide.before, hide);

    console.log('\n[5] 主题持久化（重新打开面板）');
    await pop.ev('applyTheme("light"); await new Promise(r=>setTimeout(r,300)); return 1;');
    const stored = await pop.ev(`
      const r = await new Promise(res => chrome.storage.local.get('uiState', res));
      return (r.uiState || {}).theme;`);
    check('主题已写入存储', stored === 'light', stored);
    // 关掉旧面板，重开一个
    await b.send('Target.closeTarget', { targetId });
    ({ pop, targetId } = await openPopup());
    const reopened = await pop.ev(`
      await new Promise(r => setTimeout(r, 800));
      return { theme: state.theme, dataTheme: document.documentElement.dataset.theme,
               bodyBg: getComputedStyle(document.body).backgroundColor,
               icon: (document.getElementById('themeIcon') || {}).innerHTML ? 'set' : 'empty' };`);
    console.log('    ', JSON.stringify(reopened));
    check('重开面板仍是浅色', reopened.theme === 'light' && reopened.dataTheme === 'light', reopened);
    check('重开后背景仍是纯白', isWhite(reopened.bodyBg), reopened.bodyBg);
    check('主题按钮图标已设置', reopened.icon === 'set', reopened);

    console.log('\n[6] 切回深色');
    const back = await pop.ev(`
      applyTheme('dark'); await new Promise(r => setTimeout(r, 400));
      return { dataTheme: document.documentElement.dataset.theme,
               bodyBg: getComputedStyle(document.body).backgroundColor };`);
    console.log('    ', JSON.stringify(back));
    check('能切回深色', back.dataTheme === 'dark' && isDark(back.bodyBg), back);

    console.log('\n[7] 卡片选择 / 搜索 / 空状态的交互契约');
    const inter = await pop.ev(`
      applyTheme('light');
      const q = document.getElementById('q');
      q.value = '';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));

      const first = document.querySelector('.card');
      first.click();
      await new Promise(r => setTimeout(r, 60));
      const afterCardClick = {
        selected: first.classList.contains('selected'),
        checked: first.querySelector('input').checked,
        disabled: document.getElementById('dlSel').disabled,
        label: document.getElementById('dlSelLabel').textContent,
        stat: document.getElementById('stat').textContent
      };

      const box = first.querySelector('input');
      box.click();
      await new Promise(r => setTimeout(r, 60));
      const afterBoxClick = {
        selected: first.classList.contains('selected'),
        checked: box.checked,
        selectedSize: selected.size
      };

      first.click();
      document.getElementById('selAll').click();
      const afterAll = { selected: selected.size, view: viewItems.length, cards: document.querySelectorAll('.card').length };
      document.getElementById('selNone').click();
      const afterNone = { selected: selected.size };

      // 精确匹配第一张图，验证筛选时复用同一个卡片节点
      const needle = first.dataset.url.split('/').pop();
      q.value = needle;
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const one = document.querySelector('.card');
      const filtered = {
        count: document.querySelectorAll('.card').length,
        sameNode: one === first,
        clearVisible: !document.getElementById('clearSearch').hidden
      };

      q.value = '__no_such_image_98765__';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const empty = {
        cards: document.querySelectorAll('.card').length,
        visible: !document.getElementById('empty').hidden,
        text: document.getElementById('emptyText').textContent.slice(0, 60)
      };

      document.getElementById('clearSearch').click();
      await new Promise(r => setTimeout(r, 400));
      const cleared = {
        q: q.value,
        cards: document.querySelectorAll('.card').length,
        emptyHidden: document.getElementById('empty').hidden,
        clearHidden: document.getElementById('clearSearch').hidden
      };

      // 选中第一张后把它筛掉：选中集合应保留，下载按钮仍可用
      const cardNow = document.querySelectorAll('.card');
      cardNow[0].click();
      const otherNeedle = cardNow[1].dataset.url.split('/').pop();
      q.value = otherNeedle;
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const hiddenSelection = {
        selectedSize: selected.size,
        disabled: document.getElementById('dlSel').disabled,
        label: document.getElementById('dlSelLabel').textContent,
        visibleCards: document.querySelectorAll('.card').length
      };
      document.getElementById('clearSearch').click();
      await new Promise(r => setTimeout(r, 300));

      return { afterCardClick, afterBoxClick, afterAll, afterNone, filtered, empty, cleared, hiddenSelection };`);
    console.log('    ', JSON.stringify(inter));
    check('点卡片能选中并激活下载按钮', inter.afterCardClick.selected && inter.afterCardClick.checked && !inter.afterCardClick.disabled, inter.afterCardClick);
    check('下载按钮文案带选中数量', /1/.test(inter.afterCardClick.label), inter.afterCardClick.label);
    check('点复选框只切换一次（不会双触发）', !inter.afterBoxClick.selected && !inter.afterBoxClick.checked && inter.afterBoxClick.selectedSize === 0, inter.afterBoxClick);
    check('全选覆盖当前筛选结果', inter.afterAll.selected === inter.afterAll.view && inter.afterAll.selected > 0, inter.afterAll);
    check('清空后选中数为 0', inter.afterNone.selected === 0, inter.afterNone);
    check('过滤为单张时复用原卡片节点', inter.filtered.count === 1 && inter.filtered.sameNode === true, inter.filtered);
    check('过滤时显示清空搜索按钮', inter.filtered.clearVisible === true, inter.filtered);
    check('无匹配时显示空状态而不是空白', inter.empty.cards === 0 && inter.empty.visible === true, inter.empty);
    check('清空搜索后恢复列表、隐藏空状态', inter.cleared.q === '' && inter.cleared.cards > 0 && inter.cleared.emptyHidden === true && inter.cleared.clearHidden === true, inter.cleared);
    check(
      '选中项被筛选隐藏后仍保留，下载按钮可用',
      inter.hiddenSelection.selectedSize === 1 && inter.hiddenSelection.disabled === false && /1/.test(inter.hiddenSelection.label),
      inter.hiddenSelection
    );

    console.log('\n[异常]');
    if (!pop.exc.length) console.log('  （无）');
    pop.exc.slice(0, 6).forEach((l) => console.log('  ' + String(l).split('\n')[0]));

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n测试异常：', e.message); process.exit(1); });
