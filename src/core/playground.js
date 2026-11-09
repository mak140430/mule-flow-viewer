// The Playground tab: your own DataWeave with inputs on the left, the script in the middle and the output on the
// right. Inputs are payload, attributes and named variables, each typed in or taken from a file (choose or drop one);
// the project's modules can be imported and p() reads the selected environment's properties. Playgrounds are saved
// in this browser (files only by name: choose them again after a reload). Runs on the local engine (runner.js's).

import { h } from './dom.js';
import { highlightDataWeave } from './dataweave.js';
import { modulesOf } from './chain.js';
import { propertiesOf, missingModules, errorHint, formatSize, MIMES, EXT, STORE_LIMIT, HIGHLIGHT_LIMIT } from './runner.js';

const KEY = 'mfv.playgrounds';
const NAME = /^[A-Za-z_][\w-]{0,79}$/;
const STARTER = {
  name: 'Playground 1',
  script: '%dw 2.0\noutput application/json\n---\n{\n  greeting: "Hello " ++ (payload.name default "world"),\n  items: sizeOf(payload.items default [])\n}',
  inputs: [{ name: 'payload', mime: 'application/json', text: '{\n  "name": "Ada",\n  "items": [1, 2, 3]\n}' }],
};

const load = () => {
  try { const v = JSON.parse(localStorage.getItem(KEY)); if (v?.items?.length) return v; } catch { /* nothing saved, or unavailable */ }
  return { active: 'p1', items: [{ id: 'p1', ...structuredClone(STARTER) }] };
};
const save = (state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ active: state.active, items: state.items.map((p) => ({ ...p, inputs: p.inputs.map(({ name, mime, text, fileName }) => ({ name, mime, text: text?.length < STORE_LIMIT ? text : '', fileName })) })) }));
  } catch { /* storage full or unavailable */ }
};
const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * A new playground from a script and inputs (the "Open in playground" of a Run block); it becomes the active one.
 * versions: [{label, script}] of a changed script (Before, After), switched between on the same inputs; version: the one shown.
 */
export function addPlayground({ name, script, inputs, versions = null, version = 0 }) {
  const state = load();
  const id = newId();
  state.items.push({ id, name: name || `Playground ${state.items.length + 1}`, script, inputs: inputs?.length ? inputs : structuredClone(STARTER.inputs),
    ...(versions?.length > 1 ? { versions, version } : {}) });
  state.active = id;
  save(state);
}

/** ctx: {engine, project, env} */
export function renderPlaygroundView(ctx) {
  const state = load();
  let pg = state.items.find((p) => p.id === state.active) || state.items[0];
  const root = h('div.play');
  const output = h('div.play-output-body');
  const status = h('span.muted.play-status');
  const live = h('input', { type: 'checkbox', checked: true });
  let timer = null;
  let running = false;
  let again = false;
  const files = new Map();      // input (object) -> {file, fileId}: kept for this page only

  const persist = () => save(state);
  const schedule = () => { persist(); if (live.checked) { clearTimeout(timer); timer = setTimeout(run, 450); } };

  async function run() {
    if (!ctx.engine) return;
    if (running) { again = true; return; }
    running = true;
    status.textContent = 'Running…';
    try {
      const sent = {};
      for (const input of pg.inputs) {
        const f = files.get(input);
        if (f && !f.fileId) { status.textContent = `Uploading ${input.name}…`; f.fileId = await ctx.engine.upload(f.file); }
        sent[input.name] = f ? { file: f.fileId, mime: input.mime } : { text: input.text || '', mime: input.mime };
      }
      const modules = modulesOf(pg.script, ctx.project);
      const r = await ctx.engine.run({ script: pg.script, modules, properties: propertiesOf(ctx.project, ctx.env), inputs: sent });
      status.textContent = r.ms != null ? `${r.ms} ms` : '';
      if (!r.ok) {
        if (/file is gone/.test(r.error)) files.forEach((f) => { f.fileId = null; });
        const missing = missingModules(pg.script, modules, ctx.project);
        output.replaceChildren(h('pre.run-error', r.error), errorHint(r.error) ? h('div.muted', errorHint(r.error)) : '', missing.length && /Unable to resolve module/.test(r.error)
          ? h('div.muted', `${missing.join(', ')} is not in this project, so it cannot be imported here.`) : '');
        return;
      }
      const copy = h('button', { onclick: async () => { await navigator.clipboard.writeText(r.output); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); } }, 'Copy');
      output.replaceChildren(...[
        h('div.play-output-tools', r.note ? h('span.muted', r.note) : null, h('span.spacer'),
          r.truncated ? h('a', { href: ctx.engine.outputUrl(r.outputId), download: 'dataweave-output.txt' }, `Download all ${formatSize(r.size)}`) : null, copy),
        h('pre.code', r.output.length < HIGHLIGHT_LIMIT ? h('code', { html: highlightDataWeave(r.output) }) : h('code', r.output)),
      ].filter(Boolean));
    } catch (e) {
      status.textContent = '';
      output.replaceChildren(h('pre.run-error', e.message));
    } finally {
      running = false;
      if (again) { again = false; run(); }
    }
  }

  // ---------------------------------------------------------------- inputs

  function card(input) {
    const fixed = input.name === 'payload';
    const area = h('textarea.mono', { spellcheck: 'false', placeholder: 'Type or paste sample data, or drop a file here' });
    area.value = input.text || '';
    area.oninput = () => { input.text = area.value; schedule(); };
    area.onkeydown = keys;
    const mime = h('select', { onchange: () => { input.mime = mime.value; schedule(); } }, MIMES.map(([v, l]) => h('option', { value: v }, l)));
    mime.value = input.mime || 'application/json';
    const picker = h('input', { type: 'file', hidden: true });
    const fileRow = h('div.play-file');
    const showFile = () => {
      const f = files.get(input);
      area.hidden = !!f;
      fileRow.hidden = !f && !input.fileName;
      fileRow.replaceChildren(...(f ? [h('span.mono', f.file.name), h('span.muted', ` ${formatSize(f.file.size)}`),
        h('button.close', { title: 'Type it instead', onclick: () => { files.delete(input); input.fileName = null; showFile(); schedule(); } }, '×')]
        : input.fileName ? [h('span.muted', `${input.fileName}: choose it again (files are not kept after a reload)`)] : []));
    };
    const useFile = (file) => {
      if (!file) return;
      files.set(input, { file, fileId: null });
      input.fileName = file.name;
      const ext = file.name.split('.').pop().toLowerCase();
      if (EXT[ext]) input.mime = mime.value = EXT[ext];
      if (file.size < STORE_LIMIT) file.text().then((t) => { input.text = t; area.value = t; });
      showFile();
      schedule();
    };
    picker.onchange = () => useFile(picker.files[0]);
    const name = fixed ? h('span.play-input-name.mono', 'payload')
      : h('input.play-input-name.mono', { value: input.name, spellcheck: 'false', title: 'attributes, vars (an object of all variables), or vars.<name>' });
    if (!fixed) {
      name.onchange = () => {
        const v = name.value.trim();
        const ok = v === 'attributes' || v === 'vars' || (v.startsWith('vars.') && NAME.test(v.slice(5)));
        if (!ok || pg.inputs.some((x) => x !== input && x.name === v)) { name.value = input.name; name.classList.add('bad'); setTimeout(() => name.classList.remove('bad'), 900); return; }
        input.name = v;
        schedule();
      };
    }
    const el = h('div.play-card',
      h('div.play-card-head', name, mime, h('a', { onclick: () => picker.click() }, 'File…'), picker,
        fixed ? null : h('button.close', { title: 'Remove', onclick: () => { pg.inputs = pg.inputs.filter((x) => x !== input); files.delete(input); renderInputs(); schedule(); } }, '×')),
      area, fileRow);
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('drop'); };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = (e) => { e.preventDefault(); el.classList.remove('drop'); useFile(e.dataTransfer.files[0]); };
    showFile();
    return el;
  }

  const inputsList = h('div.play-inputs');
  function renderInputs() {
    inputsList.replaceChildren(...pg.inputs.map(card));
  }
  const addVar = () => {
    let n = 1;
    while (pg.inputs.some((x) => x.name === `vars.var${n}`)) n++;
    pg.inputs.push({ name: `vars.var${n}`, mime: 'application/json', text: '' });
    renderInputs();
    inputsList.lastChild?.querySelector('input.play-input-name')?.select();
  };
  const addAttributes = () => {
    if (pg.inputs.some((x) => x.name === 'attributes')) return;
    pg.inputs.push({ name: 'attributes', mime: 'application/json', text: '{\n  "headers": {},\n  "queryParams": {},\n  "uriParams": {}\n}' });
    renderInputs();
    schedule();
  };

  // ---------------------------------------------------------------- script

  const script = h('textarea.mono.play-script', { spellcheck: 'false' });
  function keys(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Tab' && !e.shiftKey && e.target.tagName === 'TEXTAREA') {
      e.preventDefault();
      e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
      e.target.dispatchEvent(new Event('input'));
    }
  }
  script.onkeydown = keys;
  script.oninput = () => {
    pg.script = script.value;
    if (pg.versions) pg.versions[pg.version].script = script.value;   // each version keeps its own edits
    schedule();
  };

  // a changed script's versions: the same inputs, one script or the other
  const versionSwitch = h('div.seg.play-versions');
  function renderVersions() {
    versionSwitch.hidden = !pg.versions;
    versionSwitch.replaceChildren(...(pg.versions || []).map((v, i) => h(`button${i === pg.version ? '.active' : ''}`, {
      title: `Run the ${v.label.toLowerCase()} version on these inputs`,
      onclick: () => {
        if (i === pg.version) return;
        pg.version = i;
        pg.script = script.value = v.script;
        renderVersions();
        persist();
        run();
      },
    }, v.label)));
  }

  // ---------------------------------------------------------------- playgrounds

  const picker = h('select.play-pick', { title: 'Your playgrounds (saved in this browser)' });
  const title = h('input.play-name', { spellcheck: 'false', title: 'Rename' });
  title.onchange = () => { pg.name = title.value.trim() || pg.name; title.value = pg.name; persist(); renderPicker(); };
  function renderPicker() {
    picker.replaceChildren(...state.items.map((p) => h('option', { value: p.id, selected: p.id === pg.id }, p.name)));
  }
  picker.onchange = () => { open(state.items.find((p) => p.id === picker.value)); };
  function open(p) {
    pg = p;
    state.active = p.id;
    persist();
    files.clear();
    title.value = p.name;
    script.value = p.script;
    renderVersions();
    renderPicker();
    renderInputs();
    output.replaceChildren(h('p.muted', ctx.engine ? 'Running…' : ''));
    run();
  }
  const add = (from) => {
    const id = newId();
    const p = from ? { ...structuredClone(from), id, name: `${from.name} copy` } : { id, ...structuredClone(STARTER), name: `Playground ${state.items.length + 1}` };
    state.items.push(p);
    open(p);
  };
  const remove = () => {
    if (state.items.length === 1) return;
    state.items = state.items.filter((p) => p !== pg);
    open(state.items[0]);
  };

  root.append(...[
    h('div.play-bar',
      picker, title,
      h('button', { onclick: () => add(), title: 'New playground' }, 'New'),
      h('button', { onclick: () => add(pg), title: 'A copy of this one' }, 'Duplicate'),
      h('button', { onclick: remove, title: 'Delete this playground' }, 'Delete'),
      h('span.spacer'),
      h('span.muted.play-env', { title: "p('…') reads this environment's properties (Env in the toolbar)" }, `p() reads ${ctx.env || 'no environment'}`),
      h('label.run-live', { title: 'Run again after every edit' }, live, 'Live'),
      h('button.run-button', { title: '⌘↵', onclick: () => run() }, 'Run'),
      status),
    ctx.engine ? null : h('p.notice', 'The DataWeave CLI is not installed, so scripts cannot run here. See the setup guide.'),
    resizable(h('section.play-col',
      h('div.play-col-head', h('h3', 'Inputs'), h('span.spacer'), h('a', { onclick: addVar }, '+ Variable'), h('a', { onclick: addAttributes }, '+ Attributes')),
      inputsList),
    h('section.play-col',
      h('div.play-col-head', h('h3', 'Script'), h('span.spacer'), versionSwitch),
      script),
    h('section.play-col',
      h('div.play-col-head', h('h3', 'Output')),
      output)),
  ].filter(Boolean));
  open(pg);
  return root;
}

// ------------------------------------------------------------------ column widths

const COLS = 'mfv.playCols';
const DEFAULT_COLS = [1, 1.25, 1];
const MIN_COL = 220;   // px

/**
 * The three columns side by side, with a handle between each two: drag to share the width differently, double-click
 * to go back to the default. The shares are kept for the next playground.
 */
function resizable(...cols) {
  let shares = DEFAULT_COLS;
  try { const v = JSON.parse(localStorage.getItem(COLS)); if (Array.isArray(v) && v.length === 3 && v.every((n) => n > 0)) shares = v; } catch { /* unavailable */ }
  const grid = h('div.play-grid');
  const apply = () => { grid.style.gridTemplateColumns = shares.map((f) => `minmax(0, ${f}fr)`).join(' var(--play-gap) '); };
  const keep = () => { try { localStorage.setItem(COLS, JSON.stringify(shares)); } catch { /* unavailable */ } };
  const handle = (i) => h('div.play-handle', {
    title: 'Drag to resize · double-click to reset',
    ondblclick: () => { shares = DEFAULT_COLS; apply(); keep(); },
    onpointerdown: (e) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      // the columns' widths now, in pixels; the two beside the handle trade width
      const widths = cols.map((c) => c.getBoundingClientRect().width);
      const pair = widths[i] + widths[i + 1];
      const x0 = e.clientX;
      const move = (ev) => {
        const left = Math.max(MIN_COL, Math.min(pair - MIN_COL, widths[i] + ev.clientX - x0));
        const w = [...widths];
        w[i] = left;
        w[i + 1] = pair - left;
        const total = w.reduce((a, b) => a + b, 0);
        shares = w.map((x) => +(x / total * 3).toFixed(3));
        apply();
      };
      const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); keep(); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('pointercancel', up, { once: true });
    },
  });
  grid.append(cols[0], handle(0), cols[1], handle(1), cols[2]);
  apply();
  return grid;
}
