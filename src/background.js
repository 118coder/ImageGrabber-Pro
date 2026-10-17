/* =============================================================================
 * 图集捕手 Image Grabber Pro — Service Worker
 * -----------------------------------------------------------------------------
 * 职责：
 *   · 汇总所有 frame 的扫描结果（chrome.scripting.executeScript allFrames）
 *   · 下载调度：并发队列 + 进度回传 + 目录/文件命名模板
 *   · 抓取策略三级兜底：
 *       ① offscreen 带 Cookie / 可改 Referer 的跨域 fetch（兼容防盗链、需登录）
 *       ② 直接交给浏览器下载器（走浏览器自身会话）
 *       ③ 元素可见区域截图（Canvas 污染 / 视频帧 / 无法取源时）
 *   · 防盗链：按需下发 declarativeNetRequest 会话规则改写 Referer
 *   · ZIP 打包（交给 offscreen 做，SW 里没有 createObjectURL）
 * =========================================================================== */

const OFFSCREEN_PATH = 'src/offscreen.html';
const DEFAULTS = {
  minWidth: 0,
  minHeight: 0,
  includeProbable: false,
  deepScan: true,
  thoroughScan: false,
  scriptScan: true,
  includeTiny: false,
  folderTemplate: '图集捕手/{host}',
  nameTemplate: '{name}',
  concurrency: 4,
  hotlinkBypass: true,
  fetchFirst: true
};

// ------------------------------------------------------------------ 配置读写
async function getSettings() {
  const got = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, got.settings || {});
}

// ------------------------------------------------------------------ offscreen
let offscreenReady = null;
async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      if (chrome.offscreen && chrome.offscreen.hasDocument) {
        const has = await chrome.offscreen.hasDocument();
        if (has) return true;
      }
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: '跨域抓取图片资源并生成可下载的 blob URL、打包 ZIP'
      });
      return true;
    } catch (e) {
      if (String(e && e.message).includes('Only a single offscreen')) return true;
      offscreenReady = null;
      return false;
    }
  })();
  return offscreenReady;
}

async function offscreenCall(payload, retry = true) {
  const ok = await ensureOffscreen();
  if (!ok) return { ok: false, error: '无法创建 offscreen 文档（浏览器版本过低？需 Chrome/Edge 109+）' };
  try {
    return await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, payload));
  } catch (e) {
    if (retry) {
      offscreenReady = null;
      return offscreenCall(payload, false);
    }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------------ 防盗链
let dnrSeq = 1;
function urlFilterFor(url) {
  let u = url;
  try {
    const p = new URL(url);
    u = p.origin + p.pathname;
  } catch (_) {
    /* 保持原样 */
  }
  u = u.split(/[?#]/)[0].slice(0, 1800);
  if (/[*^|]/.test(u)) {
    try {
      u = new URL(url).origin + '/';
    } catch (_) {
      return null;
    }
  }
  return '|' + u;
}

/**
 * 在 fn() 执行期间，为该图片地址临时改写请求头。
 *
 * 两种防盗链策略（实测都需要）：
 *   'spoof'  把 Referer 伪造成来源页——多数站点校验 Referer 是否属于自己域名
 *   'omit'   把 Referer 清空——另一些站点把"没有 Referer"当作直接访问而放行
 * 业务上先试 spoof，失败再用 omit 重试一次，两条路合起来覆盖面最大。
 */
async function withReferer(imageUrl, pageUrl, fn, opts) {
  const settings = await getSettings();
  if (!settings.hotlinkBypass || !pageUrl) return fn();
  const mode = opts && opts.mode === 'omit' ? 'omit' : 'spoof';

  let origin = '';
  try {
    const p = new URL(pageUrl);
    if (!/^https?:$/.test(p.protocol)) return fn();
    origin = p.origin + '/';
  } catch (_) {
    return fn();
  }
  const filter = urlFilterFor(imageUrl);
  if (!filter) return fn();

  const id = 910000 + (dnrSeq++ % 80000);
  const requestHeaders =
    mode === 'omit'
      ? [{ header: 'referer', operation: 'remove' }]
      : [{ header: 'referer', operation: 'set', value: origin }];
  if (mode !== 'omit' && opts && opts.withOrigin) {
    requestHeaders.push({ header: 'origin', operation: 'set', value: origin.replace(/\/$/, '') });
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 2,
          action: { type: 'modifyHeaders', requestHeaders },
          condition: {
            urlFilter: filter,
            resourceTypes: ['xmlhttprequest', 'image', 'media', 'other', 'object', 'main_frame', 'sub_frame']
          }
        }
      ]
    });
  } catch (_) {
    return fn();
  }
  try {
    return await fn();
  } finally {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

/** 带防盗链双策略的抓取：先伪装 Referer，失败再清空 Referer 重试 */
async function fetchWithHotlinkRetry(imageUrl, pageUrl, run) {
  const first = await withReferer(imageUrl, pageUrl, run, { mode: 'spoof' });
  if (first && first.ok) return first;
  const second = await withReferer(imageUrl, pageUrl, run, { mode: 'omit' });
  if (second && second.ok) return second;
  return first || second;
}

// ------------------------------------------------------------------ 缩略图缓存
// 弹窗滚动/切换尺寸会反复请求同一批图，缓存 5 分钟避免重复解码
const thumbCache = new Map();
const thumbInflight = new Map(); // 同一 URL 的并发请求合并成一次

const THUMB_CONCURRENCY = 4;
let thumbActive = 0;
const thumbQueue = [];

function scheduleThumb(task) {
  return new Promise((resolve, reject) => {
    thumbQueue.push({ task, resolve, reject });
    pumpThumb();
  });
}

function pumpThumb() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive++;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        thumbActive--;
        pumpThumb();
      });
  }
}

// ------------------------------------------------------------------ 采集
/** 给任意 Promise 加超时；超时返回 fallback，而不是让调用方永远挂着 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: String((e && e.message) || e) })),
    new Promise((r) => setTimeout(() => r({ timeout: true }), ms))
  ]).then((r) => (r.timeout ? fallback : r.ok ? r.value : null));
}

async function injectContentScript(tabId) {
  try {
    // 注入本身也可能因为页面正在卸载/导航而挂起
    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['src/content.js']
      }),
      8000,
      null
    );
  } catch (_) {
    /* 有些 frame（chrome:// 等）注入失败属正常 */
  }
}

async function collectAll(tabId, opts) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: '标签页已关闭' };
  if (!tab.url) {
    return { ok: false, error: '这是浏览器内部页面（设置 / 扩展管理 / 应用商店），扩展无权读取里面内容' };
  }
  if (/^(chrome|edge|about|devtools|chrome-extension|extension|view-source):/i.test(tab.url)) {
    return { ok: false, error: '浏览器内部页面不允许扩展读取（请换普通网页）' };
  }

  await injectContentScript(tabId);

  // 关键：executeScript 在某个 frame 卡死（页面死循环、巨型 DOM、正在导航）时不会返回。
  // 这里必须给硬超时，否则弹窗会一直"卡加载"。
  const budget = Math.max(6000, Math.min(20000, (opts && opts.budgetMs ? opts.budgetMs : 300) * 12));
  let frames = null;
  const raw = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (o) => (window.__IGP__ && window.__IGP__.collect ? window.__IGP__.collect(o) : null),
      args: [opts]
    }),
    budget,
    'TIMEOUT'
  );

  if (raw === 'TIMEOUT') {
    // 退路：只扫主 frame（子 frame 卡住时仍能拿到主要内容）
    const mainOnly = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: (o) => (window.__IGP__ && window.__IGP__.collect ? window.__IGP__.collect(o) : null),
        args: [opts]
      }),
      budget,
      'TIMEOUT'
    );
    if (mainOnly === 'TIMEOUT' || mainOnly === null) {
      return {
        ok: false,
        error: `扫描超时（${Math.round(budget / 1000)} 秒未响应）。页面可能过大或某个子框架无响应，可尝试只扫主页面或刷新后再试`
      };
    }
    frames = mainOnly;
  } else if (raw === null) {
    return { ok: false, error: '扫描失败：页面脚本无响应或已导航' };
  } else {
    frames = raw;
  }

  const merged = new Map();
  const stats = { frames: 0, ms: 0, truncated: false };
  for (const fr of frames) {
    const res = fr && fr.result;
    if (!res || !res.ok) continue;
    stats.frames++;
    stats.ms = Math.max(stats.ms, res.stats ? res.stats.ms : 0);
    if (res.stats && res.stats.truncated) stats.truncated = true;
    for (const item of res.items || []) {
      const key = item.url;
      const prev = merged.get(key);
      const frameId = fr.frameId == null ? 0 : fr.frameId;
      if (!prev) {
        item.frameId = frameId;
        item.inIframe = frameId !== 0;
        item.topPageUrl = tab.url || ''; // 归档目录按"用户正在看的这个页面"算，而不是 iframe 自己的域名
        merged.set(key, item);
      } else {
        if (!prev.w && item.w) {
          prev.w = item.w;
          prev.h = item.h;
        }
        if (!prev.alt && item.alt) prev.alt = item.alt;
        prev.probable = prev.probable && item.probable;
      }
    }
  }

  const items = Array.from(merged.values());
  return {
    ok: true,
    items,
    stats,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    tabId
  };
}

// ------------------------------------------------------------------ 命名
function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function sanitize(s, fallback) {
  const out = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  return out || fallback || 'image';
}

/** 目录分段用：允许返回空串（空分段会被丢掉，而不是变成 "image"） */
function sanitizeSegment(s) {
  return String(s == null ? '' : s)
    .replace(/[\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

function baseNameFromUrl(url) {
  if (url.startsWith('data:')) return '';
  if (/^(canvas|video):\/\//.test(url)) return '';
  try {
    const p = new URL(url);
    let last = p.pathname.split('/').filter(Boolean).pop() || '';
    try {
      last = decodeURIComponent(last);
    } catch (_) {
      /* 保持原样 */
    }
    return last;
  } catch (_) {
    return '';
  }
}

function extFromUrl(url) {
  const base = baseNameFromUrl(url);
  const m = base.match(/\.([a-zA-Z0-9]{2,5})$/);
  if (!m) return '';
  const ext = '.' + m[1].toLowerCase();
  if (/\.(?:js|css|html?|json|php|aspx?|jsp)$/.test(ext)) return '';
  return ext;
}

function pageHostOf(item) {
  // 目录/命名用顶层页面域名；防盗链 Referer 另用 item.pageUrl（那才是真正的来源页）
  const src = item.topPageUrl || item.pageUrl || item.frameUrl || '';
  try {
    return new URL(src).host || 'page';
  } catch (_) {
    return 'page';
  }
}

function buildFilename(item, settings, index) {
  settings = settings || DEFAULTS;
  const host = pageHostOf(item);
  let base = baseNameFromUrl(item.url);
  let ext = extFromUrl(item.url);

  if (!base) {
    const kindName = { canvas: 'canvas', media: 'video-frame', 'svg-inline': 'vector', img: 'image' };
    base = (kindName[item.kind] || 'image') + '-' + pad(((index - 1) % 999) + 1);
    if (item.kind === 'svg-inline' && !ext) ext = '.svg';
    if ((item.kind === 'canvas' || item.kind === 'media') && !ext) ext = '.png';
  } else if (ext) {
    base = base.slice(0, base.length - ext.length);
  }
  base = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);

  const w = item.w || 0;
  const h = item.h || 0;
  const vars = {
    name: base,
    ext: ext.replace(/^\./, ''),
    index: String(index),
    w: String(w),
    h: String(h),
    size: w && h ? w + 'x' + h : '',
    alt: (item.alt || '').slice(0, 40),
    host,
    date: today(),
    kind: item.kind || 'img'
  };
  let tpl = settings.nameTemplate || '{name}';
  let name = tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  name = sanitize(name, base);
  if (!/\.[a-zA-Z0-9]{2,5}$/.test(name) && ext) name += ext;
  return name;
}

function buildFolder(item, settings) {
  const host = pageHostOf(item);
  const tpl = settings.folderTemplate || DEFAULTS.folderTemplate;
  const folder = tpl
    .replace(/\{host\}/g, host)
    .replace(/\{date\}/g, today())
    .replace(/\{title\}/g, '')
    .split('/')
    .map((seg) => sanitizeSegment(seg))
    .filter(Boolean)
    .join('/');
  return folder;
}

// ------------------------------------------------------------------ 下载
async function downloadViaUrl(url, filename) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download(
        { url, filename, saveAs: false, conflictAction: 'uniquify' },
        (downloadId) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve({ ok: true, downloadId });
        }
      );
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/** 单个图片的下载（三级兜底） */
async function downloadOne(item, index, ctx) {
  const settings = ctx.settings;
  const folder = buildFolder(item, settings);
  let filename = (folder ? folder + '/' : '') + buildFilename(item, settings, index);
  filename = filename.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '');

  // 已是内联数据（canvas 导出 / SVG / data URI）
  if (item.url.startsWith('data:')) {
    return Object.assign(await downloadViaUrl(item.url, filename), { via: 'data' });
  }

  // blob: 只能在页面上下文转换
  if (item.url.startsWith('blob:') && ctx.tabId != null) {
    const res = await sendToFrame(ctx.tabId, item.frameId, { type: 'IGP_BLOB', url: item.url });
    if (res && res.ok && res.dataUrl) {
      return Object.assign(await downloadViaUrl(res.dataUrl, filename), { via: 'blob' });
    }
  }

  // 首选：带 Cookie / Referer 的 offscreen 抓取（伪装 Referer 失败会再试"无 Referer"）
  if (settings.fetchFirst && /^https?:/i.test(item.url)) {
    const fetched = await fetchWithHotlinkRetry(item.url, item.pageUrl, () =>
      offscreenCall({ type: 'FETCH', url: item.url, wantDataUrl: false, timeout: ctx.timeout || 45000 })
    );
    if (fetched && fetched.ok && fetched.objectUrl) {
      let name = filename;
      if (fetched.ext && !/\.[a-zA-Z0-9]{2,5}$/.test(name)) name += '.' + fetched.ext;
      const saved = await downloadViaUrl(fetched.objectUrl, name);
      if (saved.ok) {
        setTimeout(() => {
          offscreenCall({ type: 'RELEASE', objectUrl: fetched.objectUrl, delay: 0 }).catch(() => {});
        }, 300000);
        return Object.assign(saved, { via: 'fetch', size: fetched.size });
      }
      // 兜底：个别版本对 blob URL 下载有限制，小文件改走 dataURL 再存一次
      const asData = await offscreenCall({
        type: 'DATAURL',
        objectUrl: fetched.objectUrl,
        maxBytes: 12 * 1024 * 1024
      });
      if (asData && asData.ok && asData.dataUrl) {
        const retry = await downloadViaUrl(asData.dataUrl, name);
        if (retry.ok) {
          setTimeout(() => {
            offscreenCall({ type: 'RELEASE', objectUrl: fetched.objectUrl, delay: 0 }).catch(() => {});
          }, 300000);
          return Object.assign(retry, { via: 'fetch-data', size: asData.size });
        }
      }
      // 还是不行就退回直连
    }
  }

  // 兜底：交给浏览器下载器（走浏览器自己的 Cookie 会话）
  const direct = await downloadViaUrl(item.url, filename);
  return Object.assign(direct, { via: 'direct' });
}

async function sendToFrame(tabId, frameId, msg, timeout = 8000) {
  // frameId 可能来自 dataset（字符串）或别的消息来源，必须规范成整数：
  // chrome.tabs.sendMessage 收到 "0" 这种字符串会直接报错，导致整条通道静默失效。
  let fid = null;
  if (frameId != null && frameId !== '') {
    const n = Number(frameId);
    fid = Number.isInteger(n) && n >= 0 ? n : null;
  }
  const opts = fid == null ? {} : { frameId: fid };
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, msg, opts),
      new Promise((r) => setTimeout(() => r({ ok: false, error: '内容脚本无响应' }), timeout))
    ]);
    return res || { ok: false, error: '无响应' };
  } catch (e) {
    // frame 已销毁 / 该 frame 没有内容脚本：退化为广播给所有 frame
    try {
      if (fid != null) {
        const res = await Promise.race([
          chrome.tabs.sendMessage(tabId, msg),
          new Promise((r) => setTimeout(() => r({ ok: false, error: '内容脚本无响应' }), timeout))
        ]);
        return res || { ok: false, error: '无响应' };
      }
    } catch (_) {
      /* 落到下面返回错误 */
    }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 可见区域截图（Canvas 被污染 / 视频帧 / 无法取源时使用） */
async function cropVisibleShot(tabId, item) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: '标签页已关闭' };

  let rectRes = await sendToFrame(tabId, item.frameId, { type: 'IGP_RECT', url: item.url });
  if (!rectRes || !rectRes.ok) {
    await sendToFrame(tabId, item.frameId, { type: 'IGP_HIGHLIGHT', url: item.url });
    await new Promise((r) => setTimeout(r, 500));
    rectRes = await sendToFrame(tabId, item.frameId, { type: 'IGP_RECT', url: item.url });
  }
  if (!rectRes || !rectRes.ok) return { ok: false, error: '元素不在可见区域内，请先在页面上滚动到它' };

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    return { ok: false, error: '截图失败：' + String((e && e.message) || e) };
  }

  const cropped = await offscreenCall({
    type: 'CROP',
    dataUrl,
    rect: rectRes.rect,
    dpr: rectRes.dpr || 1
  });
  if (!cropped || !cropped.ok) return { ok: false, error: (cropped && cropped.error) || '裁剪失败' };
  return { ok: true, dataUrl: cropped.dataUrl, w: Math.round(rectRes.rect.w), h: Math.round(rectRes.rect.h) };
}

/** canvas / video 元素导出 */
async function exportVisual(tabId, { kind, index, url, frameId, tryShot }) {
  const res =
    kind === 'canvas'
      ? await sendToFrame(tabId, frameId, { type: 'IGP_CANVAS', index })
      : await sendToFrame(tabId, frameId, { type: 'IGP_VIDEO_FRAME', index });

  if (res && res.ok && res.dataUrl) return { ok: true, dataUrl: res.dataUrl, w: res.w, h: res.h, via: 'direct' };
  if (!tryShot) return { ok: false, error: (res && res.error) || '取源失败' };

  const shot = await cropVisibleShot(tabId, { url, frameId, kind });
  if (shot.ok) return { ok: true, dataUrl: shot.dataUrl, w: shot.w, h: shot.h, via: 'screenshot' };
  return { ok: false, error: ((res && res.error) || '取源失败') + '；' + (shot.error || '截图也失败了') };
}

// ------------------------------------------------------------------ 批量队列
const running = new Map(); // jobId -> {done, total, fails, canceled}

async function runBatch(tabId, items, opts) {
  const settings = await getSettings();
  const concurrency = Math.max(1, Math.min(12, opts.concurrency || settings.concurrency || 4));
  const jobId = 'job_' + Date.now();
  const state = { done: 0, total: items.length, ok: 0, fail: 0, errors: [], canceled: false, via: {} };
  running.set(jobId, state);
  broadcast({ type: 'IGP_PROGRESS', jobId, done: 0, total: items.length, phase: 'start' });

  const queue = items.map((item, i) => ({ item, i }));
  const ctx = { settings, tabId, timeout: 45000 };

  async function worker() {
    for (;;) {
      if (state.canceled) return;
      const next = queue.shift();
      if (!next) return;
      const { item, i } = next;
      let res;
      try {
        res = await downloadOne(item, i + 1, ctx);
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      state.done++;
      if (res && res.ok) {
        state.ok++;
        const v = res.via || 'direct';
        state.via[v] = (state.via[v] || 0) + 1;
      } else {
        state.fail++;
        if (state.errors.length < 30) {
          state.errors.push({ url: item.url, error: (res && res.error) || '未知错误' });
        }
      }
      broadcast({
        type: 'IGP_PROGRESS',
        jobId,
        done: state.done,
        total: state.total,
        ok: state.ok,
        fail: state.fail,
        phase: 'progress'
      });
      await new Promise((r) => setTimeout(r, 40)); // 轻微错峰，避免瞬时打满连接
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  running.delete(jobId);
  broadcast({ type: 'IGP_PROGRESS', jobId, done: state.done, total: state.total, ok: state.ok, fail: state.fail, phase: 'done' });
  return state;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ------------------------------------------------------------------ 右键菜单
const MENUS = [
  { id: 'igp-image-download', title: '用图集捕手下载这张图片', contexts: ['image'] },
  { id: 'igp-image-copy', title: '复制图片地址', contexts: ['image'] },
  { id: 'igp-link-download', title: '下载链接指向的图片', contexts: ['link'] },
  { id: 'igp-page-gallery', title: '提取本页所有图片（打开图库）', contexts: ['page', 'frame', 'selection'] },
  { id: 'igp-page-download', title: '直接下载本页全部图片', contexts: ['page', 'frame'] },
  { id: 'igp-selection-download', title: '只提取选区内的图片（打开图库）', contexts: ['selection'] }
];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    MENUS.forEach((m) => {
      try {
        chrome.contextMenus.create(m);
      } catch (_) {
        /* ignore */
      }
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  try {
    switch (info.menuItemId) {
      case 'igp-image-download': {
        const url = info.srcUrl;
        if (!url) return;
        const item = {
          url,
          kind: 'img',
          w: 0,
          h: 0,
          alt: '',
          pageUrl: info.pageUrl || tab.url
        };
        await downloadOne(item, 1, { settings: await getSettings(), tabId: tab.id });
        broadcast({ type: 'IGP_TOAST', text: '已开始下载图片', kind: 'ok' });
        break;
      }
      case 'igp-image-copy': {
        if (!info.srcUrl) return;
        const copied = await offscreenCall({ type: 'CLIPBOARD', text: info.srcUrl });
        if (copied && copied.ok) {
          broadcast({ type: 'IGP_TOAST', text: '图片地址已复制到剪贴板', kind: 'ok' });
        } else {
          await chrome.storage.session.set({ clipboard: info.srcUrl });
          broadcast({ type: 'IGP_TOAST', text: '地址已取出：打开本扩展面板会自动复制', kind: 'warn' });
        }
        break;
      }
      case 'igp-link-download': {
        if (!info.linkUrl) return;
        await downloadOne(
          { url: info.linkUrl, kind: 'link', w: 0, h: 0, alt: '', pageUrl: info.pageUrl || tab.url },
          1,
          { settings: await getSettings(), tabId: tab.id }
        );
        break;
      }
      case 'igp-page-gallery':
      case 'igp-selection-download': {
        const opts = { deep: true, thorough: await thoroughDefault(), budgetMs: 400 };
        if (info.menuItemId === 'igp-selection-download') opts.scopeSelection = true;
        const res = await collectAll(tab.id, opts);
        if (!res.ok) {
          broadcast({ type: 'IGP_TOAST', text: res.error, kind: 'error' });
          return;
        }
        const items = res.items;
        const id = 'h' + Date.now().toString(36);
        const payload = {
          items,
          pageUrl: res.pageUrl,
          pageTitle: res.pageTitle,
          tabId: tab.id,
          ts: Date.now()
        };
        try {
          await chrome.storage.session.set({ ['igp_handoff_' + id]: payload });
        } catch (_) {
          /* 超限就退化成不带数据打开 */
        }
        chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer.html') + '?id=' + id });
        break;
      }
      case 'igp-page-download': {
        const res = await collectAll(tab.id, { deep: true, thorough: await thoroughDefault(), budgetMs: 400 });
        if (!res.ok) {
          broadcast({ type: 'IGP_TOAST', text: res.error, kind: 'error' });
          return;
        }
        const settings = await getSettings();
        const filtered = filterItems(res.items, settings);
        const state = await runBatch(tab.id, filtered, { settings });
        broadcast({
          type: 'IGP_TOAST',
          text: `下载完成：成功 ${state.ok} / 失败 ${state.fail}`,
          kind: state.fail ? 'warn' : 'ok'
        });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    broadcast({ type: 'IGP_TOAST', text: String((e && e.message) || e), kind: 'error' });
  }
});

async function thoroughDefault() {
  const s = await getSettings();
  return !!s.thoroughScan;
}

function filterItems(items, settings) {
  const minW = settings.minWidth || 0;
  const minH = settings.minHeight || 0;
  return items.filter((it) => {
    if (!settings.includeProbable && it.probable) return false;
    if (it.kind === 'canvas' || it.kind === 'media') return true;
    if (minW && it.w && it.w < minW) return false;
    if (minH && it.h && it.h < minH) return false;
    if (!settings.includeTiny && it.w === 1 && it.h === 1) return false;
    return true;
  });
}

// ------------------------------------------------------------------ 消息路由
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.target === 'offscreen') return false; // 给 offscreen 的消息

  (async () => {
    try {
      switch (msg.type) {
        case 'IGP_COUNT': {
          if (sender.tab && sender.tab.id != null && sender.frameId === 0) {
            updateBadge(sender.tab.id, msg.count || 0);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'IGP_SETTINGS_GET':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'IGP_SETTINGS_SET': {
          const cur = await getSettings();
          const next = Object.assign(cur, msg.settings || {});
          await chrome.storage.local.set({ settings: next });
          sendResponse({ ok: true, settings: next });
          break;
        }
        case 'IGP_COLLECT': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          const settings = await getSettings();
          const opts = Object.assign(
            { deep: settings.deepScan, thorough: settings.thoroughScan, scripts: settings.scriptScan, budgetMs: 300 },
            msg.opts || {}
          );
          sendResponse(await collectAll(tabId, opts));
          break;
        }
        case 'IGP_DOWNLOAD': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          const settings = await getSettings();
          const state = await runBatch(tabId, msg.items || [], Object.assign({}, msg.opts, { settings }));
          sendResponse({ ok: true, state });
          break;
        }
        case 'IGP_THUMB': {
          // 缩略图优先级：先问页面里的内容脚本（命中页面自己的 HTTP 缓存，几乎零流量），
          // 失败再退回 offscreen（扩展分区，一定会重新下载）。
          // 原因：Chromium 的 HTTP 缓存按顶层站点分区，扩展和网页拿的不是同一份缓存。
          const maxSide = Math.max(64, Math.min(512, msg.maxSide || 256));
          const cacheKey = msg.url + '|' + maxSide;
          const hit = thumbCache.get(cacheKey);
          if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
            sendResponse(hit.value);
            break;
          }
          if (thumbInflight.has(cacheKey)) {
            sendResponse(await thumbInflight.get(cacheKey));
            break;
          }

          const job = scheduleThumb(async () => {
            let payload = null;

            // ① 页面内通道（零/低流量）
            const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
            if (tabId != null && /^(https?|blob|data):/i.test(msg.url)) {
              const inPage = await sendToFrame(
                tabId,
                msg.frameId,
                { type: 'IGP_PAGE_THUMB', url: msg.url, maxSide, quality: msg.quality },
                12000
              );
              if (inPage && inPage.ok && inPage.dataUrl) {
                payload = {
                  ok: true,
                  dataUrl: inPage.dataUrl,
                  w: inPage.w,
                  h: inPage.h,
                  passthrough: !!inPage.passthrough,
                  via: inPage.via || 'page'
                };
              }
            }

            // ② 扩展侧通道（会重新下载，作为兜底）
            if (!payload) {
              const asThumb = () =>
                offscreenCall({
                  type: 'THUMB',
                  url: msg.url,
                  maxSide,
                  quality: msg.quality,
                  timeout: 20000
                });
              const result = /^https?:/i.test(msg.url)
                ? await fetchWithHotlinkRetry(msg.url, msg.pageUrl, asThumb)
                : await asThumb();

              if (result && result.ok && result.dataUrl) {
                payload = {
                  ok: true,
                  dataUrl: result.dataUrl,
                  w: result.w,
                  h: result.h,
                  passthrough: !!result.passthrough,
                  via: 'offscreen'
                };
              } else {
                payload = { ok: false, error: (result && result.error) || '缩略图生成失败' };
              }
            }

            if (payload.ok) {
              if (thumbCache.size > 600) thumbCache.clear();
              thumbCache.set(cacheKey, { at: Date.now(), value: payload });
            }
            return payload;
          }).finally(() => thumbInflight.delete(cacheKey));

          thumbInflight.set(cacheKey, job);
          sendResponse(await job);
          break;
        }
        case 'IGP_RELEASE_URL':
          offscreenCall({ type: 'RELEASE', objectUrl: msg.objectUrl, delay: msg.delay || 0 }).catch(() => {});
          sendResponse({ ok: true });
          break;
        case 'IGP_VISUAL_DATA': {
          // 取 canvas/视频帧的像素数据（不下载），用于打包 ZIP
          const out = await exportVisual(msg.tabId, Object.assign({ tryShot: msg.tryShot !== false }, msg));
          sendResponse(out);
          break;
        }
        case 'IGP_EXPORT_VISUAL': {
          // 默认允许"可见区域截图"兜底（画布被跨域污染时唯一可行方案）
          const out = await exportVisual(msg.tabId, Object.assign({ tryShot: msg.tryShot !== false }, msg));
          if (!out.ok) {
            sendResponse(out);
            break;
          }
          const settings = await getSettings();
          const item = { url: out.dataUrl, kind: msg.kind, w: out.w, h: out.h, pageUrl: msg.pageUrl, alt: '' };
          const saved = await downloadOne(item, msg.index + 1, { settings, tabId: msg.tabId });
          sendResponse(Object.assign(saved, { via: out.via }));
          break;
        }
        case 'IGP_ZIP': {
          const zipSettings = await getSettings();
          const files = (msg.items || []).map((it) => ({
            url: it.url,
            name: buildFilename(it, zipSettings, it.index || 1),
            dataUrl: it.dataUrl
          }));
          const pageHost = (() => {
            try {
              return new URL(msg.pageUrl || '').host || 'images';
            } catch (_) {
              return 'images';
            }
          })();
          const res = await offscreenCall({
            type: 'ZIP',
            files,
            zipName: pageHost + '-' + today() + '.zip',
            timeout: 60000
          });
          if (!res || !res.ok) {
            sendResponse({ ok: false, error: (res && res.error) || '打包失败' });
            break;
          }
          const saved = await downloadViaUrl(res.objectUrl, '图集捕手/' + res.name);
          setTimeout(() => offscreenCall({ type: 'RELEASE', objectUrl: res.objectUrl }).catch(() => {}), 300000);
          sendResponse({ ok: saved.ok, error: saved.error, count: res.count, size: res.size, name: res.name });
          break;
        }
        case 'IGP_CANCEL':
          for (const [, st] of running) st.canceled = true;
          sendResponse({ ok: true });
          break;
        case 'IGP_HIGHLIGHT': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          sendResponse(await sendToFrame(tabId, msg.frameId, { type: 'IGP_HIGHLIGHT', url: msg.url }, 3000));
          break;
        }
        case 'IGP_OPEN_OPTIONS':
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        // 只有界面上才关心的广播消息，回一个空响应避免调用方报错
        case 'IGP_PROGRESS':
        case 'IGP_ZIP_PROGRESS':
        case 'IGP_TOAST':
          sendResponse({ ok: true });
          break;
        case 'IGP_HANDOFF': {
          const key = 'igp_handoff_' + msg.id;
          const got = await chrome.storage.session.get(key);
          sendResponse({ ok: true, data: got[key] || null });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息：' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();

  return true; // 异步响应
});

// ------------------------------------------------------------------ 角标
function updateBadge(tabId, count) {
  const text = count > 999 ? '999+' : count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') updateBadge(tabId, 0);
});

// ------------------------------------------------------------------ 生命周期
chrome.runtime.onInstalled.addListener(async (details) => {
  createMenus();
  const got = await chrome.storage.local.get('settings');
  if (!got.settings) await chrome.storage.local.set({ settings: DEFAULTS });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
});
chrome.runtime.onStartup.addListener(() => {
  createMenus();
});
