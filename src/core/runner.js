// "Run" under a DataWeave script: editors for the inputs it reads (payload, vars, attributes, error),
// sent with the project modules it imports and the environment's property values to a local engine.
// engine: {upload(file) -> id, run(request) -> result, outputUrl(id)} (see adapters/dev-server.js).

import { h } from './dom.js';
import { dwImports, modulePath, highlightDataWeave } from './dataweave.js';
import { testSamples, runSample, modulesOf, jsonObject } from './chain.js';
import { JSON_MIME } from './munit.js';

export const MIMES = [['application/json', 'JSON'], ['application/xml', 'XML'], ['application/csv', 'CSV'], ['application/yaml', 'YAML'],
  ['application/dw', 'DataWeave'], ['text/plain', 'Text']];
export const EXT = { json: 'application/json', xml: 'application/xml', csv: 'application/csv', yaml: 'application/yaml', yml: 'application/yaml', dwl: 'application/dw' };
export const STORE_LIMIT = 200_000;
export const HIGHLIGHT_LIMIT = 200_000;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`mfv.dw.${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`mfv.dw.${k}`, JSON.stringify(v)); } catch { /* storage full or unavailable */ } },
};

/** Inputs a script reads, with starter values: vars and attributes list the names it uses. */
function inputsOf(code) {
  const body = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const names = (re) => [...new Set([...body.matchAll(re)].map((m) => m[1]))];
  const skeleton = (keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, null])), null, 2);
  const out = [];
  if (/\bpayload\b/.test(body)) out.push({ name: 'payload', text: '{}', mime: 'application/json' });
  const varNames = names(/\bvars\.([A-Za-z_$][\w$]*)/g);
  if (/\bvars\b/.test(body)) out.push({ name: 'vars', text: skeleton(varNames), mime: 'application/json', keys: varNames });
  if (/\battributes\b/.test(body)) out.push({ name: 'attributes', text: skeleton(names(/\battributes\.([A-Za-z_$][\w$]*)/g)), mime: 'application/json' });
  // set inside error handlers: error.description, error.errorType, error.errorMessage, ...
  const errorFields = names(/(?<![\w.$])error\.([A-Za-z_$][\w$]*)/g);
  if (errorFields.length) out.push({ name: 'error', text: skeleton(errorFields), mime: 'application/json' });
  return out;
}

/** What to do about an error the user can fix here, or null. */
export function errorHint(error) {
  if (/Property 'secure::/.test(error)) return 'secure:: values need the key: the key button next to Env.';
  return null;
}

export function missingModules(code, modules, project) {
  return [code, ...Object.values(modules)].flatMap(dwImports)
    .filter((m) => modulePath(m) && !project.dwl.has(modulePath(m)));
}

/** Every property resolved for the environment: scripts may build keys at runtime (`p('a.' ++ x)`). */
export function propertiesOf(project, env) {
  const out = {};
  for (const key of new Set(project.propertyFiles.flatMap((pf) => Object.keys(pf.values)))) {
    const r = project.resolveProperty(key, env);
    if (r) out[key] = r.value;
  }
  // decrypted secure:: values, once the key is given (secure.js); they go only to the local engine
  for (const [key, plain] of project.secrets?.get(env) || []) out[`secure::${key}`] = plain;
  return out;
}

const short = (text, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
export const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

/**
 * Collapsed "Run" block; built when first opened.
 * sites: [{processor, flow}] that run the script; MUnit tests reaching them offer input samples.
 */
export function renderRunner(code, key, ctx, sites = []) {
  const el = h('details.runner', h('summary', 'Run'));
  el.addEventListener('toggle', () => {
    if (el.open && el.children.length === 1) el.append(runnerBody(code, key, ctx, sites));
  });
  return el;
}

export const PLAYGROUND_SCRIPT = '%dw 2.0\noutput application/json\n---\npayload';

/** A DataWeave playground: your own script and inputs, run on this machine; starts on the script. */
export function renderPlayground(ctx) {
  return runnerBody(PLAYGROUND_SCRIPT, 'playground', ctx, [], { start: 'script', live: true });
}

const LIVE = 'mfv.dw.live';
const liveDefault = (fallback) => { try { const v = localStorage.getItem(LIVE); return v == null ? fallback : v === '1'; } catch { return fallback; } };

/**
 * The script is editable (the "script" tab: Run uses what is there, "Undo my edits" goes back), and with Live
 * on, every edit to it or to an input runs it again after a short pause.
 */
function runnerBody(code, key, ctx, sites, opts = {}) {
  const saved = store.get(key) || {};
  let script = saved['#script']?.text ?? code;
  // "vars.<key>": a variable kept in its own format (XML, CSV, ...), added by test samples
  const extra = Object.keys(saved).filter((n) => n.startsWith('vars.')).map((name) => ({ name }));
  const keys = inputsOf(code).find((i) => i.name === 'vars')?.keys || [];
  let editors = [...inputsOf(script), ...extra].map((i) => editor({ ...i, ...saved[i.name] }));
  let active = opts.start || editors[0]?.input.name || 'script';
  const tabs = h('div.run-tabs');
  const panes = h('div');
  const output = h('div.run-output');
  const status = h('span.muted');
  const sampleNote = h('div.run-note');

  function editor(input) {
    input.file = null;
    const area = h('textarea.mono', { spellcheck: 'false', rows: 8 });
    input.text = area.value = input.text ?? '';
    area.oninput = () => { input.text = area.value; schedule(); };
    area.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } };
    const picker = h('input', { type: 'file', hidden: true });
    const fileRow = h('div.run-file');
    const showFile = () => {
      area.hidden = !!input.file;
      fileRow.hidden = !input.file;
      fileRow.replaceChildren(...(input.file ? [
        h('span.mono', input.file.name), h('span.muted', ` ${formatSize(input.file.size)}`),
        h('button.close', { title: 'Use text instead', onclick: () => { input.file = null; input.fileId = null; showFile(); } }, '×'),
      ] : []));
    };
    const mime = h('select', { onchange: (e) => { input.mime = e.target.value; schedule(); } }, MIMES.map(([v, label]) => h('option', { value: v }, label)));
    mime.value = input.mime || 'application/json';
    input.mime = mime.value;
    picker.onchange = () => {
      const file = picker.files[0];
      if (!file) return;
      input.file = file;
      input.fileId = null;
      const ext = file.name.split('.').pop().toLowerCase();
      if (EXT[ext]) input.mime = mime.value = EXT[ext];
      showFile();
    };
    const pane = h('div.run-input',
      h('div.run-input-bar', mime, h('a', { onclick: () => picker.click() }, 'Choose file'), picker),
      area, fileRow);
    showFile();
    const set = ({ text, mime: m }) => {
      input.file = null;
      input.fileId = null;
      input.text = area.value = text;
      input.mime = mime.value = m;
      showFile();
    };
    return { input, pane, set };
  }

  // the script itself, editable
  const scriptArea = h('textarea.mono.run-script', { spellcheck: 'false', rows: 14 });
  scriptArea.value = script;
  const undo = h('a', { onclick: () => { script = scriptArea.value = code; edited(); } }, 'Undo my edits');
  const edited = () => {
    undo.hidden = script === code;
    layout();
    // a variable or input the edited script starts reading gets an editor
    const have = new Set(editors.map((ed) => ed.input.name));
    const added = inputsOf(script).filter((i) => !have.has(i.name));
    if (added.length) { editors = [...editors, ...added.map((i) => editor(i))]; layout(); }
    schedule();
  };
  scriptArea.oninput = () => { script = scriptArea.value; edited(); };
  scriptArea.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); scriptArea.setRangeText('  ', scriptArea.selectionStart, scriptArea.selectionEnd, 'end'); scriptArea.oninput(); }
  };
  const scriptPane = h('div.run-input.run-script-pane', h('div.run-input-bar', h('span.spacer'), undo), scriptArea);
  undo.hidden = script === code;

  function layout() {
    if (active !== 'script' && !editors.some((ed) => ed.input.name === active)) active = editors[0]?.input.name || 'script';
    const tab = (name, label) => h(`button${name === active ? '.active' : ''}`, { onclick: () => { active = name; layout(); } }, label);
    tabs.replaceChildren(tab('script', script === code ? 'script' : 'script ✎'), ...editors.map((ed) => tab(ed.input.name, ed.input.name)));
    // panes are moved only when the set changes: moving a box you type in takes its cursor away
    const want = [scriptPane, ...editors.map((ed) => ed.pane)];
    if (want.length !== panes.children.length || want.some((p, i) => panes.children[i] !== p)) {
      const focused = document.activeElement;
      const at = focused?.selectionStart != null ? [focused.selectionStart, focused.selectionEnd] : null;
      panes.replaceChildren(...want);
      if (focused && panes.contains(focused)) { focused.focus(); if (at) focused.setSelectionRange(...at); }
    }
    scriptPane.hidden = active !== 'script';
    editors.forEach((ed) => { ed.pane.hidden = ed.input.name !== active; });
  }
  layout();

  const samples = sites.length ? testSamples(ctx.project, sites) : [];
  let manual = null;    // the user's own inputs while a test sample is shown
  const source = samples.length ? h('select.run-source', {
    title: 'Inputs',
    onchange: (e) => { e.target.title = e.target.selectedOptions[0].text; useSample(samples[e.target.value]); },
  }, h('option', { value: '' }, 'Your inputs'), samples.map((s, i) => h('option', { value: i }, s.test.name))) : null;

  const results = new Map();    // sample -> event at the script, so switching back is instant
  const MAX_ERRORS = 3;

  async function useSample(sample) {
    sampleNote.replaceChildren();
    if (!sample) {
      if (manual) editors = manual;
      manual = null;
      layout();
      return;
    }
    manual ??= editors;
    const base = inputsOf(code);
    source.disabled = true;
    status.textContent = 'Running the test…';
    try {
      if (!results.has(sample)) {
        results.set(sample, await runSample(sample, { project: ctx.project, engine: ctx.engine, properties: propertiesOf(ctx.project, ctx.env) },
          (n) => { status.textContent = `Running the test… step ${n}`; }));
      }
      const r = results.get(sample);
      // variables the script reads first; the rest of the event follows
      const vars = [...r.vars].sort(([a], [b]) => keys.includes(b) - keys.includes(a));
      const filled = {
        payload: r.payload,
        attributes: r.attributes,
        vars: { text: jsonObject(vars.filter(([, v]) => v.mime === JSON_MIME), keys.filter((k) => !r.vars.has(k))), mime: JSON_MIME },
      };
      editors = [
        ...base.map((i) => editor({ ...i, ...(filled[i.name] || {}) })),
        ...(base.some((i) => i.name === 'vars') ? vars.filter(([, v]) => v.mime !== JSON_MIME) : [])
          .map(([k, v]) => editor({ name: `vars.${k}`, ...v })),
      ];
      layout();
      schedule();
      const unknown = keys.filter((k) => !r.vars.has(k) && r.unknownVars.has(k));
      sampleNote.append(...[
        r.offRoute ? h('div.muted', `In this test “${r.offRoute.choice.label}” takes ${r.offRoute.taken.label === 'Default' ? 'Default' : short(r.offRoute.taken.expr)}, so this script doesn't run; the inputs are what it would get.`) : null,
        !r.exact && !r.offRoute && base.some((i) => i.name === 'payload') ? h('div.muted', r.blocker?.handlers || r.blocker?.errorType !== undefined
          ? 'This runs in an error handler, so payload is the event before the failing step and may differ.'
          : r.blocker
            ? `“${r.blocker.label}” runs before this script and isn't mocked in this test, so payload may differ.`
            : 'Payload may differ from what this script gets in the test.') : null,
        ...unknown.map((k) => h('div.muted', `vars.${k} comes from “${r.unknownVars.get(k).label}”, which this test doesn't mock.`)),
        ...r.errors.slice(0, MAX_ERRORS).map((e) => h('div.muted', e)),
        r.errors.length > MAX_ERRORS ? h('div.muted', `${r.errors.length - MAX_ERRORS} more steps failed.`) : null,
      ].filter(Boolean));
    } catch (e) {
      sampleNote.append(h('div.muted', e.message));
    } finally {
      status.textContent = '';
      source.disabled = false;
    }
  }

  const button = h('button.run-button', { title: '⌘↵', onclick: () => run() }, 'Run');
  const live = h('input', { type: 'checkbox' });
  live.checked = liveDefault(!!opts.live);
  live.onchange = () => { try { localStorage.setItem(LIVE, live.checked ? '1' : '0'); } catch { /* unavailable */ } if (live.checked) run(); };
  const liveLabel = h('label.run-live', { title: 'Run again after every edit' }, live, 'Live');
  let timer = null;
  let running = false;
  let again = false;
  function schedule() {
    if (!live.checked) return;
    clearTimeout(timer);
    timer = setTimeout(run, 450);
  }

  async function run() {
    if (running) { again = true; return; }
    running = true;
    button.disabled = true;
    status.textContent = 'Running…';
    output.replaceChildren();
    try {
      const sent = {};
      for (const { input } of editors) {
        if (input.file && !input.fileId) {
          status.textContent = `Uploading ${input.name}…`;
          input.fileId = await ctx.engine.upload(input.file);
          status.textContent = 'Running…';
        }
        sent[input.name] = input.file ? { file: input.fileId, mime: input.mime } : { text: input.text, mime: input.mime };
      }
      store.set(key, Object.fromEntries([
        ...editors.filter(({ input }) => input.text.length < STORE_LIMIT).map(({ input }) => [input.name, { text: input.text, mime: input.mime }]),
        ...(script !== code && script.length < STORE_LIMIT ? [['#script', { text: script }]] : []),
      ]));
      const modules = modulesOf(script, ctx.project);
      const r = await ctx.engine.run({ script, modules, properties: propertiesOf(ctx.project, ctx.env), inputs: sent });
      status.textContent = r.ms != null ? `${r.ms} ms` : '';
      if (!r.ok) {
        if (/file is gone/.test(r.error)) editors.forEach(({ input }) => { input.fileId = null; });
        const missing = missingModules(script, modules, ctx.project);
        output.append(h('pre.run-error', r.error), errorHint(r.error) ? h('div.muted', errorHint(r.error)) : '', missing.length && /Unable to resolve module/.test(r.error)
          ? h('div.muted', `${missing.join(', ')} is not in this project (most likely from a dependency), so it cannot run here.`)
          : '');
        return;
      }
      output.append(...[
        r.note ? h('div.muted', r.note) : null,
        r.truncated ? h('div.muted', `First ${formatSize(r.output.length)} of ${formatSize(r.size)} · `,
          h('a', { href: ctx.engine.outputUrl(r.outputId), download: 'dataweave-output.txt' }, 'download all')) : null,
        h('pre.code', r.output.length < HIGHLIGHT_LIMIT ? h('code', { html: highlightDataWeave(r.output) }) : h('code', r.output)),
      ].filter(Boolean));
    } catch (e) {
      status.textContent = '';
      output.append(h('pre.run-error', e.message));
    } finally {
      button.disabled = false;
      running = false;
      if (again) { again = false; run(); }
    }
  }

  if (live.checked && opts.live) setTimeout(run);
  // the script and its inputs as they are now, in a playground of their own
  const toPlayground = ctx.openPlayground ? h('a.run-to-play', {
    title: 'Copy this script and its inputs into a new playground',
    onclick: () => ctx.openPlayground({ name: key.split(':').pop(), script, inputs: editors.map(({ input }) => ({ name: input.name, mime: input.mime, text: input.text })) }),
  }, 'Open in playground') : null;
  return h('div.run-body', h('div.run-edit', h('div.run-head', tabs, source), sampleNote, panes, h('div.run-actions', button, liveLabel, status, h('span.spacer'), toPlayground)), output);
}
