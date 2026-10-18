/* =============================================================================
 * 内容指纹（MD5）— 单元测试
 *   只验证 MD5：这是合并"字节完全相同的重复图片"的唯一依据。
 *
 *   曾经这里还测过一个"画面指纹"（9×8 灰度差分），它已经在真实站点上被证伪
 *   （卡牌页所有卡共用卡框，粗指纹分不开，把几十张不同的卡并成一张），
 *   所以整块代码与测试一起删掉了。
 * 用法： node tools/test-hash.js
 * ============================================================================= */
'use strict';
const H = require('../src/hash.js');

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
const md5of = (s) => H.md5(new TextEncoder().encode(s));

console.log('\n[1] MD5 正确性（RFC 1321 标准测试向量）');
check('空串', md5of('') === 'd41d8cd98f00b204e9800998ecf8427e', md5of(''));
check('"abc"', md5of('abc') === '900150983cd24fb0d6963f7d28e17f72', md5of('abc'));
check('"message digest"', md5of('message digest') === 'f96b697d7cb7938d525a2f31aaf161d0', md5of('message digest'));
check(
  '字母表 a~z',
  md5of('abcdefghijklmnopqrstuvwxyz') === 'c3fcd3d76192e4007dfb496cca67e13b',
  md5of('abcdefghijklmnopqrstuvwxyz')
);
check(
  '字母数字混合',
  md5of('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') === 'd174ab98d277d9f5a5611c2c9f419d9f',
  md5of('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
);
check(
  '80 位数字',
  md5of('12345678901234567890123456789012345678901234567890123456789012345678901234567890') ===
    '57edf4a22be3c955ac49da2e2107b67a',
  md5of('12345678901234567890123456789012345678901234567890123456789012345678901234567890')
);

console.log('\n[2] MD5 边界：跨 64 字节块 / 二进制 / 长度编码');
check(
  '55 字节（不触发补块）与 56 字节（触发补块）都稳定',
  md5of('x'.repeat(55)) === md5of('x'.repeat(55)) && md5of('x'.repeat(56)) !== md5of('x'.repeat(55)),
  null
);
const big = new Uint8Array(100000);
for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
check('100KB 二进制输入能算完且结果稳定', H.md5(big) === H.md5(big) && H.md5(big).length === 32, H.md5(big));
check('ArrayBuffer 输入与 Uint8Array 一致', H.md5(big.buffer.slice(0, 1000)) === H.md5(big.slice(0, 1000)), null);
check('一个字节不同 → 哈希完全不同', H.md5(new Uint8Array([1, 2, 3])) !== H.md5(new Uint8Array([1, 2, 4])), null);
check('输出永远是 32 位小写十六进制', /^[0-9a-f]{32}$/.test(H.md5(big)), H.md5(big));

console.log('\n[3] 只导出了 MD5（画面指纹已移除，避免误用）');
check('导出面收窄到 md5', JSON.stringify(Object.keys(H)) === JSON.stringify(['md5']), Object.keys(H));
check('没有 fingerprint / looksSame / distance 这些旧接口',
  H.fingerprint === undefined && H.looksSame === undefined && H.distance === undefined,
  Object.keys(H));

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
