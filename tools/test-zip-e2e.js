/* =============================================================================
 * 真机回归：ZIP 打包下载后的真实落盘文件名（有头模式）
 *
 * 背景：部分 Edge 版本会忽略 chrome.downloads.download 的 filename 参数和
 * onDeterminingFilename，blob 下载落盘名会变成 blob 的 UUID（乱码源头）。
 * 本测试用真实浏览器走「打包 ZIP」按钮，断言落盘名 == 页面标题_日期.zip，
 * 验证完自动删除测试产物。
 *
 * 注意：会弹出一个浏览器窗口几秒钟；下载会落到系统默认下载目录，测完即删。
 * 用法： node tools/test-zip-e2e.js
 * =========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8794;
const DEBUG_PORT = 9340;
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];

// ------------------------------------------------------------------ PNG 生成
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { let c = -1; for (const x of b) c = CRC_T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}
function solidPng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1; raw[o + x * 3] = rgb[0]; raw[o + x * 3 + 1] = rgb[1]; raw[o + x * 3 + 2] = rgb[2]; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 夹具页：页面标题就是断言用的包名来源
const PAGE_TITLE = 'ZIP落盘名回归验证页';
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/e2e') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head><body>
      <h1>zip filename regression</h1>
      ${[1, 2, 3, 4].map((i) => `<img src="/img/p${i}.png" alt="卡图${i}" width="300" height="220">`).join('\n')}
      </body></html>`);
    return;
  }
  if (/\.png$/.test(url)) {
    const n = parseInt(url.replace(/\D/g, '') || '1', 10);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(solidPng(200 + n * 10, 160 + n * 8, [(n * 60) % 255, (n * 90) % 255, (n * 120) % 255]));
    return;
  }
  res.writeHead(404); res.end('nope');
});

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}
async function connect(url, browserLevel) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const c = new CDP(ws);
  if (browserLevel) return c;
  await c.send('Runtime.enable');
  await c.send('Page.enable').catch(() => {});
  return c;
}
const listTargets = async () => (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json());
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 未就绪 */ }
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
    await new Promise((r) => setTimeout(r, 300));
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

(async function main() {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge/Chrome：' + BROWSERS.join(' | '));
  console.log('浏览器：' + exe + '（有头模式，会短暂弹窗）');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = path.join(os.tmpdir(), 'igp-zip-e2e-' + Date.now());
  const logFile = fs.openSync(path.join(os.tmpdir(), 'igp-zip-e2e-browser.log'), 'w');
  const proc = spawn(exe, [
    `--user-data-dir=${profile}`, `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeDefaultBrowserNotifier,Translate', '--window-size=900,700', 'about:blank'
  ], { stdio: ['ignore', 'ignore', logFile] });
  const cleanupBrowser = () => { try { proc.kill(); } catch (_) { /* ignore */ } };
  process.on('exit', cleanupBrowser);

  const sw = await waitFor(async () => {
    const list = await listTargets();
    return list.find((t) => t.type === 'service_worker' && /\/src\/background\.js/.test(t.url));
  }, 45000, '扩展 SW');
  const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
  const swCdp = await connect(sw.webSocketDebuggerUrl);
  const browserWs = (await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json()).webSocketDebuggerUrl;
  const browserCdp = await connect(browserWs, true);

  const created = await browserCdp.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/e2e`, background: false });
  await waitFor(async () => (await listTargets()).find((t) => t.id === created.targetId), 30000, '夹具页');
  await new Promise((r) => setTimeout(r, 2000));
  const tabId = await swCdp.evaluate(`
    const all = await chrome.tabs.query({});
    const t = all.find(t => (t.url || '') === 'http://127.0.0.1:${PORT}/e2e');
    return t ? t.id : null;`);
  if (tabId == null) throw new Error('找不到夹具页标签页');

  // 日期与插件内 today() 同源：本地时区
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const expectName = `${PAGE_TITLE}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;

  console.log('\n[1] 走真实「打包 ZIP」按钮');
  const popupT = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, background: false });
  const popupTarget = await waitFor(async () => (await listTargets()).find((t) => t.id === popupT.targetId), 20000, 'popup');
  const popupCdp = await connect(popupTarget.webSocketDebuggerUrl);
  await browserCdp.send('Target.activateTarget', { targetId: created.targetId });
  await new Promise((r) => setTimeout(r, 800));
  const zipResult = await popupCdp.evaluate(`
    await new Promise(r => setTimeout(r, 1000));
    await rescan();
    if (!allItems.length) return { error: '没有采集到图片' };
    viewItems.forEach(it => selected.add(it.url));
    paintSelection();
    $('zip').click();
    const t0 = Date.now();
    let toastText = '';
    for (;;) {
      toastText = document.getElementById('toast') ? document.getElementById('toast').textContent : '';
      if (toastText && !/正在打包/.test(toastText)) break;
      if (Date.now() - t0 > 60000) break;
      await new Promise(r => setTimeout(r, 400));
    }
    return { toast: toastText };`);
  check('打包成功', /已打包/.test(zipResult.toast || ''), zipResult);

  console.log('\n[2] 落盘文件名断言');
  await waitFor(async () => {
    const dls = await swCdp.evaluate('return await chrome.downloads.search({});');
    return dls.some((x) => /\.zip$/.test(x.filename)) && dls.every((x) => ['complete', 'interrupted'].includes(x.state));
  }, 60000, 'ZIP 下载结束');
  const dls = await swCdp.evaluate('return await chrome.downloads.search({});');
  const zipDl = dls.find((x) => /\.zip$/.test(x.filename) && !/igp-probe/.test(x.filename));
  check('有 ZIP 下载记录', !!zipDl, dls.map((x) => path.basename(x.filename)));
  if (zipDl) {
    check('下载完成（state=complete）', zipDl.state === 'complete', { state: zipDl.state, error: zipDl.error });
    check('落盘名 == 页面标题_日期.zip（不是 blob UUID）', path.basename(zipDl.filename) === expectName, zipDl.filename);
    if (zipDl.state === 'complete') {
      // 测试产物：从真实下载目录删除（只删本测试生成的那个）
      const produced = zipDl.filename;
      try {
        if (fs.existsSync(produced) && fs.statSync(produced).size === zipDl.fileSize) {
          fs.rmSync(produced, { force: true });
          console.log('    （已删除测试产物 ' + path.basename(produced) + '）');
        }
      } catch (_) { /* 删除失败不判失败 */ }
    }
  }

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  cleanupBrowser();
  fs.closeSync(logFile);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('E2E 异常：', e.message);
  try { console.error('浏览器日志：\n' + fs.readFileSync(path.join(os.tmpdir(), 'igp-zip-e2e-browser.log'), 'utf8').slice(-1500)); } catch (_) { /* ignore */ }
  process.exit(1);
});
