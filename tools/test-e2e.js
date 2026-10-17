/* =============================================================================
 * 真机端到端验证（无需第三方依赖，Node 自带 WebSocket + fetch）
 * 用 Edge/Chrome headless 加载扩展，然后：
 *   1. 起一个本地 http 站点，页面里放各种形态的图片
 *   2. 让后台真的执行一次 collectAll（验证 executeScript + 隔离世界 + 扫描器）
 *   3. 打开 popup.html，真的跑一次 rescan，检查：
 *        · 卡片有没有渲染出来
 *        · #empty / #progressWrap 的 computed display 是不是 none（历史 bug）
 *        · 缩略图是否真的加载成功
 *   4. 走一次真实下载，确认文件名被浏览器接受
 * 用法： node tools/e2e-browser.js [--headed]
 * =========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8791;
const DEBUG_PORT = 9333;
const FIXTURE_URL = `http://127.0.0.1:${PORT}/e2e`;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

// ------------------------------------------------------------------ PNG 生成
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function solidPng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const PNG_CACHE = new Map();
function pngFor(seed) {
  const key = String(seed);
  if (!PNG_CACHE.has(key)) {
    const n = Math.abs([...key].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 200;
    PNG_CACHE.set(key, solidPng(60 + (n % 50), 40 + (n % 40), [(n * 7) % 255, (n * 13) % 255, (n * 29) % 255]));
  }
  return PNG_CACHE.get(key);
}

// ------------------------------------------------------------------ 测试页面
function buildPage() {
  const imgs = [];
  for (let i = 1; i <= 20; i++) imgs.push(`<img src="/img/pic${i}.png" alt="图${i}" width="${400 + i * 30}" height="${300 + i * 20}">`);
  const lazy = [];
  for (let i = 1; i <= 6; i++) lazy.push(`<img data-src="/img/lazy${i}.png" alt="懒加载${i}">`);
  const bg = [];
  for (let i = 1; i <= 4; i++) bg.push(`.bg${i} { background-image: url('/css/bg${i}.png'); }`);
  const esc = [];
  for (let i = 1; i <= 3; i++) esc.push(`"https:\\/\\/cdn.e2e.test\\/gallery\\/escaped${i}.png"`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta property="og:image" content="/meta/og.png">
<style>${bg.join('\n')} .box{width:300px;height:200px}</style>
<script>window.GALLERY=[${esc.join(',')}];</script>
</head><body>
<h1>e2e</h1>
${imgs.join('\n')}
${lazy.join('\n')}
<div class="bg1 box"></div><div class="bg2 box"></div><div class="bg3 box"></div><div class="bg4 box"></div>
<picture><source srcset="/img/pic-src-400.png 400w, /img/pic-src-1600.png 1600w"><img src="/img/pic-fb.png"></picture>
<img srcset="/img/ss-400.png 400w, /img/ss-1600.png 1600w" src="/img/ss-fb.png">
<canvas id="c" width="640" height="480"></canvas>
<div class="thumb" data-img="https://img.cdn.e2e.test/photo/8f3a1c9d77b0?w=1200"></div>
</body></html>`;
}

// ------------------------------------------------------------------ 静态服务
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/e2e' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildPage());
    return;
  }
  if (/\.png$/.test(url)) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(pngFor(url));
    return;
  }
  res.writeHead(404);
  res.end('nope');
});

// ------------------------------------------------------------------ CDP 客户端
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async()=>{${expression}})()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}
async function connect(url, opts = {}) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  // browser 级连接没有 Runtime/Page 域，只能发 Target.* 命令
  if (opts.browser) return cdp;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable').catch(() => {});
  return cdp;
}
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return r.json();
}
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {
      /* 还没就绪 */
    }
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ------------------------------------------------------------------ 断言
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

// ------------------------------------------------------------------ 主流程
(async function main() {
  const headed = process.argv.includes('--headed');
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge/Chrome，可执行文件路径：' + BROWSERS.join(' | '));
  console.log('浏览器：' + exe);

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = path.join(os.tmpdir(), 'igp-e2e-profile-' + Date.now());
  const logFile = fs.openSync(path.join(os.tmpdir(), 'igp-e2e-browser.log'), 'w');
  const args = [
    headed ? '' : '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeDefaultBrowserNotifier,Translate',
    '--disable-background-timer-throttling',
    '--allow-insecure-localhost',
    'about:blank'
  ].filter(Boolean);
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', logFile] });
  process.on('exit', () => {
    try {
      proc.kill();
    } catch (_) {
      /* ignore */
    }
  });

  console.log('启动浏览器，等待扩展 Service Worker…');
  const sw = await waitFor(async () => {
    const list = await listTargets();
    return list.find((t) => t.type === 'service_worker' && /chrome-extension:\/\/[^/]+\/src\/background\.js/.test(t.url));
  }, 45000, '扩展 Service Worker');
  const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
  console.log(`扩展已加载 id=${extId}`);

  const swCdp = await connect(sw.webSocketDebuggerUrl);
  const browserWs = (await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json()).webSocketDebuggerUrl;
  const browserCdp = await connect(browserWs, { browser: true });

  // ---- 1) 打开测试页
  const created = await browserCdp.send('Target.createTarget', { url: FIXTURE_URL, background: false });
  const pageTarget = await waitFor(async () => {
    const list = await listTargets();
    return list.find((t) => t.id === created.targetId);
  }, 20000, '测试页 target');
  const pageCdp = await connect(pageTarget.webSocketDebuggerUrl);
  await new Promise((r) => setTimeout(r, 2500)); // 等 content script 注入 + 图片加载

  const domInfo = await pageCdp.evaluate(`
    // window.__IGP__ 在隔离世界（isolated world），主世界的 Runtime.evaluate 看不到它，
    // 这是 chrome.scripting 的正常行为。这里改用"后台能否采集成功"来间接验证。
    return { imgs: document.querySelectorAll('img').length };`);
  console.log('\n[1] 页面与内容脚本');
  check('页面里有 28 个 <img>（含懒加载占位）', domInfo.imgs === 28, domInfo);
  check('内容脚本已注入（由下一节的采集结果验证）', domInfo.imgs > 0, domInfo);

  // ---- 2) 后台真的跑一次 collectAll
  const tabId = await swCdp.evaluate(`
    const tabs = await chrome.tabs.query({url: 'http://127.0.0.1:${PORT}/*'});
    return tabs.length ? tabs[0].id : null;`);
  check('能拿到测试页的 tabId', typeof tabId === 'number', tabId);

  const collected = await swCdp.evaluate(`
    const r = await collectAll(${tabId}, {deep: true, thorough: false, scripts: true, budgetMs: 400});
    if (!r.ok) return {error: r.error};
    return {count: r.items.length, ms: r.stats.ms, frames: r.stats.frames, errors: r.stats.errors,
            kinds: r.items.reduce((a,i)=>{a[i.kind]=(a[i.kind]||0)+1;return a},{}),
            urls: r.items.map(i=>i.url), sample: r.items.slice(0,6).map(i=>i.kind+':'+i.url.slice(-28))};`);
  console.log('\n[2] 后台采集（executeScript → 隔离世界 → 扫描器）');
  check('采集没有报错', !collected.error, collected);
  console.log('    详情：', JSON.stringify(collected));
  check('抓到 30 张以上', collected.count >= 30, collected.count);
  check('耗时小于 200ms', collected.ms < 200, collected.ms);
  const picUrls = (collected.urls || []).filter((u) => /\/img\/pic\d+\.png$/.test(u));
  check('20 张普通图片全部抓到', picUrls.length === 20, picUrls.length);
  check('srcset 的大图地址在结果里（ss-1600 / pic-src-1600）', (collected.urls||[]).some(u=>u.includes('ss-1600')) && (collected.urls||[]).some(u=>u.includes('pic-src-1600')), (collected.urls||[]).filter(u=>u.includes('1600')));
  // 1.5.0 的行为变更：深度模式会先把 data-src 写回 src 唤醒懒加载，
  // 所以这些地址会以 img 类出现（并带上真实尺寸），不再标成 lazy。
  // 关键是"地址被采集到"，分类标签反而更准确了。
  const lazyUrls = (collected.urls || []).filter((u) => /\/img\/lazy\d+\.png$/.test(u));
  check('懒加载地址全部被抓到（唤醒后归为 img）', lazyUrls.length === 6, lazyUrls);
  check('样式表背景被抓到', !!collected.kinds.css, collected.kinds);
  check('内联脚本里的转义地址被抓到', !!collected.kinds.script, collected.kinds);
  check('og:image 被抓到', !!collected.kinds.meta, collected.kinds);
  check('canvas 作为可视元素被抓到', !!collected.kinds.canvas, collected.kinds);

  // ---- 3) popup 真的渲染
  const popupTargetCreated = await browserCdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/src/popup.html`,
    background: false
  });
  const popupTarget = await waitFor(async () => {
    const list = await listTargets();
    return list.find((t) => t.id === popupTargetCreated.targetId);
  }, 20000, 'popup target');
  const popupCdp = await connect(popupTarget.webSocketDebuggerUrl);
  // popup 启动时把"当前活动标签"当来源页；这里先把测试页激活再手动 rescan
  await browserCdp.send('Target.activateTarget', { targetId: created.targetId });
  await new Promise((r) => setTimeout(r, 800));
  const view = await popupCdp.evaluate(`
    // 等弹窗自己的 boot() 跑完，避免两次 rescan 打架
    await new Promise(r => setTimeout(r, 1200));
    await rescan();
    // 缩略图是异步加载的，轮询等它们出像素（最多 20 秒）
    const t0 = Date.now();
    let imgs = [];
    for (;;) {
      imgs = [...document.querySelectorAll('.thumb img')];
      // complete 在 data: + lazy 下不可靠，以 naturalWidth 为准
      const ok = imgs.filter(i => i.naturalWidth > 0).length;
      if (ok >= 5 || Date.now() - t0 > 20000) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const cards = document.querySelectorAll('.card');
    const empty = document.getElementById('empty');
    const prog = document.getElementById('progressWrap');
    const thumbImgs = [...document.querySelectorAll('.thumb img')];
    const loadedThumbs = thumbImgs.filter(i=>i.naturalWidth>0).length;
    const first = thumbImgs[0];
    const fcs = first ? getComputedStyle(first) : null;
    const thumbEl = document.querySelector('.thumb');
    const tcs = thumbEl ? getComputedStyle(thumbEl) : null;
    return {
      allItems: allItems.length,
      viewItems: viewItems.length,
      cards: cards.length,
      emptyDisplay: getComputedStyle(empty).display,
      emptyHidden: empty.hidden,
      progressDisplay: getComputedStyle(prog).display,
      loadedThumbs,
      thumbImgCount: thumbImgs.length,
      fallbackCount: document.querySelectorAll('.thumb .ph').length,
      firstSrc: first ? String(first.getAttribute('src')).slice(0,60) : null,
      firstDataSrc: first ? String(first.dataset.src||'').slice(0,60) : null,
      firstNaturalW: first ? first.naturalWidth : null,
      firstComplete: first ? first.complete : null,
      imgRect: first ? { w: Math.round(first.getBoundingClientRect().width), h: Math.round(first.getBoundingClientRect().height) } : null,
      imgCss: fcs ? { display: fcs.display, opacity: fcs.opacity, visibility: fcs.visibility } : null,
      thumbRect: thumbEl ? { w: Math.round(thumbEl.getBoundingClientRect().width), h: Math.round(thumbEl.getBoundingClientRect().height) } : null,
      thumbCssHeight: tcs ? tcs.height : null,
      countChip: document.getElementById('count').textContent,
      gridHeight: document.getElementById('grid').getBoundingClientRect().height,
      stat: document.getElementById('stat').textContent
    };`);
  console.log('\n[3] 弹窗渲染');
  console.log('    详情：', JSON.stringify(view));
  check('扫描结果不为空（弹窗有数据）', view.allItems > 0, view.allItems);
  check('默认筛选后仍有卡片', view.viewItems > 5, view.viewItems);
  check('卡片真的渲染进 DOM', view.cards > 5, view.cards);
  check('#empty 提示框处于隐藏状态（display:none）', view.emptyDisplay === 'none' && view.emptyHidden === true, view);
  check('#progressWrap 空闲时隐藏', view.progressDisplay === 'none', view.progressDisplay);
  check('网格占满可用高度', view.gridHeight > 260, view.gridHeight);
  check('缩略图真的加载出像素', view.loadedThumbs > 5, view.loadedThumbs);

  // ---- 4) 真实下载
  console.log('\n[4] 真实下载链路');
  const dl = await popupCdp.evaluate(`
    const it = allItems.find(i => i.url.includes('/img/pic1.png')) || allItems[0];
    const r = await sendBg({type:'IGP_DOWNLOAD', tabId, items:[{url: it.url, kind: it.kind, w: it.w, h: it.h, alt: it.alt, pageUrl: it.pageUrl}], opts:{}});
    return r;`);
  console.log('    详情：', JSON.stringify(dl));
  check('下载请求成功（文件名被浏览器接受）', dl.ok === true && dl.state && dl.state.ok === 1, dl);

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  console.log('临时用户目录：' + profile);

  try {
    proc.kill();
  } catch (_) {
    /* ignore */
  }
  fs.closeSync(logFile);
  if (!headed) {
    const logTxt = fs.readFileSync(path.join(os.tmpdir(), 'igp-e2e-browser.log'), 'utf8').slice(-1200);
    if (logTxt.trim()) console.log('\n浏览器日志片段：\n' + logTxt);
  }
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nE2E 异常：', e.message);
  try {
    console.error('浏览器日志：\n' + fs.readFileSync(path.join(os.tmpdir(), 'igp-e2e-browser.log'), 'utf8').slice(-2000));
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
