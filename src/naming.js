/* =============================================================================
 * 图集捕手 — 图片命名
 *
 * 一个原则：面板上显示的名字，就是下载后落盘的名字。
 *
 * 很多站点的图片地址只是存储服务的对象名（一串 UUID / 哈希），真正对人类有意
 * 义的名字在页面上（alt / title / aria-label）。此时用页面上的名字，避免出现
 * "面板显示 123，存下来却是 0b3febed-43e5-4251-87f9-a42dd9ff9984" 这种事。
 *
 * 弹窗、图库、后台下载共用这一份逻辑。
 * ============================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IGPName = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 明显只是占位说法，不能当文件名 */
  const GENERIC =
    /^(?:image|img|images|photo|photos|pic|pics|picture|banner|logo|icon|avatar|thumb|thumbnail|preview|placeholder|untitled|download|file|blob|tmp|temp|null|undefined|image\d+|图片|图像|照片|头像|图标|缩略图|未命名)$/i;

  /** UUID / 长十六进制 / 长数字：存储服务的对象名，对人没有意义 */
  const MEANINGLESS =
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{20,}|\d{10,})$/i;

  const EXT_WHITELIST =
    /^(?:jpe?g|png|gif|webp|bmp|svg|avif|tiff?|ico|heic|heif|jfif|apng|mp4|webm|ogg|mov|m4v)$/i;

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  }

  /** 地址里的原始文件名（不含目录、不含参数） */
  function baseName(url) {
    const s = String(url || '');
    if (!s || /^(data|blob|canvas|video):/i.test(s)) return '';
    try {
      const p = new URL(s);
      return safeDecode(p.pathname.split('/').filter(Boolean).pop() || '');
    } catch (_) {
      return '';
    }
  }

  function splitExt(name) {
    const s = String(name || '').trim();
    const m = s.match(/^(.*?)(?:\.([a-zA-Z0-9]{2,5}))$/);
    if (!m) return { base: s, ext: '' };
    return { base: m[1], ext: '.' + m[2].toLowerCase() };
  }

  /** 名字是否"没有信息量"：空、占位词、或 UUID/哈希 */
  function isWeak(name) {
    const base = String(name || '').trim();
    if (!base) return true;
    if (GENERIC.test(base) || MEANINGLESS.test(base)) return true;
    return GENERIC.test(splitExt(base).base) || MEANINGLESS.test(splitExt(base).base);
  }

  /** 缩略图服务的地址常常把真实格式放在参数里：?format=jpg / ?fm=webp */
  function extFromQuery(url) {
    const m = String(url || '').match(/[?&](?:format|fm|type|ext|extension)=\.?([a-zA-Z0-9]{2,5})(?:[&#]|$)/i);
    return m && EXT_WHITELIST.test(m[1]) ? '.' + m[1].toLowerCase() : '';
  }

  /** 名字里自带的扩展名也算数（alt="海报.png"） */
  function extFromName(name) {
    const e = splitExt(name).ext;
    return e && EXT_WHITELIST.test(e.slice(1)) ? e : '';
  }

  /**
   * 决定这张图叫什么。返回 base（不含扩展名）/ ext / source。
   *   source: 'alt' 用了页面上的名字，'url' 用了地址里的文件名，'none' 都没有
   */
  function choose(item) {
    const it = item || {};
    const url = String(it.url || '');
    const alt = String(it.alt || '').trim();
    const urlName = baseName(url);
    const urlParts = splitExt(urlName);
    const altParts = splitExt(alt);

    const urlWeak = isWeak(urlParts.base);
    const useAlt = !!alt && urlWeak;
    const base = useAlt ? altParts.base : urlParts.base || altParts.base;
    const ext = urlParts.ext || extFromQuery(url) || altParts.ext || extFromName(alt);

    let source = 'none';
    if (useAlt) source = 'alt';
    else if (urlParts.base) source = 'url';
    else if (base) source = 'alt';

    return { base: String(base || '').trim(), ext, source, urlName, alt };
  }

  /** 最终落盘名（不含目录），与面板显示一致 */
  function filename(item) {
    const c = choose(item);
    return c.base ? c.base + c.ext : '';
  }

  return { baseName, splitExt, isWeak, extFromQuery, choose, filename };
});
