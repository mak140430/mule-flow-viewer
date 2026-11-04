// The built extension in a real Chrome, in a throwaway profile (your own Chrome and settings are not touched):
// loads it, registers the helper for that profile only, presses "open" for a page, and checks the viewer it opens.
//   node tools/e2e_chrome.mjs <chrome binary> <folder with clones> <page url> [screenshot.png]

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [chromeBin, roots, page, shot] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
const ext = join(root, 'dist', 'mule-flow-viewer', 'extension');
const helper = join(root, 'dist', 'mule-flow-viewer', 'helper', 'mfv_helper.py');
const profile = mkdtempSync(join(tmpdir(), 'mfv-chrome-'));
const home = mkdtempSync(join(tmpdir(), 'mfv-home-'));

// the helper registered for this profile only, with its state in a throwaway home
const launcher = join(home, 'mfv_helper.sh');
writeFileSync(launcher, `#!/bin/sh\nMFV_NO_FETCH=1 HOME="${home}" exec "${process.env.PYTHON || 'python3'}" -u "${helper}" "$@"\n`);
chmodSync(launcher, 0o755);
mkdirSync(join(profile, 'NativeMessagingHosts'));
writeFileSync(join(profile, 'NativeMessagingHosts', 'mule_flow_viewer.helper.json'), JSON.stringify({
  name: 'mule_flow_viewer.helper', description: 'test', path: launcher, type: 'stdio',
  allowed_origins: ['chrome-extension://gikmgdbiaplaeechloibkkgajcbbikom/'],
}));

const chrome = spawn(chromeBin, [`--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let buf = '';
let seq = 0;
const waiting = new Map();
const events = [];
chrome.stdio[4].on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else events.push(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function attach(match, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const { targetInfos } = await send('Target.getTargets');
    const t = targetInfos.find(match);
    if (t) return (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await sleep(300);
  }
  throw new Error('target not found');
}

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok ' : 'BAD'} ${name}${detail ? `  (${detail})` : ''}`); };

try {
  const { id } = await send('Extensions.loadUnpacked', { path: ext });
  check('extension loads, with its fixed id', id === 'gikmgdbiaplaeechloibkkgajcbbikom', id);
  const worker = await attach((t) => t.type === 'service_worker' && t.url.includes(id));
  await send('Runtime.runIfWaitingForDebugger', {}, worker).catch(() => {});
  for (let i = 0; i < 50 && !(await evaluate(worker, 'typeof mfvOpen').catch(() => '')).startsWith('function'); i++) await sleep(200);
  // the welcome guide: opens over the setup page and ticks the helper off
  {
    const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${id}/setup.html#welcome` });
    const g = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    let ticks = null;
    for (let i = 0; i < 40 && !ticks; i++) {
      ticks = await evaluate(g, `document.querySelector('.check[data-for="helper"].ok') && [...document.querySelectorAll('.guide .check')].map((c) => c.textContent).join(' | ')`).catch(() => null);
      await sleep(300);
    }
    const shown = await evaluate(g, `[...document.querySelectorAll('.guide .os-cmd')].filter((e) => !e.hidden).map((e) => e.innerText.replace(/Copy$/, '').trim()).join(' | ')`);
    check('the welcome guide ticks off the helper and shows this OS\'s commands', ticks && shown, `${ticks} · ${shown}`);
    if (shot) {
      const { data } = await send('Page.captureScreenshot', {}, g);
      writeFileSync(shot.replace(/\.png$/, '-guide.png'), Buffer.from(data, 'base64'));
    }
    await send('Target.closeTarget', { targetId });
  }
  // as a user would on the setup page: where the clones are
  await evaluate(worker, `chrome.storage.sync.set({ roots: [${JSON.stringify(roots)}] })`);
  await evaluate(worker, `mfvOpen(${JSON.stringify({ url: page, title: '', selection: '' })})`);
  const reply = await evaluate(worker, `chrome.storage.session.get(null).then((s) => JSON.stringify(Object.values(s).at(-1)?.reply))`);
  check('the helper answers the extension', JSON.parse(reply || '{}').ok, reply?.slice(0, 160));
  const view = await attach((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${id}/viewer/`));
  await send('Runtime.enable', {}, view);
  await send('Log.enable', {}, view).catch(() => {});
  const wait = async (expr, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await evaluate(view, expr).catch(() => null); if (v) return v; await sleep(300); }
    return null;
  };
  const flows = await wait(`document.querySelectorAll('#main .flow').length`);
  // on failure, what the page said: its console and network errors
  const said = () => events.filter((e) => e.sessionId === view && (e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded' || e.method === 'Runtime.exceptionThrown'))
    .map((e) => e.params.entry ? `${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url || ''}` : e.params.exceptionDetails ? e.params.exceptionDetails.exception?.description?.split('\n')[0] : `${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description).join(' ')}`)
    .slice(-4).join(' | ');
  // and which requests it finished (one still waiting is not listed)
  const done = () => evaluate(view, `[document.readyState, location.pathname, typeof window.fetch.guarded].join(' ') + ' | ' + performance.getEntries().map((e) => e.name.replace(/^chrome-extension:\\/\\/[^/]+/, '').replace(/[?#].*/, '') + ' ' + Math.round(e.duration) + 'ms').join(', ')`).catch((e) => String(e));
  check('the viewer opens the project through the helper', flows, flows ? `${flows} flows` : `${await evaluate(view, `document.getElementById('main').innerText.slice(0, 120)`)} · ${said()} · finished: ${await done()}`);
  if (process.env.E2E_HELPER_ONLY) { chrome.kill(); process.exit(flows ? 0 : 1); }
  check('no token in the tab URL', !(await evaluate(view, 'location.href')).includes('token'));
  const hit = await wait(`[...document.querySelectorAll('#main .xml-hit')].map((e) => e.textContent.trim().slice(0, 40))[0]`);
  check("the page's file and lines are shown", hit, hit);
  // the same features as in the dev viewer, through the token-protected server
  await evaluate(view, `location.hash = 'grid=' + encodeURIComponent(${JSON.stringify('')})`);
  await evaluate(view, `document.getElementById('grid-toggle').click()`);
  const grid = await wait(`document.querySelector('.grid') && document.querySelectorAll('.grid thead .branch-button').length`);
  check('Branches grid', grid, `${grid - 1} columns`);
  await evaluate(view, `location.hash = 'search=' + encodeURIComponent('flow-ref')`);
  const search = await wait(`document.querySelector('.search-head')?.innerText`);
  check('search every branch', search && !/failed/i.test(search), search?.replace(/\n/g, ' '));
  await evaluate(view, `history.back(); history.back(); document.getElementById('history').click()`);
  const diffShown = await wait(`document.body.classList.contains('diff-mode') && document.getElementById('commit').selectedOptions[0]?.text`);
  check('History opens a diff', diffShown, diffShown);
  await evaluate(view, `document.getElementById('notes').click()`);
  const notes = await wait(`document.querySelector('.notes-body')?.textContent.split('\\n').length`);
  check('release notes', notes, `${notes} lines`);
  await evaluate(view, `document.querySelector('.diff-modal-backdrop')?.remove(); document.getElementById('history').click()`);
  await evaluate(view, `document.getElementById('colour').value = 'age'; document.getElementById('colour').dispatchEvent(new Event('change'))`);
  const painted = await wait(`document.querySelectorAll('#main .blame').length`);
  check('colour by age', painted, `${painted} elements`);
  await evaluate(view, `document.getElementById('colour').value = ''; document.getElementById('colour').dispatchEvent(new Event('change'))`);
  const engine = await evaluate(view, `(async () => { const s = (await chrome.storage.session.get(sessionStorage.getItem('mfv.session'))); const v = Object.values(s)[0]; const r = await fetch(v.server.base + '/api/dw', { headers: { 'X-MFV-Token': v.server.token } }); return r.status + ' ' + JSON.stringify(await r.json()); })()`);
  check('DataWeave status through the token', engine.startsWith('200'), engine);
  // fonts come from Google Fonts and fall back to system ones: a failed font download is not the viewer's error
  const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(e.params.entry.url || '')));
  check('no uncaught errors in the viewer', errors.length === 0,
    errors.map((e) => e.params.exceptionDetails?.exception?.description?.split('\n')[0] || `${e.params.entry?.text} ${e.params.entry?.url || ''}`).slice(0, 3).join(' | ') || '0');
  if (shot) {
    const { data } = await send('Page.captureScreenshot', {}, view);
    writeFileSync(shot, Buffer.from(data, 'base64'));
  }
  // a pull request page: its "source into target" opens as a merge preview of the source into the target
  if (process.env.PR_TEXT) {
    const before = new Set((await send('Target.getTargets')).targetInfos.map((t) => t.targetId));
    await evaluate(worker, `mfvOpen(${JSON.stringify({ url: page.replace(/\?.*/, '/pullrequest/1'), title: 'Pull request', selection: '', text: process.env.PR_TEXT })})`);
    const pr = await attach((t) => t.type === 'page' && t.url.includes('/viewer/') && !before.has(t.targetId), 20000);
    let hash = '';
    for (let i = 0; i < 60 && !/into=/.test(hash); i++) { hash = await evaluate(pr, 'decodeURIComponent(location.hash)').catch(() => ''); await sleep(300); }
    check('a pull request opens as its merge preview', /into=/.test(hash), hash.replace(/[0-9a-f]{40}/g, (x) => x.slice(0, 7)));
  }
  // Azure DevOps, read by the viewer itself (no helper, no clone): AZURE_API is a stand-in for the site
  // (tools/mock_azure.py), AZURE_PAGE a pull request page there
  if (process.env.AZURE_API && process.env.AZURE_PAGE) {
    const before = new Set((await send('Target.getTargets')).targetInfos.map((t) => t.targetId));
    await evaluate(worker, `chrome.storage.session.clear()`);
    await evaluate(worker, `mfvOpen(${JSON.stringify({ url: process.env.AZURE_PAGE, title: '', selection: '', text: '', apiOrigin: process.env.AZURE_API })})`);
    check('an Azure DevOps page does not ask the helper', !(await evaluate(worker, `chrome.storage.session.get(null).then((s) => !!Object.values(s).at(-1)?.reply)`)));
    const az = await attach((t) => t.type === 'page' && t.url.includes('/viewer/') && !before.has(t.targetId), 20000);
    await send('Runtime.enable', {}, az);
    const waitAz = async (expr, ms = 60000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = await evaluate(az, expr).catch(() => null); if (v) return v; await sleep(300); }
      return null;
    };
    const azFlows = await waitAz(`document.querySelectorAll('#main .flow').length || (/Sign in|no Mule/.test(document.getElementById('main').innerText) && document.getElementById('main').innerText)`);
    check('the viewer reads the repository from the code host', typeof azFlows === 'number', `${azFlows} flows`);
    const where = await waitAz(`document.querySelector('#where:not([hidden]) .where-name')?.textContent`);
    check("it opens on the pull request's source branch", where === process.env.AZURE_SOURCE, where);
    let hash = '';
    for (let i = 0; i < 80 && !/into=/.test(hash); i++) { hash = await evaluate(az, 'decodeURIComponent(location.hash)').catch(() => ''); await sleep(300); }
    check('the pull request opens as its merge preview', /into=/.test(hash), hash.replace(/[0-9a-f]{40}/g, (x) => x.slice(0, 7)));
    const t0 = Date.now();
    const drawn = await waitAz(`document.body.classList.contains('diff-mode') && !/Loading/.test(document.getElementById('main').innerText) && (document.querySelectorAll('#main .flow').length || document.querySelector('#main .empty-state')?.textContent)`);
    check('the merge preview draws', drawn, `${typeof drawn === 'number' ? `${drawn} flows` : drawn} in ${Date.now() - t0} ms`);
    // what the pull request affects
    await evaluate(az, `document.getElementById('impact-toggle').click()`);
    const impactShown = await waitAz(`document.querySelector('.impact-view .search-head')?.innerText`);
    check('Impact lists the entry points the pull request reaches', impactShown, impactShown?.replace(/\n/g, ' '));
    if (shot) writeFileSync(shot.replace(/\.png$/, '-impact.png'), Buffer.from((await send('Page.captureScreenshot', {}, az)).data, 'base64'));
    // the toolbar's views during the comparison: they open (for its newer side) and the canvas comes back as it was
    await evaluate(az, `document.getElementById('impact-toggle').click()`);
    await waitAz(`document.querySelector('#main section.diff-file')`);
    await evaluate(az, `window.mfvCanvas = document.querySelector('#main section.diff-file'); document.getElementById('overview-toggle').click()`);
    const ovInDiff = await waitAz(`document.body.classList.contains('diff-mode') && !!document.querySelector('.overview')`);
    await evaluate(az, `document.getElementById('overview-toggle').click()`);
    const sameCanvas = await waitAz(`document.querySelector('#main section.diff-file') === window.mfvCanvas`);
    check('Overview opens during a comparison, and the canvas comes back as it was', ovInDiff && sameCanvas);
    check('the XML button is there during a comparison', await evaluate(az, `!document.getElementById('xml-toggle').hidden`));
    // checks, trace and used by, on the page's branch
    await evaluate(az, `location.hash = 'checks=1'`);
    const checksShown = await waitAz(`document.querySelector('.checks-view .search-head')?.innerText`);
    check('Checks lists what is worth a look', checksShown, checksShown?.replace(/\n/g, ' '));
    if (shot) writeFileSync(shot.replace(/\.png$/, '-checks.png'), Buffer.from((await send('Page.captureScreenshot', {}, az)).data, 'base64'));
    await evaluate(az, `location.hash = 'trace=' + encodeURIComponent(${JSON.stringify(process.env.AZURE_TRACE || '')})`);
    const traced = await waitAz(`document.querySelector('.trace-view') && document.querySelectorAll('.trace-step').length`);
    check('Trace follows the entry flow into the flows it calls', traced > 5, `${traced} steps`);
    if (shot) writeFileSync(shot.replace(/\.png$/, '-trace.png'), Buffer.from((await send('Page.captureScreenshot', {}, az)).data, 'base64'));
    if (process.env.AZURE_LIB_FLOW) {
      await evaluate(az, `location.hash = 'lib=' + encodeURIComponent(${JSON.stringify(process.env.AZURE_LIB_FLOW)})`);
      const used = await waitAz(`(() => { const t = [...document.querySelectorAll('#panel .details-section h3')].find((e) => e.textContent === 'Used by')?.nextElementSibling?.innerText || ''; return /Looking/.test(t) ? '' : t; })()`);
      check("Used by finds the apps that call a library's flow", used && !/Could not/.test(used), used?.replace(/\n/g, ' ').slice(0, 160));
      if (shot) writeFileSync(shot.replace(/\.png$/, '-usedby.png'), Buffer.from((await send('Page.captureScreenshot', {}, az)).data, 'base64'));
    }
    // the overview: entry points and their errors, properties per environment, library versions across the apps
    const capture = async (name) => { if (shot) writeFileSync(shot.replace(/\.png$/, `-${name}.png`), Buffer.from((await send('Page.captureScreenshot', {}, az)).data, 'base64')); };
    await evaluate(az, `location.hash = 'app=endpoints'`);
    const eps = await waitAz(`document.querySelectorAll('details.endpoint').length`);
    await evaluate(az, `(() => { const d = document.querySelector('details.endpoint.kind-api') || document.querySelector('details.endpoint'); if (d) d.open = true; })()`);
    const errs = await waitAz(`document.querySelectorAll('.errors-table tbody tr').length`);
    check('Overview lists the entry points and the errors each answers with', eps && errs, `${eps} entry points, ${errs} error rows on the first resource`);
    await capture('overview');
    await evaluate(az, `location.hash = 'app=calls'`);
    const calls = await waitAz(`document.querySelectorAll('.overview .search-file').length`);
    check('Calls lists the configurations it reaches other systems through', calls, `${calls}`);
    await evaluate(az, `location.hash = 'app=properties'`);
    const keys = await waitAz(`document.querySelectorAll('.env-matrix tbody tr').length && document.querySelector('.overview .search-head').innerText`);
    check('Properties shows each key per environment', keys, keys?.replace(/\n/g, ' '));
    await capture('properties');
    await evaluate(az, `location.hash = 'app=libraries'`);
    const libs = await waitAz(`document.querySelectorAll('.lib-app').length && [...document.querySelectorAll('.overview .search-file-head')].map((e) => e.innerText).join(' | ')`, 120000);
    check("Libraries shows the versions the owner's apps use", libs, libs?.slice(0, 200));
    await capture('libraries');
    // a flow as an image
    await evaluate(az, `location.hash = ''`);
    await waitAz(`document.querySelector('#main section.flow')`);
    const png = await evaluate(az, `(async () => { const m = await import('/src/core/export-image.js'); const b = await m.elementPng(document.querySelector('#main section.flow')); const bytes = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); })()`).catch((e) => String(e));
    check('a flow exports as a PNG', png?.length > 2000, png?.length > 2000 ? `${Math.round(png.length * 0.75 / 1024)} KB` : png);
    if (shot && png?.length > 2000) writeFileSync(shot.replace(/\.png$/, '-flow-image.png'), Buffer.from(png, 'base64'));
    const dw = await evaluate(az, `chrome.runtime.sendNativeMessage('mule_flow_viewer.helper', { type: 'dw' }).then((r) => r.ok)`).catch(() => false);
    check('DataWeave still runs through the helper, when there is one', dw);
    const errors = events.filter((e) => e.sessionId === az && e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    check('no uncaught errors in the Azure DevOps viewer', !errors.length, errors.join(' | ').slice(0, 300) || '0');
    if (shot) {
      const { data } = await send('Page.captureScreenshot', {}, az);
      writeFileSync(shot.replace(/\.png$/, '-azure.png'), Buffer.from(data, 'base64'));
    }
  }
  // GitHub without a token, on a repository it does not show: the viewer asks for a token once
  {
    const before = new Set((await send('Target.getTargets')).targetInfos.map((t) => t.targetId));
    await evaluate(worker, `mfvOpen({ url: 'https://github.com/mfv-test-nobody-xyz/none-here', title: '', selection: '', text: '' })`);
    const gh = await attach((t) => t.type === 'page' && t.url.includes('/viewer/') && !before.has(t.targetId), 20000);
    let form = null;
    for (let i = 0; i < 60 && !form; i++) { form = await evaluate(gh, `document.querySelector('.token-form') && document.querySelector('.token-ask p').textContent`).catch(() => null); await sleep(300); }
    check('GitHub asks for a read-only token where it needs one', form, form);
  }
  // a page whose repository is not cloned and git cannot reach: the setup page explains
  await evaluate(worker, `mfvOpen({ url: 'https://git.example.com/nobody/not-cloned-here', title: '', selection: '', text: '' })`);
  const setup = await attach((t) => t.type === 'page' && t.url.includes('/setup.html#s='), 30000);
  const wait2 = async (expr) => { for (let i = 0; i < 60; i++) { const v = await evaluate(setup, expr).catch(() => null); if (v) return v; await sleep(300); } return null; };
  check('a repository git cannot reach opens the setup page, which says so', await wait2(`/could not reach/.test(document.getElementById('problem')?.innerText || '')`));
  check('the setup page sees the helper', await wait2(`document.querySelector('.helper-ok')?.textContent`));
} catch (e) {
  check('run', false, e.message);
} finally {
  chrome.kill();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
