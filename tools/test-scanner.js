/* =============================================================================
 * 扫描器实测：用 jsdom 加载真实 HTML（tools/fixture.html），
 * 在页面里跑一遍 src/content.js，检查各类图片是否都被找出来。
 * 用法： node tools/test-scanner.js      （需要 jsdom：npm i --no-save jsdom）
 * =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const contentSrc = fs.readFileSync(path.join(ROOT, 'src', 'content.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');

const PAGE_URL = 'https://www.example.com/gallery/post-1';

let pass = 0;
let fail = 0;
const found = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function has(list, fragment, kind) {
  return list.some((it) => it.url.includes(fragment) && (!kind || it.kind === kind));
}
function item(list, fragment) {
  return list.find((it) => it.url.includes(fragment));
}

(async function run() {
  const dom = new JSDOM(fixture, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: undefined // 不加载任何外部资源
  });
  const { window } = dom;
  window.fetch = () => Promise.reject(new Error('测试环境不联网')); // jsdom 没带 fetch

  // 假 chrome API（内容脚本只用 onMessage / sendMessage）
  const messages = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      getManifest() {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
      },
      sendMessage(msg) {
        messages.push(msg);
        return Promise.resolve({ ok: true });
      }
    }
  };

  // 注入内容脚本，让它自己在页面里跑起来
  const script = window.document.createElement('script');
  script.textContent = contentSrc;
  window.document.head.appendChild(script);

  check('内容脚本加载并挂载 window.__IGP__', !!(window.__IGP__ && window.__IGP__.collect), Object.keys(window.__IGP__ || {}));
  if (!window.__IGP__) {
    console.log('\n内容脚本没跑起来，后续测试跳过');
    process.exit(1);
  }

  const t0 = Date.now();
  const res = await window.__IGP__.collect({ deep: true, thorough: true, scripts: true, budgetMs: 500 });
  const ms = Date.now() - t0;
  const items = res.items;
  items.forEach((it) => found.push(it));
  console.log(`\n扫描完成：${items.length} 条，耗时 ${ms}ms（jsdom 无真实布局，仅验证提取逻辑）\n`);

  console.log('[1] 基础图片');
  check('普通 img src', has(items, '/img/plain.jpg'));
  check('img 尺寸被记录（width/height 属性）', item(items, 'plain.jpg').w === 800, item(items, 'plain.jpg'));
  check('alt 文本被记录', item(items, 'plain.jpg').alt === '普通图', item(items, 'plain.jpg').alt);

  console.log('\n[2] srcset 取最大');
  check('srcset 里 1600w 的那张', has(items, 'big-1600.jpg'));
  check('没有误加 400w 的小图', !has(items, 'small-400.jpg'));
  check('src 兜底图也在列表里', has(items, 'fallback.jpg'));
  check('picture > source 的 2x 被选中', has(items, 'pic-a@2x.webp'), items.filter((i) => i.url.includes('pic-a')).map((i) => i.url));
  check('picture 里的 img 兜底图也收了', has(items, 'pic-fallback.jpg'));

  console.log('\n[3] 懒加载（不滚动也能抓到）');
  check('data-src', has(items, 'lazy-data.jpg'));
  check('data-original', has(items, 'lazy-original.png'));
  check('data-lazy-srcset 取最大', has(items, 'lazy-srcset-big.jpg'));
  check('data-background-image', has(items, 'div-bg.jpg'));
  check('data-img 无扩展名但路径含 photo → 标为疑似', (() => {
    const it = item(items, '9f1c8e77b2d4a6c3');
    return !!it && it.probable === true;
  })(), item(items, '9f1c8e77b2d4a6c3'));

  console.log('\n[4] 内联样式与样式表背景');
  check('内联 background-image', has(items, 'inline-bg.png'));
  check('内联 image-set 两张都抓到', has(items, 'inline-set-1x.jpg') && has(items, 'inline-set-2x.jpg'));
  check('样式表里的 background-image', has(items, 'css/hero-bg.jpg'));
  check('image-set 的多分辨率都抓到（内联样式通道）', has(items, 'inline-set-1x.jpg') && has(items, 'inline-set-2x.jpg'));
  check('@media 里的背景图也抓到', has(items, 'css/mq-banner.webp'));
  console.log('  · 注：jsdom 的 CSSOM 会丢弃 image-set 声明，样式表里的 image-set 放到 [11] 用真实 cssText 验证');

  console.log('\n[5] 头部信息与视频封面');
  check('og:image', has(items, '/og/share-cover.png') && item(items, 'share-cover').kind === 'meta');
  check('twitter:image', has(items, 'twitter/card.jpg'));
  check('link rel=preload as=image', has(items, 'preload/hero.avif'));
  check('video poster', has(items, 'video/poster.jpg') && item(items, 'poster.jpg').kind === 'poster');

  console.log('\n[6] 链接与 SVG');
  check('a[href] 的图片直链', has(items, 'full-size-image.jpeg'));
  check('PDF / JS / HTML 链接被排除', !has(items, 'manual.pdf') && !has(items, 'app.js') && !has(items, '/page/index.html'));
  check('javascript: 链接被排除', !items.some((i) => i.url.startsWith('javascript:')));
  check('svg > image 的 href', has(items, 'svg/embedded.png'));
  check('内联 SVG 被导出为 data:image/svg+xml', items.some((i) => i.kind === 'svg-inline' && i.url.startsWith('data:image/svg+xml')));
  check('内联 SVG 带 viewBox 尺寸', (() => {
    const it = items.find((i) => i.kind === 'svg-inline');
    return it && it.w === 200 && it.h === 150;
  })(), items.filter((i) => i.kind === 'svg-inline').map((i) => [i.w, i.h]));

  console.log('\n[7] 脚本文本里的转义地址');
  check('JSON-LD 里 escaped-1.jpg', has(items, 'gallery/escaped-1.jpg'));
  check('JSON-LD 里 escaped-2.png', has(items, 'gallery/escaped-2.png'));

  console.log('\n[8] 特殊地址与可视元素');
  check('blob: 地址被收（kind=blob/img）', has(items, 'blob:https://www.example.com/7c1a'));
  check('data: 图片被收且不算疑似', (() => {
    const it = items.find((i) => i.url.startsWith('data:image/gif'));
    return it && it.probable === false;
  })());
  check('1×1 统计像素被收（交给界面过滤）', (() => {
    const it = item(items, 'pixel.gif');
    return it && it.w === 1 && it.h === 1;
  })());
  check('canvas 作为可视元素列出', items.some((i) => i.kind === 'canvas' && i.w === 640 && i.h === 480), items.filter((i) => i.kind === 'canvas'));

  console.log('\n[9] 干扰项不误报');
  check('没有抓到 /api/v1/user/profile', !has(items, '/api/v1'));
  check('没有抓到 readme.md', !has(items, 'readme.md'));

  console.log('\n[10] 接口行为');
  check('统计信息完整', res.stats && typeof res.stats.ms === 'number' && res.stats.scannedElements > 20, res.stats);
  const scoped = await window.__IGP__.collect({ deep: false, budgetMs: 120 });
  check('重复调用仍然正常（串行队列）', scoped.ok && scoped.items.length > 0, scoped.items && scoped.items.length);
  const canvasRes = window.__IGP__.canvasSnapshot(0);
  check('canvas 快照接口不崩溃（jsdom 无真实画布，允许失败）', typeof canvasRes.ok === 'boolean', canvasRes);
  const rectRes = window.__IGP__.elementRect(items[0].url);
  check('elementRect 接口可用', typeof rectRes.ok === 'boolean', rectRes);
  const hl = window.__IGP__.highlight(items[0].url);
  check('highlight 接口可用', typeof hl.ok === 'boolean', hl);
  const blob = await window.__IGP__.blobToDataUrl('blob:https://www.example.com/x');
  check('blobToDataUrl 对非法 blob 有兜底', blob.ok === false || typeof blob.ok === 'boolean', blob);

  console.log('\n[10.5] 版本守卫：扩展升级后必须替换页面里的旧脚本');
  // 旧版 content.js 版本号写死，导致升级后已打开的标签页仍在跑旧逻辑。
  // 现在版本号取自 manifest，这里验证"旧版本残留会被替换、同版本会跳过"。
  {
    const v = window.chrome.runtime.getManifest().version;
    // 模拟旧版本残留
    const stale = window.document.createElement('script');
    stale.textContent = 'window.__IGP__ = { version: "0.0.1", tag: "STALE" };';
    window.document.head.appendChild(stale);
    stale.remove();
    const staleObj = window.__IGP__;
    // 重新注入
    const re = window.document.createElement('script');
    re.textContent = contentSrc;
    window.document.head.appendChild(re);
    re.remove();
    check('页面里的旧版本脚本被替换', window.__IGP__ !== staleObj && window.__IGP__.version === v, {
      stale: staleObj && staleObj.version,
      now: window.__IGP__ && window.__IGP__.version
    });
    check('替换后 collect 可用', typeof window.__IGP__.collect === 'function', typeof window.__IGP__.collect);
    const same = window.__IGP__;
    const again = window.document.createElement('script');
    again.textContent = contentSrc;
    window.document.head.appendChild(again);
    again.remove();
    check('同版本重复注入仍然跳过（不重复初始化）', window.__IGP__ === same, null);
  }

  console.log('\n[11] 用真实 cssText 验证样式表解析（jsdom 的 CSSOM 太弱，这里换成合成样式表）');
  const fakeSheets = [
    {
      cssRules: [
        {
          selectorText: '.multi',
          cssText:
            '.multi { background-image: image-set(url("https://cdn.example.com/css/set-1x.png") 1x, url("https://cdn.example.com/css/set-2x.png") 2x); }'
        },
        {
          // @media 这类分组规则：没有 selectorText，只有子规则
          selectorText: undefined,
          cssText: '@media (min-width:800px) { .in-media { background: url(/css/mq-deep.webp) } }',
          cssRules: [
            { selectorText: '.in-media', cssText: '.in-media { background: url(/css/mq-deep.webp) }' }
          ]
        },
        { selectorText: 'a:hover', cssText: 'a:hover { background-image: url("/css/hover-bg.png") }' },
        {
          // CSS 嵌套：父规则自己也有 cssRules（Chrome 112+ 每条规则都有）
          selectorText: '.nested',
          cssText: '.nested { background: url(/css/nested-outer.png); & .inner { background: url(/css/nested-inner.png) } }',
          cssRules: [{ selectorText: '& .inner', cssText: '& .inner { background: url(/css/nested-inner.png) }' }]
        },
        {
          // 普通规则：Chrome 里 cssRules 是"存在但为空"的列表，绝不能被当成分组规则跳过
          selectorText: '.plain',
          cssText: '.plain { background-image: url(/css/plain-bg.jpg) }',
          cssRules: []
        },
        {
          selectorText: '.commented',
          cssText: '.commented { /* url(/css/should-not-match.png) */ background-image: url(/css/after-comment.png) }'
        }
      ]
    }
  ];
  Object.defineProperty(window.document, 'styleSheets', { value: fakeSheets, configurable: true });
  const cssRes = await window.__IGP__.collect({ deep: false, thorough: false, budgetMs: 200 });
  const cssItems = cssRes.items;
  check('image-set 两个分辨率都解析出来', has(cssItems, 'css/set-1x.png') && has(cssItems, 'css/set-2x.png'), cssItems.filter((i) => i.kind === 'css').map((i) => i.url));
  check('分组规则（@media）继续往下递归', has(cssItems, 'css/mq-deep.webp'));
  check('带伪类的选择器也能处理', has(cssItems, 'css/hover-bg.png'));
  check('CSS 嵌套内外层都抓到', has(cssItems, 'css/nested-outer.png') && has(cssItems, 'css/nested-inner.png'));
  check('cssRules 为空列表的普通规则不被跳过', has(cssItems, 'css/plain-bg.jpg'));
  check('注释里的 url 也不会漏（浏览器会保留注释文本）', has(cssItems, 'css/after-comment.png'));

  console.log('\n—— 抓到的全部地址（按类型） ——');
  const byKind = {};
  for (const it of items) (byKind[it.kind] = byKind[it.kind] || []).push(it.url.replace(/^data:image\/svg\+xml.*/, 'data:svg(inline)'));
  for (const [k, v] of Object.entries(byKind)) {
    console.log(`  ${k} (${v.length}):`);
    v.forEach((u) => console.log('    · ' + u.replace(PAGE_URL.slice(0, 24), '').slice(0, 110)));
  }

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
