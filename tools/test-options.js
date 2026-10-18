/* =============================================================================
 * 设置页冒烟测试（真机）
 *   · 表单能渲染出全部字段
 *   · 保存后真的写进 chrome.storage
 *   · 重新打开页面能读回来
 * 用法： node tools/test-options.js
 * ============================================================================= */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEBUG_PORT = 9407;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.p = new Map();
    this.exc = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const q = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? q.j(new Error(m.error.message)) : q.r(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.exc.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((r, j) => {
      this.p.set(id, { r, j });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr, ms = 20000) {
    const res = await Promise.race([
      this.send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }),
      new Promise((r) => setTimeout(() => r({ __t: true }), ms))
    ]);
    if (res.__t) return { __timeout: ms };
    if (res.exceptionDetails) return { __err: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
    return res.result.value;
  }
}
async function conn(url, browser) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const c = new CDP(ws);
  // 浏览器级连接没有 Runtime 域，只有普通页面才有
  if (!browser) {
    await c.send('Runtime.enable');
    await c.send('Page.enable').catch(() => {});
  }
  return c;
}
const list = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
async function waitFor(fn, ms, label) {
  const t = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {
      /* 继续等 */
    }
    if (Date.now() - t > ms) throw new Error('超时：' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}

(async () => {
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'igp-options-' + Date.now());
  const logF = fs.openSync(path.join(os.tmpdir(), 'igp-options.log'), 'w');
  const proc = spawn(
    exe,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--load-extension=${ROOT}`,
      `--disable-extensions-except=${ROOT}`,
      '--remote-debugging-port=' + DEBUG_PORT,
      '--window-size=1000,900',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', logF] }
  );

  try {
    const sw = await waitFor(async () => (await list()).find((t) => t.type === 'service_worker' && /\/src\/background\.js$/.test(t.url)), 45000, 'service worker');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];

    const b = await conn((await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl, true);
    const created = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options.html`, background: false });
    await b.send('Target.activateTarget', { targetId: created.targetId });
    const ot = await waitFor(async () => (await list()).find((t) => t.id === created.targetId), 20000, 'options page');
    const opt = await conn(ot.webSocketDebuggerUrl);
    await sleep(1200);

    console.log('\n[1] 表单渲染');
    const form = await opt.ev(`
      const ids = ['includeProbable','includeTiny','deepScan','thoroughScan','scriptScan','hotlinkBypass','fetchFirst',
                   'minWidth','minHeight','concurrency','folderTemplate','nameTemplate'];
      return {
        missing: ids.filter(id => !document.getElementById(id)),
        saveBtn: !!document.getElementById('save'),
        // 画面指纹/分辨率/判定等级这些"高级查重"选项已经移除，界面不该再出现
        legacy: ['mergeLevel'].filter(id => document.getElementById(id))
      };`, 15000);
    console.log('表单：', JSON.stringify(form));
    check('所有设置字段都在', form.missing.length === 0, form.missing);
    check('有保存按钮', form.saveBtn === true, form);
    check('已移除的判定等级控件不再出现', form.legacy.length === 0, form.legacy);

    console.log('\n[2] 保存后落进 storage');
    const saved = await opt.ev(`
      document.getElementById('concurrency').value = '7';
      document.getElementById('nameTemplate').value = '{index}_{name}';
      document.getElementById('deepScan').checked = false;
      document.getElementById('save').click();
      await new Promise(r => setTimeout(r, 600));
      const got = await new Promise(r => chrome.storage.local.get('settings', r));
      return { settings: got.settings || {}, savedShown: document.getElementById('saved').classList.contains('show') };
    `, 15000);
    console.log('保存结果：', JSON.stringify(saved));
    check('数字字段保存成功', saved.settings && saved.settings.concurrency === 7, saved.settings);
    check('文本字段保存成功', saved.settings && saved.settings.nameTemplate === '{index}_{name}', saved.settings);
    check('开关保存成功', saved.settings && saved.settings.deepScan === false, saved.settings);
    check('不再写入已删除的 mergeLevel',
      !saved.settings || saved.settings.mergeLevel === undefined,
      saved.settings && saved.settings.mergeLevel);
    check('给出了"已保存"反馈', saved.savedShown === true, saved.savedShown);

    console.log('\n[3] 重新打开页面能读回来');
    await opt.send('Page.reload', { ignoreCache: true });
    await sleep(1500);
    const again = await opt.ev(`
      return {
        concurrency: document.getElementById('concurrency').value,
        nameTemplate: document.getElementById('nameTemplate').value,
        deepScan: document.getElementById('deepScan').checked
      };
    `, 15000);
    check('刷新后并发数仍是 7', again.concurrency === '7', again);
    check('刷新后文件名模板仍生效', again.nameTemplate === '{index}_{name}', again);
    check('刷新后开关状态仍生效', again.deepScan === false, again);

    check('没有运行时异常', opt.exc.length === 0, opt.exc.slice(0, 3));

    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  } finally {
    try {
      proc.kill();
    } catch (_) {
      /* ignore */
    }
    fs.closeSync(logF);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
