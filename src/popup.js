/* =============================================================================
 * 图集捕手 — 弹窗逻辑
 * =========================================================================== */
'use strict';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const emptyBox = $('empty');

let allItems = [];      // 扫描到的全部条目
let viewItems = [];     // 经过筛选、当前展示的条目
let selected = new Set();
let tabId = null;
let pageUrl = '';
let settings = {};
let renderedCount = 0;
const RENDER_LIMIT = 600; // 一次性渲染太多缩略图会卡，滚动到底自动追加

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
  theme: 'dark'
};

/** 预览失败的条目（url → 原因）。缩略图加载失败时写入，用于"隐藏失效"筛选 */
const brokenThumbs = new Map();

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
            () => finish({ ok: false, error: '扫描超时：页面响应过慢，可以点刷新重试，或先滚动页面让内容加载完' }),
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
  if (url.startsWith('data:')) {
    if (url.startsWith('data:image/svg')) return alt || '内联 SVG 矢量图';
    return alt || '内联数据图片';
  }
  if (/^(canvas|video):\/\//.test(url)) return alt || (url.startsWith('canvas') ? 'Canvas 画布内容' : '视频当前帧');
  try {
    const p = new URL(url);
    const last = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || p.host);
    return (alt ? alt + ' · ' : '') + last;
  } catch (_) {
    return url.slice(0, 60);
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
    render();
    setEmptyHint('找不到可扫描的网页标签页。请先切到要抓图的网页，再点这个扩展图标。');
    toast('找不到当前标签页', 'error');
    return;
  }
  if (!/^(https?|file):/i.test(tab.url || '')) {
    allItems = [];
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

  const res = await sendBg({
    type: 'IGP_COLLECT',
    tabId,
    opts: { deep: state.deep, thorough: state.thorough, scripts: true, budgetMs: 320 }
  });
  if (token !== scanToken) return; // 后发起的扫描已经覆盖了结果，丢弃这次
  $('rescan').classList.remove('spin');

  if (!res || !res.ok) {
    allItems = [];
    render();
    const msg = (res && res.error) || '扫描失败';
    setEmptyHint('扫描失败：' + msg + '<br />可以点右上角的刷新按钮重试。');
    toast(msg, 'error');
    return;
  }
  allItems = normalizeItems(res.items);
  // 重新扫描后旧条目的预览结论已不适用（地址可能变了），清掉重来
  brokenThumbs.clear();
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

function applyFilter() {
  const q = state.q.trim().toLowerCase();
  const min = state.minSize;
  let list = allItems.filter((it) => {
    if (!state.susp && (it.probable || it.kind === 'attr')) return false;
    // 隐藏预览失败的条目（地址失效 / 图床拒绝 / 解码失败）
    if (state.hideBroken && brokenThumbs.has(it.url)) return false;
    const g = kindGroup(it.kind);
    if (state.typeFilter !== 'all' && state.typeFilter !== g) return false;
    const maxDim = Math.max(it.w || 0, it.h || 0);
    if (min > 0) {
      if (it.kind === 'canvas' || it.kind === 'media') {
        /* 可视元素不看尺寸过滤 */
      } else if (maxDim && maxDim < min) return false;
      else if (!maxDim && min >= 300) return false; // 尺寸未知的小图标，在大图筛选下丢弃
    }
    if (q) {
      const hay = (it.url + ' ' + it.alt + ' ' + it.label).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });

  if (state.sort === 'area') {
    list = list.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
  } else if (state.sort === 'w') {
    list = list.slice().sort((a, b) => (b.w || 0) - (a.w || 0));
  } else if (state.sort === 'kind') {
    list = list.slice().sort((a, b) => kindGroup(a.kind).localeCompare(kindGroup(b.kind)) || (b.w * b.h) - (a.w * a.h));
  }
  viewItems = list;
}

function cardHtml(it, idx) {
  const g = kindGroup(it.kind);
  const dim = it.w && it.h ? `${it.w}×${it.h}` : '';
  const tagCls = it.probable || it.kind === 'attr' ? 'susp' : g;
  const visual = g === 'visual';
  const icon = visual ? (it.kind === 'canvas' ? '🎨' : '🎬') : g === 'vector' ? '✒️' : '🖼️';
  const name = fmtName(it.url, it.alt);
  const canDl = isDownloadable(it);
  return `
  <div class="card${it.w && it.h && it.w > it.h * 1.6 ? ' wide' : ''}" data-i="${idx}" title="${escapeHtml(it.url.slice(0, 300))}">
    <div class="thumb">
      ${visual ? `<div class="ph">${icon}</div>` : `<img alt="" decoding="async" data-src="${escapeHtml(it.url)}" />`}
      <label class="chk"><input type="checkbox" data-i="${idx}" /></label>
      <span class="tag ${tagCls}">${kindLabel(it.kind)}</span>
      ${dim ? `<span class="dim">${dim}</span>` : ''}
      <div class="acts">
        <button data-act="dl" data-i="${idx}" title="下载">下载</button>
        <button data-act="copy" data-i="${idx}" title="复制地址">复制</button>
        <button data-act="locate" data-i="${idx}" title="在页面上定位">定位</button>
        ${canDl ? `<button data-act="open" data-i="${idx}" title="新标签页查看原图">查看</button>` : `<button data-act="export" data-i="${idx}" title="导出为 PNG">导出</button>`}
      </div>
    </div>
    <div class="name" title="${escapeHtml(it.url.slice(0, 300))}">${escapeHtml(name)}</div>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 允许外部（rescan 失败时）覆盖空状态文案，说明真正的原因 */
let emptyHintOverride = null;
function setEmptyHint(html) {
  emptyHintOverride = html || null;
  if (html && !viewItems.length) {
    emptyBox.hidden = false;
    $('emptyText').innerHTML = html;
  }
}

function render() {
  applyFilter();
  grid.innerHTML = '';
  renderedCount = 0;
  if (!viewItems.length) {
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
    appendMore();
  }
  updateStat();
}

function appendMore() {
  const slice = viewItems.slice(renderedCount, renderedCount + RENDER_LIMIT);
  if (!slice.length) return;
  const html = slice.map((it, k) => cardHtml(it, renderedCount + k)).join('');
  grid.insertAdjacentHTML('beforeend', html);
  renderedCount += slice.length;
  bindThumbs();
  paintSelection();
}

grid.addEventListener('scroll', () => {
  if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 240) appendMore();
});

/** 缩略图：直接加载失败时，改用带 Cookie 的 fetch 再取一次（防盗链场景） */
const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries, obs) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        obs.unobserve(en.target);
        loadThumb(en.target);
      });
    }, { root: grid, rootMargin: '300px' })
  : null;

function bindThumbs() {
  const pending = [];
  grid.querySelectorAll('img[data-src]').forEach((img) => {
    if (img.dataset.bound) return;
    img.dataset.bound = '1';
    pending.push(img);
    // 只在进入（或接近）可视区时才生成缩略图：150 张图不会一起挤向后台
    if (thumbObserver) {
      try {
        thumbObserver.observe(img);
        return;
      } catch (_) {
        /* 观察器不可用则退化为立即加载 */
      }
    }
    loadThumb(img);
  });

  // 兜底：观察器不触发（无头环境、异常布局）时，1.2 秒后把剩下的也加载上，
  // 避免"永远空白"——但会让先出图的顺序优先。
  if (thumbObserver && pending.length) {
    setTimeout(() => pending.forEach((img) => loadThumb(img)), 1200);
  }
}

function loadThumb(img) {
  const url = img.dataset.src;
  if (!url || img.dataset.started) return;
  img.dataset.started = '1';

  // 一律走后台降采样：拿回几十 KB 的小 WebP，而不是让 <img> 解码几 MB 的原图。
  // 顺带解决防盗链（后台会带来源页 Referer + Cookie）。
  const maxSide = thumbRequestSide();
  sendBg({ type: 'IGP_THUMB', url, pageUrl, maxSide }).then((res) => {
    if (res && res.ok && res.dataUrl) {
      img.dataset.thumbSide = String(maxSide);
      img.dataset.fallbackShown = '';
      img.src = res.dataUrl;
      return;
    }
    // 后台也拿不到（地址失效 / 被墙）：给直连最后一次机会
    img.src = url;
  });

  img.addEventListener(
    'error',
    () => {
      if (!img.dataset.fallbackShown) {
        markThumbBroken(url, 'load-failed');
        showThumbFallback(img);
      }
    },
    { once: true }
  );
}

/** 记录预览失败，供"隐藏失效"筛选使用；开启该开关时立即重绘 */
function markThumbBroken(url, reason) {
  if (!url || brokenThumbs.has(url)) return;
  brokenThumbs.set(url, reason || 'unknown');
  if (state.hideBroken) {
    // 只在当前视图里还有这张图时重绘，避免无谓刷新
    if (viewItems.some((it) => it.url === url)) render();
  }
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
  if (!host) return;
  img.dataset.fallbackShown = '1';
  img.remove();
  if (host.querySelector('.ph')) return;
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = '🚫';
  const tip = document.createElement('div');
  tip.className = 'placeholder-txt';
  tip.textContent = '预览不可用（仍可下载）';
  host.appendChild(ph);
  host.appendChild(tip);
}

function updateStat() {
  $('stat').textContent = `已选 ${selected.size} 张 · 共 ${viewItems.length} 张`;
  $('dlSel').disabled = selected.size === 0;
  $('dlSel').textContent = selected.size ? `下载选中 (${selected.size})` : '下载选中';
}

function paintSelection() {
  grid.querySelectorAll('.card').forEach((card) => {
    const it = viewItems[Number(card.dataset.i)];
    const on = it && selected.has(it.url);
    card.classList.toggle('selected', !!on);
    const box = card.querySelector('input[type="checkbox"]');
    if (box) box.checked = !!on;
  });
  updateStat();
}

// ------------------------------------------------------------------ 交互
grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation();
    const it = viewItems[Number(btn.dataset.i)];
    if (!it) return;
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

  const box = e.target.closest('input[type="checkbox"]');
  const card = e.target.closest('.card');
  if (!card) return;
  const it = viewItems[Number(card.dataset.i)];
  if (!it) return;
  if (box) {
    if (box.checked) selected.add(it.url);
    else selected.delete(it.url);
    paintSelection();
    return;
  }
  // 点卡片其它位置 = 切换选中
  if (selected.has(it.url)) selected.delete(it.url);
  else selected.add(it.url);
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
    toast(`下载完成：成功 ${s.ok}，失败 ${s.fail}`, s.fail ? 'warn' : 'ok');
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
  const items = viewItems.filter((it) => selected.has(it.url));
  if (!items.length) return;
  downloadItems(items);
});

$('dlAll').addEventListener('click', () => {
  if (!viewItems.length) return;
  downloadItems(viewItems.slice());
});

$('zip').addEventListener('click', async () => {
  const items = viewItems.filter((it) => selected.has(it.url));
  const list = items.length ? items : viewItems;
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
function onFilterChange(immediate) {
  const run = () => {
    state.q = $('q').value;
    state.minSize = Number($('minSize').value) || 0;
    state.typeFilter = $('typeFilter').value;
    state.sort = $('sort').value;
    state.susp = $('susp').checked;
    persist();
    render();
  };
  clearTimeout(filterTimer);
  if (immediate) run();
  else filterTimer = setTimeout(run, 180);
}

['minSize', 'typeFilter', 'sort'].forEach((id) => $(id).addEventListener('change', () => onFilterChange(true)));
$('susp').addEventListener('change', () => onFilterChange(true));
$('q').addEventListener('input', () => onFilterChange(false));

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
  if ($('thumbSizeVal')) $('thumbSizeVal').textContent = String(h);
  if ($('thumbSize') && Number($('thumbSize').value) !== h) $('thumbSize').value = String(h);
}

$('thumbSize').addEventListener('input', () => applyThumbSize(Number($('thumbSize').value)));
$('thumbSize').addEventListener('change', () => persist());

// 隐藏预览失败的图片：纯视图筛选，不重新扫描
$('hideBroken').addEventListener('change', () => {
  state.hideBroken = $('hideBroken').checked;
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
  const t = theme === 'light' ? 'light' : 'dark';
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT') rescan();
  if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement.tagName !== 'INPUT') {
    applyTheme(state.theme === 'light' ? 'dark' : 'light');
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && document.activeElement.tagName !== 'INPUT') {
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
    theme: ui.theme === 'light' ? 'light' : 'dark'
  });
  $('q').value = state.q;
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

  // 右键菜单里的"复制图片地址"落地：剪贴板在弹窗里写
  chrome.storage.session.get('clipboard', (r) => {
    if (r && r.clipboard) {
      navigator.clipboard.writeText(r.clipboard).catch(() => {});
      chrome.storage.session.remove('clipboard');
      toast('图片地址已复制', 'ok');
    }
  });

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
