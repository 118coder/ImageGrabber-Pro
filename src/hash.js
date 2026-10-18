/* =============================================================================
 * 图集捕手 — 内容指纹
 *
 * md5(bytes)：字节完全一致的铁证。同一张图换了文件名、换了目录、换了 CDN 域名
 * 上传多份时，这是唯一能认出来的信号。
 *
 * 只做 MD5。曾经加过"画面指纹"（9×8 灰度差分），在真实站点上被证伪：
 * 卡牌类页面所有卡共用一个卡框，只有中间插画不同，粗采样后几乎无法区分，
 * 会把几十张不同的卡判成同一张。宁可少合并，也不能把不同的图并掉。
 * ============================================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IGPHash = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ MD5
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const K = (() => {
    const k = new Int32Array(64);
    for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    return k;
  })();

  const HEX = '0123456789abcdef';
  function hex32LE(v, out) {
    for (let i = 0; i < 4; i++) {
      const b = (v >>> (i * 8)) & 0xff;
      out.push(HEX[b >> 4], HEX[b & 15]);
    }
  }

  /** MD5（RFC 1321）。输入 Uint8Array / ArrayBuffer，输出 32 位小写十六进制 */
  function md5(input) {
    const bytes =
      input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input || 0);
    const len = bytes.length;
    const total = (len + 8 + 64) & ~63; // 留出 0x80 与 8 字节长度，凑成 64 的整数倍
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    // 长度以 bit 计，小端 64 位；hi 用除法避免 (len << 3) 溢出
    dv.setUint32(total - 8, (len << 3) >>> 0, true);
    dv.setUint32(total - 4, Math.floor(len / 536870912), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const M = new Int32Array(16);

    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) & 15;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) & 15;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) & 15;
        }
        F = (F + A + K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    const out = [];
    hex32LE(a0, out);
    hex32LE(b0, out);
    hex32LE(c0, out);
    hex32LE(d0, out);
    return out.join('');
  }

  return { md5 };
});
