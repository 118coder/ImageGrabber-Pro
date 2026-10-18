/* =============================================================================
 * 图集捕手 — offscreen 文档
 * 负责：跨域 fetch（带 Cookie / 可改 Referer）、blob URL 生成、ZIP 打包
 * =========================================================================== */
'use strict';

const objectUrls = new Map(); // objectUrl -> 创建时间

// ------------------------------------------------------------------ 基础工具
function extFromMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  const table = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/tiff': 'tiff',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/jxl': 'jxl',
    'image/apng': 'apng',
    'application/zip': 'zip'
  };
  return table[m] || '';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBytes(dataUrl) {
  const idx = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, idx);
  const body = dataUrl.slice(idx + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

function releaseUrl(objectUrl, delay) {
  if (!objectUrl) return;
  setTimeout(() => {
    if (objectUrls.has(objectUrl)) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (_) {
        /* ignore */
      }
      objectUrls.delete(objectUrl);
    }
  }, typeof delay === 'number' ? delay : 120000);
}

// 定期清理超过 10 分钟没被取走的 blob URL，避免内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [url, t] of objectUrls) {
    if (now - t > 600000) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {
        /* ignore */
      }
      objectUrls.delete(url);
    }
  }
}, 60000);

// ------------------------------------------------------------------ 抓取
async function fetchToBlob(url, opts) {
  const o = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeout || 30000);
  try {
    const res = await fetch(url, {
      credentials: o.credentials === false ? 'omit' : 'include',
      cache: o.cache || 'default',
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw new Error('内容为空');
    const headerType = res.headers.get('content-type') || '';
    const type = (blob.type && blob.type !== 'application/octet-stream' ? blob.type : headerType.split(';')[0]) || '';
    return { blob, type, size: blob.size, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function handleFetch(msg) {
  const { url, wantDataUrl, maxDataUrl } = msg;
  if (typeof url !== 'string' || !url) return { ok: false, error: '无效地址' };
  try {
    const { blob, type, size } = await fetchToBlob(url, msg);
    const objectUrl = URL.createObjectURL(blob);
    objectUrls.set(objectUrl, Date.now());
    const result = {
      ok: true,
      objectUrl,
      size,
      type,
      ext: extFromMime(type)
    };
    const limit = typeof maxDataUrl === 'number' ? maxDataUrl : 1_500_000;
    if (wantDataUrl === true && size <= limit) {
      try {
        result.dataUrl = await blobToDataUrl(blob);
      } catch (_) {
        /* dataUrl 只是备份通道，失败不影响 */
      }
    }
    return result;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------------ ZIP
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * 极简 ZIP 写入器（仅 stored 不压缩）。
 * 不压缩的原因：图片本身已是压缩格式，deflate 只会浪费时间。
 */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  const enc = new TextEncoder();

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const parts = chunks.concat(central, [eocd]);
  return new Blob(parts, { type: 'application/zip' });
}

async function handleZip(msg) {
  const files = msg.files || [];
  const zipName = msg.zipName || 'images.zip';
  const results = [];
  const entries = [];
  const MAX = 3.2 * 1024 * 1024 * 1024;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      let bytes;
      if (typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:')) {
        bytes = dataUrlToBytes(f.dataUrl);
      } else {
        const { blob, type } = await fetchToBlob(f.url, msg);
        bytes = new Uint8Array(await blob.arrayBuffer());
        if (!f.name && type) f.name = 'image.' + (extFromMime(type) || 'bin');
      }
      if (!bytes || !bytes.length) throw new Error('内容为空');
      entries.push({ name: sanitizeName(f.name), bytes });
      results.push({ url: f.url, ok: true, size: bytes.length });
    } catch (e) {
      results.push({ url: f.url, ok: false, error: String((e && e.message) || e) });
    }
    if (i % 8 === 7 || i === files.length - 1) {
      chrome.runtime
        .sendMessage({ type: 'IGP_ZIP_PROGRESS', done: i + 1, total: files.length })
        .catch(() => {});
    }
  }

  if (!entries.length) return { ok: false, error: '没有可打包的内容', results };

  let total = 0;
  for (const e of entries) total += e.bytes.length;
  if (total > MAX) return { ok: false, error: '总大小超过 3.2GB，无法打包', results };

  // 同名文件自动加序号
  const used = new Set();
  for (const e of entries) {
    let name = e.name;
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let k = 2;
      while (used.has(base + '_' + k + ext)) k++;
      name = base + '_' + k + ext;
    }
    used.add(name);
    e.name = name;
  }

  const blob = buildZip(entries);
  const objectUrl = URL.createObjectURL(blob);
  objectUrls.set(objectUrl, Date.now());
  return { ok: true, objectUrl, size: blob.size, name: sanitizeName(zipName), count: entries.length, results };
}

function sanitizeName(name) {
  const s = String(name || 'image')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || 'image').slice(0, 180);
}

// ------------------------------------------------------------------ 缩略图生成
// GIF 保留原始字节才能播放动画；超过上限则退回静态首帧，避免拖垮面板
const GIF_PREVIEW_MAX = 6 * 1024 * 1024;

/**
 * 把原图降采样成小尺寸 WebP，供弹窗/图库显示。
 * 这样列表里十几二十张图不会各自占几 MB 内存，也不必让 <img> 去解码原尺寸。
 * 由于 fetch 会命中页面已建立的 HTTP 缓存，绝大多数情况下不产生额外流量。
 */
async function handleThumb(msg) {
  const maxSide = Math.max(32, Math.min(512, msg.maxSide || 256));
  const quality = typeof msg.quality === 'number' ? msg.quality : 0.72;
  let url = msg.url;
  if (!url) return { ok: false, error: '缺少地址' };

  try {
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'force-cache', // 优先用缓存：页面本来已经加载过这些图
      redirect: 'follow'
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const blob = await res.blob();
    if (!blob.size) return { ok: false, error: '内容为空' };
    const type = (blob.type || '').toLowerCase();
    const isGif = /gif/.test(type) || /\.gif(?:[?#]|$)/i.test(url);

    // 小/中等 GIF 直接原样交给 <img>，保留动画
    if (isGif && blob.size <= GIF_PREVIEW_MAX) {
      const dataUrl = await blobToDataUrl(blob);
      return { ok: true, dataUrl, passthrough: true, gif: true, size: blob.size, type };
    }

    // SVG 用 createImageBitmap 解码不稳定，直接原样交给 <img>（本身很小、可缩放）
    if (/svg/.test(type) || blob.size < 3000) {
      const dataUrl = await blobToDataUrl(blob);
      return { ok: true, dataUrl, passthrough: true, gif: isGif, size: blob.size, type };
    }

    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) {
      // 解码失败（罕见格式）——退回原图，至少能显示
      const dataUrl = await blobToDataUrl(blob);
      return { ok: true, dataUrl, passthrough: true, gif: isGif, size: blob.size, type };
    }

    const srcW = bmp.width;
    const srcH = bmp.height;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    try {
      bmp.close();
    } catch (_) {
      /* ignore */
    }

    let outBlob = null;
    try {
      outBlob = await canvas.convertToBlob({ type: 'image/webp', quality });
    } catch (_) {
      outBlob = null;
    }
    if (!outBlob) outBlob = await canvas.convertToBlob({ type: 'image/png' });

    const dataUrl = await blobToDataUrl(outBlob);
    return {
      ok: true,
      dataUrl,
      w,
      h,
      srcW,
      srcH,
      srcBytes: blob.size,
      thumbBytes: outBlob.size,
      gif: isGif,
      type: outBlob.type
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------------ 可见区域截图裁剪
/**
 * 页面截图是"设备像素"尺寸，元素矩形是"CSS 像素"尺寸，所以按 dpr 换算，
 * 再留一点边距，把目标区域抠出来。
 */
async function handleCrop(msg) {
  const { dataUrl, rect, dpr } = msg;
  if (!dataUrl || !rect) return { ok: false, error: '缺少截图数据' };
  const scale = dpr || 1;
  const pad = msg.pad == null ? 1 : msg.pad;
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('截图解码失败'));
      im.src = dataUrl;
    });
    const sx = Math.max(0, Math.round((rect.x - pad) * scale));
    const sy = Math.max(0, Math.round((rect.y - pad) * scale));
    const sw = Math.max(1, Math.min(img.width - sx, Math.round((rect.w + pad * 2) * scale)));
    const sh = Math.max(1, Math.min(img.height - sy, Math.round((rect.h + pad * 2) * scale)));
    if (sw < 2 || sh < 2) return { ok: false, error: '目标区域过小或不在可视范围内' };
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return { ok: true, dataUrl: canvas.toDataURL('image/png'), w: sw, h: sh };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 把已经抓下来的内容（objectUrl）或某个地址转成 data URL。
 * 用于"blob URL 下载被浏览器拒绝"时的兜底通道。
 */
async function handleDataUrl(msg) {
  const target = msg.objectUrl || msg.url;
  if (!target) return { ok: false, error: '缺少地址' };
  try {
    const res = await fetch(target, { credentials: target.startsWith('blob:') ? 'same-origin' : 'include' });
    const blob = await res.blob();
    const max = msg.maxBytes || 12 * 1024 * 1024;
    if (blob.size > max) {
      return { ok: false, size: blob.size, error: `文件 ${(blob.size / 1048576).toFixed(1)}MB，超过 dataURL 兜底上限` };
    }
    return { ok: true, dataUrl: await blobToDataUrl(blob), size: blob.size, type: blob.type, ext: extFromMime(blob.type) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------------ 消息入口
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'THUMB':
      handleThumb(msg).then(sendResponse);
      return true;
    case 'DATAURL':
      handleDataUrl(msg).then(sendResponse);
      return true;
    case 'CROP':
      handleCrop(msg).then(sendResponse);
      return true;
    case 'FETCH':
      handleFetch(msg).then(sendResponse);
      return true;
    case 'ZIP':
      handleZip(msg).then(sendResponse);
      return true;
    case 'RELEASE':
      releaseUrl(msg.objectUrl, msg.delay);
      sendResponse({ ok: true });
      return false;
    case 'PING':
      sendResponse({ ok: true, alive: true });
      return false;
    default:
      return false;
  }
});
