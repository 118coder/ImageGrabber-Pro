/* =============================================================================
 * 图集捕手 Image Grabber Pro — 内容脚本（扫描器）
 * -----------------------------------------------------------------------------
 * 设计目标：在不阻塞页面、不触发重排的前提下，尽可能把一页里所有"能变成文件"的
 * 图片找出来。覆盖的取图途径：
 *   1. <img> 的 src / currentSrc / srcset（自动挑最大那张）
 *   2. <picture><source> 、<video poster>、<link rel=preload as=image>
 *   3. 内联 <svg> 与 <svg><image href>
 *   4. 内联 style 与样式表里的 background-image / image-set() / content:url()
 *   5. 全属性深扫：data-src / data-original / data-lazy-* 等任意自定义属性
 *   6. 内联 <script> 文本里的图片地址（JSON 图集、转义过的 URL）
 *   7. performance resource timing：JS 动态 fetch/XHR 加载过的图片
 *   8. blob: / data: 地址
 *   9. <canvas> / <video> / <iframe>：可直接导出，或走"可见区域截图"兜底
 *
 * 返回给上层的统一结构见 makeItem()。
 * 该文件同时支持两种调用方式：
 *   - chrome.runtime.onMessage（单个 frame 主动上报，用于角标计数）
 *   - window.__IGP_COLLECT__（由 chrome.scripting.executeScript 在 allFrames 下调用，
 *     一次拿到所有 frame 的结果）
 * =========================================================================== */
(function () {
  'use strict';

  // 版本号取自扩展 manifest，保证每次升级后重新注入会真正替换旧脚本。
  // （以前写死成常量，升级后旧标签页里的旧代码会被判定为"同版本"而跳过，
  //   导致用户看到新版 UI 却仍在跑旧扫描逻辑，必须手动刷新页面才恢复。）
  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return '0';
    }
  })();
  if (window.__IGP__ && window.__IGP__.version === VERSION) return;

  // ---------------------------------------------------------------- 常量与工具
  const IMG_EXT =
    /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico|cur|tiff?|heic|heif|jfif|pjpeg|apng|jxl|psd)(?:[?#]|$)/i;
  const NON_IMG_EXT =
    /\.(?:js|mjs|cjs|css|html?|xhtml|php|aspx?|jsp|do|action|json|jsonp|xml|rss|atom|txt|md|csv|tsv|pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tgz|tar|bz2|xz|exe|msi|apk|dmg|iso|mp4|webm|mkv|mov|avi|flv|m3u8|mpd|ts|mp3|wav|ogg|m4a|flac|opus|woff2?|ttf|otf|eot|wasm|map|manifest|webmanifest)(?:[?#]|$)/i;
  const ATTR_HINT =
    /(?:^|[-_])(?:src|href|url|uri|link|img|image|images|pic|pico|photo|photos|thumb|thumbnail|cover|avatar|poster|bg|background|lazy|zoom|original|origin|full|large|big|hq|hd|raw|source|media|asset|file|art|shot|frame|view|preview|render|bitmap|jpeg|jpg|png|webp|gif)(?:$|[-_])/i;
  const PATH_HINT =
    /(?:^|\/)(?:images?|imgs?|photos?|pics?|thumbnails?|thumbs?|covers?|avatars?|uploads?|media|assets?|files?|pictures?|gallery|attachments?|resource|storage|cdn\d*|static\d*)(?:\/|$)/i;
  const SCRIPT_URL_RE =
    /https?:(?:\\?\/){2}[^\s"'`<>)\]}]{4,600}?\.(?:jpe?g|png|gif|webp|avif|bmp|svg|jxl|jfif)(?:\?[^\s"'`<>\\)\]}]{0,300})?/gi;
  const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const CSS_IMAGE_SET_RE = /image-set\(([^)]*)\)/gi;

  // 记录 url → 元素，用于"在页面上定位 / 区域截图"。用普通 Map（WeakMap 的键必须是对象）
  const elementsByUrl = new Map();
  const MAX_ELEMENT_REFS = 6000;

  function rememberElement(url, el) {
    if (!url || !el || elementsByUrl.has(url)) return;
    if (elementsByUrl.size >= MAX_ELEMENT_REFS) return;
    elementsByUrl.set(url, el);
  }

  // 扫描根：默认整页；"仅扫描选区"时改成选区所在的容器
  let ACTIVE_ROOT = null;
  function qsa(sel, root) {
    return (root || ACTIVE_ROOT || document).querySelectorAll(sel);
  }

  function resolveRoot(opts) {
    const docEl = document.documentElement || document.body || document;
    if (!opts || !opts.scopeSelection) return docEl;
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return docEl;
      const range = sel.getRangeAt(0);
      let node = range.commonAncestorContainer;
      if (node && node.nodeType === 3) node = node.parentElement;
      if (node && node.querySelectorAll) return node;
      if (node && node.closest) return node.closest('body') || docEl;
    } catch (_) {
      /* 忽略，退回整页 */
    }
    return docEl;
  }

  function abs(u, base) {
    if (!u) return '';
    const s = String(u).trim();
    if (!s || s === '#' || s.startsWith('javascript:') || s.startsWith('mailto:') || s.startsWith('tel:'))
      return '';
    if (s.length > 8192) return '';
    try {
      return new URL(s, base || document.baseURI).href;
    } catch (_) {
      return '';
    }
  }

  function unescapeUrl(s) {
    return s
      .replace(/\\u002[fF]/g, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/\\u0026/g, '&');
  }

  function isDataImage(s) {
    return /^data:image\//i.test(s);
  }
  function isBlob(s) {
    return /^blob:/i.test(s);
  }
  function isHttpLike(s) {
    return /^(?:https?:|file:|chrome-extension:)/i.test(s);
  }

  function pickSrcset(value, base) {
    const out = [];
    if (!value) return out;
    for (const raw of String(value).split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const seg = part.split(/\s+/);
      const url = abs(seg[0], base);
      if (!url) continue;
      // 描述符可能是 400w（宽度）或 2x（像素密度），分开记录，别混算
      let w = 0;
      let x = 1;
      const desc = seg[1] || '';
      if (desc) {
        const n = parseFloat(desc);
        if (isFinite(n)) {
          if (/x$/i.test(desc)) x = n;
          else w = Math.round(n);
        }
      }
      // weight 只用于"在同一组 srcset 里挑最大"，w 与 x 各自归一化后取较大者
      out.push({ url, w: w, x: x, weight: w || x * 1000 });
    }
    return out;
  }

  function bestFromSrcset(value, base) {
    const list = pickSrcset(value, base);
    if (!list.length) return '';
    list.sort((a, b) => b.weight - a.weight);
    return list[0].url;
  }

  // ---------------------------------------------------------------- 结果容器
  function makeItem(kind, url, extra) {
    return Object.assign(
      {
        url,
        kind,
        w: 0,
        h: 0,
        alt: '',
        label: '',
        probable: false,
        frameUrl: '',
        pageUrl: '',
        index: -1,
        media: ''
      },
      extra || {}
    );
  }

  // 同一 URL 被多个通道发现时，按这里的优先级保留信息更全的那条（数字越小越可信）
  const KIND_RANK = {
    canvas: 0,
    media: 1,
    'svg-inline': 2,
    img: 3,
    srcset: 4,
    link: 5,
    meta: 6,
    poster: 7,
    js: 8,
    script: 9,
    css: 10,
    'inline-css': 11,
    svg: 12,
    lazy: 13,
    blob: 14,
    attr: 15
  };

  function Collector() {
    this.map = new Map();
    this.stats = {
      scannedElements: 0,
      truncated: false,
      errors: [],
      ms: 0,
      frames: 0
    };
  }
  Collector.prototype.add = function (item) {
    if (!item || !item.url) return;
    const key = item.url;
    const prev = this.map.get(key);
    if (!prev) {
      this.map.set(key, item);
      return;
    }
    // 合并：保留信息更全的那条
    const prevRank = KIND_RANK[prev.kind] == null ? 99 : KIND_RANK[prev.kind];
    const nextRank = KIND_RANK[item.kind] == null ? 99 : KIND_RANK[item.kind];
    if (nextRank < prevRank) {
      item.w = item.w || prev.w;
      item.h = item.h || prev.h;
      item.alt = item.alt || prev.alt;
      item.probable = item.probable && prev.probable;
      this.map.set(key, item);
      return;
    }
    if (!prev.w && item.w) {
      prev.w = item.w;
      prev.h = item.h;
    }
    if (!prev.alt && item.alt) prev.alt = item.alt;
    prev.probable = prev.probable && item.probable;
  };
  Collector.prototype.list = function () {
    return Array.from(this.map.values());
  };

  // ---------------------------------------------------------------- 各来源扫描
  function scanImgElements(col, ctx) {
    const imgs = qsa('img');
    for (let i = 0; i < imgs.length; i++) {
      const el = imgs[i];
      // 未真正加载出来时（懒加载占位、图片挂了）退回到 width/height 属性
      const attrW = parseInt(el.getAttribute('width'), 10) || 0;
      const attrH = parseInt(el.getAttribute('height'), 10) || 0;
      const w = el.naturalWidth || el.width || attrW || 0;
      const h = el.naturalHeight || el.height || attrH || 0;
      const alt = el.getAttribute('alt') || '';
      const candidates = [];

      // srcset 优先取最大的一张
      const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
      const best = bestFromSrcset(srcset, el.baseURI);
      if (best) candidates.push(makeItem('srcset', best, { w, h, alt, label: 'srcset' }));

      const cur = el.currentSrc || '';
      const src = el.getAttribute('src') || '';
      const resolvedCur = abs(cur, el.baseURI);
      const resolvedSrc = abs(src, el.baseURI);
      if (resolvedCur) candidates.push(makeItem('img', resolvedCur, { w, h, alt, label: 'currentSrc' }));
      if (resolvedSrc && resolvedSrc !== resolvedCur)
        candidates.push(makeItem('img', resolvedSrc, { w, h, alt, label: 'src' }));

      // <picture> 里的 <source>
      const parent = el.parentElement;
      if (parent && parent.tagName === 'PICTURE') {
        parent.querySelectorAll('source').forEach((s) => {
          const u = bestFromSrcset(s.getAttribute('srcset'), s.baseURI);
          if (u) candidates.push(makeItem('srcset', u, { w, h, alt, label: 'picture>source' }));
        });
      }

      for (const item of candidates) {
        item.media = el.getAttribute('media') || '';
        col.add(item);
        rememberElement(item.url, el);
      }
    }
  }

  function scanVideoPoster(col) {
    qsa('video[poster]').forEach((v) => {
      const u = abs(v.getAttribute('poster'), v.baseURI);
      if (u) col.add(makeItem('poster', u, { label: 'video poster' }));
    });
  }

  function scanHeadLinks(col) {
    qsa('link[href]').forEach((l) => {
      const rel = (l.getAttribute('rel') || '').toLowerCase();
      const as = (l.getAttribute('as') || '').toLowerCase();
      const type = (l.getAttribute('type') || '').toLowerCase();
      const href = abs(l.getAttribute('href'), l.baseURI);
      if (!href) return;
      if (as === 'image' || /image\//.test(type)) {
        col.add(makeItem('link', href, { label: 'preload' }));
      } else if (/icon/.test(rel)) {
        col.add(makeItem('link', href, { label: rel, probable: true }));
      }
    });
    const metas = [
      'meta[property="og:image"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[itemprop="image"]',
      'meta[name="msapplication-TileImage"]',
      'meta[name="thumbnail"]'
    ];
    metas.forEach((sel) => {
      qsa(sel).forEach((m) => {
        const u = abs(m.getAttribute('content'), m.baseURI);
        if (u) col.add(makeItem('meta', u, { label: 'meta' }));
      });
    });
  }

  function scanAnchors(col) {
    qsa('a[href]').forEach((a) => {
      const raw = a.getAttribute('href') || '';
      if (!raw || raw.startsWith('#')) return;
      const u = abs(raw, a.baseURI);
      if (!u) return;
      if (!IMG_EXT.test(u) || NON_IMG_EXT.test(u)) return;
      col.add(makeItem('link', u, { label: 'a[href]' }));
    });
  }

  function scanSvg(col) {
    // <svg><image href>（含 xlink:href）
    qsa('image').forEach((im) => {
      const raw = im.getAttribute('href') || im.getAttribute('xlink:href') || '';
      const u = abs(raw, im.baseURI);
      if (u && !u.startsWith('#')) col.add(makeItem('svg', u, { label: 'svg>image' }));
    });
    // 内联 <svg>：直接序列化成可保存的 svg 文件
    const svgs = qsa('svg');
    let n = 0;
    for (let i = 0; i < svgs.length && n < 120; i++) {
      const el = svgs[i];
      if (el.ownerSVGElement) continue; // 只要最外层
      let html = '';
      try {
        html = new XMLSerializer().serializeToString(el);
      } catch (_) {
        continue;
      }
      if (!html || html.length < 64) continue; // 空壳/无效
      const m = html.match(/viewBox=["']([\d.\s-]+)["']/i);
      let w = 0;
      let h = 0;
      if (m) {
        const p = m[1].trim().split(/[\s,]+/).map(Number);
        if (p.length === 4) {
          w = Math.round(p[2]);
          h = Math.round(p[3]);
        }
      }
      if (!w || !h) {
        w = parseInt(el.getAttribute('width'), 10) || 0;
        h = parseInt(el.getAttribute('height'), 10) || 0;
      }
      // 过滤 UI 小图标：太短且画布很小的丢掉；有明确尺寸或含 <image> 的一律保留
      const hasInnerImage = /<image[\s>]/i.test(html);
      if (!hasInnerImage && html.length < 200 && !(w >= 48 && h >= 48)) continue;
      const url =
        'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent(html.replace(/>\s+</g, '><'));
      col.add(makeItem('svg-inline', url, { w, h, label: '内联 SVG', alt: '' }));
      n++;
    }
  }

  function scanMediaElements(col) {
    // canvas / video 本身不是文件，但可以导出，单独交给弹窗处理
    const canvases = qsa('canvas');
    canvases.forEach((c, i) => {
      if (!c.width || !c.height) return;
      if (c.width * c.height < 1024) return;
      const item = makeItem('canvas', 'canvas://index/' + i, {
        w: c.width,
        h: c.height,
        index: i,
        label: 'Canvas 画布'
      });
      col.add(item);
      rememberElement(item.url, c);
    });
    const videos = qsa('video');
    videos.forEach((v, i) => {
      if (!v.videoWidth || !v.videoHeight) return;
      const item = makeItem('media', 'video://index/' + i, {
        w: v.videoWidth,
        h: v.videoHeight,
        index: i,
        label: '视频当前帧'
      });
      col.add(item);
      rememberElement(item.url, v);
    });
  }

  function scanInlineStyles(col) {
    const els = qsa('[style*="url("]');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const style = el.getAttribute('style') || '';
      const r = el.getBoundingClientRect();
      let m;
      CSS_URL_RE.lastIndex = 0;
      while ((m = CSS_URL_RE.exec(style))) {
        const u = abs(m[2], el.baseURI);
        if (!u) continue;
        col.add(
          makeItem('inline-css', u, {
            w: Math.round(r.width),
            h: Math.round(r.height),
            label: '内联样式背景'
          })
        );
        rememberElement(u, el);
      }
    }
  }

  function scanStyleSheets(col) {
    const sheets = document.styleSheets;
    const seenSelectors = new Set();
    let visited = 0;

    function readRules(rules, depth) {
      if (!rules || depth > 6) return;
      for (let i = 0; i < rules.length && visited < 60000; i++) {
        let rule;
        try {
          rule = rules[i];
        } catch (_) {
          continue;
        }
        visited++;
        // 坑：Chrome 112+ 会给每条 CSSStyleRule 都挂上 cssRules（没有嵌套时是空列表），
        // 所以必须按 length 判断"分组/嵌套规则"，否则所有普通样式规则都会被跳过。
        let nested = null;
        try {
          nested = rule.cssRules && rule.cssRules.length ? rule.cssRules : null;
        } catch (_) {
          nested = null;
        }
        if (nested && !rule.selectorText) {
          // @media / @supports / @layer 这类纯分组规则：只递归子规则
          readRules(nested, depth + 1);
          continue;
        }
        let text = '';
        try {
          text = rule.cssText || '';
        } catch (_) {
          continue;
        }
        if (text.indexOf('url(') === -1) {
          if (nested) readRules(nested, depth + 1);
          continue;
        }
        // 收集该规则里所有 url(...)（含 image-set 的多分辨率）
        const urls = [];
        let m;
        CSS_URL_RE.lastIndex = 0;
        while ((m = CSS_URL_RE.exec(text))) {
          if (m[2] && !m[2].startsWith('data:')) urls.push(m[2]);
        }
        if (!urls.length) continue;
        const selector = (rule.selectorText || '').trim();
        const cleanSelector = selector
          .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '')
          .replace(/:(?:hover|active|focus|visited|target|checked|disabled|not\([^)]*\))/g, '')
          .trim();
        let target = null;
        let rect = { width: 0, height: 0 };
        if (cleanSelector && !seenSelectors.has(cleanSelector) && seenSelectors.size < 4000) {
          seenSelectors.add(cleanSelector);
          try {
            target = document.querySelector(cleanSelector);
            if (target) {
              const r = target.getBoundingClientRect();
              rect = { width: Math.round(r.width), height: Math.round(r.height) };
            }
          } catch (_) {
            target = null;
          }
        }
        for (const rawUrl of urls) {
          const u = abs(rawUrl, document.baseURI);
          if (!u) continue;
          col.add(
            makeItem('css', u, {
              w: rect.width,
              h: rect.height,
              label: selector ? 'CSS: ' + selector.slice(0, 80) : 'CSS 背景'
            })
          );
          if (target) rememberElement(u, target);
        }
        // CSS 嵌套（& 语法）：子规则的 url 在父级 cssText 里也会出现，靠去重合并
        if (nested) readRules(nested, depth + 1);
      }
    }

    for (let s = 0; s < sheets.length; s++) {
      let rules;
      try {
        rules = sheets[s].cssRules;
      } catch (_) {
        continue; // 跨域样式表，拿不到规则（正常现象）
      }
      readRules(rules, 0);
    }
  }

  // 判断一个属性值像不像图片地址
  function classifyValue(name, value) {
    if (typeof value !== 'string') return 0;
    const v = value.trim();
    if (v.length < 8 || v.length > 4096) return 0;
    if (/^[{[<]/.test(v)) return 0;
    if (isDataImage(v)) return 2;
    if (isBlob(v)) return 2;
    if (/^data:/i.test(v)) return 0;
    if (!/^(?:https?:|file:|\/\/|\/|\.\/|\.\.\/|[a-zA-Z0-9_-]+\/[^\s])/.test(v)) return 0;
    if (NON_IMG_EXT.test(v)) return 0;
    if (/^[a-zA-Z0-9_\-\/.]+\s+[a-zA-Z0-9_\-\/.]+$/.test(v)) return 0; // "class otherclass"
    if (IMG_EXT.test(v)) return 2;
    const u = v.startsWith('//') ? 'https:' + v : v;
    if (!isHttpLike(u) && !u.startsWith('/')) return 0;
    // 无扩展名：只接受"属性名有意义 + 路径里有图片语汇"的，标记为疑似
    if (ATTR_HINT.test(name) && (PATH_HINT.test(u) || /[?&](?:w|h|width|height|size|quality|q)=/.test(u)))
      return 1;
    if (ATTR_HINT.test(name) && /\/(?:[0-9a-f]{16,}|[0-9a-f-]{24,})(?:[?#]|$)/i.test(u)) return 1;
    return 0;
  }

  function scanElementAttrs(el, col, ctx) {
    const attrs = el.attributes;
    if (!attrs || !attrs.length) return;
    const tag = el.tagName;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      const name = a.name;
      if (name === 'class' || name === 'id' || name === 'style' || name === 'd') continue;
      if (name.startsWith('on')) continue;
      if (name === 'ping' || name === 'integrity' || name === 'crossorigin') continue;
      let value = a.value;
      if (!value || value.length < 8) continue;
      // srcset 类属性按"取最大"处理
      if (/srcset$/i.test(name)) {
        const best = bestFromSrcset(value, el.baseURI);
        if (best) {
          col.add(makeItem('srcset', best, { label: tag.toLowerCase() + '@' + name }));
        }
        continue;
      }
      const level = classifyValue(name, value);
      if (!level) continue;
      if (value.indexOf('\\/') !== -1 || value.indexOf('\\u002') !== -1) value = unescapeUrl(value);
      const u = abs(value, el.baseURI);
      if (!u) continue;
      if (tag === 'IMG' && (name === 'src' || name === 'srcset')) continue; // 已扫过
      if (!isHttpLike(u) && !isDataImage(u) && !isBlob(u)) continue;
      col.add(
        makeItem(level === 2 ? 'lazy' : 'attr', u, {
          probable: level === 1,
          label: tag.toLowerCase() + '@' + name,
          alt: el.getAttribute && (el.getAttribute('alt') || '') || ''
        })
      );
      rememberElement(u, el);
    }
  }

  function walkShadow(el, col, ctx, depth) {
    if (depth > 4) return;
    let root;
    try {
      root = el.shadowRoot;
    } catch (_) {
      return;
    }
    if (!root) return;
    try {
      root.querySelectorAll('*').forEach((child) => {
        ctx.stats.scannedElements++;
        scanElementAttrs(child, col, ctx);
        // 组件库常把背景图画在 Shadow DOM 里的自定义元素上，属性深扫看不到
        try {
          const bg = getComputedStyle(child).backgroundImage;
          if (bg && bg !== 'none' && bg.indexOf('url(') !== -1) {
            let m;
            CSS_URL_RE.lastIndex = 0;
            while ((m = CSS_URL_RE.exec(bg))) {
              const u = abs(m[2], child.baseURI);
              if (u) {
                const r = child.getBoundingClientRect();
                col.add(
                  makeItem('css', u, {
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    label: 'shadow 背景'
                  })
                );
                rememberElement(u, child);
              }
            }
          }
        } catch (_) {
          /* ignore */
        }
        walkShadow(child, col, ctx, depth + 1);
      });
      root.querySelectorAll('img').forEach((im) => {
        const u = abs(im.currentSrc || im.getAttribute('src'), im.baseURI);
        if (u) {
          col.add(makeItem('img', u, { w: im.naturalWidth, h: im.naturalHeight, label: 'shadow DOM' }));
          rememberElement(u, im);
        }
      });
      // <picture> 在 shadow 里也要处理
      root.querySelectorAll('source[srcset]').forEach((s) => {
        const best = bestFromSrcset(s.getAttribute('srcset'), s.baseURI);
        if (best) col.add(makeItem('srcset', best, { label: 'shadow picture' }));
      });
    } catch (_) {
      /* ignore */
    }
  }

  const yieldLoop = () => new Promise((r) => setTimeout(r, 0));

  async function deepScan(col, ctx, opts) {
    const walker = document.createNodeIterator(
      ACTIVE_ROOT || document.documentElement || document,
      NodeFilter.SHOW_ELEMENT
    );
    let n = 0;
    const t0 = Date.now();
    let node;
    for (;;) {
      node = walker.nextNode();
      if (!node) break;
      ctx.stats.scannedElements++;
      try {
        scanElementAttrs(node, col, ctx);
        if (node.shadowRoot) walkShadow(node, col, ctx, 0);
      } catch (_) {
        /* 某些只读/异常节点忽略 */
      }
      if ((++n & 511) === 0) {
        await yieldLoop();
        if (Date.now() - t0 > opts.budgetMs) {
          ctx.stats.truncated = true;
          break;
        }
      }
    }
  }

  async function thoroughScan(col, ctx, opts) {
    // 逐元素取 computedStyle：慢，但能挖出任何背景图（含 CSS 变量、伪元素）
    const all = qsa('*');
    const t0 = Date.now();
    let n = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      try {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundImage;
        if (bg && bg !== 'none' && bg.indexOf('url(') !== -1) {
          let m;
          CSS_URL_RE.lastIndex = 0;
          while ((m = CSS_URL_RE.exec(bg))) {
            const u = abs(m[2], el.baseURI);
            if (!u) continue;
            const r = el.getBoundingClientRect();
            col.add(
              makeItem('css', u, {
                w: Math.round(r.width),
                h: Math.round(r.height),
                label: 'computed: ' + el.tagName.toLowerCase()
              })
            );
            rememberElement(u, el);
          }
        }
        const before = cs.getPropertyValue('content');
        if (before && before.indexOf('url(') !== -1) {
          const m2 = CSS_URL_RE.exec(before);
          CSS_URL_RE.lastIndex = 0;
          if (m2) {
            const u = abs(m2[2], el.baseURI);
            if (u) col.add(makeItem('css', u, { label: '伪元素 content' }));
          }
        }
      } catch (_) {
        /* ignore */
      }
      if ((++n & 255) === 0) {
        await yieldLoop();
        if (Date.now() - t0 > opts.budgetMs * 3) {
          ctx.stats.truncated = true;
          break;
        }
      }
    }
  }

  function scanScriptText(col, ctx) {
    // 内联脚本 / JSON-LD / <template> 里的图片地址（图集类网站最常见）
    const nodes = qsa('script:not([src]), template');
    let budget = 3_000_000;
    for (let i = 0; i < nodes.length && budget > 0; i++) {
      const text = nodes[i].textContent || '';
      if (!text || text.length < 32) continue;
      const slice = text.length > budget ? text.slice(0, budget) : text;
      budget -= slice.length;
      if (slice.indexOf('.jp') === -1 && slice.indexOf('.png') === -1 && slice.indexOf('.webp') === -1 &&
          slice.indexOf('.gif') === -1 && slice.indexOf('.svg') === -1 && slice.indexOf('.avif') === -1)
        continue;
      let m;
      SCRIPT_URL_RE.lastIndex = 0;
      let count = 0;
      while ((m = SCRIPT_URL_RE.exec(slice)) && count < 400) {
        const u = abs(unescapeUrl(m[0]), document.baseURI);
        if (u) {
          col.add(makeItem('script', u, { probable: false, label: '脚本文本' }));
          count++;
        }
      }
    }
  }

  /**
   * srcset 全尺寸变体：很多站点只用当前一档，但属性里放出了多档地址。
   * 全部列出来，用户想下原图时不会只看到缩略图。
   */
  function scanSrcsetVariants(col) {
    const seen = new Set();
    qsa('img[srcset], source[srcset], img[data-srcset], source[data-srcset]').forEach((el) => {
      const raw = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
      if (!raw) return;
      for (const c of pickSrcset(raw, el.baseURI)) {
        if (!c.url || seen.has(c.url)) continue;
        seen.add(c.url);
        col.add(
          makeItem('srcset', c.url, {
            w: c.w || 0,
            h: 0,
            label: c.w ? 'srcset ' + c.w + 'w' : 'srcset ' + c.x + 'x'
          })
        );
      }
    });
  }

  /**
   * URL 变体探测：很多图床把缩略图与原图放在同路径的不同命名下。
   * 只做纯字符串改写、不额外发请求，真正的存在性检查留给下载阶段。
   * 覆盖：_thumb/-300x200/缩略目录/查询串尺寸参数。
   */
  function scanUrlVariants(col) {
    const DIM_PARAM = /^(?:w|h|width|height|size|quality|q|resize|fit|crop|thumb)$/i;
    // 顺序有讲究：目录级（/thumb/）先判，否则会被文件名级规则误伤
    const rules = [
      { name: '去缩略目录', re: /\/(?:thumbnails?|thumbs?|small|preview)\//gi, to: '/' },
      { name: '去缩略后缀', re: /([_\-.])(?:thumb|thumbnail|thumbs|small|mini|tiny|low|preview)(?=\.[a-z]{2,5}(?:[?#]|$))/gi, to: '' },
      { name: '去尺寸后缀', re: /[_\-]\d{2,4}x\d{2,4}(?=\.[a-z]{2,5}(?:[?#]|$))/gi, to: '' }
    ];

    const urls = col.list().map((it) => it.url).filter((u) => /^https?:/i.test(u));
    let n = 0;
    for (const raw of urls) {
      if (n > 800) break;

      // 1) 查询串里的尺寸参数
      try {
        const u = new URL(raw);
        const keys = [...u.searchParams.keys()];
        if (keys.some((k) => DIM_PARAM.test(k))) {
          const clean = new URL(raw);
          for (const k of keys) if (DIM_PARAM.test(k)) clean.searchParams.delete(k);
          if (clean.href !== raw) {
            col.add(makeItem('attr', clean.href, { label: '去尺寸参数', probable: true }));
            n++;
          }
        }
      } catch (_) {
        continue;
      }

      // 2) 路径命名变体（只看路径，避免误改查询串）
      let pathOnly = raw;
      try {
        const u = new URL(raw);
        pathOnly = u.origin + u.pathname;
      } catch (_) {
        continue;
      }
      for (const rule of rules) {
        rule.re.lastIndex = 0;
        const variant = pathOnly.replace(rule.re, rule.to);
        if (variant !== pathOnly && variant.length > 12) {
          col.add(makeItem('attr', variant, { label: rule.name, probable: true }));
          n++;
          break;
        }
      }
    }
  }

  /**
   * 懒加载解锁：把 data-* 里的真实地址写回 src，让浏览器真的去加载。
   * 这样"读元素像素"的零流量缩略图通道才能命中它。
   */
  function unlockLazyImages() {
    let n = 0;
    const ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-echo', 'data-url', 'data-full', 'data-large'];
    qsa('img').forEach((el) => {
      if (el.naturalWidth > 0) return;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const u = abs(v, el.baseURI);
        if (!u || u === el.src) continue;
        try {
          el.loading = 'eager';
          el.src = u;
          n++;
        } catch (_) {
          /* ignore */
        }
        break;
      }
    });
    return n;
  }

  function scanResourceTiming(col) {
    let entries;
    try {
      entries = performance.getEntriesByType('resource');
    } catch (_) {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const u = e.name;
      if (!u || !isHttpLike(u)) continue;
      if (NON_IMG_EXT.test(u)) continue;
      const type = e.initiatorType;
      const looksImage =
        IMG_EXT.test(u) ||
        (type === 'img' && !/\.(?:js|css)(?:[?#]|$)/i.test(u)) ||
        /image\//.test(e.contentType || '');
      if (!looksImage) continue;
      // CSS 背景图也会出现在资源列表里，标成 css 而不是 js：一是分类更准，
      // 二是 Collector 的优先级里 css(10) 高于 js(8)，合并时保留"有元素定位"的那条。
      const isCssInitiated = type === 'css' || type === 'link';
      const item = makeItem(isCssInitiated ? 'css' : 'js', u, {
        label: '网络加载(' + type + ')',
        probable: isCssInitiated ? true : !IMG_EXT.test(u)
      });
      col.add(item);
    }
  }

  // ---------------------------------------------------------------- 汇总
  let collectChain = Promise.resolve(); // 串行化，避免并发扫描互相插队

  function collect(opts) {
    const run = () => collectOnce(opts);
    collectChain = collectChain.then(run, run);
    return collectChain;
  }

  async function collectOnce(opts) {
    const o = Object.assign(
      { deep: true, thorough: false, scripts: true, scopeSelection: false, budgetMs: 260 },
      opts || {}
    );
    const t0 = Date.now();
    const col = new Collector();
    const ctx = { stats: col.stats };
    const scopedRoot = resolveRoot(o);
    ACTIVE_ROOT = scopedRoot;
    const scoped = scopedRoot !== (document.documentElement || document.body);

    // 单个通道失败不能拖垮整次扫描，但也不能悄悄吞掉——记进 stats.errors，
    // 弹窗会把它打到控制台，方便定位"为什么这类图没抓到"。
    const safe = (name, fn) => {
      try {
        fn();
      } catch (e) {
        ctx.stats.errors.push(name + ': ' + String((e && e.message) || e));
      }
    };

    try {
      safe('img', () => scanImgElements(col, ctx));
      safe('media', () => scanMediaElements(col, ctx));
      safe('poster', () => scanVideoPoster(col));
      safe('head', () => scanHeadLinks(col));
      safe('anchor', () => scanAnchors(col));
      safe('svg', () => scanSvg(col));
      safe('inline-style', () => scanInlineStyles(col));
      safe('stylesheet', () => scanStyleSheets(col));
      safe('timing', () => scanResourceTiming(col));
      // 新增通道：多分辨率变体与命名变体（纯字符串推导，不发请求）
      safe('srcset-variants', () => scanSrcsetVariants(col));
      safe('url-variants', () => scanUrlVariants(col));

      if (o.deep) {
        // 深度模式下先把懒加载唤醒，再扫一遍元素（顺序很重要：
        // 唤醒后 naturalWidth 才有值，缩略图通道才能零流量取图）
        if (o.unlockLazy !== false) {
          const unlocked = unlockLazyImages();
          if (unlocked) ctx.stats.unlockedLazy = unlocked;
        }
        await deepScan(col, ctx, o);
        safe('img-after-unlock', () => scanImgElements(col, ctx));
        if (o.scripts) safe('script-text', () => scanScriptText(col, ctx));
      }
      if (o.thorough) {
        await thoroughScan(col, ctx, o);
      }
    } finally {
      ACTIVE_ROOT = null;
    }

    const pageUrl = location.href;
    const items = col.list();
    for (const it of items) {
      it.pageUrl = pageUrl;
      it.frameUrl = pageUrl;
      it.topFrame = window.top === window;
      if (it.url.startsWith('data:') || it.url.startsWith('blob:')) it.probable = false;
    }
    col.stats.ms = Date.now() - t0;
    col.stats.scoped = scoped;
    return { ok: true, items, stats: col.stats, frameUrl: pageUrl, version: VERSION };
  }

  // ---------------------------------------------------------------- 特殊导出
  function canvasSnapshot(index) {
    const list = qsa('canvas', document);
    const c = list[index];
    if (!c) return { ok: false, error: '找不到该 canvas' };
    try {
      const url = c.toDataURL('image/png');
      if (url && url.length > 64) return { ok: true, dataUrl: url, w: c.width, h: c.height };
      return { ok: false, error: '画布为空' };
    } catch (e) {
      return { ok: false, error: 'CORS 保护（跨域画布被污染），请用"区域截图"下载' };
    }
  }

  function videoFrame(index) {
    const list = qsa('video', document);
    const v = list[index];
    if (!v) return { ok: false, error: '找不到该 video' };
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return { ok: true, dataUrl: c.toDataURL('image/png'), w: c.width, h: c.height };
    } catch (e) {
      return { ok: false, error: '视频源受保护，请用"区域截图"下载' };
    }
  }

  // ---------------------------------------------------------------- 页面内缩略图
  /**
   * 在页面上下文里取缩略图。
   *
   * 为什么必须放在页面里：Chromium 的 HTTP 缓存按"顶层站点"分区。扩展的 offscreen 文档属于
   * chrome-extension:// 分区，和网页分区完全隔离，所以从扩展抓图一定会重新下载一遍
   * （实测 100% 重复下载）。而在页面上下文 fetch 同一地址会直接命中页面已建立的缓存，
   * 字节数近乎为零。
   *
   * 另外，对已经是同一元素的图片（<img>/背景图/CSS），可以直接画到 canvas 拿像素，
   * 连 fetch 都不需要。
   */
  const thumbMemo = new Map(); // url|side -> { dataUrl, w, h, gif }
  // GIF 直接返回原始字节才能保留动画；超过这个大小就退回静态首帧，避免面板被单个动图拖垮
  const GIF_PREVIEW_MAX = 6 * 1024 * 1024;

  function looksLikeGif(url) {
    return /\.gif(?:[?#]|$)/i.test(url || '') || /^data:image\/gif/i.test(url || '');
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c;
  }

  /** 把已经解码好的图像源（img/canvas/bitmap）降采样成 WebP dataURL */
  /**
   * 从已解码的 <img> 生成缩略图。
   * 优先用 createImageBitmap(img, {resizeWidth, resizeHeight})：让解码器直接输出目标尺寸，
   * 省掉"整张大图先画进 canvas 再缩放"的那一步（对大图尤其明显）。
   * 不支持时退回普通 downsample。
   */
  async function downsampleImageElement(img, maxSide, quality) {
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    if (!srcW || !srcH) return null;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    // 只缩小不放大：原图本来就小的时候没必要走位图缩放
    if (scale < 0.98 && typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(img, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'high'
        });
        const canvas = makeCanvas(w, h);
        canvas.getContext('2d', { alpha: true }).drawImage(bmp, 0, 0);
        try {
          bmp.close();
        } catch (_) {
          /* ignore */
        }
        let dataUrl = '';
        try {
          dataUrl = canvas.toDataURL('image/webp', quality == null ? 0.72 : quality);
          if (!/^data:image\/(webp|png)/.test(dataUrl)) dataUrl = canvas.toDataURL('image/png');
        } catch (_) {
          return null;
        }
        return { dataUrl, w, h };
      } catch (_) {
        /* 跨域/不支持：走下面的普通路径 */
      }
    }
    return downsample(img, srcW, srcH, maxSide, quality);
  }

  /** 把已经解码好的图像源（img/canvas/bitmap）降采样成 WebP dataURL */
  function downsample(source, srcW, srcH, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/webp', quality == null ? 0.72 : quality);
      // 浏览器不支持 webp 编码时会回退成 png
      if (!/^data:image\/(webp|png)/.test(dataUrl)) dataUrl = canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
    return { dataUrl, w, h };
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }

  /** 通道 A：元素已经在页面上渲染过 —— 直接拿它的像素，零网络 */
  async function thumbFromElement(url, maxSide, quality) {
    const el = elementsByUrl.get(url);
    if (!el || !el.isConnected) return null;
    try {
      if (el.tagName === 'IMG') {
        // 懒加载的图可能还没解码：decode() 复用同一次网络请求（通常已在缓存里）
        if (el.naturalWidth === 0 && el.src) {
          try {
            await el.decode();
          } catch (_) {
            /* 解码失败则走后面的兜底 */
          }
        }
        if (el.naturalWidth > 0) {
          // 跨域且不是 CORS 加载的 <img> 会污染 canvas，导出必然 SecurityError。
          // 提前避开这条注定失败的路，直接让 fetch 通道走页面缓存。
          if (!canReadElementPixels(el)) return null;
          return downsampleImageElement(el, maxSide, quality);
        }
        // 元素还没真正加载（src 是占位符等）：用同地址另开一个 Image
        const u = el.currentSrc || el.src;
        if (u) {
          const off = await loadImageElement(u);
          if (off) return downsampleImageElement(off, maxSide, quality);
        }
      }
      if (el.tagName === 'VIDEO' && el.videoWidth > 0) {
        return downsample(el, el.videoWidth, el.videoHeight, maxSide, quality);
      }
      if (el.tagName === 'CANVAS' && el.width > 0) {
        return downsample(el, el.width, el.height, maxSide, quality);
      }
    } catch (_) {
      /* 跨域污染等情况：交给下面的 fetch 通道 */
    }
    return null;
  }

  /** 该元素的像素能否安全导出（canvas 是否会被污染） */
  function canReadElementPixels(el) {
    const src = el.currentSrc || el.src;
    if (!src) return false;
    if (/^(data|blob):/i.test(src)) return true;
    try {
      if (new URL(src, location.href).origin === location.origin) return true;
    } catch (_) {
      /* 无法判断就按跨域处理 */
    }
    // 只有带 crossorigin 成功加载的跨域图片才是 origin-clean
    return !!el.crossOrigin;
  }

  /** 离屏 <img> 加载：与页面 <img> 共享同一份 HTTP 缓存，不额外下载 */
  function loadImageElement(url, timeoutMs) {
    return new Promise((resolve) => {
      const im = new Image();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      im.onload = () => finish(im.naturalWidth > 0 ? im : null);
      im.onerror = () => finish(null);
      im.decoding = 'async';
      im.src = url;
      setTimeout(() => finish(null), timeoutMs || 8000);
    });
  }

  async function thumbFromFetch(url, maxSide, quality) {
    // cache: 'force-cache' 让浏览器优先用已有副本；页面分区下基本等于零流量
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob.size) throw new Error('内容为空');
    const type = (blob.type || '').toLowerCase();
    const isGif = /gif/.test(type) || looksLikeGif(url);

    // GIF 保留原始字节，<img> 才能播放动画。缓存命中时字节来自页面自己的 HTTP 缓存。
    if (isGif && blob.size <= GIF_PREVIEW_MAX) {
      return {
        dataUrl: await readBlobAsDataUrl(blob),
        passthrough: true,
        gif: true,
        size: blob.size,
        type
      };
    }

    // SVG 无法可靠地用 canvas 采样（且通常很小），直接返回原数据
    if (/svg/.test(type) || blob.size < 3000) {
      return { dataUrl: await readBlobAsDataUrl(blob), passthrough: true, gif: isGif, size: blob.size };
    }

    let bmp = null;
    try {
      bmp = await createImageBitmap(blob);
    } catch (_) {
      bmp = null;
    }

    if (bmp) {
      const out = downsample(bmp, bmp.width, bmp.height, maxSide, quality);
      try {
        bmp.close();
      } catch (_) {
        /* ignore */
      }
      if (out) {
        out.srcBytes = blob.size;
        out.gif = isGif; // 超过预览上限的 GIF：静态首帧 + GIF 标记
        return out;
      }
    }

    // createImageBitmap 解不了（部分 HEIC/AVIF 变体）时，退回 <img> 解码：
    // <img> 的解码器覆盖面比 createImageBitmap 更广，通常还能拿到像素。
    try {
      const objUrl = URL.createObjectURL(blob);
      const im = await loadImageElement(objUrl);
      if (im && im.naturalWidth > 0) {
        const out = downsample(im, im.naturalWidth, im.naturalHeight, maxSide, quality);
        URL.revokeObjectURL(objUrl);
        if (out) {
          out.srcBytes = blob.size;
          out.gif = isGif;
          return out;
        }
      } else {
        URL.revokeObjectURL(objUrl);
      }
    } catch (_) {
      /* 继续走原样返回 */
    }

    // 最后兜底：原样返回字节（弹窗里 <img> 也许能显示，只是不降采样）
    return { dataUrl: await readBlobAsDataUrl(blob), passthrough: true, gif: isGif, size: blob.size };
  }

  async function makeThumb(msg) {
    const url = msg && msg.url;
    if (!url) return { ok: false, error: '缺少地址' };
    const maxSide = Math.max(64, Math.min(512, msg.maxSide || 256));
    const quality = typeof msg.quality === 'number' ? msg.quality : 0.72;
    const key = url + '|' + maxSide;
    const hit = thumbMemo.get(key);
    if (hit) {
      return { ok: true, dataUrl: hit.dataUrl, w: hit.w, h: hit.h, gif: !!hit.gif, cached: true };
    }

    // 页面里的原图还在下载：立即让出后台并发槽，弹窗稍后重试。
    // 若在此 await decode()/fetch，几张慢图就会把整条缩略图队列堵死。
    const pendingEl = elementsByUrl.get(url);
    if (pendingEl && pendingEl.tagName === 'IMG' && !pendingEl.complete) {
      return { ok: false, pending: true, retryAfter: 1200 };
    }

    // 1) 页面上已经渲染出来的图：直接读像素，零网络。
    // GIF 跳过这条（canvas 只能拿首帧），走 fetch 保留原始动画。
    const direct = looksLikeGif(url) ? null : await thumbFromElement(url, maxSide, quality);
    if (direct && direct.dataUrl) {
      if (thumbMemo.size > 400) thumbMemo.clear();
      thumbMemo.set(key, { dataUrl: direct.dataUrl, w: direct.w, h: direct.h, gif: false });
      return { ok: true, dataUrl: direct.dataUrl, w: direct.w, h: direct.h, gif: false, via: 'element' };
    }

    // 2) 走页面分区的 HTTP 缓存
    if (/^(https?|blob):/i.test(url)) {
      try {
        const fetched = await thumbFromFetch(url, maxSide, quality);
        if (fetched && fetched.dataUrl) {
          // 动图原字节可能很大，不放进页面内存缓存，避免同一张 GIF 存两份
          if (!fetched.passthrough) {
            if (thumbMemo.size > 400) thumbMemo.clear();
            thumbMemo.set(key, {
              dataUrl: fetched.dataUrl,
              w: fetched.w,
              h: fetched.h,
              gif: !!fetched.gif
            });
          }
          return {
            ok: true,
            dataUrl: fetched.dataUrl,
            w: fetched.w,
            h: fetched.h,
            passthrough: !!fetched.passthrough,
            gif: !!fetched.gif,
            via: 'page-cache'
          };
        }
      } catch (e) {
        // 页面里拿不到（被 CSP / CORS 拦）：交给后台的 offscreen 通道再试
        return { ok: false, error: String((e && e.message) || e), retryInBackground: true };
      }
    }

    // 3) data: 地址本来就没有网络开销，直接返回
    if (/^data:/i.test(url)) {
      return { ok: true, dataUrl: url, passthrough: true, gif: looksLikeGif(url), via: 'inline' };
    }

    return { ok: false, error: '无法在页面内生成缩略图' };
  }

  function blobToDataUrl(url) {
    // blob: 只能在页面上下文里取，因此由内容脚本转成 dataURL 交给后台下载
    return new Promise((resolve) => {
      if (!isBlob(url)) {
        resolve({ ok: false, error: '不是 blob 地址' });
        return;
      }
      fetch(url, { credentials: 'include' })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        })
        .then(
          (b) =>
            new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(new Error('读取 blob 失败'));
              fr.readAsDataURL(b);
            })
        )
        .then((dataUrl) => resolve({ ok: true, dataUrl, size: dataUrl.length }))
        .catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    });
  }

  function highlight(url) {
    const el = elementsByUrl.get(url);
    if (!el || !el.isConnected) return { ok: false };
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    } catch (_) {
      /* ignore */
    }
    const prev = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #ff2d55';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prev;
      el.style.outlineOffset = prevOffset;
    }, 1600);
    return { ok: true };
  }

  function elementRect(url) {
    const el = elementsByUrl.get(url);
    if (!el || !el.isConnected) return { ok: false };
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false };
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)
      return { ok: false, error: 'out-of-view' };
    return {
      ok: true,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      dpr: window.devicePixelRatio || 1,
      viewport: { w: innerWidth, h: innerHeight }
    };
  }

  // ---------------------------------------------------------------- 对外接口
  const api = {
    version: VERSION,
    collect,
    canvasSnapshot,
    videoFrame,
    blobToDataUrl,
    makeThumb,
    highlight,
    elementRect,
    count: async () => (await collect({ deep: false, budgetMs: 80 })).items.length
  };
  window.__IGP__ = api;
  window.__IGP_COLLECT__ = collect;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'IGP_PING':
        sendResponse({ ok: true, version: VERSION, frameUrl: location.href });
        return false;
      case 'IGP_COLLECT':
        collect(msg.opts).then(sendResponse);
        return true;
      case 'IGP_CANVAS':
        sendResponse(canvasSnapshot(msg.index));
        return false;
      case 'IGP_VIDEO_FRAME':
        sendResponse(videoFrame(msg.index));
        return false;
      case 'IGP_BLOB':
        blobToDataUrl(msg.url).then(sendResponse);
        return true;
      case 'IGP_PAGE_THUMB':
        makeThumb(msg).then(sendResponse);
        return true;
      case 'IGP_HIGHLIGHT':
        sendResponse(highlight(msg.url));
        return false;
      case 'IGP_RECT':
        sendResponse(elementRect(msg.url));
        return false;
      default:
        return false;
    }
  });

  // 页面加载后主动上报一次数量（用于工具栏角标），用空闲时机跑，避免影响页面
  if (window.top === window) {
    let lastCountAt = 0;
    const recount = (budget) => {
      const now = Date.now();
      if (now - lastCountAt < 5000) return; // 限流：最多 5 秒一次，避免动画/广告导致疯狂重扫
      lastCountAt = now;
      // 超大页面（数万个节点）不值得为了角标反复深扫
      let heavy = false;
      try {
        heavy = document.getElementsByTagName('*').length > 30000;
      } catch (_) {
        /* ignore */
      }
      collect({ deep: !heavy, budgetMs: budget })
        .then((res) => {
          chrome.runtime
            .sendMessage({ type: 'IGP_COUNT', count: res.items.length, url: location.href })
            .catch(() => {});
        })
        .catch(() => {});
    };

    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 800));
    idle(() => recount(200), { timeout: 2500 });

    // 懒加载/无限滚动：内容变化时重新计数（防抖 + 限流 + 空闲时执行）
    let timer = null;
    try {
      const mo = new MutationObserver((records) => {
        // 只关心"真的新增了带图片的元素"
        let interesting = false;
        for (const r of records) {
          if (r.type !== 'childList' || !r.addedNodes.length) continue;
          interesting = true;
          break;
        }
        if (!interesting || timer) return;
        timer = setTimeout(() => {
          timer = null;
          const run = () => recount(150);
          if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2000 });
          else run();
        }, 2200);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {
      /* ignore */
    }
  }
})();
