/* =============================================================================
 * 图集捕手 — 重复图片合并
 *
 * 同一张图在页面里经常有多个地址：
 *   · 每次生成的签名参数不同（auth_key / X-Amz-* / token）
 *   · 同一资源的尺寸参数不同（?w=300 / ?w=1200）
 *   · 缩略图命名后缀不同（photo-300x200.jpg / photo_thumb.png / photo@2x.png）
 *
 * 这里把 URL 归一成"图片身份"，同一身份只保留一条最合适的记录，其余折叠掉。
 * 弹窗、图库、右键"下载本页全部图片"共用这份逻辑。
 * ============================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IGPDedupe = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 只影响"取哪一份/怎么取"的参数，不改变图片本身 */
  const VOLATILE_PARAM =
    /^(?:auth_?key|authkey|authorization|signature|sign|sig|token|access_?token|expires?|expire|e|policy|credential|x-amz-[a-z0-9-]+|x-oss-[a-z0-9-]+|ossaccesskeyid|security-token|v|ver|version|t|ts|timestamp|time|_|cb|cache|cachebust|cachebuster|rnd|random|nonce|date|updated|update|w|h|width|height|size|quality|q|resize|fit|crop|thumb|thumbnail|format|fm|auto|dpr|scale|type)$/i;

  /**
   * 文件名里的尺寸/缩略后缀：photo-300x200.jpg / photo_thumb.png / photo@2x.png / photo-scaled.jpg
   * 只用来找"派生变体对应的原图"，本身不参与地址归一。
   */
  const SIZE_SUFFIX =
    /(?:[_\-.]\d{2,4}x\d{2,4}|[_\-](?:thumb|thumbnail|thumbs|small|mini|tiny|low|preview|scaled|resized)|[@_\-]\d+(?:\.\d+)?x)(?=\.[a-z0-9]{2,5}$)/i;

  function baseName(path) {
    const slash = path.lastIndexOf('/');
    return path.slice(slash + 1);
  }

  function stripSizeSuffix(name) {
    return String(name || '').replace(SIZE_SUFFIX, '');
  }

  /** 拆出可归一的几块；无法解析（data:/blob:/canvas:）时返回 null */
  function parts(url) {
    let u;
    try {
      u = new URL(String(url));
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    let host = u.hostname.toLowerCase();
    if (host.indexOf('www.') === 0) host = host.slice(4);

    const path = u.pathname.replace(/\/{2,}/g, '/');
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash + 1).replace(/\/+$/, '/');
    const name = baseName(path);

    const keep = [];
    u.searchParams.forEach((v, k) => {
      if (!VOLATILE_PARAM.test(k)) keep.push(k.toLowerCase() + '=' + v);
    });
    keep.sort();

    return { host, dir, name, query: keep.length ? '?' + keep.join('&') : '' };
  }

  /**
   * 归一化 URL：同一张图的"不同地址写法"得到同一个 key。
   * 只去掉签名/尺寸这类不影响图片本身的查询参数，文件名原样保留——
   * 曾经在这里顺手剥掉 `-150x150` 这类后缀，结果把 icon512-150x150 和
   * icon512-300x300 两个不同分辨率的文件当成同一张合并了。
   */
  function normalize(url) {
    const p = parts(url);
    if (!p) return null;
    return p.host + '|' + p.dir + p.name + p.query;
  }

  /**
   * 变体键：去掉尺寸/缩略后缀后的全路径，用来判断"这张是不是某张原图的缩略版"。
   * 例：/a/photo-300x200.jpg 与 /a/photo.jpg 的 variantKey 相同。
   */
  function variantKey(url) {
    const p = parts(url);
    if (!p) return null;
    const bare = stripSizeSuffix(p.name);
    return p.host + '|' + p.dir + bare + p.query;
  }

  /** 文件名是否带尺寸/缩略后缀（即"派生变体"，而不是原图） */
  function isDerived(url) {
    const p = parts(url);
    if (!p) return false;
    return stripSizeSuffix(p.name) !== p.name;
  }

  const KIND_SCORE = {
    img: 200,
    lazy: 180,
    blob: 120,
    srcset: 150,
    poster: 80,
    meta: 60,
    link: 50,
    css: 40,
    'inline-css': 35,
    script: 30,
    attr: 5
  };

  /** 同一组里挑"最像原图"的一条：非推导项优先、尺寸大优先、原始文件名优先 */
  function score(it) {
    let s = 0;
    if (!it.probable && it.kind !== 'attr') s += 1000;
    s += KIND_SCORE[it.kind] || 10;
    const area = (Number(it.w) || 0) * (Number(it.h) || 0);
    s += Math.min(area, 50e6) / 1e6;
    const path = String(it.url || '').split(/[?#]/)[0];
    const name = baseName(path);
    if (stripSizeSuffix(name) !== name) s -= 80;
    if (/[?&](?:w|h|width|height|size|quality|q|resize|fit|crop|thumb|thumbnail|format|fm|auto|dpr|scale|type)=/i.test(it.url || '')) {
      s -= 40;
    }
    if (/^https:/i.test(it.url || '')) s += 2;
    return s;
  }

  /**
   * @returns {{list:Array, groups:number, hidden:number, alias:Object}}
   *   list   合并后的条目（保留原对象，重复组会附加 dupCount / dupUrls）
   *   hidden 被折叠掉的条目数
   *   alias  被折叠地址 → 保留地址，用于同步已选状态
   */
  /**
   * 重复判定等级：
   *   strict    只按地址（归一化后相同）
   *   standard  地址 + MD5（字节完全一致）
   *
   * 这里刻意没有"画面相似"和"分辨率相同"两种判定，两者在真实站点上都会误伤：
   *   · 画面相似：卡牌/商品图共用同一套外框，只有中间图不同，粗指纹分不开；
   *   · 分辨率相同：一页几十张同尺寸商品图会被直接并成一张。
   * 地址归一负责认出"同一张图的不同地址写法"，MD5 负责认出"字节相同的重复上传"，
   * 两者都是硬证据，不会把不同的图合并掉。
   */
  const LEVELS = { strict: 0, standard: 1 };

  function dedupe(items, opts) {
    const arr = Array.isArray(items) ? items : [];
    const options = opts || {};
    const content = options.content || null;
    const level = LEVELS[options.level] == null ? LEVELS.standard : LEVELS[options.level];

    // ① 先按归一化地址分组，顺便记住每组的"内容证据"
    const groups = new Map();
    const order = [];
    for (const it of arr) {
      if (!it || typeof it.url !== 'string') continue;
      const key = normalize(it.url) || 'raw|' + it.url;
      let g = groups.get(key);
      if (!g) {
        g = { key, items: [], md5: '', w: 0, h: 0 };
        groups.set(key, g);
        order.push(g);
      }
      g.items.push(it);
      if (content) {
        // 面板传的是 Map（url → {md5}），也兼容普通对象
        const c = typeof content.get === 'function' ? content.get(it.url) : content[it.url];
        if (c && c.md5 && !g.md5) g.md5 = c.md5;
      }
      const w = Number(it.w) || 0;
      const h = Number(it.h) || 0;
      if (w * h > g.w * g.h) {
        g.w = w;
        g.h = h;
      }
    }

    // ② 按内容把不同的地址组并起来（union-find）
    const parent = order.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (i, j) => {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    };

    if (level >= LEVELS.standard && order.length > 1) {
      // MD5：字节完全一致，无视地址、尺寸、格式
      const byMd5 = new Map();
      for (let i = 0; i < order.length; i++) {
        const g = order[i];
        if (!g.md5) continue;
        const prev = byMd5.get(g.md5);
        if (prev != null) union(prev, i);
        else byMd5.set(g.md5, i);
      }
    }

    // ③ 合并后的组：挑一条最优的留下
    const merged = new Map();
    for (let i = 0; i < order.length; i++) {
      const root = find(i);
      if (!merged.has(root)) merged.set(root, []);
      merged.get(root).push(order[i]);
    }

    const list = [];
    const alias = {};
    let hiddenCount = 0;
    for (const parts of merged.values()) {
      const all = [];
      for (const p of parts) for (const it of p.items) all.push(it);
      let best = all[0];
      for (const it of all) {
        if (score(it) > score(best)) best = it;
      }
      hiddenCount += all.length - 1;
      if (all.length > 1) {
        const copy = Object.assign({}, best);
        copy.dupCount = all.length;
        copy.dupUrls = all.map((i) => i.url);
        // 合并原因：给用户一个"为什么这几条被并了"的交代
        let reason = 'url';
        if (parts.length > 1) {
          const hasMd5 = new Set();
          let md5Dup = false;
          for (const p of parts) {
            if (p.md5) {
              if (hasMd5.has(p.md5)) md5Dup = true;
              hasMd5.add(p.md5);
            }
          }
          reason = md5Dup ? 'md5' : 'url';
        }
        copy.dupReason = reason;
        list.push(copy);
        for (const it of all) {
          if (it.url !== best.url) alias[it.url] = best.url;
        }
      } else {
        list.push(best);
      }
    }
    // 保持原顺序（按首次出现的地址）
    const pos = new Map();
    order.forEach((g, i) => {
      for (const it of g.items) if (!pos.has(it.url)) pos.set(it.url, i);
    });
    list.sort((a, b) => (pos.get(a.url) || 0) - (pos.get(b.url) || 0));

    return { list, groups: merged.size, hidden: hiddenCount, alias };
  }

  return { normalize, variantKey, isDerived, score, dedupe, stripSizeSuffix, LEVELS };
});
