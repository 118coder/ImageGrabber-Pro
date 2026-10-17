/* =============================================================================
 * 离线冒烟测试：在 Node 里用假的 chrome API 加载 background.js，
 * 真的跑一遍「采集 → 下载 → 打包」的链路，检查：
 *   · 有没有引用到不存在的函数
 *   · 目录/文件名模板是否正确
 *   · 三级兜底顺序、并发队列、错误是否被吞掉
 * 用法： node tools/test-harness.js
 * =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8');

// ------------------------------------------------------------------ 假环境
const listeners = [];
const downloads = [];
const dnrRules = [];
const outbox = []; // background 广播出去的消息
let menuListener = null;
let sessionStore = {};
let localStore = {};

const FAKE_ITEMS_FRAME0 = [
  { url: 'https://cdn.example.com/a/photo-1.jpg', kind: 'img', w: 1920, h: 1080, alt: '封面', label: 'src', probable: false, pageUrl: 'https://www.example.com/post/1' },
  { url: 'https://cdn.example.com/a/bg.webp?x=1', kind: 'css', w: 800, h: 600, alt: '', label: 'CSS: .hero', probable: false, pageUrl: 'https://www.example.com/post/1' },
  { url: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E', kind: 'svg-inline', w: 100, h: 100, alt: '', label: '内联 SVG', probable: false, pageUrl: 'https://www.example.com/post/1' },
  { url: 'blob:https://www.example.com/1234-5678', kind: 'blob', w: 0, h: 0, alt: '', label: 'blob', probable: false, pageUrl: 'https://www.example.com/post/1' },
  { url: 'canvas://index/0', kind: 'canvas', w: 640, h: 480, alt: '', label: 'Canvas 画布', probable: false, index: 0, pageUrl: 'https://www.example.com/post/1' },
  { url: 'https://tracker.example.com/pixel.gif', kind: 'img', w: 1, h: 1, alt: '', label: 'src', probable: false, pageUrl: 'https://www.example.com/post/1' },
  { url: 'https://cdn.example.com/maybe/8f3a1c9d77b0', kind: 'attr', w: 0, h: 0, alt: '', label: 'div@data-img', probable: true, pageUrl: 'https://www.example.com/post/1' }
];
const FAKE_ITEMS_FRAME1 = [
  { url: 'https://ads.example.net/banner.png', kind: 'img', w: 300, h: 250, alt: 'ad', label: 'src', probable: false, pageUrl: 'https://ads.example.net/frame' }
];

const chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    lastError: null,
    getURL: (p) => 'chrome-extension://test/' + p,
    openOptionsPage() {},
    async sendMessage(msg) {
      outbox.push(msg);
      if (msg && msg.target === 'offscreen') {
        // 假 offscreen：FETCH 返回 blob URL，ZIP 返回打包结果
        if (msg.type === 'FETCH') {
          if (/denied/.test(msg.url)) return { ok: false, error: 'HTTP 403' };
          return { ok: true, objectUrl: 'blob:chrome-extension://test/fake-' + Math.random().toString(36).slice(2), size: 12345, type: 'image/jpeg', ext: 'jpg' };
        }
        if (msg.type === 'ZIP') return { ok: true, objectUrl: 'blob:chrome-extension://test/zip', size: 55555, name: msg.zipName, count: msg.files.length };
        if (msg.type === 'CROP') return { ok: true, dataUrl: 'data:image/png;base64,AAAA' };
        if (msg.type === 'DATAURL') return { ok: true, dataUrl: 'data:image/jpeg;base64,EEEE', size: 999, type: 'image/jpeg', ext: 'jpg' };
        if (msg.type === 'CLIPBOARD') return { ok: true };
        if (msg.type === 'RELEASE') return { ok: true };
        return { ok: true };
      }
      return { ok: true };
    }
  },
  storage: {
    local: {
      async get(k) {
        if (typeof k === 'string') return { [k]: localStore[k] };
        return Object.assign({}, localStore);
      },
      async set(o) {
        Object.assign(localStore, o);
      }
    },
    session: {
      async get(k) {
        return typeof k === 'string' ? { [k]: sessionStore[k] } : Object.assign({}, sessionStore);
      },
      async set(o) {
        Object.assign(sessionStore, o);
      },
      async remove(k) {
        delete sessionStore[k];
      }
    }
  },
  scripting: {
    async executeScript(arg) {
      if (arg.files) return [{ frameId: 0, result: null }];
      return [
        { frameId: 0, result: { ok: true, items: FAKE_ITEMS_FRAME0, stats: { frames: 1, ms: 42, truncated: false } } },
        { frameId: 7, result: { ok: true, items: FAKE_ITEMS_FRAME1, stats: { frames: 1, ms: 12, truncated: false } } }
      ];
    }
  },
  tabs: {
    async get(id) {
      return { id, url: 'https://www.example.com/post/1', title: '测试页面', windowId: 1, favIconUrl: '' };
    },
    async create() {},
    async update() {},
    async sendMessage(tabId, msg, opts) {
      if (msg.type === 'IGP_BLOB') return { ok: true, dataUrl: 'data:image/png;base64,BBBB' };
      if (msg.type === 'IGP_CANVAS') return { ok: false, error: 'CORS 保护（跨域画布被污染）' };
      if (msg.type === 'IGP_VIDEO_FRAME') return { ok: true, dataUrl: 'data:image/png;base64,CCCC', w: 640, h: 480 };
      if (msg.type === 'IGP_RECT') return { ok: true, rect: { x: 10, y: 20, w: 640, h: 480 }, dpr: 2 };
      if (msg.type === 'IGP_HIGHLIGHT') return { ok: true };
      return { ok: true };
    },
    onUpdated: { addListener() {} },
    async captureVisibleTab() {
      return 'data:image/png;base64,DDDD';
    }
  },
  downloads: {
    download(opts, cb) {
      downloads.push(opts);
      if (cb) cb(downloads.length);
    }
  },
  declarativeNetRequest: {
    async updateSessionRules(rule) {
      dnrRules.push(rule);
    }
  },
  contextMenus: {
    removeAll(cb) {
      if (cb) cb();
    },
    create() {},
    onClicked: { addListener: (fn) => (menuListener = fn) }
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {}
  },
  offscreen: {
    async hasDocument() {
      return true;
    },
    async createDocument() {}
  }
};

const sandbox = {
  chrome,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  TextEncoder,
  TextDecoder,
  Promise,
  Math,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  isFinite,
  parseInt,
  parseFloat
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'background.js' });

// ------------------------------------------------------------------ 测试工具
function call(msg, sender) {
  return new Promise((resolve, reject) => {
    let settled = false;
    for (const fn of listeners) {
      const ret = fn(msg, sender || {}, (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      });
      if (ret === true) {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('消息 ' + msg.type + ' 没有响应（超时）'));
          }
        }, 8000);
        return;
      }
    }
    if (!settled) resolve(undefined);
  });
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''));
  }
}

(async function run() {
  console.log('\n[1] 采集：合并多 frame 结果');
  const collected = await call({ type: 'IGP_COLLECT', tabId: 1, opts: { deep: true } });
  check('返回 ok', collected && collected.ok === true, collected);
  check('合并了 iframe 里的图片（8 张）', collected.items.length === 8, collected.items && collected.items.length);
  const adItem = collected.items.find((i) => i.url.includes('ads.example.net'));
  check('iframe 条目带 frameId=7', adItem && adItem.frameId === 7, adItem);
  check('统计里记录了 frame 数', collected.stats.frames === 2, collected.stats);

  console.log('\n[2] 下载：模板、并发、三级兜底');
  const settings = await call({ type: 'IGP_SETTINGS_GET' });
  check('默认设置可读取', settings.ok && settings.settings.concurrency === 4, settings.settings);
  await call({
    type: 'IGP_SETTINGS_SET',
    settings: { nameTemplate: '{index}_{w}x{h}_{name}', folderTemplate: '图集捕手/{host}/{date}', concurrency: 3 }
  });

  const dlItems = collected.items.filter((i) => i.kind !== 'canvas');
  const dlRes = await call({ type: 'IGP_DOWNLOAD', tabId: 1, items: dlItems, opts: {} });
  check('批量下载返回 ok', dlRes && dlRes.ok, dlRes && dlRes.state);
  check('每个条目都触发了下载', downloads.length === dlItems.length, { got: downloads.length, want: dlItems.length });
  check(
    '路径带站点目录与日期',
    downloads.every((d) => /^图集捕手\/www\.example\.com\/\d{4}-\d{2}-\d{2}\//.test(d.filename)),
    downloads.map((d) => d.filename)
  );
  check(
    '文件名模板 {index}_{w}x{h}_{name} 生效（并保留真实扩展名）',
    downloads.some((d) => /2_800x600_bg\.webp$/.test(d.filename)) && downloads.some((d) => /1_1920x1080_photo-1\.jpg$/.test(d.filename)),
    downloads.map((d) => d.filename)
  );
  check('data: 地址直接下载', downloads.some((d) => d.url.startsWith('data:image/svg')), null);
  check('blob: 地址被转成 dataURL 下载', downloads.some((d) => d.url === 'data:image/png;base64,BBBB'), null);
  check('防盗链规则已下发并回收', dnrRules.length >= 2 && dnrRules.every((r) => 'addRules' in r || 'removeRuleIds' in r), dnrRules.length);
  check('走的都是 offscreen 抓取通道', Object.keys(dlRes.state.via).includes('fetch'), dlRes.state.via);

  console.log('\n[3] 抓取失败时回退直连');
  downloads.length = 0;
  const res403 = await call({
    type: 'IGP_DOWNLOAD',
    tabId: 1,
    items: [{ url: 'https://cdn.example.com/denied/pic.png', kind: 'img', w: 0, h: 0, alt: '', pageUrl: 'https://www.example.com/post/1' }],
    opts: {}
  });
  check('403 后仍完成下载（回退直连）', res403.state.ok === 1, res403.state);
  check('直连下载的是原始地址', downloads[0] && downloads[0].url === 'https://cdn.example.com/denied/pic.png', downloads[0]);

  console.log('\n[3b] 浏览器拒绝 blob URL 下载时 → dataURL 兜底');
  const realDownload = chrome.downloads.download;
  chrome.downloads.download = (opts, cb) => {
    if (String(opts.url).startsWith('blob:')) {
      // 真实浏览器失败时会置 lastError，这里如实模拟
      chrome.runtime.lastError = { message: 'Invalid URL' };
      try {
        if (cb) cb(undefined);
      } finally {
        chrome.runtime.lastError = null;
      }
      return;
    }
    realDownload(opts, cb);
  };
  downloads.length = 0;
  const blobFallback = await call({
    type: 'IGP_DOWNLOAD',
    tabId: 1,
    items: [{ url: 'https://cdn.example.com/pic/blob-test.jpg', kind: 'img', w: 0, h: 0, alt: '', pageUrl: 'https://www.example.com/post/1' }],
    opts: {}
  });
  chrome.downloads.download = realDownload;
  check('blob 下载被拒后改用 dataURL 成功', blobFallback.state.ok === 1 && Object.keys(blobFallback.state.via).includes('fetch-data'), blobFallback.state);
  check('落盘的确实是 dataURL 通道', downloads.every((d) => !d.url.startsWith('blob:')), downloads.map((d) => d.url.slice(0, 40)));

  console.log('\n[4] Canvas 导出：直接取源失败 → 截图兜底');
  const canvasRes = await call({
    type: 'IGP_VISUAL_DATA',
    tabId: 1,
    frameId: 0,
    kind: 'canvas',
    index: 0,
    url: 'canvas://index/0',
    pageUrl: 'https://www.example.com/post/1'
  });
  check('画布导出成功（走截图）', canvasRes.ok && canvasRes.via === 'screenshot', canvasRes);
  check('导出的是裁剪后的 PNG', String(canvasRes.dataUrl).startsWith('data:image/png'), canvasRes.dataUrl && canvasRes.dataUrl.slice(0, 30));

  console.log('\n[5] ZIP 打包');
  const zipRes = await call({
    type: 'IGP_ZIP',
    items: dlItems.slice(0, 3).map((i, k) => Object.assign({ index: k + 1 }, i)),
    pageUrl: 'https://www.example.com/post/1'
  });
  check('打包成功', zipRes.ok && zipRes.count === 3, zipRes);
  check('ZIP 文件名带站点与日期', /^www\.example\.com-\d{4}-\d{2}-\d{2}\.zip$/.test(zipRes.name), zipRes.name);
  const zipCall = outbox.filter((m) => m.target === 'offscreen' && m.type === 'ZIP').pop();
  check('ZIP 里每个文件都有文件名', zipCall.files.every((f) => f.name && f.name.length > 3), zipCall.files.map((f) => f.name));

  console.log('\n[6] 内部页面保护');
  const savedGet = chrome.tabs.get;
  chrome.tabs.get = async (id) => ({ id, url: undefined, title: '设置', windowId: 1 });
  const internal = await call({ type: 'IGP_COLLECT', tabId: 9, opts: {} });
  check('内部页面给出明确提示', internal.ok === false && /内部页面/.test(internal.error), internal);
  chrome.tabs.get = savedGet;

  console.log('\n[7] 右键菜单');
  check('右键菜单已注册', menuListener !== null && Object.keys(menuListener).length >= 0, null);
  downloads.length = 0;
  await menuListener({ menuItemId: 'igp-image-download', srcUrl: 'https://cdn.example.com/x/one.jpg', pageUrl: 'https://www.example.com/p' }, { id: 1, url: 'https://www.example.com/p' });
  check('右键单图下载可用', downloads.length === 1, downloads);

  downloads.length = 0;
  sessionStore = {};
  await menuListener({ menuItemId: 'igp-page-gallery', pageUrl: 'https://www.example.com/p' }, { id: 1, url: 'https://www.example.com/p' });
  const handoffKey = Object.keys(sessionStore).find((k) => k.startsWith('igp_handoff_'));
  check('图库接力数据已写入 session', !!handoffKey && sessionStore[handoffKey].items.length === 8, handoffKey);

  console.log('\n[8] 极端参数下的文件名（非法字符 / 空目录 / 超长名）');
  await call({
    type: 'IGP_SETTINGS_SET',
    settings: { folderTemplate: '///', nameTemplate: '{alt}', concurrency: 2 }
  });
  downloads.length = 0;
  await call({
    type: 'IGP_DOWNLOAD',
    tabId: 1,
    items: [
      { url: 'https://cdn.example.com/i?id=1&ext=jpg', kind: 'img', w: 0, h: 0, alt: 'a/b\\c:d*e?f"g<h>i|j\nk', pageUrl: 'https://www.example.com/p' },
      { url: 'https://cdn.example.com/' + 'x'.repeat(300) + '.png', kind: 'img', w: 0, h: 0, alt: '', pageUrl: 'https://www.example.com/p' },
      { url: 'data:image/png;base64,iVBORw0KGgo=', kind: 'canvas', w: 10, h: 10, alt: '', pageUrl: 'https://www.example.com/p' }
    ],
    opts: {}
  });
  check('三个条目都提交了下载', downloads.length === 3, downloads.length);
  check('文件名不会以 / 开头', downloads.every((d) => !d.filename.startsWith('/')), downloads.map((d) => d.filename));
  check('文件名不含反斜杠/非法字符', downloads.every((d) => !/[\\:*?"<>|\u0000-\u001f]/.test(d.filename)), downloads.map((d) => d.filename));
  check('文件名不含 .. 或多余斜杠', downloads.every((d) => !d.filename.includes('..') && !d.filename.includes('//')), downloads.map((d) => d.filename));
  check('超长文件名被截断', downloads.every((d) => d.filename.length < 240), downloads.map((d) => d.filename.length));
  check('data: 图片有兜底文件名', downloads.some((d) => /canvas-03\.png$/.test(d.filename)), downloads.map((d) => d.filename));

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
