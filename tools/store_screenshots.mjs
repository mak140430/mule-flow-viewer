// Chrome Web Store screenshots (1280×800), taken in the real extension on the made-up demo project (tools/demo/make_demo_repo.py), in a throwaway Chrome profile.
//   node tools/store_screenshots.mjs <chrome binary> <demo repo folder> <out folder>

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [chromeBin, repo, out] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
const ext = join(root, 'dist', 'mule-flow-viewer', 'extension');
const helper = join(root, 'dist', 'mule-flow-viewer', 'helper', 'mfv_helper.py');
const profile = mkdtempSync(join(tmpdir(), 'mfv-shots-'));
const home = mkdtempSync(join(tmpdir(), 'mfv-home-'));
mkdirSync(out, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const tip = (b) => git('rev-parse', b);

const launcher = join(home, 'mfv_helper.sh');
writeFileSync(launcher, `#!/bin/sh\nMFV_NO_FETCH=1 HOME="${home}" exec python3 -u "${helper}" "$@"\n`);
chmodSync(launcher, 0o755);
mkdirSync(join(profile, 'NativeMessagingHosts'));
writeFileSync(join(profile, 'NativeMessagingHosts', 'mule_flow_viewer.helper.json'), JSON.stringify({
  name: 'mule_flow_viewer.helper', description: 'shots', path: launcher, type: 'stdio',
  allowed_origins: ['chrome-extension://gikmgdbiaplaeechloibkkgajcbbikom/'],
}));

const chrome = spawn(chromeBin, [`--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,1000', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let buf = '';
let seq = 0;
const waiting = new Map();
chrome.stdio[4].on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (s, expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (s, expr, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { if (await evaluate(s, expr).catch(() => null)) return true; }
  const state = await evaluate(s, `location.hash + ' | ' + (document.querySelector('#main')?.innerText || '').slice(0, 300)`).catch((e) => e.message);
  throw new Error(`timed out: ${expr}\n  at ${state}`);
};
async function attach(match) {
  for (let i = 0; i < 80; i++) {
    const t = (await send('Target.getTargets')).targetInfos.find(match);
    if (t) return (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await sleep(250);
  }
  throw new Error('no target');
}
async function shot(s, name, width = 1280, height = 800) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, s);
  await sleep(900);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, s);
  writeFileSync(join(out, name), Buffer.from(data, 'base64'));
  console.log(`saved ${name}`);
}

try {
  const { id } = await send('Extensions.loadUnpacked', { path: ext });
  const worker = await attach((t) => t.type === 'service_worker' && t.url.includes(id));
  for (let i = 0; i < 50 && !(await evaluate(worker, 'typeof mfvOpen').catch(() => '')).startsWith('function'); i++) await sleep(200);
  await evaluate(worker, `chrome.storage.sync.set({ roots: [${JSON.stringify(dirname(repo))}] })`);
  await evaluate(worker, `chrome.storage.local.set({ guideSeen: 1 })`);
  await evaluate(worker, `mfvOpen({ url: 'https://git.acme.example/acme/orders-api/src/branch/main/src/main/mule/orders.xml', title: '', selection: '', text: '' })`);
  const v = await attach((t) => t.type === 'page' && t.url.includes(`${id}/viewer/`));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, v);
  await until(v, `document.querySelectorAll('#main .flow').length`);
  const go = async (theme, hash, ready) => {
    await evaluate(v, `localStorage.setItem('mfv.theme', ${JSON.stringify(theme)}); localStorage.setItem('mfv.xml', '0'); document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.getElementById('theme').textContent = ${JSON.stringify(theme === 'dark' ? '☾' : '☀')}; location.hash = ${JSON.stringify(hash)}; 1`);
    await until(v, ready);
  };
  const enc = encodeURIComponent;
  const main = tip('main');
  const feature = tip('feature/order-discounts');
  const base = git('merge-base', 'main', 'feature/order-discounts');

  // 1. the canvas, with the XML of the selected lines under it (the element they define pulses)
  await evaluate(v, `localStorage.setItem('mfv.xml', '1'); localStorage.setItem('mfv.xmlHeight', '300'); 1`);
  await go('light', `file=${enc('src/main/mule/customers.xml')}`, `document.querySelector('[data-flow="customers-sync"]')`);
  await go('light', `file=${enc('src/main/mule/orders.xml')}&L=30-32`, `document.querySelector('#main .xml-hit') && document.querySelector('#xml .xl.hl')`);
  await evaluate(v, `document.getElementById('xml').style.height = '300px'; document.querySelectorAll('.flow-scroll').forEach((e) => { e.scrollLeft = 0; }); const m = document.getElementById('main'); const f = document.querySelector('[data-flow="orders:create-order"]'); m.scrollTop += f.getBoundingClientRect().top - m.getBoundingClientRect().top - 16; 1`);
  await shot(v, '1-flows.png');
  await evaluate(v, `localStorage.setItem('mfv.xml', '0'); 1`);
  // 2. a merge preview: the feature branch into main, with the element both changed
  await go('dark', `file=${enc('src/main/mule/orders.xml')}&flow=orders:create-order&sel=o-7&rev=${feature}&base=${base}&vs=${main}&ref=feature%2Forder-discounts&into=main`,
    `document.body.classList.contains('diff-mode') && document.querySelector('#panel .diff-status')`);
  // the choice and the changed transform in view
  await sleep(1500);   // the viewer's own scroll to the selected element finishes first
  await evaluate(v, `document.getElementById('panel').style.width = '420px'; document.querySelectorAll('.flow-scroll').forEach((e) => { const r = e.querySelector('.router'); e.scrollLeft = r ? r.offsetLeft - 24 : 0; }); document.getElementById('main').scrollTop = 0; 1`);
  await shot(v, '2-merge-preview.png');
  await evaluate(v, `document.getElementById('panel').style.width = ''; 1`);
  // 3. branches side by side
  await go('light', `grid=${enc('main,qa,feature/order-discounts')}`, `document.querySelector('.grid tbody tr:not(.grid-group)')`);
  await shot(v, '3-branches.png');
  // 4. DataWeave with MUnit test inputs, full window
  await go('light', `file=${enc('src/main/mule/orders.xml')}&flow=orders:create-order&sel=o-7`, `document.querySelector('#panel details.runner')`);
  await evaluate(v, `(async () => {
    document.body.classList.add('panel-wide');
    const run = document.querySelector('#panel details.runner'); run.open = true; run.dispatchEvent(new Event('toggle'));
    await new Promise((r) => setTimeout(r, 400));
    const pick = run.querySelector('.run-source'); pick.value = '0'; pick.dispatchEvent(new Event('change'));
    for (let i = 0; i < 60 && !run.querySelector('.run-tabs button:nth-child(2)'); i++) await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => setTimeout(r, 1500));
    run.querySelectorAll('.run-tabs button')[1].click();
    run.querySelector('.run-button').click();
    return 1; })()`);
  await until(v, `document.querySelector('#panel .run-output pre')`);
  await shot(v, '4-dataweave.png');
  await evaluate(v, `document.body.classList.remove('panel-wide'); 1`);
  // 5. the playground
  await evaluate(v, `localStorage.setItem('mfv.playgrounds', JSON.stringify({ active: 'p1', items: [{ id: 'p1', name: 'Order totals by customer',
    script: '%dw 2.0\\noutput application/json\\n---\\npayload groupBy $.customer\\n  mapObject (orders, customer) -> {\\n    (customer): {\\n      orders: sizeOf(orders),\\n      total: sum(orders.amount) * (1 - vars.discount)\\n    }\\n  }',
    inputs: [{ name: 'payload', mime: 'application/csv', text: 'customer,order,amount\\nC-77,SO-1001,159\\nC-77,SO-1004,42.5\\nC-12,SO-1002,310\\nC-31,SO-1003,88' },
      { name: 'vars.discount', mime: 'application/json', text: '0.1' }] }] })); 1`);
  await go('dark', `play=1`, `document.querySelector('.play-output-body pre')`);
  await shot(v, '5-playground.png');
  // 6. what the feature branch reaches
  await go('light', `file=${enc('src/main/mule/orders.xml')}&rev=${feature}&base=${base}&vs=${main}&ref=feature%2Forder-discounts&into=main&impact=1`,
    `document.querySelector('.impact-row')`);
  await shot(v, '6-impact.png');
  // 7. entry points, the first opened to its errors
  await go('light', `file=${enc('src/main/mule/orders.xml')}&app=endpoints`, `document.querySelector('details.endpoint')`);
  await evaluate(v, `(() => { const d = document.querySelector('details.endpoint'); d.open = true; d.dispatchEvent(new Event('toggle')); return 1; })()`);
  await until(v, `document.querySelector('.endpoint-errors > *')`);
  await shot(v, '7-entry-points.png');
  // 8. properties per environment
  await go('dark', `file=${enc('src/main/mule/orders.xml')}&app=properties`, `document.querySelector('.env-matrix tbody tr')`);
  await shot(v, '8-properties.png');
  // 9. checks
  await go('light', `file=${enc('src/main/mule/orders.xml')}&checks=1`, `document.querySelector('.checks-view .check-row')`);
  await shot(v, '9-checks.png');

} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
