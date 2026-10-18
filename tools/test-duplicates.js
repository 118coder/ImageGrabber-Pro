/* =============================================================================
 * 重复图片合并 + 命名一致性 — 端到端测试（真浏览器 + 真下载）
 *
 *   页面里同一张图被引用了 4 次（签名参数 / 尺寸参数 / 缩略后缀），
 *   另有一张图在地址里只是 UUID、名字写在 alt 上（就是用户遇到的那个问题）。
 *
 * 校验：
 *   · 默认只显示 1 条，并带 ×4 角标，状态栏报告合并数量
 *   · 关掉开关能看到全部地址，再打开又合并回去
 *   · 先全选再合并：选中集合被归并，不会把同一张图下载两遍
 *   · 面板显示的名字 == 真实落盘的文件名（UUID 那种用页面上的名字）
 *
 * 用法： node tools/test-duplicates.js
 * ============================================================================= */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8841;
const DEBUG_PORT = 9405;

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
const PATTERNS = {
  // 同心圆：行内灰度先降后升，指纹结构丰富
  c: (x, y, w, h) => {
    const d = Math.hypot(x - w / 2, y - h / 2) / Math.max(w, h);
    return [Math.round(d * 255), Math.round(255 - d * 255), 60];
  },
  // 竖条纹
  stripe: (x) => [40, 40, (x % 37) * 6],
  // 8×8 棋盘
  z: (x, y, w, h) => ((((x * 8) / w) | 0) + (((y * 8) / h) | 0)) % 2 ? [210, 70, 70] : [40, 70, 210],
  // 4×3 亮块阵列
  dots: (x, y, w, h) => {
    const cx = ((x / w) * 4) | 0;
    const cy = ((y / h) * 3) | 0;
    const on = cx % 2 === 0 && cy % 2 === 0;
    return on ? [240, 240, 60] : [30, 30, 30];
  },
  // 单调斜向渐变（dHash 的极端情形：整行单调）
  d: (x, y, w, h) => [Math.round((x / w) * 235), Math.round((y / h) * 235), 90],
  // 暗底 + 左上亮块 / 右下亮块
  blk: (x, y, w, h) => (x < w * 0.35 && y < h * 0.35 ? [245, 245, 245] : [25, 25, 25]),
  blkr: (x, y, w, h) => (x > w * 0.6 && y > h * 0.6 ? [245, 245, 245] : [25, 25, 25]),
  // 暗底 + 中间一条亮竖带
  bars: (x, y, w, h) => (x > w * 0.4 && x < w * 0.6 ? [250, 120, 60] : [20, 20, 20])
};
function png(w, h, pattern) {
  const fn = PATTERNS[pattern] || PATTERNS.d;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const [r, g, b] = fn(x, y, w, h);
      raw[o] = r & 255; raw[o + 1] = g & 255; raw[o + 2] = b & 255;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 每个用例组用不同的画面，避免不同组的图因为"画面像"而互相合并
const PNG_PHOTO = png(600, 400, 'c'); // 组 A：同一张图的地址变体
const PNG_PHOTO_SMALL = png(300, 200, 'c'); //            —— 缩放版，画面相同
const PNG_OTHER = png(600, 400, 'stripe'); // 单独的图
const PNG_UUID = png(400, 300, 'z'); // 地址是 UUID、名字在 alt 上
const PNG_ART_TWIN = png(600, 400, 'dots'); // 组 D：同一份字节，同源两个不同路径/文件名
const PNG_TWIN = png(500, 380, 'd'); // 组 E：字节完全相同的两份拷贝（同源,两个路径）
const PNG_CROSS = png(420, 320, 'bars'); // 组 G：字节完全相同的两份拷贝（跨域,两个路径）
const PNG_SAMESIZE_1 = png(400, 300, 'blk'); // 组 F：尺寸相同、画面不同（绝不该合并）
const PNG_SAMESIZE_2 = png(400, 300, 'blkr');
const PNG_1 = png(1, 1, 'd'); // 1×1 站点图标：会被默认尺寸筛选挡住

const UUID_PATH = '/uuid/0b3febed-43e5-4251-87f9-a42dd9ff9984';
const TWIN_A = '/twin/one/photo-final-v2.png';
const TWIN_B = '/twin/two/9f8e7d6c5b4a39281706f5e4d3c2b1a0.png';
const ART_BIG = '/art/gallery-big.png';
const ART_SMALL = '/art/elsewhere/gallery-small.png'; // 与上面字节完全相同，文件名/目录都不同
const SAME_1 = '/same-size/left.png';
const SAME_2 = '/same-size/right.png';
const CROSS_1 = '/cross/one/0b3febed-43e5-4251-87f9-a42dd9ff9984.png';
const CROSS_2 = '/cross/two/totally-different-name.png';
const hits = {};

const ROUTES = {
  '/img/photo.png': PNG_PHOTO,
  '/img/photo-300x200.png': PNG_PHOTO_SMALL,
  '/img/other.png': PNG_OTHER,
  [UUID_PATH]: PNG_UUID,
  [TWIN_A]: PNG_TWIN,
  [TWIN_B]: PNG_TWIN,
  [ART_BIG]: PNG_ART_TWIN,
  [ART_SMALL]: PNG_ART_TWIN,
  [SAME_1]: PNG_SAMESIZE_1,
  [SAME_2]: PNG_SAMESIZE_2,
  '/favicon.ico': PNG_1
};

const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  const url = req.url.split('?')[0];
  if (ROUTES[url]) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' });
    res.end(ROUTES[url]);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>重复图片测试</title></head>
<body style="margin:0">
  <!-- A：同一张图，4 种地址 -->
  <img src="/img/photo.png?auth_key=aaa" width="600" height="400" alt="">
  <img src="/img/photo.png?auth_key=bbb" width="600" height="400" alt="">
  <img src="/img/photo.png?w=300" width="600" height="400" alt="">
  <img src="/img/photo-300x200.png" width="300" height="200" alt="">
  <!-- 地址只是 UUID，名字在 alt 上 -->
  <img src="${UUID_PATH}" width="400" height="300" alt="123">
  <img src="/img/other.png" width="600" height="400" alt="">
  <!-- E：字节完全相同的两份拷贝，路径毫不相干 -->
  <img src="${TWIN_A}" width="500" height="380" alt="">
  <img src="${TWIN_B}" width="500" height="380" alt="">
  <!-- D：同一张图的两个尺寸，地址也毫不相干 -->
  <img src="${ART_BIG}" width="600" height="400" alt="">
  <img src="${ART_SMALL}" width="300" height="200" alt="">
  <!-- F：尺寸完全相同，但是两张不同的图 -->
  <img src="${SAME_1}" width="400" height="300" alt="">
  <img src="${SAME_2}" width="400" height="300" alt="">
  <!-- G：跨域（另一个端口、另一个域名）。页面读不了它的像素，走 fetch 通道 → 能算 MD5 -->
  <img src="http://127.0.0.1:${CORS_PORT}${CROSS_1}" width="420" height="320" alt="">
  <img src="http://127.0.0.1:${CORS_PORT}${CROSS_2}" width="420" height="320" alt="">
</body></html>`);
});

// 第二个端口：模拟"另一台 CDN"。带 CORS 头保证页面能 fetch，但不给 <img> 加 crossorigin，
// 于是元素通道用不了、必须走 fetch → 拿到原始字节 → 算得出 MD5。
const CORS_PORT = 8842;
const corsHits = {};
const corsServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  corsHits[url] = (corsHits[url] || 0) + 1;
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=600',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(PNG_CROSS);
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
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

const SNAPSHOT = `
  await new Promise(r => setTimeout(r, 400));
  return {
    cards: [...document.querySelectorAll('.card')].map(c => ({
      url: c.dataset.url,
      name: c.querySelector('.name').textContent,
      dup: c.querySelector('.dup-badge') ? c.querySelector('.dup-badge').textContent : null,
      dupTitle: c.querySelector('.dup-badge') ? c.querySelector('.dup-badge').title : null
    })),
    stat: document.getElementById('stat').textContent,
    count: document.getElementById('count').textContent,
    allUrls: allItems.map(i => i.url),
    selectedCount: selected.size,
    selectedUrls: [...selected],
    selectedItems: allItems.filter(i => selected.has(i.url)).length,
    dedupeOn: document.getElementById('dedupe').checked
  };`;

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => corsServer.listen(CORS_PORT, '127.0.0.1', r));
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  // 把下载目录钉在临时目录里，别往用户真实的下载文件夹里丢测试文件
  const profile = path.join(os.tmpdir(), 'igp-dupes-' + Date.now());
  const dlDir = path.join(profile, 'downloads');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: dlDir, prompt_for_download: false }, savefile: { default_directory: dlDir } })
  );
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-dupes.log'), 'w');
  const proc = spawn(exe, [
    '--headless=new', `--user-data-dir=${profile}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--remote-debugging-port=' + DEBUG_PORT, '--window-size=1000,760',
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'ignore', logF] });

  try {
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 45000, 'sw');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);

    const pt = await b.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/`, background: false });
    await b.send('Target.activateTarget', { targetId: pt.targetId });
    await waitFor(async () => (await list()).find((t) => t.id === pt.targetId), 20000, 'page');
    await sleep(2500);

    const qt = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
    await b.send('Target.activateTarget', { targetId: qt.targetId });
    const qT = await waitFor(async () => (await list()).find((t) => t.id === qt.targetId), 20000, 'popup');
    const pop = await conn(qT.webSocketDebuggerUrl, false);
    await sleep(2500);

    const CLEAN = `
      // 用"≥300px"过滤掉 1×1 图标之类的噪声，只看用例里的图
      const min = document.getElementById('minSize');
      min.value = '300';
      min.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));`;

    // MD5 要等缩略图生成完才有（同源图走元素通道拿不到字节，只有跨域图会走 fetch）
    const WAIT_MD5 = `
      for (let i = 0; i < 90 && contentFp.size < 2; i++) await new Promise(r => setTimeout(r, 300));
      await new Promise(r => setTimeout(r, 1500)); // 等一次防抖判重跑完`;
    const boot = await pop.ev('await rescan();' + CLEAN + WAIT_MD5 + `
      return { md5: contentFp.size, ids: allItems.length, cards: document.querySelectorAll('.card').length };`, 60000);
    console.log('MD5 就绪：', JSON.stringify(boot));

    console.log('\n[1] 默认开启合并');
    const on = await pop.ev(SNAPSHOT, 30000);
    if (on.__err || on.__timeout) throw new Error('读取面板失败：' + JSON.stringify(on));
    console.log('卡片：', JSON.stringify(on.cards, null, 1));
    console.log('状态栏：', on.stat, '| 扫描总数：', on.count);

    const photo = on.cards.find((c) => /photo\.png\?auth_key=aaa/.test(c.url));
    const uuidCard = on.cards.find((c) => c.url.endsWith(UUID_PATH));
    const ALL_PATHS = [
      '/img/photo.png?auth_key=aaa',
      '/img/photo.png?auth_key=bbb',
      '/img/photo.png?w=300',
      '/img/photo-300x200.png',
      '/img/other.png',
      UUID_PATH,
      TWIN_A,
      TWIN_B,
      ART_BIG,
      ART_SMALL,
      SAME_1,
      SAME_2,
      CROSS_1,
      CROSS_2
    ];
    const card = (p) => on.cards.find((c) => c.url.includes(p));
    check('跨域图的 MD5 已算出（查重的依据）', boot.md5 >= 2, boot);
    check('14 个地址都被扫到', ALL_PATHS.every((p) => on.allUrls.some((u) => u.endsWith(p) || u.includes(p))), on.allUrls.length);
    // 14 个地址 → 11 组：
    //   · photo 的 3 个参数变体合成 1 组（缩略变体 photo-300x200 单独一条）；
    //   · 跨域两份字节相同的副本按 MD5 合成 1 组；
    //   · 其余各自独立（同源副本走"读像素"通道，不额外抓字节，因此不比对 MD5）。
    check('合并后只剩 11 张卡片（14 个地址 → 11 组）',
      on.cards.length === 11 && !on.cards.some((c) => /favicon/.test(c.url)),
      on.cards.map((c) => c.url));
    check('同一张图的 3 个参数变体合并成 1 张卡片', !!photo && photo.dup === '×3', photo && photo.dup);
    check('角标说明里写明原地址数量', !!photo && /3 个地址/.test(photo.dupTitle || ''), photo && photo.dupTitle);
    check('按地址合并的原因说明是"地址只是参数不同"', !!photo && /参数不同/.test(photo.dupTitle || ''), photo && photo.dupTitle);
    check('状态栏报告合并数量', /合并\s*3\s*张重复/.test(on.stat), on.stat);

    console.log('\n[1b] MD5：字节完全相同的图合并（只对真拿到字节的图生效）');
    const twin = card(TWIN_A);
    const cross = card(CROSS_1);
    const sameA = card(SAME_1);
    const sameB = card(SAME_2);
    check('跨域的两份字节相同副本按 MD5 合并',
      !!cross && cross.dup === '×2' && /字节完全相同/.test(cross.dupTitle || ''),
      cross);
    check('尺寸相同但内容不同 → 两张都在，绝不合并', !!sameA && !!sameB && sameA.dup === null && sameB.dup === null, {
      sameA,
      sameB
    });
    check('同源的两份字节相同副本不合并（同源走读像素通道，不额外抓字节）',
      !!twin && twin.dup === null,
      twin);
    check('没有证据的图不会被误合（other / uuid 各自一张）',
      card('/img/other.png') && card('/img/other.png').dup === null && !!uuidCard && uuidCard.dup === null,
      on.cards.map((c) => [c.url, c.dup]));
    check('缩略变体单独成条（不同分辨率不并进原图）',
      !!on.cards.find((c) => /photo-300x200/.test(c.url) && c.dup === null),
      on.cards.filter((c) => /photo/.test(c.url)).map((c) => [c.url, c.dup]));
    // 按完整 URL 计数：每个地址只应该被请求一次（查重不产生任何请求）
    check('同源图每个地址只请求一次（查重不额外发请求）',
      hits['/img/photo.png?auth_key=aaa'] === 1 &&
        hits['/img/photo.png?auth_key=bbb'] === 1 &&
        hits['/img/photo.png?w=300'] === 1 &&
        hits[ART_BIG] === 1 &&
        hits[ART_SMALL] === 1 &&
        hits[SAME_1] === 1 &&
        hits[TWIN_A] === 1,
      hits);
    check('跨域图最多两次（页面加载 + CORS 抓取，缓存键不同）',
      corsHits[CROSS_1] <= 2 && corsHits[CROSS_2] <= 2 && corsHits[CROSS_1] >= 1,
      corsHits);

    console.log('\n[2] 关掉开关 → 显示全部地址');
    const off = await pop.ev(`
      const box = document.getElementById('dedupe');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      ${SNAPSHOT}`, 30000);
    check('关闭后能看到全部 14 个地址', off.cards.length === 14, off.cards.length);
    check('关闭后没有重复角标', off.cards.every((c) => c.dup === null), off.cards.map((c) => c.dup));
    check('关闭后状态栏不再报告合并', !/合并/.test(off.stat), off.stat);

    console.log('\n[3] 全选后再打开开关：选中集合要被归并');
    const merged = await pop.ev(`
      document.getElementById('selAll').click();
      await new Promise(r => setTimeout(r, 200));
      const box = document.getElementById('dedupe');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      ${SNAPSHOT}`, 30000);
    check('合并后又是 11 张卡片', merged.cards.length === 11, merged.cards.length);
    check('选中的地址被归并（14 → 11）', merged.selectedCount === 11, merged.selectedUrls);
    check('"下载选中"不会重复下载同一张图', merged.selectedItems === 11, {
      selectedItems: merged.selectedItems,
      urls: merged.selectedUrls
    });
    check('全选时计数与卡片一致', /已选\s*11\s*张/.test(merged.stat), merged.stat);

    console.log('\n[3b] 「每组最大」一键只留分辨率最大的那张');
    const maxSel = await pop.ev(`
      document.getElementById('selMax').click();
      await new Promise(r => setTimeout(r, 400));
      ${SNAPSHOT}`, 20000);
    // photo 组里最大的是 photo.png(600×400)，缩略变体 photo-300x200 应被排除
    const pickedPhoto = (maxSel.selectedUrls || []).filter((u) => /\/img\/photo\.png/.test(u));
    check('重复组里只留下了最大的一张（600×400 而非 300×200）',
      pickedPhoto.length === 1 && /auth_key=aaa|auth_key=bbb|w=300/.test(pickedPhoto[0]),
      pickedPhoto);
    check('非重复条目仍然被选中', (maxSel.selectedUrls || []).length === 11, maxSel.selectedUrls.length);

    console.log('\n[5] 面板显示的名字 == 落盘的名字');
    check('UUID 地址的卡片显示页面上的名字', !!uuidCard && uuidCard.name === '123', uuidCard);
    check('有真实文件名的卡片保持原样', !!photo && photo.name === 'photo.png', photo);

    console.log('\n[6] 新加的工具栏按钮/开关没有挤坏工具栏');
    const layout = await pop.ev(`
      const qb = document.querySelector('.quickbar');
      const qr = document.querySelector('.quick-right');
      const chips = [...qr.children].map(el => {
        const r = el.getBoundingClientRect();
        const input = el.querySelector('input');
        return { id: (input && input.id) || el.className, top: Math.round(r.top), right: Math.round(r.right), w: Math.round(r.width) };
      });
      return {
        // 同一行的判定按 10px 分桶：垂直居中差 1px 不算换行
        rows: new Set(chips.map(c => Math.round(c.top / 10))).size,
        chips,
        qbOverflow: qb.scrollWidth - qb.clientWidth,
        bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        inner: window.innerWidth
      };`, 20000);
    console.log('工具栏：', JSON.stringify(layout));
    check('工具栏里的开关排在同一行', layout.rows === 1, layout.chips);
    check('工具栏没有横向溢出', layout.qbOverflow <= 0, layout.qbOverflow);
    check('整个面板没有出现横向滚动条', layout.bodyOverflow <= 0, { bodyOverflow: layout.bodyOverflow, inner: layout.inner });
    const dupBox = (layout.chips || []).find((c) => c.id === 'dedupe');
    check('「合并重复」开关确实在工具栏上', !!dupBox && dupBox.w > 0, layout.chips);
    check('「合并重复」开关没有被裁掉', !!dupBox && dupBox.right <= layout.inner, { dupBox, inner: layout.inner });

    const dl = await pop.ev(`
      const item = allItems.find(i => /0b3febed/.test(i.url));
      const r = await sendBg({ type: 'IGP_DOWNLOAD', tabId, items: [item], opts: {} });
      await new Promise(r2 => setTimeout(r2, 5000));
      const list = await new Promise(r2 => chrome.downloads.search({ orderBy: ['-startTime'], limit: 5 }, r2));
      return { state: r && r.state, files: list.map(d => d.filename) };`, 30000);
    console.log('下载结果：', JSON.stringify(dl));
    const savedName = (dl.files || [])[0] || '';
    const onDisk = fs.existsSync(savedName);
    check('下载完成', !!dl.state && dl.state.ok === 1, dl.state);
    check('落盘文件名是 123（不是 UUID）', /[\\/]123( \(\d+\))?\.\w{2,5}$/.test(savedName), dl.files);
    check('文件真的写进了下载目录', onDisk, savedName);
    check('落在图集捕手目录下', /图集捕手/.test(savedName), dl.files);

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try { proc.kill(); } catch (_) {}
    fs.closeSync(logF);
    server.close();
    corsServer.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
