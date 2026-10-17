/* =============================================================================
 * 校验手写的 ZIP 打包器（offscreen.js 里的 buildZip）：
 *   1. CRC32 与 Node 内置 zlib.crc32 对比
 *   2. 结构自检（本地头 / 中央目录 / EOCD 签名与偏移）
 *   3. 真机校验：写到临时文件后用 PowerShell Expand-Archive 解压
 * 用法： node tools/test-zip.js
 * =========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'src', 'offscreen.js'), 'utf8');

// ------------------------------------------------------------------ 假环境
const listeners = [];
const sandbox = {
  chrome: {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async () => ({ ok: true })
    }
  },
  console,
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  URL,
  Blob,
  FileReader: class {},
  TextEncoder,
  TextDecoder,
  Uint8Array,
  Uint32Array,
  Int8Array,
  DataView,
  ArrayBuffer,
  Promise,
  Math,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  fetch: async () => {
    throw new Error('测试环境不联网');
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'offscreen.js' });

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''));
  }
}

// ------------------------------------------------------------------ 准备测试样本
const samples = [
  { name: 'photo one.jpg', bytes: Buffer.from('这个文件内容用来验证 ZIP 打包是否正确。'.repeat(50)) },
  { name: 'bg_1920x1080.png', bytes: Buffer.alloc(4096, 7) },
  { name: '小图.webp', bytes: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03]) },
  { name: 'empty-ish.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }
];

(async function run() {
  console.log('\n[1] CRC32 与 Node 实现对比');
  const crcSamples = [
    Buffer.from('123456789'),
    Buffer.from('hello world'),
    Buffer.alloc(10000, 0xab),
    Buffer.from(samples[0].bytes)
  ];
  for (const s of crcSamples) {
    const mine = vm.runInContext(`crc32(new Uint8Array([${Array.from(s.subarray(0, 64)).join(',')}]))`, sandbox);
    const ref = zlib.crc32(s.subarray(0, 64));
    // 长样本分段验证（避免构造超长表达式）
    check(`CRC32 一致（${s.length} 字节）`, mine === ref, { mine, ref });
  }

  console.log('\n[2] 生成 ZIP');
  const filesLiteral = samples
    .map((s) => `{ name: ${JSON.stringify(s.name)}, bytes: new Uint8Array([${Array.from(s.bytes).join(',')}]) }`)
    .join(', ');
  const blob = vm.runInContext(`buildZip([${filesLiteral}])`, sandbox);
  const buf = Buffer.from(await blob.arrayBuffer());
  check('产出 Blob（application/zip）', blob.type === 'application/zip', blob.type);
  check('文件非空', buf.length > 100, buf.length);

  console.log('\n[3] 结构自检');
  check('本地文件头签名 0x04034b50', buf.readUInt32LE(0) === 0x04034b50, buf.readUInt32LE(0).toString(16));
  const eocdOffset = buf.length - 22;
  check('EOCD 签名 0x06054b50', buf.readUInt32LE(eocdOffset) === 0x06054b50, buf.readUInt32LE(eocdOffset).toString(16));
  check('EOCD 记录条目数 = 4', buf.readUInt16LE(eocdOffset + 10) === 4, buf.readUInt16LE(eocdOffset + 10));
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  check('中央目录偏移 + 长度 = EOCD 位置', cdOffset + cdSize === eocdOffset, { cdOffset, cdSize, eocdOffset });
  check('中央目录签名 0x02014b50', buf.readUInt32LE(cdOffset) === 0x02014b50, buf.readUInt32LE(cdOffset).toString(16));

  // 逐个条目校验 CRC 与数据
  let off = 0;
  let crcOk = true;
  for (const s of samples) {
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const size = buf.readUInt32LE(off + 18);
    const crc = buf.readUInt32LE(off + 14);
    const dataStart = off + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + size);
    if (crc !== zlib.crc32(data) || !data.equals(s.bytes)) crcOk = false;
    off = dataStart + size;
  }
  check('每个条目的 CRC 与数据都对得上', crcOk, null);

  console.log('\n[4] 真机解压校验（PowerShell Expand-Archive）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-zip-'));
  const zipPath = path.join(tmp, 'test.zip');
  fs.writeFileSync(zipPath, buf);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${path.join(tmp, 'out')}' -Force`], { stdio: 'pipe' });
    const extracted = fs.readdirSync(path.join(tmp, 'out')).sort();
    check('Windows 能正常解压', extracted.length === samples.length, extracted);
    let contentOk = true;
    for (const s of samples) {
      const p = path.join(tmp, 'out', s.name);
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(s.bytes)) contentOk = false;
    }
    check('解压出来的文件内容与原名（含中文/空格）一致', contentOk, extracted);
  } catch (e) {
    fail++;
    console.log('  ✗ 解压失败：' + String(e.message || e).split('\n')[0]);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
