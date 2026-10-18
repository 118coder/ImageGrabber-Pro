/* =============================================================================
 * 重复图片合并 — 单元测试
 *   同一张图的多种地址（签名参数 / 尺寸参数 / 缩略后缀 / http-https / www）
 *   合并成一条；不同图片绝不误合并。
 * 用法： node tools/test-dedupe.js
 * ============================================================================= */
'use strict';
const D = require('../src/dedupe.js');
// 浏览器里 IGPHash 是全局脚本；Node 测试里手工挂上，保持同一套调用方式
global.IGPHash = require('../src/hash.js');
const H = global.IGPHash;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}
const items = (...urls) => urls.map((url) => ({ url, kind: 'img', w: 400, h: 300, probable: false }));

console.log('\n[1] 归一化：同一张图的各种地址应得到同一个 key');
const a = D.normalize('https://cdn.example.com/a/photo.png?auth_key=aaa&x=1');
const b = D.normalize('https://cdn.example.com/a/photo.png?auth_key=bbb&x=1');
check('签名参数（auth_key）不影响身份', a === b, { a, b });
check('X-Amz-* / token 也不影响身份',
  D.normalize('https://s3.example.com/p.jpg?X-Amz-Signature=1&X-Amz-Date=2') ===
    D.normalize('https://s3.example.com/p.jpg?X-Amz-Signature=9&X-Amz-Date=8'),
  null);
check('尺寸参数（?w=/?h=/?quality=）不影响身份',
  D.normalize('https://cdn.example.com/a/photo.png?w=300') ===
    D.normalize('https://cdn.example.com/a/photo.png?w=1200&quality=80'),
  null);
check('参数顺序不同不影响身份',
  D.normalize('https://cdn.example.com/a/photo.png?id=1&z=2') ===
    D.normalize('https://cdn.example.com/a/photo.png?z=2&id=1'),
  null);
check('缩略后缀不进地址归一（不同分辨率必须保留成不同条目）',
  D.normalize('https://cdn.example.com/a/photo-300x200.png') !==
    D.normalize('https://cdn.example.com/a/photo.png') &&
    D.normalize('https://cdn.example.com/a/icon512-150x150.png') !==
    D.normalize('https://cdn.example.com/a/icon512-300x300.png'),
  [
    D.normalize('https://cdn.example.com/a/photo-300x200.png'),
    D.normalize('https://cdn.example.com/a/icon512-150x150.png'),
    D.normalize('https://cdn.example.com/a/icon512-300x300.png')
  ]);
check('变体键能把缩略图指向对应原图',
  D.variantKey('https://cdn.example.com/a/photo-300x200.png') ===
    D.variantKey('https://cdn.example.com/a/photo.png') &&
    D.variantKey('https://cdn.example.com/a/photo_thumb.png') ===
    D.variantKey('https://cdn.example.com/a/photo.png') &&
    D.variantKey('https://cdn.example.com/a/photo@2x.png') ===
    D.variantKey('https://cdn.example.com/a/photo.png'),
  [D.variantKey('https://cdn.example.com/a/photo-300x200.png'), D.variantKey('https://cdn.example.com/a/photo.png')]);
check('能识别"这是派生变体"',
  D.isDerived('https://c.example.com/a/photo-300x200.png') === true &&
    D.isDerived('https://c.example.com/a/photo_thumb.png') === true &&
    D.isDerived('https://c.example.com/a/photo.png') === false,
  null);
check('http/https 与 www 前缀视为同一张图',
  D.normalize('http://www.cdn.example.com/a/photo.png') ===
    D.normalize('https://cdn.example.com/a/photo.png'),
  null);
check('hash 不参与身份', D.normalize('https://c.example.com/p.png#x') === D.normalize('https://c.example.com/p.png'), null);
check('data: / blob: 地址不做归一（返回 null，按原样保留）',
  D.normalize('data:image/png;base64,AAA') === null && D.normalize('blob:http://x/1') === null,
  null);

console.log('\n[2] 不能误合并');
check('不同的 id 参数是不同图片',
  D.normalize('https://c.example.com/p.php?id=1') !== D.normalize('https://c.example.com/p.php?id=2'),
  null);
check('不同路径是不同图片',
  D.normalize('https://c.example.com/a/p.png') !== D.normalize('https://c.example.com/b/p.png'), null);
check('形状相似但不同的文件名不合并',
  D.normalize('https://c.example.com/a/photo-1.png') !== D.normalize('https://c.example.com/a/photo-2.png'), null);

console.log('\n[3] 合并结果');
const res = D.dedupe(
  items(
    'https://cdn.example.com/a/photo.png?auth_key=a',
    'https://cdn.example.com/a/photo.png?auth_key=b',
    'https://cdn.example.com/a/photo.png?w=300',
    'https://cdn.example.com/a/photo-300x200.png',
    'https://cdn.example.com/a/other.png'
  )
);
check('3 个参数变体折叠成 1 条，缩略变体单独保留', res.list.length === 3, res.list.map((i) => i.url));
check('被折叠的数量统计正确', res.hidden === 2, res.hidden);
const kept = res.list.find((i) => i.url === 'https://cdn.example.com/a/photo.png?auth_key=a');
check('保留项带 dupCount', kept && kept.dupCount === 3, kept);
check('保留项带全部原始地址', kept && Array.isArray(kept.dupUrls) && kept.dupUrls.length === 3, kept && kept.dupUrls);
check('其他图片不受影响', !!res.list.find((i) => /other\.png/.test(i.url)), res.list.map((i) => i.url));
check('alias 指向保留下来的那条地址',
  Object.keys(res.alias).length === 2 && Object.values(res.alias).every((v) => v === kept.url),
  res.alias);

console.log('\n[4] 保留哪一条');
const pick = D.dedupe([
  { url: 'https://cdn.example.com/a/p.png?w=100', kind: 'attr', probable: true, w: 0, h: 0 },
  { url: 'https://cdn.example.com/a/p.png?w=200', kind: 'img', probable: false, w: 300, h: 200 },
  { url: 'https://cdn.example.com/a/p-600x400.png', kind: 'img', probable: false, w: 600, h: 400 }
]);
check('优先选非"疑似"且尺寸更大的地址',
  pick.list.length === 2 &&
    pick.list[0].url === 'https://cdn.example.com/a/p.png?w=200' &&
    pick.list.some((i) => /p-600x400/.test(i.url)),
  pick.list.map((i) => [i.url, i.dupCount]));

const singles = D.dedupe(items('https://c.example.com/a.png', 'https://c.example.com/b.png'));
check('没有重复时不附加 dupCount', singles.list.every((i) => i.dupCount === undefined) && singles.hidden === 0, singles.list);

console.log('\n[5] 边界');
check('空数组安全', D.dedupe([]).list.length === 0, null);
check('非数组安全', D.dedupe(null).list.length === 0, null);
check('无效条目被跳过（不抛错）',
  D.dedupe([null, { url: 'https://c.example.com/a.png' }, undefined]).list.length === 1,
  null);

console.log('\n[6] MD5：字节完全一致时，即使地址毫无关系也合并');
const item = (url, w, h, alt) => ({ url, kind: 'img', w, h, alt: alt || '', probable: false });

const byMd5 = D.dedupe(
  [
    item('https://a.example.com/gallery/pic-01.jpg', 1600, 1200),
    item('https://b.cdn.net/other-name-400.jpg', 400, 300)
  ],
  {
    content: {
      'https://a.example.com/gallery/pic-01.jpg': { md5: 'aa11' },
      'https://b.cdn.net/other-name-400.jpg': { md5: 'aa11' }
    }
  }
);
check('MD5 相同 → 不同域名/文件名/尺寸也合并', byMd5.list.length === 1 && byMd5.hidden === 1, byMd5.list.map((i) => i.url));
check('合并原因标为 md5', byMd5.list[0].dupReason === 'md5', byMd5.list[0].dupReason);
check('保留分辨率更大的那张', byMd5.list[0].url === 'https://a.example.com/gallery/pic-01.jpg', byMd5.list[0].url);
check('两个地址都记进 dupUrls', byMd5.list[0].dupUrls.length === 2, byMd5.list[0].dupUrls);

const noMd5 = D.dedupe(
  [
    item('https://a.example.com/gallery/pic-01.jpg', 1600, 1200),
    item('https://b.cdn.net/other-name-400.jpg', 400, 300)
  ],
  {
    content: {
      'https://a.example.com/gallery/pic-01.jpg': { md5: 'aa11' },
      'https://b.cdn.net/other-name-400.jpg': { md5: 'bb22' }
    }
  }
);
check('MD5 不同 → 不合并', noMd5.list.length === 2, noMd5.list.map((i) => i.url));
check(
  '没有 MD5 证据时不会只看尺寸就合并',
  D.dedupe(
    [item('https://a.example.com/x/one.png', 300, 300), item('https://a.example.com/y/two.png', 300, 300)],
    {
      content: {
        'https://a.example.com/x/one.png': { md5: 'm1' },
        'https://a.example.com/y/two.png': { md5: 'm2' }
      }
    }
  ).list.length === 2,
  null
);

console.log('\n[7] 真实站点回归：pokemon.cn 的两个典型误合并');
// ① 同页图标的不同分辨率：不能合并（曾经被"剥掉尺寸后缀"合并掉）
const icons = D.dedupe(
  [
    item('https://image.pokemon.com.cn/wp-content/uploads/2025/11/icon512-150x150.png?auth_key=a', 150, 150),
    item('https://image.pokemon.com.cn/wp-content/uploads/2025/11/icon512-300x300.png?auth_key=a', 300, 300),
    item('https://image.pokemon.com.cn/wp-content/uploads/2025/11/icon512-300x300.png?auth_key=b', 300, 300)
  ],
  {
    content: {
      'https://image.pokemon.com.cn/wp-content/uploads/2025/11/icon512-150x150.png?auth_key=a': { md5: 'i150' },
      'https://image.pokemon.com.cn/wp-content/uploads/2025/11/icon512-300x300.png?auth_key=a': { md5: 'i300' },
      'https://image.pokemon.com.cn/wp-content/uploads/2025/11/icon512-300x300.png?auth_key=b': { md5: 'i300' }
    }
  }
);
check('150x150 与 300x300 绝不合并（分辨率不同就是不同的图）',
  icons.list.length === 2,
  icons.list.map((i) => [i.url, i.dupCount]));
check(
  '只有签名不同的那份 300x300 被合并',
  icons.list.find((i) => /300x300/.test(i.url)).dupCount === 2,
  icons.list.map((i) => [i.url, i.dupCount, i.dupReason])
);

// ② 卡牌页：同一套卡框、不同插画，绝不能按"画面像"合并
const cards = D.dedupe(
  [
    item('https://image.pokemon.com.cn/uploads/2026/10/20261016105433204.png?auth_key=1', 1549, 2336),
    item('https://image.pokemon.com.cn/uploads/2026/10/20261016105433204.png?auth_key=2', 1549, 2336),
    item('https://image.pokemon.com.cn/uploads/2026/10/20261016105427197.png?auth_key=1', 1549, 2336),
    item('https://image.pokemon.com.cn/uploads/2026/10/20261016105427197.png?auth_key=2', 1549, 2336),
    item('https://image.pokemon.com.cn/uploads/2026/10/20261016105451502.png?auth_key=1', 1549, 2336)
  ],
  { content: {} }
);
check('5 个地址 → 3 张卡（只有同文件名的签名重复被合并）', cards.list.length === 3, cards.list.map((i) => [i.url, i.dupCount]));
check(
  '不同卡牌之间绝不合并（即使尺寸完全相同）',
  cards.list.every((i) => i.dupCount === undefined || i.dupCount === 2),
  cards.list.map((i) => [i.url, i.dupCount])
);

// ③ 缩略变体不再并入原图：不同分辨率就是不同的东西，宁可多显示一条
const withOriginal = D.dedupe(
  [
    item('https://a.example.com/p/photo.png?auth_key=1', 1200, 800),
    item('https://a.example.com/p/photo.png?auth_key=2', 1200, 800),
    item('https://a.example.com/p/photo-300x200.png', 300, 200)
  ],
  {}
);
check('同名的签名重复合并成 1 条', withOriginal.list.length === 2, withOriginal.list.map((i) => [i.url, i.dupCount]));
check('缩略变体独立成条（不并进原图）',
  withOriginal.list.some((i) => /photo-300x200/.test(i.url) && i.dupCount === undefined),
  withOriginal.list.map((i) => [i.url, i.dupCount]));
check('合并原因只有 url / md5 两种',
  withOriginal.list.filter((i) => i.dupReason).every((i) => i.dupReason === 'url' || i.dupReason === 'md5'),
  withOriginal.list.map((i) => i.dupReason));

const withoutOriginal = D.dedupe(
  [
    item('https://a.example.com/p/photo-300x200.png', 300, 200),
    item('https://a.example.com/p/photo-600x400.png', 600, 400)
  ],
  {}
);
check('两个缩略变体各算一张（不能互并）', withoutOriginal.list.length === 2, withoutOriginal.list.map((i) => i.url));

console.log('\n[8] 判定等级');
const pair = [
  item('https://a.example.com/x/photo.png', 800, 600),
  item('https://b.cdn.net/y/photo.png', 800, 600)
];
const diffMd5 = { 'https://a.example.com/x/photo.png': { md5: 'q1' }, 'https://b.cdn.net/y/photo.png': { md5: 'q2' } };
const sameMd5 = { 'https://a.example.com/x/photo.png': { md5: 'q1' }, 'https://b.cdn.net/y/photo.png': { md5: 'q1' } };
check('strict：只按地址，忽略 MD5 证据', D.dedupe(pair, { content: sameMd5, level: 'strict' }).list.length === 2, null);
check('standard：MD5 不一致则不合并', D.dedupe(pair, { content: diffMd5, level: 'standard' }).list.length === 2, null);
check('standard：MD5 一致则合并', D.dedupe(pair, { content: sameMd5, level: 'standard' }).list.length === 1, null);
check('没有指纹时退回只看地址（不会误合）', D.dedupe(pair, { content: null, level: 'standard' }).list.length === 2, null);
check(
  '等级只剩两档（没有 aggressive）',
  D.LEVELS.strict === 0 && D.LEVELS.standard === 1 && D.LEVELS.aggressive === undefined,
  D.LEVELS
);

console.log('\n[9] alias 覆盖内容合并的地址（选中态要跟着走）');
const aliasRes = D.dedupe(
  [item('https://a.example.com/p/one.jpg', 1600, 1200), item('https://b.example.com/q/two.jpg', 400, 300)],
  {
    content: {
      'https://a.example.com/p/one.jpg': { md5: 'same' },
      'https://b.example.com/q/two.jpg': { md5: 'same' }
    }
  }
);
check(
  '被折叠的地址指向保留的地址',
  aliasRes.alias['https://b.example.com/q/two.jpg'] === 'https://a.example.com/p/one.jpg',
  aliasRes.alias
);

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
