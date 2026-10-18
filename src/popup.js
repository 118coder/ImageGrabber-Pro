/* =============================================================================
 * 图集捕手 — 弹窗逻辑
 * =========================================================================== */
'use strict';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const emptyBox = $('empty');

let allItems = [];      // 扫描到的全部条目
let viewItems = [];     // 经过筛选、当前展示的条目
let itemByUrl = new Map(); // 当前视图的 url → 条目，点击时 O(1) 取数据
let selected = new Set();
let tabId = null;
let pageUrl = '';
let settings = {};
let renderedCount = 0;
const RENDER_LIMIT = 600; // 一次性渲染太多缩略图会卡，滚动到底自动追加

/**
 * 已生成的卡片节点（url → element）。
 * 筛选、排序、批量移图时复用同一批 DOM，不重建整格；
 * 缩略图因此不会闪一下再出现，滚动时也不会触发重复请求。
 */
const cardEls = new Map();

/**
 * 缩略图 dataURL 缓存（无容量上限风险：按条数淘汰）。
 * 重绘 / 筛选后直接从内存恢复缩略图，不再走一次异步请求。
 */
const thumbCache = new Map();
const THUMB_CACHE_LIMIT = 400;
const THUMB_CACHE_BYTES = 64 * 1024 * 1024;
let thumbCacheBytes = 0;

/** GIF 缩略图元数据：url → 是否保留了原始动画 */
const gifUrls = new Map();

/** 隐藏失效模式下，等待批量移除的 url */
let pendingBrokenUrls = new Set();
let brokenFlushTimer = null;

const state = {
  q: '',
  minSize: 120,
  typeFilter: 'all',
  sort: 'area',
  susp: false,
  deep: true,
  thorough: false,
  thumbSize: 116,
  hideBroken: false,
  dedupe: true,
  theme: 'light'
};

/** 预览失败的条目（url → 原因）。缩略图加载失败时写入，用于"隐藏失效"筛选 */
const brokenThumbs = new Map();

/** 上一轮"合并重复"折叠掉的条目数，用于状态栏提示 */
let dedupedHidden = 0;

/**
 * 内容指纹表：url → {md5}
 * 缩略图生成时顺手算出来的（页面内那条零网络链路），不是额外请求。
 * 有了它就能认出"地址不同、尺寸不同，其实是同一张图"。
 */
const contentFp = new Map();
let contentDedupeTimer = null;


function dupReasonText(reason) {
  return reason === 'md5' ? '字节完全相同（MD5 一致）' : '地址只是参数不同';
}

function dupTitle(it) {
  return `同一张图片在页面里有 ${it.dupCount} 个地址，已合并显示（${dupReasonText(it.dupReason)}）`;
}

/**
 * 记下一条内容指纹。只有"合并结果真的变了"才重绘，
 * 否则滚动过程中每加载一张缩略图都会动一次列表。
 */
function recordContent(url, res) {
  const md5 = res.md5 || '';
  if (!md5) return;
  const prev = contentFp.get(url);
  if (prev && prev.md5 === md5) return;
  contentFp.set(url, { md5 });
  if (!state.dedupe) return;
  // 真·防抖：缩略图是分批出来的，必须在最后一张到达后再跑一次，
  // 否则先到的那几张跑完就再也不会重新判重了
  clearTimeout(contentDedupeTimer);
  contentDedupeTimer = setTimeout(() => {
    contentDedupeTimer = null;
    const before = viewItems.length;
    applyFilter();
    if (viewItems.length !== before) {
      render();
      toast(`按 MD5 又合并了 ${before - viewItems.length} 张重复图片`, 'ok');
    } else {
      updateStat();
    }
  }, 700);
}

// ------------------------------------------------------------------ 小工具
function sendBg(msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // 硬超时：后台若因页面卡死而无响应，弹窗不能一直转圈
    const timer =
      timeoutMs === 0
        ? null
        : setTimeout(
            () => finish({ ok: false, error: '扫描超时：页面响应过慢，请先滚动页面让内容加载完，再重新扫描' }),
            timeoutMs || 25000
          );
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (timer) clearTimeout(timer);
        if (err) finish({ ok: false, error: err.message });
        else finish(res);
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      finish({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

let toastTimer = null;
function toast(text, kind) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast ' + (kind || '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function kindGroup(kind) {
  if (kind === 'css' || kind === 'inline-css') return 'css';
  if (kind === 'canvas' || kind === 'media') return 'visual';
  if (kind === 'svg-inline') return 'vector';
  if (kind === 'img' || kind === 'srcset' || kind === 'link' || kind === 'meta' || kind === 'poster' || kind === 'js' || kind === 'script' || kind === 'lazy' || kind === 'blob') return 'photo';
  return 'other';
}

function kindLabel(kind) {
  const map = {
    img: '图片',
    srcset: '响应式',
    link: '链接',
    meta: '分享图',
    poster: '封面',
    js: '动态',
    script: '图集',
    lazy: '懒加载',
    blob: 'Blob',
    css: '背景',
    'inline-css': '背景',
    'svg-inline': 'SVG',
    canvas: 'Canvas',
    media: '视频帧',
    attr: '属性'
  };
  return map[kind] || kind;
}

function fmtName(url, alt) {
  // 支持 fmtName(item) 与 fmtName(url, alt) 两种调用
  const it = url && typeof url === 'object' ? url : { url: String(url || ''), alt: alt || '' };
  const u = String(it.url || '');
  if (u.startsWith('data:')) {
    if (u.startsWith('data:image/svg')) return it.alt || '内联 SVG 矢量图';
    return it.alt || '内联数据图片';
  }
  if (/^(canvas|video):\/\//.test(u)) return it.alt || (u.startsWith('canvas') ? 'Canvas 画布内容' : '视频当前帧');
  // 面板显示的名字 = 下载落盘的名字（地址是 UUID 时用页面上的名字）
  if (window.IGPName) {
    const n = window.IGPName.filename(it);
    if (n) return n;
  }
  try {
    const p = new URL(u);
    const last = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || p.host);
    return (it.alt ? it.alt + ' · ' : '') + last;
  } catch (_) {
    return u.slice(0, 60);
  }
}

function isDownloadable(it) {
  return !!it.url && !/^(canvas|video):\/\//.test(it.url);
}

// ------------------------------------------------------------------ 扫描
let scanToken = 0; // 每次扫描自增；旧扫描回来时若 token 变了就丢弃，避免并发 rescan 互相覆盖 DOM

/** 找到"用户正在看的那个网页"：排除扩展自己的页面和其他扩展页 */
async function resolveTargetTab() {
  const isWebPage = (t) => t && t.id != null && /^(https?|file):/i.test(t.url || '');

  // 1) 当前窗口的活动标签
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isWebPage(active)) return active;
  } catch (_) {
    /* 继续往下找 */
  }

  // 2) 活动标签在别的窗口（弹窗被当成独立窗口时 currentWindow 里没有网页）
  try {
    const [activeAny] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (isWebPage(activeAny)) return activeAny;
  } catch (_) {
    /* continue */
  }

  // 3) 全浏览器兜底：取最近访问过的网页
  try {
    const all = await chrome.tabs.query({});
    const candidates = all.filter(isWebPage);
    if (candidates.length) {
      candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return candidates[0];
    }
  } catch (_) {
    /* continue */
  }
  return null;
}

async function rescan(silent) {
  const token = ++scanToken;
  $('rescan').classList.add('spin');
  $('pageInfo').textContent = '正在扫描…';
  const tab = await resolveTargetTab();
  if (token !== scanToken) return; // 已被更新的扫描取代
  if (!tab) {
    $('rescan').classList.remove('spin');
    $('pageInfo').textContent = '';
    allItems = [];
    $('count').textContent = '0';
    resetCards();
    render();
    setEmptyHint('找不到可扫描的网页标签页。请先切到要抓图的网页，再点这个扩展图标。');
    toast('找不到当前标签页', 'error');
    return;
  }
  if (!/^(https?|file):/i.test(tab.url || '')) {
    allItems = [];
    $('count').textContent = '0';
    resetCards();
    render();
    $('rescan').classList.remove('spin');
    $('pageInfo').textContent = '';
    setEmptyHint('当前标签页是浏览器内部页面（设置 / 扩展管理 / 应用商店），扩展无权读取。请切到普通网页。');
    toast('当前是浏览器内部页面，扩展无法读取（请切到普通网页）', 'error');
    return;
  }
  tabId = tab.id;
  pageUrl = tab.url || '';
  $('pageInfo').textContent = tab.title ? tab.title.slice(0, 60) : pageUrl.slice(0, 60);
  $('pageInfo').title = tab.title || pageUrl;

  const res = await sendBg({
    type: 'IGP_COLLECT',
    tabId,
    opts: { deep: state.deep, thorough: state.thorough, scripts: true, budgetMs: 320 }
  });
  if (token !== scanToken) return; // 后发起的扫描已经覆盖了结果，丢弃这次
  $('rescan').classList.remove('spin');

  if (!res || !res.ok) {
    allItems = [];
    $('count').textContent = '0';
    resetCards();
    render();
    const msg = (res && res.error) || '扫描失败';
    setEmptyHint('扫描失败：' + escapeHtml(msg) + '。<br />可以点右上角的刷新按钮重试。');
    toast(msg, 'error');
    return;
  }
  allItems = normalizeItems(res.items);
  // 重新扫描后旧条目的预览结论已不适用（地址可能变了），清掉重来
  brokenThumbs.clear();
  pendingBrokenUrls.clear();
  // 内容指纹同样作废：新扫描的地址集合可能完全不同
  contentFp.clear();
  clearTimeout(contentDedupeTimer);
  contentDedupeTimer = null;
  // 选中集合按 URL 保留，只剔除本次扫描里已经不存在的地址
  if (selected.size) {
    const alive = new Set(allItems.map((it) => it.url));
    for (const url of selected) if (!alive.has(url)) selected.delete(url);
  }
  $('count').textContent = String(allItems.length);
  setEmptyHint(null);
  if (!silent) {
    const extra = res.stats && res.stats.truncated ? '（内容过多，已快速采样）' : '';
    toast(`扫描完成：找到 ${allItems.length} 张，耗时 ${res.stats ? res.stats.ms : 0}ms，覆盖 ${res.stats ? res.stats.frames : 1} 个框架${extra}`, 'ok');
  }
  if (res.stats && res.stats.errors && res.stats.errors.length) {
    // 有通道报错时留痕，方便定位"某类图抓不到"
    console.warn('[图集捕手] 部分扫描通道失败：', res.stats.errors);
  }
  // 手动/切换参数后的扫描允许重建一次列表；缩略图仍从缓存里秒出
  resetCards();
  render();
}

// ------------------------------------------------------------------ 筛选与渲染
/**
 * 把后台回来的条目规整成可安全渲染的形状。
 * 后台/内容脚本异常、页面脚本篡改返回值时都可能混进 null、缺字段、非字符串 URL；
 * 任何一条坏数据都不该让整个面板崩成空白，所以在这里统一清洗掉。
 */
function normalizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const url = typeof it.url === 'string' ? it.url : '';
    if (!url || url.length > 200000) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const w = Number(it.w);
    const h = Number(it.h);
    out.push({
      url,
      kind: typeof it.kind === 'string' && it.kind ? it.kind : 'img',
      w: isFinite(w) && w > 0 ? Math.round(w) : 0,
      h: isFinite(h) && h > 0 ? Math.round(h) : 0,
      alt: typeof it.alt === 'string' ? it.alt : '',
      label: typeof it.label === 'string' ? it.label : '',
      probable: !!it.probable,
      frameId: Number.isInteger(it.frameId) ? it.frameId : 0,
      index: Number.isInteger(it.index) ? it.index : -1,
      pageUrl: typeof it.pageUrl === 'string' ? it.pageUrl : '',
      media: typeof it.media === 'string' ? it.media : ''
    });
  }
  return out;
}

function isGifItem(it) {
  const u = (it && it.url) || '';
  return /\.gif(?:[?#]|$)/i.test(u) || /^data:image\/gif/i.test(u) || /[?&](?:format|type)=gif(?:&|$)/i.test(u);
}

function applyFilter() {
  const q = state.q.trim().toLowerCase();
  const min = state.minSize;
  let list = allItems.filter((it) => {
    if (!state.susp && (it.probable || it.kind === 'attr')) return false;
    // 隐藏预览失败的条目（地址失效 / 图床拒绝 / 解码失败）
    if (state.hideBroken && brokenThumbs.has(it.url)) return false;
    const g = kindGroup(it.kind);
    const gif = isGifItem(it);
    if (state.typeFilter === 'gif') {
      if (!gif) return false;
    } else if (state.typeFilter !== 'all' && state.typeFilter !== g) return false;
    const maxDim = Math.max(it.w || 0, it.h || 0);
    if (min > 0) {
      if (it.kind === 'canvas' || it.kind === 'media') {
        /* 可视元素不看尺寸过滤 */
      } else if (maxDim && maxDim < min) return false;
      // 尺寸未知的 GIF 多数是 1×1 埋点；启用尺寸筛选时按小图处理
      else if (!maxDim && (min >= 300 || gif)) return false;
    }
    if (q) {
      const hay = (it.url + ' ' + it.alt + ' ' + it.label).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });

  // 同一张图的多种地址（签名参数 / 尺寸参数 / 缩略后缀）以及内容相同的图
  // （MD5 字节一致）折叠成一条
  if (state.dedupe && window.IGPDedupe) {
    const res = window.IGPDedupe.dedupe(list, { content: contentFp });
    dedupedHidden = res.hidden;
    // 被折叠的地址若已被选中，把选中态挪到保留下来的那条上，避免重复下载同一张
    for (const hidden in res.alias) {
      if (selected.has(hidden)) {
        selected.delete(hidden);
        selected.add(res.alias[hidden]);
      }
    }
    list = res.list;
  } else {
    dedupedHidden = 0;
  }

  if (state.sort === 'area') {
    list = list.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
  } else if (state.sort === 'w') {
    list = list.slice().sort((a, b) => (b.w || 0) - (a.w || 0));
  } else if (state.sort === 'kind') {
    list = list.slice().sort((a, b) => kindGroup(a.kind).localeCompare(kindGroup(b.kind)) || (b.w * b.h) - (a.w * a.h));
  }
  viewItems = list;
  itemByUrl = new Map(list.map((it) => [it.url, it]));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const BROKEN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3.5 16 4.3-4a2 2 0 0 1 2.7 0l3.2 3M13 13.8l1.4-1.3a2 2 0 0 1 2.7 0l3.4 3.2M4 4l16 16"/></svg>';
const CANVAS_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 4.7-4.3a2 2 0 0 1 2.7 0L17 18"/></svg>';
const VIDEO_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 4.2-2.4a.8.8 0 0 1 1.3.7v7.4a.8.8 0 0 1-1.3.7L16 14z"/><path d="m9.5 9.2 3.4 2.8-3.4 2.8z"/></svg>';

/** 允许外部（rescan 失败时）覆盖空状态文案，说明真正的原因 */
let emptyHintOverride = null;
function setEmptyHint(html) {
  emptyHintOverride = html || null;
  if (html && !viewItems.length) {
    emptyBox.hidden = false;
    $('emptyText').innerHTML = html;
  }
}

/** 标记 GIF：预览保留动画时提示"GIF 动图"，超大文件则说明是静态首帧 */
function markCardGif(card, url) {
  if (!card || !gifUrls.has(url)) return;
  const tag = card.querySelector('.tag');
  if (!tag) return;
  tag.classList.add('gif');
  tag.textContent = 'GIF';
  tag.title = gifUrls.get(url) ? 'GIF 动图预览' : 'GIF 大图静态预览';
}

/** 卡片静态骨架；图片地址通过 dataset 写入，不拼进 HTML */
function makeCard(it) {
  const g = kindGroup(it.kind);
  const visual = g === 'visual';
  const dim = it.w && it.h ? `${it.w}×${it.h}` : '';
  const tagCls = it.probable || it.kind === 'attr' ? 'susp' : g;
  const canDl = isDownloadable(it);
  const card = document.createElement('div');
  card.className = 'card' + (it.w && it.h && it.w > it.h * 1.6 ? ' wide' : '');
  card.dataset.url = it.url;
  card.dataset.group = g;
  card.title = it.url.slice(0, 300);

  card.innerHTML = `
    <div class="thumb${visual ? ' is-loaded' : ' is-loading'}">
      ${visual
        ? `<div class="visual-ico">${it.kind === 'canvas' ? CANVAS_ICON : VIDEO_ICON}<span>${kindLabel(it.kind)}</span></div>`
        : '<img alt="" decoding="async" />'}
      <label class="chk" title="选择这张图片">
        <input type="checkbox" aria-label="选择这张图片" />
      </label>
      <span class="tag ${tagCls}"></span>
      ${
        it.dupCount > 1
          ? `<span class="dup-badge" title="同一张图片在页面里有 ${it.dupCount} 个地址，已合并显示（${dupReasonText(it.dupReason)}）">×${it.dupCount}</span>`
          : ''
      }
      ${dim ? `<span class="dim">${dim}</span>` : ''}
      <div class="acts">
        <button type="button" data-act="dl" title="下载这张图片">下载</button>
        <button type="button" data-act="copy" title="复制图片地址">复制</button>
        <button type="button" data-act="locate" title="在页面上定位">定位</button>
        ${
          canDl
            ? '<button type="button" data-act="open" title="在新标签页查看原图">查看</button>'
            : '<button type="button" data-act="export" title="导出为 PNG">导出</button>'
        }
      </div>
    </div>
    <div class="name"></div>`;

  const nameEl = card.querySelector('.name');
  nameEl.textContent = fmtName(it.url, it.alt);
  nameEl.title = it.url.slice(0, 300);

  const tagEl = card.querySelector('.tag');
  tagEl.textContent = kindLabel(it.kind);

  const img = card.querySelector('img');
  if (img) {
    img.dataset.src = it.url;
    img.dataset.frameId = String(it.frameId == null ? 0 : it.frameId);

    // 先挂监听再赋 src：命中缓存时也要能收到 load / error
    img.addEventListener('load', () => onThumbLoad(img));
    img.addEventListener('error', () => onThumbError(img), { once: true });

    const cached = thumbCache.get(it.url);
    if (cached) {
      // 缓存命中：不排队、不请求，直接出图
      img.dataset.started = '1';
      img.dataset.queued = '1';
      applyThumbSrc(img, cached.dataUrl);
      markCardGif(card, it.url);
      applyCachedThumb(it.url, cached);
    }
  }

  return card;
}

/** 同一条目重新扫描后只更新文字/角标，保留已经加载好的缩略图节点 */
function syncCard(card, it) {
  card.title = it.url.slice(0, 300);
  const nameEl = card.querySelector('.name');
  if (nameEl) {
    nameEl.textContent = fmtName(it.url, it.alt);
    nameEl.title = it.url.slice(0, 300);
  }
  const tagEl = card.querySelector('.tag');
  if (tagEl) {
    const g = kindGroup(it.kind);
    tagEl.className = 'tag ' + (it.probable || it.kind === 'attr' ? 'susp' : g);
    tagEl.textContent = kindLabel(it.kind);
    markCardGif(card, it.url);
  }
  const thumb = card.querySelector('.thumb');
  let dupEl = card.querySelector('.dup-badge');
  const dupN = it.dupCount > 1 ? it.dupCount : 0;
  if (dupN) {
    if (!dupEl) {
      dupEl = document.createElement('span');
      dupEl.className = 'dup-badge';
      thumb.appendChild(dupEl);
    }
    dupEl.textContent = '×' + dupN;
    dupEl.title = `同一张图片在页面里有 ${dupN} 个地址，已合并显示`;
  } else if (dupEl) {
    dupEl.remove();
  }
  if (dupEl && dupN) dupEl.title = dupTitle(it);
  let dimEl = card.querySelector('.dim');
  const dim = it.w && it.h ? `${it.w}×${it.h}` : '';
  if (dim) {
    if (!dimEl) {
      dimEl = document.createElement('span');
      dimEl.className = 'dim';
      thumb.appendChild(dimEl);
    }
    dimEl.textContent = dim;
  } else if (dimEl) {
    dimEl.remove();
  }
  const img = card.querySelector('img');
  if (img) img.dataset.frameId = String(it.frameId == null ? 0 : it.frameId);
}

function getCard(it) {
  let card = cardEls.get(it.url);
  if (card) {
    if (card.dataset.group === kindGroup(it.kind)) {
      syncCard(card, it);
      return card;
    }
    // 类型跨组变化（普通图 ↔ 画布等）时卡片结构不同，只能换一张
    card.remove();
    cardEls.delete(it.url);
  }
  card = makeCard(it);
  cardEls.set(it.url, card);
  return card;
}

/**
 * 增量对账：只移动 / 增删差异节点，不整格 innerHTML 重建。
 * 这是"滚动时猛猛刷新"的根治点：卡片节点和已解码的缩略图都被复用。
 */
function reconcileGrid(limit) {
  const want = Math.max(0, Math.min(viewItems.length, limit));
  const desired = viewItems.slice(0, want);
  const keep = new Set();
  const nodes = [];

  for (const it of desired) {
    const el = getCard(it);
    keep.add(el);
    nodes.push(el);
  }

  for (const [url, el] of Array.from(cardEls)) {
    if (!keep.has(el)) {
      el.remove();
      cardEls.delete(url);
    }
  }

  let cursor = grid.firstElementChild;
  for (const el of nodes) {
    if (el === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    grid.insertBefore(el, cursor);
  }

  renderedCount = nodes.length;
  bindThumbs();
  paintSelection();
}

/** 清空卡片映射（用于重新扫描）；缩略图缓存保留，重绘时仍可秒出 */
function resetCards() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbQueue.length = 0;
  observedPending.clear();
  clearTimeout(hiddenEnqueueTimer);
  hiddenEnqueueTimer = null;
  cardEls.clear();
  grid.replaceChildren();
  renderedCount = 0;
  pendingBrokenUrls.clear();
  clearTimeout(brokenFlushTimer);
  brokenFlushTimer = null;
}

function render() {
  applyFilter();
  if (!viewItems.length) {
    reconcileGrid(0);
    emptyBox.hidden = false;
    if (emptyHintOverride) {
      $('emptyText').innerHTML = emptyHintOverride;
    } else if (allItems.length) {
      $('emptyText').innerHTML = `当前筛选条件下没有图片。<br />
        共扫到 ${allItems.length} 张，被过滤条件挡住了。<br />
        试试把尺寸过滤放宽、类型切到"全部"，或勾选"疑似"。`;
    } else {
      $('emptyText').innerHTML =
        '本页没有找到图片。<br />试试勾选"深度 / 彻底"，或滚动页面让懒加载图片出现后再扫描。';
    }
  } else {
    emptyBox.hidden = true;
    reconcileGrid(RENDER_LIMIT);
  }
  updateStat();
}

function appendMore() {
  if (renderedCount >= viewItems.length) return;
  reconcileGrid(renderedCount + RENDER_LIMIT);
}

let scrollTick = false;
grid.addEventListener(
  'scroll',
  () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 240) appendMore();
    });
  },
  { passive: true }
);

/**
 * 缩略图调度：可视区优先 + 并发上限。
 * 只请求进入视口附近的图；不设"整批兜底定时器"，避免滚动后突然全量下载。
 */
const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries, obs) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        obs.unobserve(en.target);
        enqueueThumb(en.target, true);
      });
    }, { root: grid, rootMargin: '320px' })
  : null;

const THUMB_CONCURRENCY = 6;
const MAX_PENDING_RETRIES = 30;
const thumbQueue = [];
let thumbActive = 0;
let thumbPumpTimer = null;

/**
 * 后台标签页里 IntersectionObserver 可能完全不触发（弹窗页被切到后台时）。
 * 这种情况下补一次队列；页面可见时绝不兜底，保持严格的视口懒加载，
 * 避免打开面板就把整页大图全下载一遍。
 */
const observedPending = new Set();
let hiddenEnqueueTimer = null;

function scheduleHiddenEnqueue() {
  if (hiddenEnqueueTimer) return;
  hiddenEnqueueTimer = setTimeout(() => {
    hiddenEnqueueTimer = null;
    const pending = Array.from(observedPending);
    observedPending.clear();
    if (document.visibilityState !== 'visible' || !grid.clientHeight) {
      pending.forEach((img) => enqueueThumb(img));
    }
  }, 900);
}

function enqueueThumb(img, front) {
  if (!img || !img.isConnected || img.dataset.started || img.dataset.queued) return;
  img.dataset.queued = '1';
  if (front) thumbQueue.unshift(img);
  else thumbQueue.push(img);
  pumpThumbs();
}

function pumpThumbs() {
  if (thumbActive >= THUMB_CONCURRENCY) return;
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const img = thumbQueue.shift();
    if (!img || !img.isConnected || img.dataset.started) continue;
    thumbActive++;
    Promise.resolve(loadThumb(img)).finally(() => {
      thumbActive--;
      // 稍微错开，避免同一帧内连续解码多张图造成掉帧
      clearTimeout(thumbPumpTimer);
      thumbPumpTimer = setTimeout(pumpThumbs, 8);
    });
  }
}

function bindThumbs() {
  grid.querySelectorAll('img[data-src]').forEach((img) => {
    if (img.dataset.bound || img.dataset.started) return;
    img.dataset.bound = '1';
    if (thumbObserver) {
      try {
        thumbObserver.observe(img);
        observedPending.add(img);
        scheduleHiddenEnqueue();
        return;
      } catch (_) {
        /* 观察器不可用则直接排队 */
      }
    }
    enqueueThumb(img);
  });
}

function onThumbLoad(img) {
  const thumb = img.closest('.thumb');
  if (!thumb) return;
  thumb.classList.remove('is-loading', 'is-broken');
  thumb.classList.add('is-loaded');
}

function onThumbError(img) {
  if (!img.isConnected || img.dataset.fallbackShown) return;
  const url = img.dataset.src;
  if (!url) return;
  markThumbBroken(url, 'load-failed');
  if (state.hideBroken) {
    // 反正马上会被批量移除，不闪一下占位文案
    img.style.display = 'none';
    return;
  }
  showThumbFallback(img);
}

/**
 * 把图放进缓存；按条数和总字节数双重淘汰（GIF 原图可能很大）。
 * 缓存的是整份结果而不只是图片字符串：重扫后卡片是新建的、缩略图直接命中缓存，
 * 若只存图片串就会丢掉 MD5，内容查重会在一次重扫后静默失效。
 */
function rememberThumb(url, thumb) {
  const prev = thumbCache.get(url);
  if (prev) thumbCacheBytes -= (prev.dataUrl || '').length;
  thumbCache.delete(url);
  thumbCache.set(url, thumb);
  thumbCacheBytes += (thumb.dataUrl || '').length;
  while (thumbCache.size > THUMB_CACHE_LIMIT || thumbCacheBytes > THUMB_CACHE_BYTES) {
    const oldest = thumbCache.keys().next().value;
    const val = thumbCache.get(oldest);
    thumbCacheBytes -= val && val.dataUrl ? val.dataUrl.length : 0;
    thumbCache.delete(oldest);
  }
}

/** 从缓存里恢复一条缩略图结果（含指纹），供重绘时使用 */
function applyCachedThumb(url, thumb) {
  if (!thumb || !thumb.dataUrl) return false;
  recordContent(url, thumb);
  return true;
}

/** 切换缩略图来源并触发淡入。命中的是内存 dataURL，不再走网络 */
function applyThumbSrc(img, src) {
  const thumb = img.closest('.thumb');
  if (!thumb || !src) return;
  thumb.classList.remove('is-broken');
  thumb.classList.add('is-loading');
  thumb.classList.remove('is-loaded');
  img.style.display = '';
  img.src = src;
  // dataURL 可能已经解码完成，load 事件不一定会再触发
  if (img.complete && img.naturalWidth > 0) onThumbLoad(img);
}

function loadThumb(img) {
  const url = img.dataset.src;
  if (!url || img.dataset.started || !img.isConnected) return Promise.resolve();
  img.dataset.started = '1';

  const cached = thumbCache.get(url);
  if (cached) {
    applyThumbSrc(img, cached.dataUrl);
    markCardGif(img.closest('.card'), url);
    applyCachedThumb(url, cached);
    return Promise.resolve();
  }

  const maxSide = thumbRequestSide();
  return sendBg(
    { type: 'IGP_THUMB', url, pageUrl, tabId, frameId: img.dataset.frameId, maxSide },
    12000
  ).then((res) => {
    // 原图还在页面上下载：让出并发槽，过一会再问。
    // 既不会堵住其它已加载的图，也不会在扩展分区重复下载原图。
    if (res && res.pending) {
      const tries = Number(img.dataset.pendingTries || 0) + 1;
      img.dataset.pendingTries = String(tries);
      if (tries <= MAX_PENDING_RETRIES) {
        setTimeout(() => {
          if (!img.isConnected || img.dataset.fallbackShown || img.naturalWidth > 0) return;
          img.dataset.started = '';
          img.dataset.queued = '';
          enqueueThumb(img, true);
        }, Math.max(800, Math.min(3000, Number(res.retryAfter) || 1200)));
        return;
      }
      // 页面长时间没加载完：最后再试一次直连原图，失败由 error 监听兜底
      img.dataset.retried = '1';
      applyThumbSrc(img, url);
      return;
    }

    if (res && res.ok && res.dataUrl) {
      // 即使元素已经被筛掉，也把结果留给下一次重绘使用
      rememberThumb(url, { dataUrl: res.dataUrl, md5: res.md5 || '' });
      recordContent(url, res);
      if (res.gif) {
        gifUrls.set(url, !!res.passthrough);
        markCardGif(img.closest('.card'), url);
      }
      if (!img.isConnected || img.dataset.fallbackShown) return;
      img.dataset.thumbSide = String(maxSide);
      applyThumbSrc(img, res.dataUrl);
      return;
    }

    if (!img.isConnected || img.dataset.fallbackShown) return;
    // 后台拿不到（地址失效 / 被墙）：直连再试一次，失败由 error 监听兜底。
    // 不再用固定 6 秒把"下载慢"误判成"失效"——大图可能确实需要更久。
    img.dataset.retried = '1';
    applyThumbSrc(img, url);
  });
}

/** 记录预览失败，供"隐藏失效"筛选使用；不在失败瞬间重建网格 */
function markThumbBroken(url, reason) {
  if (!url || brokenThumbs.has(url)) return;
  brokenThumbs.set(url, reason || 'unknown');
  if (!state.hideBroken) return;

  // 批量移除：滚动时多张图同时失败也只会触发一次很小的 DOM 变更，
  // 不会像逐张 render() 那样整格反复重建。
  pendingBrokenUrls.add(url);
  clearTimeout(brokenFlushTimer);
  brokenFlushTimer = setTimeout(flushBrokenRemovals, 180);
}

function flushBrokenRemovals() {
  brokenFlushTimer = null;
  if (!state.hideBroken) {
    pendingBrokenUrls.clear();
    return;
  }
  if (!pendingBrokenUrls.size) return;

  const urls = pendingBrokenUrls;
  pendingBrokenUrls = new Set();
  for (const url of urls) {
    const el = cardEls.get(url);
    if (el) el.remove();
    cardEls.delete(url);
  }
  viewItems = viewItems.filter((it) => !brokenThumbs.has(it.url));
  itemByUrl = new Map(viewItems.map((it) => [it.url, it]));
  renderedCount = grid.children.length;
  if (!viewItems.length) render();
  else updateStat();
}

/** 缩略图请求边长：跟着尺寸滑块走，按 64 取整以命中缓存 */
function thumbRequestSide() {
  const h = state.thumbSize || 116;
  // 留 2x 余量给高分屏
  const side = Math.ceil((h * 2) / 64) * 64;
  return Math.max(128, Math.min(512, side));
}

function showThumbFallback(img) {
  const host = img.parentElement;
  if (!host || img.dataset.fallbackShown) return;
  img.dataset.fallbackShown = '1';

  // 就地隐藏、就地加占位：不改动网格结构，滚动时不会看到整片跳动
  img.style.display = 'none';
  host.classList.remove('is-loading');
  host.classList.add('is-broken');
  if (host.querySelector('.ph')) return;

  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.innerHTML = BROKEN_ICON;
  const tip = document.createElement('div');
  tip.className = 'placeholder-txt';
  tip.textContent = '预览不可用';
  host.appendChild(ph);
  host.appendChild(tip);
}

function updateStat() {
  const merged = state.dedupe && dedupedHidden ? ` · 合并 <b>${dedupedHidden}</b> 张重复` : '';
  $('stat').innerHTML = `已选 <b>${selected.size}</b> 张 · 共 <b>${viewItems.length}</b> 张${merged}`;
  $('dlSel').disabled = selected.size === 0;
  const label = $('dlSelLabel');
  if (label) label.textContent = selected.size ? `下载选中 (${selected.size})` : '下载选中';
}

function paintSelection() {
  grid.querySelectorAll('.card').forEach((card) => {
    const on = selected.has(card.dataset.url);
    card.classList.toggle('selected', !!on);
    const box = card.querySelector('input[type="checkbox"]');
    if (box) box.checked = !!on;
  });
  updateStat();
}

// ------------------------------------------------------------------ 交互
grid.addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const it = itemByUrl.get(card.dataset.url);
  if (!it) return;

  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'dl') {
      downloadItems([it]);
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(it.url);
        toast('地址已复制', 'ok');
      } catch (_) {
        toast('复制失败', 'error');
      }
    } else if (act === 'locate') {
      const res = await sendBg({ type: 'IGP_HIGHLIGHT', tabId, frameId: it.frameId, url: it.url });
      if (!res || !res.ok) toast('该图片在页面中已不可见（可能是动态生成的）', 'warn');
    } else if (act === 'open') {
      chrome.tabs.create({ url: it.url });
    } else if (act === 'export') {
      exportVisual(it);
    }
    return;
  }

  // 选择框交给原生控件处理，change 事件里统一同步选中集合
  if (e.target.closest('.chk')) return;

  // 点卡片其它位置 = 切换选中
  if (selected.has(it.url)) selected.delete(it.url);
  else selected.add(it.url);
  paintSelection();
});

grid.addEventListener('change', (e) => {
  const box = e.target.closest('input[type="checkbox"]');
  if (!box) return;
  const card = box.closest('.card');
  if (!card) return;
  if (box.checked) selected.add(card.dataset.url);
  else selected.delete(card.dataset.url);
  paintSelection();
});

async function exportVisual(it) {
  toast('正在导出元素…');
  const res = await sendBg({
    type: 'IGP_EXPORT_VISUAL',
    tabId,
    frameId: it.frameId,
    kind: it.kind,
    index: it.index,
    url: it.url,
    pageUrl
  });
  if (res && res.ok) toast('已导出并开始下载', 'ok');
  else toast((res && res.error) || '导出失败', 'error');
}

// ------------------------------------------------------------------ 下载
async function downloadItems(list) {
  const vis = list.filter((it) => /^(canvas|video):\/\//.test(it.url));
  const normal = list
    .filter((it) => !/^(canvas|video):\/\//.test(it.url))
    .map((it) => ({
      url: it.url,
      kind: it.kind,
      w: it.w,
      h: it.h,
      alt: it.alt,
      index: it.index,
      pageUrl: it.pageUrl || pageUrl,
      frameUrl: it.frameUrl,
      frameId: it.frameId
    }));
  // Canvas / 视频帧：先取像素再下载（失败时后台会自动改用可见区域截图）
  for (const it of vis) {
    const res = await sendBg({
      type: 'IGP_EXPORT_VISUAL',
      tabId,
      frameId: it.frameId,
      kind: it.kind,
      index: it.index,
      url: it.url,
      pageUrl
    });
    if (!res || !res.ok) toast((res && res.error) || '元素导出失败', 'warn');
  }
  if (!normal.length) return;
  showProgress(0, normal.length);
  const res = await sendBg({
    type: 'IGP_DOWNLOAD',
    tabId,
    items: normal,
    opts: { concurrency: settings.concurrency || 4 }
  });
  hideProgressSoon();
  if (res && res.ok && res.state) {
    const s = res.state;
    const skip = s.skipped ? `，跳过 ${s.skipped} 张内容重复` : '';
    toast(`下载完成：成功 ${s.ok}，失败 ${s.fail}${skip}`, s.fail ? 'warn' : 'ok');
    if (s.errors && s.errors.length) {
      console.warn('[图集捕手] 失败明细：', s.errors);
    }
  } else {
    toast((res && res.error) || '下载请求失败', 'error');
  }
}

function showProgress(done, total) {
  $('progressWrap').hidden = false;
  $('progressBar').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  $('progressText').textContent = `${done}/${total}`;
}

let progressHideTimer = null;
function hideProgressSoon() {
  clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(() => {
    $('progressWrap').hidden = true;
    $('progressBar').style.width = '0%';
  }, 2500);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'IGP_PROGRESS') {
    if (msg.phase === 'start') showProgress(0, msg.total);
    else showProgress(msg.done, msg.total);
    if (msg.phase === 'done') hideProgressSoon();
  } else if (msg.type === 'IGP_ZIP_PROGRESS') {
    showProgress(msg.done, msg.total);
    $('progressText').textContent = `打包 ${msg.done}/${msg.total}`;
  } else if (msg.type === 'IGP_TOAST') {
    toast(msg.text, msg.kind);
  }
});

// ------------------------------------------------------------------ 批量操作
$('dlSel').addEventListener('click', () => {
  // 选中集合是全局的：即使某些条目被当前筛选隐藏，也要一起下载
  const items = allItems.filter((it) => selected.has(it.url));
  if (!items.length) return;
  downloadItems(items);
});

$('dlAll').addEventListener('click', () => {
  if (!viewItems.length) return;
  downloadItems(viewItems.slice());
});

$('zip').addEventListener('click', async () => {
  const picked = allItems.filter((it) => selected.has(it.url));
  const list = picked.length ? picked : viewItems;
  if (!list.length) return;

  // canvas / video 先取出 PNG 数据
  const payload = [];
  for (const it of list) {
    if (/^(canvas|video):\/\//.test(it.url)) {
      const r = await sendBg({ type: 'IGP_VISUAL_DATA', tabId, frameId: it.frameId, kind: it.kind, index: it.index, url: it.url, pageUrl });
      if (r && r.ok && r.dataUrl) payload.push({ url: it.url, dataUrl: r.dataUrl, index: it.index });
      continue;
    }
    payload.push({ url: it.url, index: it.index, w: it.w, h: it.h, alt: it.alt, pageUrl: it.pageUrl || pageUrl, kind: it.kind });
  }
  if (!payload.length) return toast('没有可打包的内容', 'warn');
  toast('正在打包…');
  const res = await sendBg({ type: 'IGP_ZIP', items: payload, pageUrl });
  if (res && res.ok) toast(`已打包 ${res.count} 个文件（${(res.size / 1048576).toFixed(1)} MB）`, 'ok');
  else toast((res && res.error) || '打包失败', 'error');
});

$('selAll').addEventListener('click', () => {
  viewItems.forEach((it) => selected.add(it.url));
  paintSelection();
});

// 每个重复组只选分辨率最大的那一张（合并重复开启时才有意义）
$('selMax').addEventListener('click', () => {
  if (!viewItems.length) return;
  selected.clear();
  const byUrl = new Map(allItems.map((it) => [it.url, it]));
  let groups = 0;
  for (const it of viewItems) {
    if (it.dupCount > 1 && Array.isArray(it.dupUrls) && it.dupUrls.length) {
      groups++;
      let best = it;
      for (const u of it.dupUrls) {
        const cand = byUrl.get(u);
        if (cand && cand.w * cand.h > best.w * best.h) best = cand;
      }
      selected.add(best.url);
    } else {
      selected.add(it.url);
    }
  }
  paintSelection();
  toast(groups ? `已全选，并从 ${groups} 组重复里各留最大的一张` : '没有发现重复，已全部选中');
});
$('selNone').addEventListener('click', () => {
  selected.clear();
  paintSelection();
});
$('selInvert').addEventListener('click', () => {
  viewItems.forEach((it) => (selected.has(it.url) ? selected.delete(it.url) : selected.add(it.url)));
  paintSelection();
});
$('selBig').addEventListener('click', () => {
  viewItems.forEach((it) => {
    if (Math.max(it.w || 0, it.h || 0) >= 800) selected.add(it.url);
  });
  paintSelection();
});

// ------------------------------------------------------------------ 过滤控件
let filterTimer = null;

function syncSearchClear() {
  const btn = $('clearSearch');
  if (btn) btn.hidden = !$('q').value;
}

function onFilterChange(immediate) {
  const run = () => {
    state.q = $('q').value;
    state.minSize = Number($('minSize').value) || 0;
    state.typeFilter = $('typeFilter').value;
    state.sort = $('sort').value;
    state.susp = $('susp').checked;
    persist();
    grid.scrollTop = 0;
    render();
  };
  clearTimeout(filterTimer);
  if (immediate) run();
  else filterTimer = setTimeout(run, 180);
}

['minSize', 'typeFilter', 'sort'].forEach((id) => $(id).addEventListener('change', () => onFilterChange(true)));
$('susp').addEventListener('change', () => onFilterChange(true));

$('q').addEventListener('input', () => {
  syncSearchClear();
  onFilterChange(false);
});

$('clearSearch').addEventListener('click', () => {
  $('q').value = '';
  syncSearchClear();
  onFilterChange(true);
  $('q').focus();
});

$('emptyRescan').addEventListener('click', () => rescan());

$('rescan').addEventListener('click', () => rescan());
$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$('deep').addEventListener('change', async () => {
  state.deep = $('deep').checked;
  persist();
  await rescan(true);
});
$('thorough').addEventListener('change', async () => {
  state.thorough = $('thorough').checked;
  persist();
  await rescan(true);
});

// 缩略图尺寸：只改 CSS 变量（grid 列宽 + 缩略图高度），
// 不重建 DOM、不重新请求图片，所以拖动滑块是即时的。
// 图片本身按初始尺寸取一次就不再动；放大时只是把它拉伸显示（略微变软，但不会重新下载）。
function applyThumbSize(size) {
  const h = Math.max(72, Math.min(260, Math.round(size)));
  state.thumbSize = h;
  document.documentElement.style.setProperty('--thumb-h', h + 'px');
  document.documentElement.style.setProperty('--card-min', Math.round(h * 1.02) + 'px');
  document.documentElement.style.setProperty('--range-fill', (((h - 72) / (260 - 72)) * 100).toFixed(1) + '%');
  if ($('thumbSizeVal')) $('thumbSizeVal').textContent = String(h);
  if ($('thumbSize') && Number($('thumbSize').value) !== h) $('thumbSize').value = String(h);
}

$('thumbSize').addEventListener('input', () => applyThumbSize(Number($('thumbSize').value)));
$('thumbSize').addEventListener('change', () => persist());

// 合并重复：同一张图的签名/尺寸/缩略地址只显示一条
$('dedupe').addEventListener('change', () => {
  state.dedupe = $('dedupe').checked;
  persist();
  grid.scrollTop = 0;
  render();
  toast(
    state.dedupe
      ? dedupedHidden
        ? `已合并 ${dedupedHidden} 张重复图片`
        : '没有发现重复图片'
      : '已显示全部地址（不再合并重复）'
  );
});

// 隐藏预览失败的图片：纯视图筛选，不重新扫描
$('hideBroken').addEventListener('change', () => {
  state.hideBroken = $('hideBroken').checked;
  pendingBrokenUrls.clear();
  clearTimeout(brokenFlushTimer);
  brokenFlushTimer = null;
  persist();
  render();
  if (state.hideBroken && brokenThumbs.size) {
    toast(`已隐藏 ${brokenThumbs.size} 张预览失效的图片`, 'ok');
  }
});

// ------------------------------------------------------------------ 主题
const THEME_ICONS = {
  // 太阳：表示"切到浅色"
  sun: 'M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-13a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1zm0 14a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1zM4 12a1 1 0 0 1 1-1h2a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm14 0a1 1 0 0 1 1-1h2a1 1 0 0 1 0 2h-2a1 1 0 0 1-1-1zM6.3 6.3a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 0 1-1.4 1.4L6.3 7.7a1 1 0 0 1 0-1.4zm9.6 9.6a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 0 1-1.4 1.4l-1.4-1.4a1 1 0 0 1 0-1.4zm3.4-9.6a1 1 0 0 1 0 1.4l-1.4 1.4a1 1 0 0 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0zM7.7 16.9a1 1 0 0 1 0 1.4l-1.4 1.4a1 1 0 0 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0z',
  // 月亮：表示"切到深色"
  moon: 'M12.3 3a1 1 0 0 1 .3 1.4A7 7 0 0 0 19 15.8a1 1 0 0 1 1.2 1.3A9 9 0 1 1 11.9 2.7a1 1 0 0 1 .4.3z'
};

function applyTheme(theme, opts) {
  const t = theme === 'dark' ? 'dark' : 'light';
  state.theme = t;
  document.documentElement.dataset.theme = t;
  const ic = $('themeIcon');
  if (ic) ic.innerHTML = `<path d="${t === 'light' ? THEME_ICONS.moon : THEME_ICONS.sun}"/>`;
  const btn = $('theme');
  if (btn) btn.title = t === 'light' ? '切换到深色主题 (T)' : '切换到浅色主题 (T)';
  if (!opts || opts.persist !== false) persist();
}

$('theme').addEventListener('click', () => {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
  toast(state.theme === 'light' ? '已切换到浅色主题' : '已切换到深色主题');
});

// ------------------------------------------------------------------ 自检
/**
 * 一键自检：把"为什么抓不到图"拆成几个可判定的步骤，返回可读结论。
 * 排查这类问题时最缺的就是这个——把猜测变成一行结果。
 */
async function runSelfCheck() {
  const report = {
    ok: true,
    version: '',
    tab: null,
    scripts: 'unknown',
    collect: null,
    problems: []
  };
  const problems = [];

  try {
    report.version = chrome.runtime.getManifest().version;
  } catch (e) {
    report.ok = false;
    problems.push('读不到扩展版本：' + ((e && e.message) || e));
  }

  const tab = await resolveTargetTab().catch(() => null);
  if (!tab) {
    report.scripts = 'no-tab';
    problems.push('找不到可扫描的网页标签页');
  } else {
    report.tab = { id: tab.id, url: (tab.url || '').slice(0, 120), title: (tab.title || '').slice(0, 80) };
    if (!/^(https?|file):/i.test(tab.url || '')) {
      report.scripts = 'internal-page';
      problems.push('当前标签页不是普通网页（扩展无权读取）');
    } else {
      // 内容脚本是否在页面里（后台会顺手注入一次，所以这里等价于"注入是否成功"）
      const ping = await sendBg({ type: 'IGP_COLLECT', tabId: tab.id, opts: { deep: false, scripts: false, budgetMs: 200 } }, 20000);
      if (ping && ping.ok) {
        report.scripts = 'ok';
        report.collect = { count: (ping.items || []).length, ms: ping.stats && ping.stats.ms };
        if (!report.collect.count) problems.push('内容脚本正常，但页面里没有可识别的图片');
      } else {
        report.scripts = 'failed';
        problems.push('内容脚本无法在页面中运行：' + ((ping && ping.error) || '未知原因'));
      }
    }
  }

  report.problems = problems;
  report.ok = problems.length === 0;
  return report;
}
window.runSelfCheck = runSelfCheck;

// 设置按钮旁加一个自检入口：抓不到图时点一下就知道卡在哪
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    runSelfCheck().then((r) => {
      const lines = [
        '版本：' + r.version,
        '目标页：' + (r.tab ? r.tab.url : '（无）'),
        '内容脚本：' + r.scripts,
        '采集结果：' + (r.collect ? r.collect.count + ' 张 / ' + r.collect.ms + 'ms' : '（未执行）')
      ];
      if (r.problems.length) lines.push('问题：' + r.problems.join('；'));
      console.warn('[图集捕手 自检]\n' + lines.join('\n'));
      toast(r.ok ? `自检通过：${r.collect ? r.collect.count : 0} 张` : r.problems[0], r.ok ? 'ok' : 'error');
    });
  }
});

function isEditing() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && !isEditing()) rescan();
  if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditing()) {
    applyTheme(state.theme === 'light' ? 'dark' : 'light');
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !isEditing()) {
    e.preventDefault();
    viewItems.forEach((it) => selected.add(it.url));
    paintSelection();
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    const items = viewItems.filter((it) => selected.has(it.url));
    if (items.length) downloadItems(items);
  }
});

// ------------------------------------------------------------------ 状态持久化
function persist() {
  // 合并写入：图库页也会改同一份 uiState（主题/尺寸），整体覆盖会把它冲掉
  chrome.storage.local.get('uiState', (r) => {
    const ui = (r && r.uiState) || {};
    Object.assign(ui, {
      q: state.q,
      minSize: state.minSize,
      typeFilter: state.typeFilter,
      sort: state.sort,
      susp: state.susp,
      deep: state.deep,
      thorough: state.thorough,
      thumbSize: state.thumbSize,
      hideBroken: state.hideBroken,
      dedupe: state.dedupe,
      theme: state.theme
    });
    chrome.storage.local.set({ uiState: ui });
  });
}

async function boot() {
  const got = await chrome.storage.local.get(['uiState', 'settings']);
  settings = got.settings || {};
  const ui = got.uiState || {};
  Object.assign(state, {
    q: ui.q || '',
    minSize: ui.minSize == null ? 120 : ui.minSize,
    typeFilter: ui.typeFilter || 'all',
    sort: ui.sort || 'area',
    susp: !!ui.susp,
    deep: ui.deep !== false,
    thorough: !!ui.thorough,
    thumbSize: ui.thumbSize || 116,
    hideBroken: !!ui.hideBroken,
    dedupe: ui.dedupe !== false,
    theme: ui.theme === 'dark' ? 'dark' : 'light'
  });
  $('q').value = state.q;
  syncSearchClear();
  $('minSize').value = String(state.minSize);
  $('typeFilter').value = state.typeFilter;
  $('sort').value = state.sort;
  $('susp').checked = state.susp;
  $('deep').checked = state.deep;
  $('thorough').checked = state.thorough;
  // 恢复上次的缩略图尺寸与主题（纯视图设置，不触发重新抓取）
  applyThumbSize(state.thumbSize);
  applyTheme(state.theme, { persist: false });
  if ($('hideBroken')) $('hideBroken').checked = state.hideBroken;
  if ($('dedupe')) $('dedupe').checked = state.dedupe;

  // boot 里任何一步出错都不能让界面停在"全空白无提示"的状态
  try {
    await rescan();
  } catch (e) {
    console.error('[图集捕手] 初始化扫描失败：', e);
    $('rescan').classList.remove('spin');
    allItems = [];
    viewItems = [];
    render();
    setEmptyHint(
      '初始化扫描出错：' +
        escapeHtml(String((e && e.message) || e)) +
        '<br />可以点右上角刷新重试；若持续出现，请在扩展详情里点"检查视图"看错误详情。'
    );
  }
}

boot().catch((e) => {
  // 连 boot 之前的准备工作都失败了（例如 storage 不可用）
  console.error('[图集捕手] 启动失败：', e);
  try {
    const box = $('empty');
    if (box) {
      box.hidden = false;
      $('emptyText').innerHTML = '扩展启动失败：' + escapeHtml(String((e && e.message) || e));
    }
  } catch (_) {
    /* 连 DOM 都拿不到就只能留白 */
  }
});
