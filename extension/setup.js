// Setup: is the helper there, what went wrong with the last page, and where to look for clones.

import { ask, openPage, DEFAULTS } from './open.js';

// where the helper is published (set by tools/build_extension.py --helper-url for store builds); empty: it came in the zip
const HELPER_DOWNLOAD = '';

const $ = (id) => document.getElementById(id);
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

async function helperStatus() {
  const r = await ask({ type: 'ping' });
  $('install').hidden = r.ok;
  $('helper').replaceChildren();
  if (!r.ok) {
    $('helper').textContent = 'Not installed (or not reachable). Install it once:';
    return false;
  }
  const ok = document.createElement('span');
  ok.className = 'helper-ok';
  ok.textContent = `Running · version ${r.version}`;
  $('helper').append(ok, ` · Python ${r.python} · git ${r.git || 'NOT FOUND (needed)'} · DataWeave CLI ${r.dw || 'not installed (optional)'}`);
  return true;
}

async function showProblem() {
  const key = new URLSearchParams(location.hash.slice(1)).get('s');
  const data = key && (await chrome.storage.session.get(key))[key];
  const box = $('problem');
  if (!data?.reply || data.reply.ok) return;
  const r = data.reply;
  const p = (text) => Object.assign(document.createElement('p'), { textContent: text });
  const button = (text, onclick) => Object.assign(document.createElement('button'), { textContent: text, onclick });
  // in this tab: the viewer replaces the setup page
  const here = async () => ({ replace: (await chrome.tabs.getCurrent()).id });
  const retry = button('Try again', async () => openPage(data, await here()));
  box.hidden = false;
  const page = Object.assign(document.createElement('p'), { className: 'muted mono setup-url', textContent: data.link || '' });
  box.replaceChildren(Object.assign(document.createElement('h2'), { textContent: 'This page could not be opened' }), page, p(r.message || r.error));
  if (r.error === 'no-helper') return;       // the install steps below say what to do
  // a clone of your own in a folder not searched is used before the helper's copy
  if (r.error === 'no-remote' && r.roots?.length) box.append(p(`If you have a clone, add its folder below (looked in ${r.roots.join(', ')}).`));
  box.append(document.createElement('br'), retry);
}

async function settings() {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  $('tokens').hidden = !tokens['github.com'];
  $('forget-token').onclick = async () => {
    delete tokens['github.com'];
    await chrome.storage.local.set({ tokens });
    $('tokens').hidden = true;
  };
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('roots').value = s.roots.join('\n');
  $('save').onclick = async () => {
    await chrome.storage.sync.set({ roots: lines($('roots').value) });
    $('saved').textContent = 'Saved';
    setTimeout(() => { $('saved').textContent = ''; }, 1500);
  };
}

// ------------------------------------------------------------------ the welcome guide

async function guide() {
  const box = $('guide');
  box.hidden = false;
  if (HELPER_DOWNLOAD) {
    const where = box.querySelector('[data-check="helper"] p.muted');
    where.replaceChildren('Download ', Object.assign(document.createElement('a'), { href: HELPER_DOWNLOAD, target: '_blank', rel: 'noopener', textContent: 'the helper' }),
      ', unzip it, and in that folder run:');
    box.querySelectorAll('[data-check="helper"] code').forEach((c) => { c.textContent = c.textContent.replace(/helper[\/\\]install\.py/, 'install.py'); });
  }
  const { os } = await chrome.runtime.getPlatformInfo();
  const mine = os === 'mac' ? 'mac' : os === 'win' ? 'win' : 'linux';
  box.querySelectorAll('[data-os]').forEach((el) => { el.hidden = !el.dataset.os.split(' ').includes(mine); });
  // a copy button on every command
  box.querySelectorAll('pre.code').forEach((pre) => {
    if (pre.querySelector('.copy')) return;
    const copy = Object.assign(document.createElement('button'), { className: 'copy', textContent: 'Copy' });
    copy.onclick = async () => { await navigator.clipboard.writeText(pre.innerText.replace(/Copy$/, '').trim()); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400); };
    pre.append(copy);
  });
  const { roots } = await chrome.storage.sync.get(DEFAULTS);
  $('guide-roots').value = roots.join('\n');
  const mark = (name, state, text) => {
    const el = box.querySelector(`.check[data-for="${name}"]`);
    el.className = `check ${state}`;
    el.textContent = text;
    el.closest('li').classList.toggle('done', state === 'ok');
  };
  // ticks itself off while open: the helper answers once it is installed
  const poll = async () => {
    if (box.hidden) return;
    const r = await ask({ type: 'ping' });
    if (r.ok) {
      mark('helper', 'ok', `✓ version ${r.version}`);
      mark('python', r.git ? 'ok' : 'bad', r.git ? `✓ Python ${r.python} · git ${r.git}` : `Python ${r.python} · git not found`);
      mark('dw', r.dw ? 'ok' : 'off', r.dw ? `✓ ${r.dw}` : 'not installed');
      $('guide-status').textContent = r.git ? 'Helper ready.' : 'git is still missing.';
    } else {
      mark('helper', 'bad', 'not registered yet');
      mark('python', 'off', 'checked once the helper runs');
      mark('dw', 'off', '');
      $('guide-status').textContent = '';
    }
    setTimeout(poll, 2000);
  };
  poll();
  $('guide-done').onclick = async () => {
    await chrome.storage.sync.set({ roots: lines($('guide-roots').value) });
    await chrome.storage.local.set({ guideSeen: 1 });
    box.hidden = true;
    history.replaceState(null, '', location.pathname);
    helperStatus();
    settings();
  };
}

$('open-guide').onclick = guide;
$('recheck').onclick = helperStatus;
helperStatus();
showProblem();
settings();
// first install: the guide comes first
if (location.hash === '#welcome') guide();
