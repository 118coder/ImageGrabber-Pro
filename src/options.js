/* 图集捕手 — 设置页 */
'use strict';

const DEFAULTS = {
  minWidth: 0,
  minHeight: 0,
  includeProbable: false,
  includeTiny: false,
  deepScan: true,
  thoroughScan: false,
  scriptScan: true,
  hotlinkBypass: true,
  fetchFirst: true,
  folderTemplate: '图集捕手/{host}',
  nameTemplate: '{name}',
  concurrency: 4
};

const BOOLS = ['includeProbable', 'includeTiny', 'deepScan', 'thoroughScan', 'scriptScan', 'hotlinkBypass', 'fetchFirst'];
const NUMS = ['minWidth', 'minHeight', 'concurrency'];
const TEXTS = ['folderTemplate', 'nameTemplate'];

function $(id) {
  return document.getElementById(id);
}

function fill(s) {
  BOOLS.forEach((k) => ($(k).checked = !!s[k]));
  NUMS.forEach((k) => ($(k).value = String(s[k] == null ? DEFAULTS[k] : s[k])));
  TEXTS.forEach((k) => ($(k).value = s[k] || DEFAULTS[k]));
}

function read() {
  const out = {};
  BOOLS.forEach((k) => (out[k] = $(k).checked));
  NUMS.forEach((k) => {
    let v = Number($(k).value);
    if (!isFinite(v) || v < 0) v = DEFAULTS[k];
    if (k === 'concurrency') v = Math.max(1, Math.min(12, Math.round(v)));
    out[k] = Math.round(v);
  });
  TEXTS.forEach((k) => (out[k] = $(k).value.trim() || DEFAULTS[k]));
  return out;
}

function flash() {
  const el = $('saved');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1600);
}

(async function init() {
  const got = await chrome.storage.local.get('settings');
  fill(Object.assign({}, DEFAULTS, got.settings || {}));

  $('save').addEventListener('click', async () => {
    const settings = read();
    await chrome.storage.local.set({ settings });
    fill(settings);
    flash();
  });

  $('reset').addEventListener('click', async () => {
    await chrome.storage.local.set({ settings: Object.assign({}, DEFAULTS) });
    fill(DEFAULTS);
    flash();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      $('save').click();
    }
  });
})();
