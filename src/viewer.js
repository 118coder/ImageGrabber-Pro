/* =============================================================================
 * 图集捕手 — 页面图库（右键菜单"提取本页所有图片"落地页）
 * =========================================================================== */
'use strict';

const $ = (id) => document.getElementById(id);
const grid = $('grid');

let allItems = [];
let viewItems = [];
let selected = new Set();
let srcTabId = null;
let pageUrl = '';
let handoffId = new URLSearchParams(location.search).get('id') || '';
let settings = {};

const state = { q: '', minSize: 120, typeFilter: 'all', sort: 'area', susp: false, thumbSize: 116, hideBroken: false, theme: 'dark' };

/** 预览失败的条目（url → 原因），供"隐藏失效"筛选 */
const brokenThumbs = new Map();

function sendBg(msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer =
      timeoutMs === 0
        ? null
        : setTimeout(() => finish({ ok: false, error: '超时：页面响应过慢，请刷新后重试' }), timeoutMs || 25000);
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (timer) clearTimeout(timer);
        finish(err ? { ok: false, error: err.message } : res);
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      finish({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function kindGroup(kind) {
  if (kind === 'css' || kind === 'inline-css') return 'css';
  if (kind === 'canvas' || kind === 'media') return 'visual';
  if (kind === 'svg-inline') return 'vector';
  return 'photo';
}

const KIND_LABEL = {
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

function fmtName(it) {
  if (it.url.startsWith('data:')) return it.alt || (it.kind === 'svg-inline' ? '内联 SVG' : '内联图片');
  if (/^(canvas|video):\/\//.test(it.url)) return it.kind === 'canvas' ? 'Canvas 画布内容' : '视频当前帧';
  try {
    const p = new URL(it.url);
    return (it.alt ? it.alt + ' · ' : '') + decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || p.host);
  } catch (_) {
    return it.url.slice(0, 70);
  }
}

let toastTimer = null;
function toast(text, kind) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast ' + (kind || '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3400);
}

// ------------------------------------------------------------------ 渲染
function applyFilter() {
  const q = state.q.trim().toLowerCase();
  const min = state.minSize;
  let list = allItems.filter((it) => {
    if (!state.susp && (it.probable || it.kind === 'attr')) return false;
    if (state.hideBroken && brokenThumbs.has(it.url)) return false;
    const g = kindGroup(it.kind);
    if (state.typeFilter !== 'all' && state.typeFilter !== g) return false;
    const maxDim = Math.max(it.w || 0, it.h || 0);
    if (min > 0 && !(it.kind === 'canvas' || it.kind === 'media')) {
      if (maxDim && maxDim < min) return false;
      if (!maxDim && min >= 300) return false;
    }
    if (q && (it.url + ' ' + (it.alt || '') + ' ' + (it.label || '')).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  if (state.sort === 'area') list.sort((a, b) => b.w * b.h - a.w * a.h);
  else if (state.sort === 'w') list.sort((a, b) => (b.w || 0) - (a.w || 0));
  else if (state.sort === 'kind') list.sort((a, b) => kindGroup(a.kind).localeCompare(kindGroup(b.kind)));
  viewItems = list;
}

function render() {
  applyFilter();
  grid.innerHTML = viewItems
    .map((it, i) => {
      const g = kindGroup(it.kind);
      const visual = g === 'visual';
      const dim = it.w && it.h ? `${it.w}×${it.h}` : '';
      const tagCls = it.probable || it.kind === 'attr' ? 'susp' : g;
      return `
      <div class="card" data-i="${i}" title="${escapeHtml(it.url.slice(0, 300))}">
        <div class="thumb">
          ${visual ? `<div class="ph">${it.kind === 'canvas' ? '🎨' : '🎬'}</div>` : `<img alt="" decoding="async" data-src="${escapeHtml(it.url)}" />`}
          <label class="chk"><input type="checkbox" data-i="${i}" /></label>
          <span class="tag ${tagCls}">${KIND_LABEL[it.kind] || it.kind}</span>
          ${dim ? `<span class="dim">${dim}</span>` : ''}
          <div class="acts">
            <button data-act="dl" data-i="${i}">下载</button>
            <button data-act="copy" data-i="${i}">复制</button>
            ${visual ? `<button data-act="export" data-i="${i}">导出</button>` : `<button data-act="open" data-i="${i}">查看</button>`}
          </div>
        </div>
        <div class="name">${escapeHtml(fmtName(it))}</div>
      </div>`;
    })
    .join('');

  $('empty').hidden = viewItems.length > 0;
  $('count').textContent = String(allItems.length);
  grid.querySelectorAll('img[data-src]').forEach((img) => loadThumb(img));
  paint();
}

/** 统一走后台降采样：拿小尺寸 WebP，而不是让 <img> 解码原图 */
const thumbCache = new Map();
function loadThumb(img) {
  const url = img.dataset.src;
  if (!url || img.dataset.started) return;
  img.dataset.started = '1';

  const maxSide = viewerThumbSide();
  const key = url + '|' + maxSide;
  if (thumbCache.has(key)) {
    img.src = thumbCache.get(key);
    return;
  }
  sendBg({ type: 'IGP_THUMB', url, pageUrl, maxSide }).then((res) => {
    if (res && res.ok && res.dataUrl) {
      if (thumbCache.size > 800) thumbCache.clear();
      thumbCache.set(key, res.dataUrl);
      img.src = res.dataUrl;
      return;
    }
    img.src = url; // 兜底直连
  });
  img.addEventListener(
    'error',
    () => {
      const host = img.parentElement;
      if (!host) return;
      const src = img.dataset.src;
      if (src && !brokenThumbs.has(src)) {
        brokenThumbs.set(src, 'load-failed');
        if (state.hideBroken) render();
      }
      img.remove();
      if (host.querySelector('.ph')) return;
      const ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = '🚫';
      host.appendChild(ph);
    },
    { once: true }
  );
}

function viewerThumbSide() {
  const h = state.thumbSize || 116;
  const side = Math.ceil((h * 1.15 * 2) / 64) * 64;
  return Math.max(128, Math.min(512, side));
}

function paint() {
  grid.querySelectorAll('.card').forEach((card) => {
    const it = viewItems[Number(card.dataset.i)];
    const on = it && selected.has(it.url);
    card.classList.toggle('selected', !!on);
    const box = card.querySelector('input[type="checkbox"]');
    if (box) box.checked = !!on;
  });
  $('stat').textContent = `已选 ${selected.size} 张 · 共 ${viewItems.length} 张`;
  $('dlSel').disabled = selected.size === 0;
  $('dlSel').textContent = selected.size ? `下载选中 (${selected.size})` : '下载选中';
}

// ------------------------------------------------------------------ 交互
grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  const card = e.target.closest('.card');
  if (!card) return;
  const it = viewItems[Number(card.dataset.i)];
  if (!it) return;

  if (btn) {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'dl') downloadItems([it]);
    else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(it.url);
        toast('地址已复制', 'ok');
      } catch (_) {
        toast('复制失败', 'error');
      }
    } else if (act === 'open') window.open(it.url, '_blank');
    else if (act === 'export') {
      if (srcTabId == null) return toast('来源标签页已关闭，无法导出元素', 'warn');
      const r = await sendBg({ type: 'IGP_EXPORT_VISUAL', tabId: srcTabId, frameId: it.frameId, kind: it.kind, index: it.index, url: it.url, pageUrl });
      toast(r && r.ok ? '已导出并开始下载' : (r && r.error) || '导出失败', r && r.ok ? 'ok' : 'error');
    }
    return;
  }
  if (selected.has(it.url)) selected.delete(it.url);
  else selected.add(it.url);
  paint();
});

async function downloadItems(items) {
  const vis = [];
  const normal = [];
  for (const it of items) {
    if (/^(canvas|video):\/\//.test(it.url)) vis.push(it);
    else
      normal.push({
        url: it.url,
        kind: it.kind,
        w: it.w,
        h: it.h,
        alt: it.alt,
        pageUrl: it.pageUrl || pageUrl,
        frameId: it.frameId
      });
  }
  for (const it of vis) {
    if (srcTabId == null) {
      toast('来源标签页已关闭，无法导出 Canvas', 'warn');
      continue;
    }
    const r = await sendBg({ type: 'IGP_EXPORT_VISUAL', tabId: srcTabId, frameId: it.frameId, kind: it.kind, index: it.index, url: it.url, pageUrl });
    if (!r || !r.ok) toast((r && r.error) || '导出失败', 'warn');
  }
  if (!normal.length) return;
  const res = await sendBg({ type: 'IGP_DOWNLOAD', tabId: srcTabId, items: normal, opts: { concurrency: settings.concurrency || 4 } });
  if (res && res.ok && res.state) toast(`下载完成：成功 ${res.state.ok}，失败 ${res.state.fail}`, res.state.fail ? 'warn' : 'ok');
  else toast((res && res.error) || '下载失败', 'error');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'IGP_PROGRESS') {
    $('progressWrap').hidden = false;
    $('progressBar').style.width = msg.total ? Math.round((msg.done / msg.total) * 100) + '%' : '0%';
    $('progressText').textContent = `${msg.done}/${msg.total}`;
    if (msg.phase === 'done') setTimeout(() => ($('progressWrap').hidden = true), 2500);
  } else if (msg.type === 'IGP_ZIP_PROGRESS') {
    $('progressWrap').hidden = false;
    $('progressText').textContent = `打包 ${msg.done}/${msg.total}`;
    $('progressBar').style.width = msg.total ? Math.round((msg.done / msg.total) * 100) + '%' : '0%';
  }
});

// ------------------------------------------------------------------ 按钮
$('selAll').addEventListener('click', () => {
  viewItems.forEach((it) => selected.add(it.url));
  paint();
});
$('selNone').addEventListener('click', () => {
  selected.clear();
  paint();
});
$('selInvert').addEventListener('click', () => {
  viewItems.forEach((it) => (selected.has(it.url) ? selected.delete(it.url) : selected.add(it.url)));
  paint();
});
$('selBig').addEventListener('click', () => {
  viewItems.forEach((it) => {
    if (Math.max(it.w || 0, it.h || 0) >= 800) selected.add(it.url);
  });
  paint();
});
$('dlSel').addEventListener('click', () => downloadItems(viewItems.filter((it) => selected.has(it.url))));
$('dlAll').addEventListener('click', () => downloadItems(viewItems.slice()));
$('zip').addEventListener('click', async () => {
  const list = viewItems.filter((it) => selected.has(it.url));
  const items = list.length ? list : viewItems;
  if (!items.length) return;
  const payload = [];
  for (const it of items) {
    if (/^(canvas|video):\/\//.test(it.url)) {
      if (srcTabId == null) continue;
      const r = await sendBg({ type: 'IGP_VISUAL_DATA', tabId: srcTabId, frameId: it.frameId, kind: it.kind, index: it.index, url: it.url, pageUrl });
      if (r && r.ok && r.dataUrl) payload.push({ url: it.url, dataUrl: r.dataUrl, index: it.index });
      continue;
    }
    payload.push({ url: it.url, index: it.index, w: it.w, h: it.h, alt: it.alt, pageUrl: it.pageUrl || pageUrl, kind: it.kind });
  }
  if (!payload.length) return toast('没有可打包的内容', 'warn');
  toast('正在打包…');
  const res = await sendBg({ type: 'IGP_ZIP', items: payload, pageUrl });
  toast(res && res.ok ? `已打包 ${res.count} 个文件（${(res.size / 1048576).toFixed(1)} MB）` : (res && res.error) || '打包失败', res && res.ok ? 'ok' : 'error');
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openSrc').addEventListener('click', () => {
  if (srcTabId != null) chrome.tabs.update(srcTabId, { active: true });
  else if (pageUrl) window.open(pageUrl, '_blank');
});
$('rescan').addEventListener('click', async () => {
  if (srcTabId == null) return toast('来源标签页已关闭，请回到页面重新操作', 'warn');
  $('rescan').classList.add('spin');
  const res = await sendBg({ type: 'IGP_COLLECT', tabId: srcTabId, opts: { deep: true, scripts: true, budgetMs: 400 } });
  $('rescan').classList.remove('spin');
  if (!res || !res.ok) return toast((res && res.error) || '扫描失败', 'error');
  allItems = res.items || [];
  selected.clear();
  render();
  toast(`重新扫描完成：${allItems.length} 张`, 'ok');
});

let ft = null;
const onFilter = (immediate) => {
  const run = () => {
    state.q = $('q').value;
    state.minSize = Number($('minSize').value) || 0;
    state.typeFilter = $('typeFilter').value;
    state.sort = $('sort').value;
    state.susp = $('susp').checked;
    render();
  };
  clearTimeout(ft);
  if (immediate) run();
  else ft = setTimeout(run, 180);
};
['minSize', 'typeFilter', 'sort'].forEach((id) => $(id).addEventListener('change', () => onFilter(true)));
$('susp').addEventListener('change', () => onFilter(true));

// 缩略图尺寸：纯视图操作，只改 CSS 变量，不重建 DOM、不重新请求
function applyThumbSize(size) {
  const h = Math.max(72, Math.min(260, Math.round(size)));
  state.thumbSize = h;
  document.documentElement.style.setProperty('--thumb-h', h + 'px');
  document.documentElement.style.setProperty('--card-min', Math.round(h * 1.02) + 'px');
  if ($('thumbSizeVal')) $('thumbSizeVal').textContent = String(h);
  if ($('thumbSize') && Number($('thumbSize').value) !== h) $('thumbSize').value = String(h);
}

$('thumbSize').addEventListener('input', () => applyThumbSize(Number($('thumbSize').value)));
$('thumbSize').addEventListener('change', saveUi);

// 隐藏预览失败的图片
$('hideBroken').addEventListener('change', () => {
  state.hideBroken = $('hideBroken').checked;
  saveUi();
  render();
  if (state.hideBroken && brokenThumbs.size) toast(`已隐藏 ${brokenThumbs.size} 张预览失效的图片`, 'ok');
});

// 主题：与弹窗共用同一份 uiState，两边切换互相同步
const THEME_ICONS = {
  sun: 'M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-13a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0V5a1 1 0 0 1 1-1zm0 14a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1zM4 12a1 1 0 0 1 1-1h2a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm14 0a1 1 0 0 1 1-1h2a1 1 0 0 1 0 2h-2a1 1 0 0 1-1-1zM6.3 6.3a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 0 1-1.4 1.4L6.3 7.7a1 1 0 0 1 0-1.4zm9.6 9.6a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 0 1-1.4 1.4l-1.4-1.4a1 1 0 0 1 0-1.4zm3.4-9.6a1 1 0 0 1 0 1.4l-1.4 1.4a1 1 0 0 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0zM7.7 16.9a1 1 0 0 1 0 1.4l-1.4 1.4a1 1 0 0 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0z',
  moon: 'M12.3 3a1 1 0 0 1 .3 1.4A7 7 0 0 0 19 15.8a1 1 0 0 1 1.2 1.3A9 9 0 1 1 11.9 2.7a1 1 0 0 1 .4.3z'
};

function applyTheme(theme, opts) {
  const t = theme === 'light' ? 'light' : 'dark';
  state.theme = t;
  document.documentElement.dataset.theme = t;
  const ic = $('themeIcon');
  if (ic) ic.innerHTML = `<path d="${t === 'light' ? THEME_ICONS.moon : THEME_ICONS.sun}"/>`;
  const btn = $('theme');
  if (btn) btn.title = t === 'light' ? '切换到深色主题' : '切换到浅色主题';
  if (!opts || opts.persist !== false) saveUi();
}

$('theme').addEventListener('click', () => {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
});

function saveUi() {
  chrome.storage.local.get('uiState', (r) => {
    const ui = (r && r.uiState) || {};
    ui.thumbSize = state.thumbSize;
    ui.hideBroken = state.hideBroken;
    ui.theme = state.theme;
    chrome.storage.local.set({ uiState: ui });
  });
}
$('q').addEventListener('input', () => onFilter(false));

// ------------------------------------------------------------------ 启动
(async function boot() {
  document.documentElement.style.height = '100%';
  const got = await chrome.storage.local.get(['settings', 'uiState']);
  settings = got.settings || {};
  const ui = got.uiState || {};
  state.thumbSize = ui.thumbSize || 116;
  state.hideBroken = !!ui.hideBroken;
  state.theme = ui.theme === 'light' ? 'light' : 'dark';
  applyThumbSize(state.thumbSize);
  applyTheme(state.theme, { persist: false });
  if ($('hideBroken')) $('hideBroken').checked = state.hideBroken;
  // 让筛选控件与弹窗保持一致的默认值
  $('minSize').value = String(settings.minWidth >= 300 ? settings.minWidth : 120);

  const res = await sendBg({ type: 'IGP_HANDOFF', id: handoffId });
  if (res && res.ok && res.data) {
    allItems = res.data.items || [];
    pageUrl = res.data.pageUrl || '';
    srcTabId = res.data.tabId == null ? null : res.data.tabId;
    $('pageInfo').textContent = (res.data.pageTitle || pageUrl).slice(0, 80);
    // 清掉临时数据
    chrome.storage.session.remove('igp_handoff_' + handoffId);
  } else {
    // 直接打开本页时：扫描当前活动标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !/^(chrome|edge)/.test(tab.url || '')) {
      srcTabId = tab.id;
      pageUrl = tab.url || '';
      $('pageInfo').textContent = (tab.title || pageUrl).slice(0, 80);
      const r = await sendBg({ type: 'IGP_COLLECT', tabId: tab.id, opts: { deep: true, scripts: true, budgetMs: 400 } });
      if (r && r.ok) allItems = r.items || [];
    }
  }
  render();
  if (!allItems.length) toast('没有扫描到图片，可回到页面滚动后再点右上角刷新', 'warn');
})();
