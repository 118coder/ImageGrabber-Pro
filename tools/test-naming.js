/* =============================================================================
 * 图片命名 — 单元测试
 *   面板上显示的名字 == 下载落盘的名字。
 *   地址只是存储服务的 UUID/哈希时，用页面上的名字（alt/title）；
 *   地址里有真实文件名时保持原样。
 * 用法： node tools/test-naming.js
 * ============================================================================= */
'use strict';
const N = require('../src/naming.js');

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
const UUID_URL = 'https://cdn.example.com/0b3febed-43e5-4251-87f9-a42dd9ff9984?auth_key=abc';

console.log('\n[1] 用户遇到的那个问题：地址是 UUID，页面上的名字是 123');
const uuid = N.choose({ url: UUID_URL, alt: '123' });
check('用页面上的名字，而不是 UUID', N.filename({ url: UUID_URL, alt: '123' }) === '123', uuid);
check('来源标记为 alt', uuid.source === 'alt', uuid);

console.log('\n[2] 地址里有真实文件名时保持原样');
check('photo-1.jpg + alt=封面 → photo-1.jpg',
  N.filename({ url: 'https://cdn.example.com/a/photo-1.jpg', alt: '封面' }) === 'photo-1.jpg', null);
check('中文文件名不会被改写',
  N.filename({ url: 'https://cdn.example.com/a/%E6%B5%B7%E6%8A%A5.png', alt: 'banner' }) === '海报.png', null);
check('没有 alt 时用地址里的名字',
  N.filename({ url: 'https://cdn.example.com/a/hero-banner-2024.webp' }) === 'hero-banner-2024.webp', null);

console.log('\n[3] 占位词 / 无信息量的名字不算名字');
check('URL 名只是 image/photo 这类占位词时用 alt',
  N.filename({ url: 'https://cdn.example.com/img/image', alt: '123' }) === '123', null);
check('alt 是占位词时不覆盖真实文件名',
  N.filename({ url: 'https://cdn.example.com/a/photo-1.jpg', alt: 'image' }) === 'photo-1.jpg', null);
check('都没有名字时保留地址里的对象名（不编造）',
  N.filename({ url: 'https://cdn.example.com/a/9f8e7d6c5b4a39281706f5e4d3c2b1a0' }) ===
    '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  null);
check('面板显示的短名字（123）不被当成占位词', !N.isWeak('123') && N.isWeak('image') && N.isWeak(''), null);

console.log('\n[4] 扩展名');
check('扩展名取自地址', N.choose({ url: 'https://c.example.com/a/p.png', alt: 'x' }).ext === '.png', null);
check('扩展名只写在参数里也能拿到（?format=jpg）',
  N.filename({ url: UUID_URL + '&format=jpg', alt: '123' }) === '123.jpg',
  null);
check('alt 自带扩展名时保留（alt="海报.png"）',
  N.filename({ url: 'https://cdn.example.com/0b3febed-43e5-4251-87f9-a42dd9ff9984', alt: '海报.png' }) === '海报.png',
  null);
check('地址里的扩展名优先于 alt 的',
  N.filename({ url: 'https://c.example.com/a/p.webp', alt: '海报.png' }) === 'p.webp', null);

console.log('\n[5] 与面板显示一致');
const cases = [
  { url: UUID_URL, alt: '123' },
  { url: 'https://cdn.example.com/a/photo-1.jpg', alt: '封面' },
  { url: 'https://cdn.example.com/img/image', alt: '123' },
  { url: 'https://cdn.example.com/a/p.webp?w=800' }
];
check('每个条目的 filename() 都非空且与 choose() 一致',
  cases.every((it) => {
    const c = N.choose(it);
    return N.filename(it) === c.base + c.ext && N.filename(it).length > 0;
  }),
  cases.map((it) => N.filename(it)));

console.log('\n[6] 非 http 地址');
check('data: / blob: / canvas: 交给调用方处理（返回空）',
  N.filename({ url: 'data:image/png;base64,AAA' }) === '' &&
    N.filename({ url: 'canvas://index/0' }) === '' &&
    N.filename({ url: 'blob:http://x/1' }) === '',
  null);

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
