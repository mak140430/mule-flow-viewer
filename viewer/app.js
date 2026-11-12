import { loadProject } from '../src/core/project.js';
import { Icons } from '../src/core/icons.js';
import { renderConfig } from '../src/core/render.js';
import { renderDetails, renderDwlDetails } from '../src/core/details.js';
import { diffProjects, resourcePath, sameElement, elementIdent, isChange, sidesOf, sideText } from '../src/core/diff.js';
import { highlightXml } from '../src/core/dataweave.js';
import { renderDiffDetails, renderDwlDiff, renderPropertiesDiff } from '../src/core/diff-details.js';
import { h, installTooltips } from '../src/core/dom.js';
import { xmlPane } from '../src/core/xml-pane.js';
import { FileVersions } from '../src/core/element-history.js';
import { defaultColumns, gridRows, renderGrid } from '../src/core/branch-grid.js';
import { locate } from '../src/core/locate.js';
import { openPalette } from '../src/core/palette.js';
import { pickBranch, pickCommit } from '../src/core/branch-picker.js';
import { scriptHistory } from '../src/core/script-history.js';
import { paintBlame, clearBlame } from '../src/core/blame.js';
import { secureConfigs, decryptAll, guardSecrets } from '../src/core/secure.js';
import { testSamples } from '../src/core/chain.js';
import { Libraries } from '../src/core/libraries.js';
import { releaseNotes, openNotes } from '../src/core/notes.js';
import { walkFlow } from '../src/core/model.js';
import { header, section, dwIcon } from '../src/core/details.js';
import { renderPlaygroundView, addPlayground } from '../src/core/playground.js';
import { devServerAdapter, serverEngine } from '../src/adapters/dev-server.js';
import { remoteAdapter } from '../src/adapters/remote.js';
import { parsePom } from '../src/adapters/git-host.js';
import { checks, isLibrary } from '../src/core/lint.js';
import { trace } from '../src/core/trace.js';
import { renderChecksView, markChecks, attention, renderTraceView, usedBySection, renderImpactView } from '../src/core/insights.js';
import { impact } from '../src/core/impact.js';
import { renderOverview } from '../src/core/overview.js';
import { elementSvg, elementPng, saveBlob } from '../src/core/export-image.js';
import { localFolderAdapter } from '../src/adapters/local-folder.js';

// before anything takes fetch: secure:: keys and values never leave this computer (secure.js)
guardSecrets();

const $ = (id) => document.getElementById(id);
const MULE_DIR = 'src/main/mule/';
const WORKTREE = 'WORKTREE';

const prefs = {
  get(k) { try { return localStorage.getItem(`mfv.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`mfv.${k}`, v); } catch { /* storage unavailable */ } },
};

const icons = new Icons();
let catalog = { connectors: {} };
let adapter = null;
let live = null;        // the project as it is on disk
let project = null;     // what is shown: `live`, or the newer side of the diff
let diff = null;        // diffProjects() result while a commit is open
let env = null;
let rendered = { file: null, flow: null, rev: null };
let routeSeq = 0;
let engine = null;      // local DataWeave engine, when the adapter has one
let xml = null;         // XML pane of the open file, while it is shown
let xmlIds = [];        // canvas ids of the elements marked in it
let libraries = null;   // shared library flows (Libraries), when the adapter can read them
let libFlows = null;    // flow name -> {lib, project, flow}, for the live project
const versions = new Map();   // file -> Promise<FileVersions>, for element history

// history: commits of the whole project, or of one file (+ the DataWeave it uses)
const log = { ref: null, all: null, file: null, filePath: null, fileOnly: false, branches: null };
const RANGE = 'RANGE';
const COMPARE = 'COMPARE';     // a merge preview or a comparison of two branches (not a commit of the list)
const projectsAt = new Map();

// ------------------------------------------------------------------ routing (hash = shareable state)

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    file: p.get('file'), flow: p.get('flow'), sel: p.get('sel'), dwl: p.get('dwl'), props: p.get('props'),
    rev: p.get('rev'), base: p.get('base'), ref: p.get('ref'), L: p.get('L'),
    // merge preview: vs is the other side's tip, into its branch; with: the branch name of base in a comparison
    vs: p.get('vs'), into: p.get('into'), with: p.get('with'), grid: p.get('grid'), search: p.get('search'),
    lib: p.get('lib'), libv: p.get('libv'), src: p.get('src'), play: p.get('play') || p.get('playground'),
    checks: p.get('checks'), trace: p.get('trace'), impact: p.get('impact'), app: p.get('app'),
    // a branch shown on its own, read-only (not compared with anything)
    at: p.get('at'),
  };
}

const REV_KEYS = ['rev', 'base', 'ref', 'vs', 'into', 'with', 'at'];

/** Keeps the open commit (rev, base, ref, ...) unless rev is given; rev: null closes it. */
function writeHash(state, push) {
  const current = readHash();
  const opens = 'rev' in state;   // a new comparison: its other keys are what state says, or none
  for (const k of REV_KEYS) if (!(k in state)) state[k] = opens ? null : current[k];
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v) p.set(k, v);
  window.history[push ? 'pushState' : 'replaceState'](null, '', `#${p}`);
  route();
}

function findFlow(name) {
  if (!diff) return project.flows.get(name);
  for (const c of diff.configs.values()) {
    const f = c.flows.find((x) => x.name === name);
    if (f) return f;
  }
  return null;
}

function navigate(flowName, selId) {
  const flow = findFlow(flowName);
  if (flow) writeHash({ file: flow.file, flow: flowName, sel: selId }, true);
}

function select(item) {
  const s = readHash();
  // a comparison draws every changed file: the element's own is the one its XML and tree show
  writeHash({ file: diff && item.file ? item.file : s.file, flow: s.flow, sel: item.id }, false);
}

function openDwl(path) {
  const s = readHash();
  writeHash({ file: s.file, flow: s.flow, dwl: path }, true);
}

function openProps(path) {
  const s = readHash();
  writeHash({ file: s.file, flow: s.flow, props: path }, true);
}

/** Any file of this version (a property file, pom.xml, an MUnit suite) with one line marked. */
function renderSourcePanel(path, line, ctx) {
  const text = project.texts.get(path);
  const highlight = /\.xml$/.test(path) ? highlightXml : (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const rows = text.split('\n').map((l, i) => h(`div.src-line${i + 1 === line ? '.hl' : ''}`, { dataset: { n: i + 1 } }, h('code', { html: highlight(l) || ' ' })));
  const body = h('div.src-view.mono', rows);
  setTimeout(() => body.querySelector('.hl')?.scrollIntoView({ block: 'center' }));
  return h('div.details', header(icons.url('core:flow'), path.split('/').pop(), path, ctx), h('section.details-section', body));
}

/** The details panel over the whole window and back (for DataWeave work, side by side). */
function toggleWide() {
  document.body.classList.toggle('panel-wide');
}

function closePanel() {
  if (document.body.classList.contains('panel-wide')) return document.body.classList.remove('panel-wide');
  const s = readHash();
  writeHash({ file: s.file, flow: s.flow }, false);
}

async function route() {
  if (!live) return;
  const seq = ++routeSeq;
  const s = readHash();
  const rev = s.rev && adapter.history ? s.rev : null;
  if (!rev && s.at && adapter.branches) log.branches ??= await adapter.branches();
  const at = !rev && s.at && log.branches?.tips?.[s.at] ? s.at : null;
  const key = rev ? `${s.ref || ''}|${rev}|${s.base || ''}|${s.vs || ''}` : at ? `at:${at}` : null;
  if (key !== rendered.rev) {
    if (at) {
      // another branch, read-only: its own project, shown like the working copy
      $('main').replaceChildren(h('div.empty-state', `Loading ${at}…`));
      let p;
      try {
        p = await projectAt(log.branches.tips[at]);
      } catch (e) {
        if (seq === routeSeq) $('main').replaceChildren(h('p.notice', `Could not load ${at}: ${e.message}`));
        return;
      }
      if (seq !== routeSeq) return;
      diff = null;
      project = p;
    } else if (rev) {
      $('main').replaceChildren(h('div.empty-state', 'Loading…'));
      let d;
      try {
        d = await loadDiff(rev, s.base, s.vs, s);
      } catch (e) {
        if (seq === routeSeq) $('main').replaceChildren(h('p.notice', `Could not load ${rev}: ${e.message}`));
        return;
      }
      if (seq !== routeSeq) return;
      diff = d;
      project = d.head;
    } else {
      diff = null;
      project = live;
    }
    rendered = { file: null, flow: null, rev: key };
    showWhere();
    await renderDiffBar(s);
    if (seq !== routeSeq) return;
  }
  $('impact-toggle').classList.toggle('active', !!s.impact);
  if (s.impact && rev) return renderImpactRoute();
  $('grid-toggle').classList.toggle('active', !!s.grid);
  // these views read the version shown: in a comparison, its newer side
  if (s.grid) return renderGridView(s, seq);
  if (s.search) return renderSearchView(s, seq);
  $('overview-toggle').classList.toggle('active', !!s.app);
  if (s.app) return renderOverviewRoute(s);
  $('checks-toggle').classList.toggle('active', !!s.checks);
  if (s.checks) return renderChecksRoute();
  if (s.trace && project.flows.has(s.trace)) return renderTraceRoute(s);
  $('play-toggle').classList.toggle('active', !!s.play);
  if (s.play) return renderPlayView();
  const file = hasFile(s.file) ? s.file : defaultFile();
  // a diff draws every changed file on one page; otherwise the canvas is one file
  const fileChanged = (diff ? 'diff' : file) !== rendered.canvas;
  const otherFile = file !== rendered.file;
  if (fileChanged) renderCanvas(file, s.sel);
  else markSelection(s.sel);
  rendered.file = file;
  if (fileChanged && s.L && !diff) prefs.set('xml', '1');
  if (fileChanged || (diff && otherFile)) renderXml(file, s);
  if (fileChanged && !diff) paintCanvas(file);
  if (fileChanged && !diff) markChecks($('main'), projectChecks());
  if (fileChanged && diff) { markUntested(diff); markSides(diff); }
  const behavior = fileChanged ? 'instant' : 'smooth';
  const lines = fileChanged && parseLines(s.L);
  if (lines) pointAt(...lines, true);
  else if (s.sel && (fileChanged || s.sel !== rendered.sel)) scrollToId(s.sel, behavior);
  else if (s.flow && s.flow !== rendered.flow) scrollToFlow(s.flow, behavior);
  // files can be thousands of pixels apart: jump
  else if (diff && file && (fileChanged || otherFile)) scrollToFile(file, 'instant');
  if (!fileChanged && s.sel !== rendered.sel) showLines(s.sel, true);
  rendered.flow = s.flow;
  rendered.sel = s.sel;
  if (diff) renderDiffTree(file, s.flow);
  else renderTree(file, s.flow);
  renderPanel(s);
}

function hasFile(path) {
  return diff ? diff.configs.has(path) : !!project.configFor(path);
}

function defaultFile() {
  if (diff) {
    const changed = [...diff.configs.values()].filter((c) => c.status);
    return (changed.find((c) => c.textChanged) || changed[0])?.path ?? null;
  }
  const main = project.configs.find((c) => /\/main\.xml$/.test(c.path));
  return (main || project.configs[0])?.path;
}

// ------------------------------------------------------------------ versions

function projectAt(rev) {
  if (!projectsAt.has(rev)) {
    const p = rev
      ? adapter.at(rev).then((a) => loadProject(a || { list: async () => [], read: async () => '' }, catalog))
        .then(async (loaded) => { await applySecrets(loaded, env); return loaded; })
      : loadProject({ list: async () => [], read: async () => '' }, catalog);
    p.catch(() => projectsAt.delete(rev));
    projectsAt.set(rev, p);
  }
  return projectsAt.get(rev);
}

/** The diff for the URL's comparison; d.revs = {base, head} (head null: the working tree). */
async function loadDiff(rev, base, vs, { with: withName, ref } = {}) {
  let d;
  if (rev === WORKTREE) {
    d = diffProjects(await projectAt('HEAD'), live);
    d.revs = { base: 'HEAD', head: null };
  } else if (base && vs) {
    // merge preview: what rev changed since base, and which of those elements vs changed too
    const [older, newer, other] = await Promise.all([projectAt(base), projectAt(rev), projectAt(vs)]);
    d = markConflicts(diffProjects(older, newer), diffProjects(older, other));
    d.revs = { base, head: rev };
  } else if (base) {
    const [older, newer] = await Promise.all([projectAt(base), projectAt(rev)]);
    d = diffProjects(older, newer);
    d.revs = { base, head: rev };
    // two branches tip to tip: which of them made each difference, from where they split
    const split = withName && adapter.mergeBase ? await adapter.mergeBase(base, rev).catch(() => null) : null;
    if (split && split !== base && split !== rev) {
      const at = await projectAt(split).catch(() => null);
      if (at) d.sides = { ...sidesOf(d, diffProjects(at, newer), diffProjects(at, older)), names: { head: ref || 'this branch', base: withName } };
    }
  } else {
    const commit = [...(log.all?.commits || []), ...(log.file?.commits || [])].find((c) => c.sha === rev || c.short === rev);
    const parent = commit ? commit.parents[0] || '' : `${rev}^`;
    const [older, newer] = await Promise.all([projectAt(parent), projectAt(commit?.sha || rev)]);
    d = diffProjects(older, newer);
    d.revs = { base: parent, head: commit?.sha || rev, commit };
  }
  if (libraries) await libraryUpgrades(d);
  return d;
}

/** Library upgrades between the two sides, and the library flows the newer side calls. */
async function libraryUpgrades(d) {
  d.libraries = [];
  d.libFlows = libFlows;
  if (!d.revs.base) return;
  try {
    const [a, b] = await Promise.all([adapter.at(d.revs.base), d.revs.head ? adapter.at(d.revs.head) : adapter]);
    const called = new Set();
    for (const f of d.head.flows.values()) walkFlow(f, (p) => { if (p.kind === 'flow-ref' && !p.dynamic && !d.head.flows.has(p.target)) called.add(p.target); });
    [d.libraries, d.libFlows] = await Promise.all([libraries.upgrades(d.base, d.head, a, b, called), libraries.flows(b)]);
  } catch { /* no pom or no library: nothing to say */ }
}

/**
 * Marks the elements d changed that `other` (the other side, since the same base) changed differently:
 * d.conflicts = their ids in d. The same edit on both sides (a merged or cherry-picked commit) is not one.
 * Elements match by doc:id, else flows and globals by name.
 */
function markConflicts(d, other) {
  const theirs = new Map([...other.byId.values()].filter((e) => isChange(e.item)).map((e) => [elementIdent(e), e.item]));
  const result = (item) => (item.diff === 'removed' ? null : item);
  d.conflicts = new Set([...d.byId.values()]
    .filter((e) => isChange(e.item) && theirs.has(elementIdent(e))
      && !sameElement(result(e.item), d.head, result(theirs.get(elementIdent(e))), other.head))
    .map((e) => e.item.id));
  return d;
}

/** Paths whose history matters for one config: the file and the DataWeave its flows use. */
function filePaths(file) {
  const paths = new Set([file]);
  for (const [path, users] of live.dwlUsers) {
    if (users.some((u) => u.flow.file === file)) paths.add(`src/main/resources/${path}`);
  }
  return [...paths];
}

async function commitList(file, ref = '') {
  if (log.ref !== ref) Object.assign(log, { ref, all: null, file: null, filePath: null });
  if (!log.all) log.all = await adapter.history([], ref);
  if (!log.fileOnly || !file) return log.all;
  if (log.filePath !== file) {
    log.file = await adapter.history(filePaths(file), ref);
    log.filePath = file;
  }
  return log.file;
}

async function renderDiffBar({ rev, base, ref, file, vs, into, with: withName }) {
  document.body.classList.toggle('diff-mode', !!rev);
  $('colour-wrap').hidden = !!rev || !adapter.versions;
  $('history').classList.toggle('active', !!rev);
  $('diffbar').hidden = !rev;
  if (!rev) return stopReplay();
  if (!log.branches) log.branches = await adapter.branches();
  const { current: currentBranch, default: defaultBranch, branches } = log.branches;
  const branch = ref || currentBranch;
  $('branch').textContent = branch === currentBranch ? `${branch} (${hereLabel()})` : branch;
  $('branch').dataset.value = branch;
  $('branch').hidden = branches.length < 2;

  const list = await commitList(file || defaultFile(), ref || '');
  const options = [];
  const compare = base && !(base === list.mergeBase && rev === list.head);
  if (compare) options.push(h('option', { value: COMPARE }, vs ? `Merge preview into ${into || 'HEAD'}` : `Compared with ${withName || base.slice(0, 7)}`));
  if (list.mergeBase && list.mergeBase !== list.head) {
    options.push(h('option', { value: RANGE }, `All changes since ${defaultBranch}`));
  }
  if (list.dirty) options.push(h('option', { value: WORKTREE }, 'Uncommitted changes'));
  for (const c of list.commits) options.push(h('option', { value: c.sha }, `${c.short}  ${c.subject}`));
  const select = $('commit');
  select.replaceChildren(...options);
  const current = list.commits.find((c) => c.sha === rev || c.short === rev);
  if (!current && !base && rev !== WORKTREE) select.prepend(h('option', { value: rev }, rev));
  select.value = compare ? COMPARE : base ? RANGE : current?.sha || rev;
  // the list to type into: the comparisons, then the commits with their author and date
  const bySha = new Map(list.commits.map((c) => [c.sha, c]));
  commitItems = [...select.options].map((o) => {
    const c = bySha.get(o.value);
    return c ? { value: c.sha, label: c.subject, sha: c.sha, author: c.author, date: c.date } : { value: o.value, label: o.text };
  });
  $('commit-pick').replaceChildren(h('span', select.selectedOptions[0]?.text || ''));
  const values = [...select.options].map((o) => o.value);
  const i = values.indexOf(select.value);
  $('newer').disabled = i <= 0;
  $('older').disabled = i < 0 || i >= values.length - 1;
  $('file-only').checked = log.fileOnly;
  // replay: the commits of the list, oldest on the left
  const steps = list.commits.map((c) => c.sha).reverse();
  const at = steps.indexOf(current?.sha);
  $('replay-wrap').hidden = steps.length < 3 || at < 0;
  $('scrub').max = steps.length - 1;
  $('scrub').value = at;
  $('replay').textContent = replaying ? '❚❚' : '▶';
  replaySteps = steps;
  const ahead = log.all.ahead;
  const conflicts = diff?.conflicts
    ? (diff.conflicts.size ? `${plural(diff.conflicts.size, 'element')} also changed on ${into || defaultBranch}` : `nothing here was also changed on ${into || defaultBranch}`)
    : '';
  $('commit-meta').classList.toggle('conflict', !!diff?.conflicts?.size);
  $('notes').onclick = () => showNotes(select.selectedOptions[0]?.text || rev);
  $('commit-meta').textContent = compare ? conflicts
    : base ? [ahead ? plural(ahead, 'commit') : null, 'compared with where it branched off', conflicts || null].filter(Boolean).join(' · ')
    : current
      ? `${current.author} · ${new Date(current.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${current.parents.length > 1 ? ' · merge, compared with first parent' : ''}`
      : rev === WORKTREE ? 'compared with HEAD' : '';
  fullTitle($('commit-meta'));
  $('commit-pick').title = select.selectedOptions[0]?.text || '';
}

/** Hovering a line cut short with "…" shows all of it. */
function fullTitle(el) {
  el.title = el.textContent;
}

function openCommit(rev, ref = readHash().ref) {
  const s = readHash();
  if (rev === COMPARE) return;
  if (rev === RANGE) {
    return writeHash({ file: s.file, flow: s.flow, rev: log.all.head, base: log.all.mergeBase, vs: log.all.defaultHead, into: log.branches.default, ref }, true);
  }
  writeHash({ file: s.file, flow: s.flow, rev, base: null, ref }, true);
}

/** First thing worth showing on a branch: what it changes, else its newest commit. */
function firstOf(list) {
  if (list.mergeBase && list.mergeBase !== list.head) return RANGE;
  return list.dirty ? WORKTREE : list.commits[0]?.sha;
}

let commitItems = [];     // the History bar's list, for its picker
let replaying = null;     // interval while a replay runs
let replaySteps = [];
const REPLAY_MS = 2200;

function stopReplay() {
  clearInterval(replaying);
  replaying = null;
  $('replay').textContent = '▶';
}

/** Plays the file's commits forward from the one shown (from the oldest when the newest is shown). */
async function toggleReplay() {
  if (replaying) return stopReplay();
  if (!log.fileOnly) {
    log.fileOnly = true;
    await renderDiffBar(readHash());
  }
  let i = replaySteps.indexOf(readHash().rev);
  if (i < 0 || i >= replaySteps.length - 1) i = -1;
  const next = () => {
    i++;
    if (i >= replaySteps.length) return stopReplay();
    openCommit(replaySteps[i]);
  };
  next();
  replaying = setInterval(next, REPLAY_MS);
  $('replay').textContent = '❚❚';
}

function step(delta) {
  const values = [...$('commit').options].map((o) => o.value);
  const next = values[values.indexOf($('commit').value) + delta];
  if (next) openCommit(next);
}

// ------------------------------------------------------------------ views

function canvasCtx(selectedId) {
  const flows = diff ? diff.libFlows : libFlows;
  return {
    project, icons, selectedId, diff,
    onSelect: select,
    onNavigate: navigate,
    onCallers: showCallers,
    libraryFlow: flows ? (name) => flows.get(name) : null,
    libraryChanged: diff ? new Set(diff.libraries?.flatMap((l) => l.flows) || []) : null,
    onLibrary: (name) => { const s = readHash(); writeHash({ file: s.file, flow: s.flow, lib: name }, true); },
  };
}

// the canvas last drawn, kept while another view (Overview, Checks, ...) is open: coming back shows it again at once
let keptCanvas = null;   // {key, nodes, scroll}
const canvasKey = (file) => `${rendered.rev}|${diff ? 'diff' : file}`;

/** Before a view replaces the canvas: keep it (once per canvas). */
function leaveCanvas() {
  const main = $('main');
  if (rendered.canvas != null) keptCanvas = { key: canvasKey(rendered.canvas), nodes: [...main.childNodes], scroll: main.scrollTop };
  rendered.canvas = null;
}

function renderCanvas(file, selectedId) {
  const main = $('main');
  rendered.canvas = diff ? 'diff' : file;
  rendered.flow = null;
  if (keptCanvas?.key === canvasKey(file)) {
    main.replaceChildren(...keptCanvas.nodes);
    main.scrollTop = keptCanvas.scroll;
    keptCanvas = null;
    markSelection(selectedId);
    return;
  }
  keptCanvas = null;
  main.replaceChildren();
  rendered.flow = null;
  if (diff && !file) {
    main.append(h('div.empty-state', diff.files.length ? 'No flow changes. See the changed files on the left.' : 'No changes in this commit.'));
    return;
  }
  if (diff) {
    const ctx = canvasCtx(selectedId);
    main.append(...[...diff.configs.values()].filter((c) => c.status || c.textChanged).map((c) => h('section.diff-file', { dataset: { file: c.path } },
      h('div.diff-file-head', h(`span.st.${c.status || 'changed'}${c.textChanged ? '' : '.indirect'}`, STATUS_LETTER[c.status] || (c.textChanged ? 'M' : '•')),
        c.path.replace(MULE_DIR, ''),
        diff.sides?.files.get(c.path) ? h('span.muted.diff-side', sideText(c.status || 'changed', diff.sides.files.get(c.path), diff.sides.names)) : null),
      renderConfig(c, ctx))));
    main.scrollTop = 0;
    return;
  }
  const config = diff ? diff.configs.get(file) : project.configFor(file);
  const error = project.errors.find((e) => e.path === file);
  if (error) main.append(h('p.notice', `${file}: ${error.message}`));
  if (config) main.append(renderConfig(config, canvasCtx(selectedId)));
  main.scrollTop = 0;
}

function markSelection(id) {
  document.querySelectorAll('#main .selected').forEach((el) => el.classList.remove('selected'));
  if (id) document.querySelector(`#main [data-id="${CSS.escape(id)}"]`)?.classList.add('selected');
}

function scrollToFlow(name, behavior) {
  const el = document.querySelector(`#main [data-flow="${CSS.escape(name)}"]`);
  if (!el) return;
  el.classList.remove('collapsed');
  el.scrollIntoView({ block: 'start', behavior });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function scrollToFile(path, behavior) {
  document.querySelector(`#main [data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start', behavior });
}

function scrollToId(id, behavior) {
  const el = document.querySelector(`#main [data-id="${CSS.escape(id)}"]`);
  el?.closest('.flow')?.classList.remove('collapsed');
  el?.scrollIntoView({ block: 'center', inline: 'center', behavior });
}

// ------------------------------------------------------------------ playground

function renderPlayView() {
  leaveCanvas();
  $('xml').hidden = true;
  $('panel').hidden = true;
  $('panel-resize').hidden = true;
  renderTree(null, null);
  $('main').replaceChildren(renderPlaygroundView({ engine, project, env,
    scriptHistory: adapter.versions ? (source) => adapter.versions(source.path).then((v) => scriptHistory(v, source)) : null }));
  $('main').scrollTop = 0;
}

/** A script and its inputs (from a Run block) as a new playground, opened. */
function openPlayground(data) {
  addPlayground(data);
  const s = readHash();
  writeHash({ file: s.file, play: '1' }, true);
}

// ------------------------------------------------------------------ branch grid

async function renderGridView(s, seq) {
  leaveCanvas();
  $('xml').hidden = true;
  $('panel').hidden = true;
  renderTree(null, null);
  log.branches ??= await adapter.branches();
  const { tips, branches } = log.branches;
  const names = s.grid.split(',').filter((n) => tips[n]);
  if (names.length < 2) names.push(...defaultColumns(log.branches).filter((n) => !names.includes(n)).slice(0, 2 - names.length));
  const main = $('main');
  main.replaceChildren(h('div.empty-state', `Loading ${names.join(', ')}…`));
  let rows;
  let columns;
  try {
    columns = await Promise.all(names.map(async (name) => ({ name, project: await projectAt(tips[name]) })));
    rows = gridRows(columns);
  } catch (e) {
    if (seq === routeSeq) main.replaceChildren(h('p.notice', `Could not load the branches: ${e.message}`));
    return;
  }
  if (seq !== routeSeq) return;
  const onColumns = (list) => writeHash({ file: s.file, grid: list.join(',') }, false);
  main.replaceChildren(renderGrid({
    icons, rows, columns: names, all: branches, current: log.branches.current,
    onColumns,
    // the column compared with the reference, at that element
    onCompare: (row, name) => writeHash({ ...(row.property ? { file: s.file, props: row.file } : { file: row.file, flow: row.flow, sel: row.ids[name] }),
      rev: tips[name], base: tips[names[0]], ref: name, with: names[0] }, true),
    onOpen: (row) => {
      const live = row.isFlow ? project.flows.get(row.label) : null;
      const id = live?.id || Object.values(row.ids)[0];
      writeHash({ file: row.file, flow: row.flow || live?.name, sel: project.byId.has(id) ? id : null }, true);
    },
  }));
  main.scrollTop = 0;
}

// ------------------------------------------------------------------ search every branch

const BRANCHES_SHOWN = 6;

async function renderSearchView(s, seq) {
  leaveCanvas();
  $('xml').hidden = true;
  $('panel').hidden = true;
  renderTree(null, null);
  const main = $('main');
  main.replaceChildren(h('div.empty-state', `Searching every branch for “${s.search}”…`));
  let r;
  try {
    [r] = await Promise.all([adapter.search(s.search), log.branches ? null : adapter.branches().then((b) => { log.branches = b; })]);
  } catch (e) {
    if (seq === routeSeq) main.replaceChildren(h('p.notice', `Search failed: ${e.message}`));
    return;
  }
  if (seq !== routeSeq) return;
  const { current, tips, branches } = log.branches;
  const mark = (text) => {
    const i = text.toLowerCase().indexOf(s.search.toLowerCase());
    return i < 0 ? text : [text.slice(0, i), h('mark', text.slice(i, i + s.search.length)), text.slice(i + s.search.length)];
  };
  const chips = (refs) => {
    const chip = (b) => h(`a.chip${b === current ? '.current' : ''}`, {
      title: b === current ? 'Your branch' : `Compare ${b} with yours`,
      onclick: (e) => { e.stopPropagation(); if (b !== current) writeHash({ file: refs.path, rev: tips[b], base: tips[current] || 'HEAD', ref: b, with: current }, true); },
    }, b);
    const list = refs.list;
    if (list.length === branches.length) return [h('span.muted', 'every branch')];
    const shown = list.slice(0, BRANCHES_SHOWN).map(chip);
    if (list.length > BRANCHES_SHOWN) {
      const more = h('a.chip.more', { onclick: (e) => { e.stopPropagation(); more.replaceWith(...list.slice(BRANCHES_SHOWN).map(chip)); } }, `+${list.length - BRANCHES_SHOWN}`);
      shown.push(more);
    }
    return shown;
  };
  const files = new Map();
  for (const hit of r.hits) {
    if (!files.has(hit.path)) files.set(hit.path, []);
    files.get(hit.path).push(hit);
  }
  main.replaceChildren(h('div.search-view',
    h('div.search-head', h('h2', `“${s.search}”`), h('span.muted', `${plural(r.hits.length, 'line')} in ${plural(files.size, 'file')}${r.truncated ? ' (first 500)' : ''} across ${plural(branches.length, 'branch', 'branches')}`)),
    r.hits.length ? null : h('p.empty-state', 'No branch has it.'),
    [...files].map(([path, hits]) => {
      // lines on the same branches say so once, in the file's header
      const shared = hits.every((x) => x.refs.join() === hits[0].refs.join());
      return h('section.search-file',
      h('div.search-file-head', h('span.mono', path), shared ? h('div.search-refs', chips({ list: hits[0].refs, path })) : null),
      hits.map((hit) => h('div.search-hit', {
        // open the line here when this branch has the file; otherwise the first branch that has it
        onclick: () => (live.configFor(hit.path) && hit.refs.includes(current)
          ? (rendered.canvas = null, writeHash({ file: hit.path, L: `${hit.line}` }, true))
          : writeHash({ file: hit.path, rev: tips[hit.refs[0]], base: tips[current] || 'HEAD', ref: hit.refs[0], with: current }, true)),
      },
      h('span.search-line.mono', hit.line), h('code.search-text', mark(hit.text)),
      shared ? null : h('div.search-refs', chips({ list: hit.refs, path: hit.path })))));
    })));
  main.scrollTop = 0;
}

// ------------------------------------------------------------------ XML pane

const xmlShown = () => prefs.get('xml') === '1';
/** Where the XML pane's file is drawn: the canvas, or in a comparison that file's section (its newer side). */
const xmlRoot = () => (diff ? document.querySelector(`#main section.diff-file[data-file="${CSS.escape(rendered.file || '')}"]`) : $('main'));
// an element of the comparison's older side only (removed): its lines are not in the file shown
const shownSide = (el) => !el.closest('[data-id^="was:"]');

function renderXml(file, s) {
  xml = null;
  const config = project.configFor(file);
  const pane = $('xml');
  pane.hidden = !xmlShown() || !config;
  $('xml-toggle').classList.toggle('active', xmlShown());
  pane.querySelector('.xml-view')?.remove();
  if (pane.hidden) return;
  xml = xmlPane(config.source, (from, to) => {
    const p = new URLSearchParams(location.hash.slice(1));
    p.set('L', from === to ? `${from}` : `${from}-${to}`);
    window.history.replaceState(null, '', `#${p}`);
    pointAt(from, to);
  }, adapter.versions && project === live ? elementHistory(file) : null);
  pane.append(xml.el);
  if (s.sel) showLines(s.sel, false);
}

/** "20" or "20-25" (also GitHub's "L20-L25") -> [20, 25] */
function parseLines(L) {
  const m = /^L?(\d+)(?:-L?(\d+))?$/.exec(L || '');
  return m && [+m[1], +(m[2] || m[1])].sort((a, b) => a - b);
}

/**
 * Pulses the canvas elements that XML lines from..to define: those wholly inside the lines
 * (outermost only), else the smallest element around them. From a link (scroll), the pane also shows the lines.
 */
function pointAt(from, to, scroll = false) {
  const els = [...(xmlRoot()?.querySelectorAll('[data-line]') || [])].filter(shownSide)
    .map((el) => ({ el, from: +el.dataset.line, to: +el.dataset.end }));
  const inside = els.filter((e) => e.from >= from && e.to <= to);
  let hits = inside.filter((e) => !inside.some((o) => o !== e && o.el.contains(e.el)));
  if (!hits.length) {
    const around = els.filter((e) => e.from <= from && e.to >= to);
    hits = around.length ? [around.reduce((a, b) => (b.to - b.from < a.to - a.from ? b : a))] : [];
  }
  document.querySelectorAll('#main .xml-hit').forEach((el) => el.classList.remove('xml-hit'));
  for (const { el } of hits) el.closest('.flow')?.classList.remove('collapsed');
  void document.body.offsetWidth;
  hits.forEach(({ el }) => el.classList.add('xml-hit'));
  xmlIds = hits.map(({ el }) => el.closest('[data-id]')?.dataset.id).filter(Boolean);
  // two smooth scrolls started together cancel each other, and a link opens the page anyway
  const behavior = scroll ? 'instant' : 'smooth';
  hits[0]?.el.scrollIntoView({ block: scroll ? 'center' : 'nearest', inline: 'nearest', behavior });
  const targets = hits.map((e) => [e.from, e.to]);
  xml?.show(scroll ? [[from, to]] : targets, { scroll: scroll && behavior, pulse: scroll, targets });
}

/** Marks the XML lines of the selected element. */
function showLines(id, pulse) {
  if (!xml) return;
  document.querySelectorAll('#main .xml-hit').forEach((el) => el.classList.remove('xml-hit'));
  const el = id && xmlRoot()?.querySelector(`[data-id="${CSS.escape(id)}"][data-line]`);
  xmlIds = el ? [id] : [];
  xml.show(el ? [[+el.dataset.line, +el.dataset.end]] : [], { scroll: pulse ? 'smooth' : 'instant', pulse });
}

// ------------------------------------------------------------------ element history

function fileVersions(file) {
  if (!versions.has(file)) {
    const p = adapter.versions(file).then((v) => new FileVersions(v, live.configFor(file).source));
    p.catch(() => versions.delete(file));
    versions.set(file, p);
  }
  return versions.get(file);
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const shortDate = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The XML pane's history button: what changed the marked elements, and where their copy differs. */
function elementHistory(file) {
  const of = async (ranges) => {
    const fv = await fileVersions(file);
    const keys = fv.keysAt(ranges);
    return keys.length ? { fv, ...fv.history(keys) } : null;
  };
  return {
    async label(ranges) {
      const r = await of(ranges);
      if (!r) return null;
      const changes = r.commits.length + (r.uncommitted ? 1 : 0);
      const changedThere = r.branches.filter((b) => b.state !== 'behind').length;
      return [changes ? plural(changes, 'change') : 'History', changedThere ? plural(changedThere, 'branch', 'branches') : null]
        .filter(Boolean).join(' · ');
    },
    async open(ranges, anchor) {
      const r = await of(ranges);
      if (!r) return;
      const sel = xmlIds[0];
      const s = readHash();
      const go = (state) => { pop.remove(); writeHash({ file: s.file, flow: s.flow, sel, ...state }, true); };
      const item = (onclick, title, meta) => h('li', h('a', { onclick, title }, title), meta ? h('div.muted', meta) : null);
      const current = (log.branches ??= await adapter.branches()).current || 'HEAD';
      const head = r.fv.v.head.sha;
      // a branch opens as a merge preview of the side that changed the element since they split
      const preview = (b) => (b.state === 'behind'
        ? { rev: head, base: b.base.sha, vs: b.sha, into: b.name, ref: null }
        : { rev: b.sha, base: b.base?.sha || head, vs: head, into: current, ref: b.name });
      const group = (state, title, absent) => {
        const list = r.branches.filter((b) => b.state === state);
        return list.length ? [h('div.pop-group', title(list.length)),
          h('ul.links', list.map((b) => item(() => go(preview(b)), b.name, b.absent ? absent : null)))] : [];
      };
      const pop = h('div.popover.history-pop',
        group('diverged', (n) => `Changed here and on ${plural(n, 'branch', 'branches')}`, 'removed there'),
        group('ahead', (n) => `Changed on ${plural(n, 'branch', 'branches')}`, 'removed there'),
        group('behind', (n) => `Older on ${plural(n, 'branch', 'branches')}`, 'not there yet'),
        h('div.pop-group', 'Changes'),
        h('ul.links',
          r.uncommitted ? item(() => go({ rev: WORKTREE, base: null, ref: null }), 'Uncommitted changes') : null,
          r.commits.map((c) => item(
            // a commit off this branch opens on a branch that has it
            () => go({ rev: c.sha, base: null, ref: c.onHead ? null : c.source || null }), c.subject,
            [c.short, c.author, shortDate(c.date), c.kind !== 'changed' ? c.kind : null].filter(Boolean).join(' · ')))),
        !r.commits.length && !r.uncommitted ? h('div.muted', 'No commits change it in the last 300 of this file.') : null);
      document.querySelector('.popover')?.remove();
      const box = anchor.getBoundingClientRect();
      document.body.append(pop);
      const height = pop.offsetHeight;
      pop.style.left = `${Math.max(8, box.right - pop.offsetWidth)}px`;
      pop.style.top = `${box.top - height - 4 > 8 ? box.top - height - 4 : box.bottom + 4}px`;
      setTimeout(() => document.addEventListener('click', (e) => { if (!pop.contains(e.target)) pop.remove(); }, { once: true }));
    },
  };
}

function setupPanelResize() {
  const panel = $('panel');
  const saved = +prefs.get('panelWidth');
  if (saved) panel.style.width = `${saved}px`;
  $('panel-resize').onpointerdown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    document.body.classList.add('resizing');
    const move = (ev) => { panel.style.width = `${Math.max(320, Math.min(window.innerWidth - 360, startW + startX - ev.clientX))}px`; };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      prefs.set('panelWidth', panel.offsetWidth);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  };
}

function setupXmlPane() {
  $('xml-toggle').onclick = () => {
    prefs.set('xml', xmlShown() ? '0' : '1');
    renderXml(rendered.file, readHash());
  };
  const pane = $('xml');
  const saved = +prefs.get('xmlHeight');
  if (saved) pane.style.height = `${saved}px`;
  pane.querySelector('.xml-resize').onpointerdown = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = pane.offsetHeight;
    const move = (ev) => { pane.style.height = `${Math.max(80, Math.min(window.innerHeight - 160, startH + startY - ev.clientY))}px`; };
    const up = () => {
      document.removeEventListener('pointermove', move);
      prefs.set('xmlHeight', pane.offsetHeight);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  };
}

function renderPanel(s) {
  const panel = $('panel');
  const ctx = { project, icons, env, diff, engine, compareEngine: diff ? engine : null, onNavigate: navigate, onSelect: select, openDwl, close: closePanel, askKey, toggleWide, openPlayground,
    onTrace: diff ? null : (name) => writeHash({ file: readHash().file, trace: name }, true), usedBy: diff ? null : usedByOwn(), onImage: exportFlow };
  if (diff?.conflicts && s.vs) {
    const current = log.branches?.current;
    // the same merge seen from the other side
    ctx.otherSide = {
      name: s.into,
      open: () => writeHash({ file: s.file, flow: s.flow, sel: s.sel, rev: s.vs, base: s.base, vs: s.rev,
        into: s.ref || current, ref: s.into === current ? null : s.into }, true),
    };
  }
  let content = null;
  if (s.src && project.texts.has(s.src)) {
    content = renderSourcePanel(s.src, +s.L || 0, ctx);
  } else if (s.lib) content = renderLibraryPanel(s, ctx);
  else if (s.dwl) content = diff ? renderDwlDiff(s.dwl, ctx) : renderDwlDetails(s.dwl, ctx);
  else if (s.props && diff) content = renderPropertiesDiff(s.props, ctx);
  else if (s.sel) {
    const hit = diff ? diff.byId.get(s.sel) : project.byId.get(s.sel) || [...project.globals.values()].find((g) => g.id === s.sel);
    const item = hit?.item || hit;
    if (item) content = diff ? renderDiffDetails(item, ctx) : renderDetails(item, ctx);
  }
  panel.hidden = !content;
  $('panel-resize').hidden = !content;
  if (!content) document.body.classList.remove('panel-wide');
  panel.replaceChildren(...(content ? [content] : []));
  panel.scrollTop = 0;
}

// ------------------------------------------------------------------ text search (this version's files)

const indexes = new WeakMap();   // project -> [{path, lines, lower}], built on the first search
const TEXT_HITS = 300;

function textIndex(p) {
  if (!indexes.has(p)) {
    indexes.set(p, [...p.texts].map(([path, text]) => {
      const lines = text.split('\n');
      return { path, lines, lower: lines.map((l) => l.toLowerCase()) };
    }));
  }
  return indexes.get(p);
}

/** Where a line of a file leads: the element it belongs to, the DataWeave file, or the file at that line. */
function openHit(path, line) {
  const s = readHash();
  if (project.configFor(path)) {
    let best = null;
    for (const { item, flow } of project.byId.values()) {
      const n = item.node;
      if (item.file !== path || !n || n.line > line || n.endLine < line) continue;
      if (!best || n.endLine - n.line < best.item.node.endLine - best.item.node.line) best = { item, flow };
    }
    if (best) return navigate(best.flow.name, best.item === best.flow ? null : best.item.id);
  }
  const res = resourcePath(path);
  if (res?.endsWith('.dwl')) return openDwl(res);
  writeHash({ file: s.file, flow: s.flow, src: path, L: `${line}` }, true);
}

/** Lines of this version's files containing the query (any case), grouped by file, under the flows. */
function textHits(q) {
  if (q.length < 2) return [];
  const files = [];
  let n = 0;
  for (const f of textIndex(project)) {
    const hits = [];
    for (let i = 0; i < f.lower.length && n < TEXT_HITS; i++) {
      if (f.lower[i].includes(q)) { hits.push(i); n++; }
    }
    if (hits.length) files.push({ f, hits });
    if (n >= TEXT_HITS) break;
  }
  const mark = (text) => {
    const i = text.toLowerCase().indexOf(q);
    return i < 0 ? text : [text.slice(0, i), h('mark', text.slice(i, i + q.length)), text.slice(i + q.length)];
  };
  return [
    h('div.tree-group', files.length ? `Text · ${n >= TEXT_HITS ? `first ${TEXT_HITS}` : plural(n, 'line')}` : 'Text · no matches in this version'),
    ...files.map(({ f, hits }) => h('div.text-file',
      h('div.text-file-name.mono', { title: f.path }, f.path.replace(/^src\/main\/(mule|resources)\//, '')),
      hits.map((i) => h('a.text-hit', { title: f.lines[i].trim(), onclick: () => openHit(f.path, i + 1) },
        h('span.text-line', i + 1), h('span.text-snippet.mono', mark(f.lines[i].trim().slice(0, 160))))))),
    adapter.search ? h('a.text-everywhere', { onclick: () => writeHash({ file: readHash().file, search: $('search').value.trim() }, true) },
      `Search every branch for “${$('search').value.trim()}”`) : null,
  ];
}

function renderTree(currentFile, currentFlow) {
  const q = $('search').value.trim().toLowerCase();
  const tree = $('tree');
  tree.replaceChildren(...project.configs.map((c) => {
    const flows = c.flows.filter((f) => f.name && (!q || f.name.toLowerCase().includes(q)));
    if (q && !flows.length) return null;
    const open = q || c.path === currentFile;
    return h('div.tree-file',
      h(`a.tree-file-name${c.path === currentFile ? '.active' : ''}`,
        { onclick: () => writeHash({ file: c.path }, true) }, c.path.replace(MULE_DIR, '')),
      open ? h('ul', flows.map((f) =>
        h('li', h(`a${f.name === currentFlow ? '.active' : ''}`, { title: f.name, onclick: () => navigate(f.name) },
          h('img', { src: icons.url(f.key), alt: '' }), f.name)))) : null);
  }).filter(Boolean), ...textHits(q));
}

const STATUS_LETTER = { added: 'A', removed: 'D', changed: 'M' };

function renderDiffTree(currentFile, currentFlow) {
  const q = $('search').value.trim().toLowerCase();
  const s = readHash();
  const configs = [...diff.configs.values()].filter((c) => c.status || c.textChanged);
  const others = diff.files.filter((f) => !f.path.startsWith(MULE_DIR) && (!q || f.path.toLowerCase().includes(q)));
  const mark = (status, indirect) => h(`span.st.${status || 'changed'}${indirect ? '.indirect' : ''}`,
    { title: indirect ? 'Affected by changed DataWeave or property values' : status }, indirect ? '•' : STATUS_LETTER[status] || 'M');

  $('tree').replaceChildren(...[
    ...configs.map((c) => {
      const flows = c.flows.filter((f) => f.diff && f.name && (!q || f.name.toLowerCase().includes(q)));
      if (q && !flows.length) return null;
      return h('div.tree-file',
        h(`a.tree-file-name${c.path === currentFile ? '.active' : ''}`, { onclick: () => writeHash({ file: c.path }, true) },
          mark(c.status, !c.textChanged), c.path.replace(MULE_DIR, '')),
        h('ul', flows.map((f) => h('li', h(`a.diff-${f.diff}${f.name === currentFlow ? '.active' : ''}`, { title: f.name, onclick: () => navigate(f.name) },
          h('img', { src: icons.url(f.key), alt: '' }), f.name)))));
    }).filter(Boolean),
    others.length ? h('div.tree-group', 'Other files') : null,
    ...others.map((f) => {
      const res = resourcePath(f.path);
      const onclick = res?.endsWith('.dwl') ? () => openDwl(res)
        : /\.(ya?ml|properties)$/.test(f.path) ? () => openProps(f.path) : null;
      const active = (res && s.dwl === res) || s.props === f.path;
      return h(`${onclick ? 'a' : 'span'}.tree-file-name.other${active ? '.active' : ''}`, { title: f.path, onclick },
        mark(f.status), (res || f.path).split('/').slice(-2).join('/'));
    }),
    ...textHits(q),
  ].filter(Boolean));
}

/**
 * A link copied from any code host (file, lines, branch) opened here; selection: text selected on that page;
 * text: the page's text, where a pull request names its branches ("source into target"): then it opens as a
 * merge preview of the source into the target.
 */
/** pr: {source, target} when the code host has said which branches the page's pull request has (else its text tells). */
async function openLink(url, selection = '', text = '', pr = null) {
  log.branches ??= adapter.branches ? await adapter.branches() : { current: '', branches: [], tips: {} };
  const at = await locate({ url, selection, text }, { files: live.allPaths || [], branches: log.branches.branches, read: (p) => adapter.read(p) });
  if (pr) at.pr = pr;
  const { current, tips } = log.branches;
  if (at.pr && tips[at.pr.source] && tips[at.pr.target] && adapter.mergeBase) {
    const base = await adapter.mergeBase(tips[at.pr.target], tips[at.pr.source]);
    if (base) {
      const file = at.path && live.configFor(at.path) ? at.path : null;
      return writeHash({ file, rev: tips[at.pr.source], base, vs: tips[at.pr.target], ref: at.pr.source, into: at.pr.target }, true);
    }
  }
  if (!at.path || !live.configFor(at.path)) return;
  $('search').value = '';
  const L = at.lines && (at.lines[0] === at.lines[1] ? `${at.lines[0]}` : at.lines.join('-'));
  if (at.branch && at.branch !== current && tips[at.branch]) {
    return writeHash({ file: at.path, rev: tips[at.branch], base: tips[current] || 'HEAD', ref: at.branch, with: current }, true);
  }
  rendered.canvas = null;   // the lines apply when the file renders, even if it is open already
  writeHash({ file: at.path, L }, true);
}

// ------------------------------------------------------------------ changed but not tested

const untested = new WeakMap();   // diff -> Set of ids of changed elements no MUnit test reaches

/**
 * Marks the diff's added and changed elements that no MUnit test (in the newer version) runs through.
 * Done in slices so a large diff never blocks the page.
 */
/** A branch comparison: differences the other branch made are dimmed, and each says who made it. */
function markSides(d) {
  if (!d.sides) return;
  for (const [id, side] of d.sides.items) {
    const item = d.byId.get(id)?.item;
    for (const el of $('main').querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) {
      el.classList.toggle('by-base', side === 'base');
      el.title = sideText(item?.diff, side, d.sides.names);
    }
  }
}

async function markUntested(d) {
  if (!untested.has(d)) {
    const head = d.head;
    const out = new Set();
    if (head.tests?.length) {
      const changed = [...d.byId.values()].filter(({ item, flow }) => item !== flow && flow && (item.diff === 'added' || item.diff === 'changed'));
      for (let i = 0; i < changed.length; i++) {
        const own = head.byId.get(changed[i].item.id);
        if (own && !testSamples(head, [{ processor: own.item, flow: own.flow }]).length) out.add(changed[i].item.id);
        if (i % 20 === 19) await new Promise((r) => setTimeout(r));
        if (diff !== d) return;
      }
    }
    out.noTests = !head.tests?.length;
    untested.set(d, out);
  }
  if (diff !== d) return;
  const ids = untested.get(d);
  for (const id of ids) {
    const el = document.querySelector(`#main .node[data-id="${CSS.escape(id)}"]`);
    if (el) { el.classList.add('untested'); el.title = `${el.title ? `${el.title} · ` : ''}No MUnit test runs this`; }
  }
  const meta = $('commit-meta');
  meta.querySelector('.untested-count')?.remove();
  const note = ids.noTests ? 'no MUnit tests in this version' : ids.size ? `${plural(ids.size, 'changed element')} no test runs` : null;
  if (note) meta.append(h('span.untested-count', ` · ${note}`));
  for (const l of d.libraries || []) {
    meta.append(h('span.untested-count', ` · ${l.artifactId} ${l.from} → ${l.to}${l.flows.length ? `, changes ${plural(l.flows.length, 'flow')} used here` : ''}`));
  }
  fullTitle(meta);
}

// ------------------------------------------------------------------ release notes

async function showNotes(label) {
  const s = readHash();
  const branch = s.ref || log.branches?.current || '';
  const title = s.vs ? `${branch}: ${label}` : s.with ? `${s.ref} compared with ${s.with}` : s.base ? `${branch}: ${label}` : label;
  let commits = [];
  if (s.rev !== WORKTREE && adapter.log) {
    commits = s.base ? (await adapter.log(s.base, s.rev).catch(() => ({ commits: [] }))).commits
      : diff.revs.commit ? [diff.revs.commit] : [];
  }
  openNotes(releaseNotes(diff, { title: title.replace(/\s+/g, ' ').trim(), commits, libraries: diff.libraries || [], reached: impactOf(diff).entries }));
}

// ------------------------------------------------------------------ impact of a comparison

const impacts = new WeakMap();   // diff -> impact()
function impactOf(d) {
  if (!impacts.has(d)) impacts.set(d, impact(d));
  return impacts.get(d);
}

function renderImpactRoute() {
  leaveCanvas();
  $('xml').hidden = true;
  $('panel').hidden = true;
  renderDiffTree(null, null);
  const open = (c) => {
    if (c.via) return writeHash({ file: readHash().file, lib: c.label }, true);
    if (c.global) return writeHash({ file: c.file, sel: c.id }, true);
    writeHash({ file: c.file, flow: c.flow, sel: c.whole ? null : c.id }, true);
  };
  const openProperty = (p) => writeHash({ file: readHash().file, props: p.file }, true);
  $('main').replaceChildren(renderImpactView(impactOf(diff), { open, openProperty }));
  $('main').scrollTop = 0;
}

// ------------------------------------------------------------------ shared library flows

/** A flow from a shared library: drawn, with the library versions that changed it; libv compares with another. */
function renderLibraryPanel(s, ctx) {
  const up = diff?.libraries?.find((l) => l.flows.includes(s.lib));
  const hit = (diff ? diff.libFlows : libFlows)?.get(s.lib);
  if (!hit && !up) return null;
  const { lib, flow } = hit || {};
  const body = h('div.lib-canvas');
  const versionsEl = h('div.lib-versions');
  const flowCtx = (p, d) => ({ project: p, icons, diff: d, onSelect: () => {}, onNavigate: () => {}, onCallers: () => {} });
  const only = (config) => ({ ...config, flows: config.flows.filter((f) => f.name === s.lib), globals: [] });
  const show = async (version) => {
    body.replaceChildren(h('p.muted', 'Loading…'));
    if (up && !version) {
      const config = [...up.diff.configs.values()].find((c) => c.flows.some((f) => f.name === s.lib));
      return body.replaceChildren(renderConfig(only(config), flowCtx(up.diff.head, up.diff)));
    }
    if (!version || version === lib.version) return body.replaceChildren(renderConfig(only(hit.project.configFor(flow.file)), flowCtx(hit.project, null)));
    const other = await libraries.project({ ...lib, version });
    const d = diffProjects(hit.project, other);
    const config = [...d.configs.values()].find((c) => c.flows.some((f) => f.name === s.lib));
    body.replaceChildren(config ? renderConfig(only(config), flowCtx(other, d)) : h('p.muted', `${version} has no ${s.lib}.`));
  };
  if (lib) {
    libraries.history(lib, s.lib).then((list) => versionsEl.replaceChildren(...list.map((v) => h(
      `a.chip${v.version === lib.version ? '.current' : ''}${v.changed ? '.changed' : ''}${v.has ? '' : '.absent'}${v.version === s.libv ? '.picked' : ''}`, {
        title: v.version === lib.version ? 'The version this project uses' : v.has ? `${v.changed ? 'Changes this flow' : 'Same as the version before'}: click to compare with ${lib.version}` : 'Not in this version',
        onclick: () => writeHash({ ...readHash(), libv: v.version === lib.version ? null : v.version }, false),
      }, v.version))));
  }
  show(s.libv);
  return h('div.details',
    header(icons.url(flow?.key || 'core:flow'), s.lib, up ? `${up.artifactId} ${up.from} → ${up.to}` : `${lib.artifactId} ${lib.version}`, ctx),
    lib ? section('Versions', versionsEl) : null,
    h('section.details-section', body),
    lib && adapter.usedBy ? usedBySection(adapter.usedBy(lib.artifactId), s.lib, lib.artifactId) : null);
}

// ------------------------------------------------------------------ checks, trace, used by

const checked = new WeakMap();   // project -> {libs, list}

/** The project's checks, knowing its libraries' flows once they have arrived. */
/** The library flows of the version shown: the working copy's, or a comparison's newer side's. */
const shownLibFlows = () => (diff && project === diff.head ? diff.libFlows : project === live ? libFlows : null);

function projectChecks() {
  const libs = shownLibFlows();
  const hit = checked.get(project);
  if (hit && hit.libs === libs) return hit.list;
  const libraryProjects = [...new Set([...(libs?.values() || [])].map((x) => x.project))];
  const list = checks(project, {
    libraryFlows: new Set(libs?.keys() || []),
    libraryTexts: libraryProjects.flatMap((p) => [...p.texts.values()]),
  });
  checked.set(project, { libs, list });
  return list;
}

function showChecksCount() {
  const n = attention(projectChecks());
  $('checks-toggle').hidden = false;
  $('checks-count').hidden = !n;
  $('checks-count').textContent = n;
}

function renderChecksRoute() {
  leaveCanvas();
  $('xml').hidden = true;
  $('panel').hidden = true;
  renderTree(null, null);
  const open = (c) => {
    if (c.id && c.flow) return writeHash({ file: c.file, flow: c.flow, sel: c.id }, true);
    if (c.id && live.configFor(c.file)) return writeHash({ file: c.file, sel: c.id }, true);
    if (live.configFor(c.file)) return writeHash({ file: c.file, L: c.line ? `${c.line}` : null }, true);
    writeHash({ file: defaultFile(), src: c.file, L: c.line ? `${c.line}` : null }, true);
  };
  $('main').replaceChildren(renderChecksView(projectChecks(), { open }));
  $('main').scrollTop = 0;
}

function renderTraceRoute(s) {
  leaveCanvas();
  $('xml').hidden = true;
  $('panel').hidden = true;
  renderTree(null, s.trace);
  const t = trace(project, s.trace, { libraryFlows: shownLibFlows() || new Map() });
  const own = (step) => step.project === project && !!step.item;
  const open = (step) => { if (own(step)) writeHash({ file: step.flow.file, flow: step.flow.name, sel: step.item.id }, true); };
  $('main').replaceChildren(renderTraceView(t, { icons, own, open }));
  $('main').scrollTop = 0;
}

function renderOverviewRoute(s) {
  leaveCanvas();
  $('xml').hidden = true;
  $('panel').hidden = true;
  renderTree(null, null);
  const libs = shownLibFlows();
  const ctx = {
    project, env, tab: s.app,
    libraryFlows: libs || new Map(),
    libraryTexts: [...new Set([...(libs?.values() || [])].map((x) => x.project))].flatMap((p) => [...p.texts.values()]),
    libraryMap: adapter.libraryMap || null,
    repoName: adapter.repo || adapter.name,
    askKey,
    hasKey: (e) => !!keyFor(e),
    commits: adapter.commitsOn && adapter.branches ? { branches: () => adapter.branches(), on: commitsOn } : null,
    onTab: (tab) => writeHash({ file: readHash().file, app: tab }, false),
    openFlow: (name) => navigate(name),
    openItem: (item, flow) => writeHash({ file: flow.file, flow: flow.name, sel: item.id }, true),
    openSource: (file, line) => writeHash({ file: defaultFile(), src: file, L: line ? `${line}` : null }, true),
  };
  $('main').replaceChildren(renderOverview(ctx));
  $('main').scrollTop = 0;
}

/** A branch's commits for the Commits overview, read once per repository. */
const commitLists = new WeakMap();
function commitsOn(branch) {
  if (!commitLists.has(adapter)) commitLists.set(adapter, new Map());
  const cache = commitLists.get(adapter);
  if (!cache.has(branch)) cache.set(branch, adapter.commitsOn(branch).catch((e) => { cache.delete(branch); throw e; }));
  return cache.get(branch);
}

/** A flow of the canvas as an image: copied to the clipboard, or saved as a PNG or an SVG. */
async function exportFlow(flow, format, button) {
  // as drawn on the canvas; a flow not drawn there is drawn for the image alone
  const card = [...document.querySelectorAll('#main section.flow')].find((el) => el.dataset.flow === flow.name)
    || renderConfig({ flows: [flow], globals: [] }, canvasCtx()).querySelector('section.flow');
  const label = button.textContent;
  const done = (text) => { button.textContent = text; setTimeout(() => { button.textContent = label; }, 1600); };
  const name = flow.name.replace(/[\\/:*?"<>|]+/g, '-');
  try {
    if (format === 'svg') {
      const { svg } = await elementSvg(card);
      saveBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
      done('Saved');
    } else if (format === 'png') {
      saveBlob(await elementPng(card), `${name}.png`);
      done('Saved');
    } else {
      // the clipboard takes a promise, so the click still counts as the user's when the image is ready
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': elementPng(card) })]);
      done('Copied');
    }
  } catch (e) {
    done('Could not');
    console.warn('image export:', e);
  }
}

/** For a library's own flows: which apps of the same owner call each one (null for an app). */
function usedByOwn() {
  if (!adapter.usedBy || !isLibrary(project)) return null;
  const artifactId = parsePom(project.texts.get('pom.xml') || '').artifactId;
  return artifactId ? (name) => usedBySection(adapter.usedBy(artifactId), name, artifactId) : null;
}

// ------------------------------------------------------------------ secure:: properties

/**
 * Keys for secure properties, per environment. They live in this tab only (sessionStorage: a reload keeps them,
 * closing the tab forgets them) and never leave the page: values are decrypted here (secure.js).
 */
const keyName = (e) => `mfv.securekey.${adapter?.name || ''}.${e}`;
const keyFor = (e) => { try { return sessionStorage.getItem(keyName(e)); } catch { return null; } };
const keepKey = (e, k) => { try { if (k) sessionStorage.setItem(keyName(e), k); else sessionStorage.removeItem(keyName(e)); } catch { /* unavailable */ } };

async function applySecrets(p, e, key = keyFor(e)) {
  if (!e || !secureConfigs(p).length) return null;
  p.secrets ??= new Map();
  if (!key) { p.secrets.delete(e); return null; }
  const r = await decryptAll(p, e, key);
  p.secrets.set(e, r.values);
  return r;
}

/**
 * Every environment's key given in this tab, applied to the live project and every version loaded so far (the
 * Properties table shows them all); the button lights up when the selected environment's values are decrypted.
 */
async function applySecretsEverywhere() {
  const envs = live.environments.length ? live.environments : [env];
  const results = await Promise.all(envs.map((e) => applySecrets(live, e)));
  const loaded = await Promise.all([...projectsAt.values()].map((p) => p.catch(() => null)));
  await Promise.all(loaded.filter(Boolean).flatMap((p) => envs.map((e) => applySecrets(p, e).catch(() => null))));
  const r = results[envs.indexOf(env)];
  $('secure-key').classList.toggle('active', !!r?.values.size);
  return r;
}

/** After a key is given or forgotten, or Env changes: what shows property values draws them again. */
function redrawValues() {
  const s = readHash();
  if (s.app) renderOverviewRoute(s);
  else renderPanel(s);
}

/**
 * The key for one environment's secure:: values (the selected one unless `forEnv` says), in a popover under `anchor`.
 * A key that works is also tried on the environments without one: projects often share a key.
 */
function askKey(forEnv = env, anchor = $('secure-key')) {
  document.querySelector('.popover')?.remove();
  const cfg = secureConfigs(live)[0];
  if (!cfg) return;
  const name = /\$\{([^}]+)\}/.exec(cfg.key)?.[1] || 'key';
  const input = h('input.mono', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: name });
  const note = h('div.muted.secure-note');
  const submit = async () => {
    const key = input.value;
    if (!key) return;
    const r = await applySecrets(live, forEnv, key).catch((e) => ({ values: new Map(), errors: [{ message: e.message }] }));
    const wrong = r.errors.filter((x) => x.message === 'wrong key');
    if (!r.values.size) {
      note.textContent = r.errors.length && !wrong.length ? r.errors[0].message : `That key does not decrypt the ${forEnv} values.`;
      note.classList.add('error');
      return;
    }
    keepKey(forEnv, key);
    for (const other of live.environments.filter((x) => x !== forEnv && !keyFor(x))) {
      const t = await decryptAll(live, other, key).catch(() => null);
      if (t?.values.size && !t.errors.some((x) => x.message === 'wrong key')) keepKey(other, key);
    }
    await applySecretsEverywhere();
    pop.remove();
    redrawValues();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  const known = !!keyFor(forEnv);
  const pop = h('div.popover.secure-pop',
    h('div.pop-group', `secure:: properties · ${forEnv}`),
    h('div.secure-row', input, h('button.run-button', { onclick: submit }, 'Decrypt')),
    note,
    h('div.muted.secure-note', `${cfg.algorithm}/${cfg.mode}${cfg.randomIvs ? ', random IVs' : ''} (from ${cfg.name || 'the secure properties config'}). Kept in this tab only, never saved or sent.`),
    known ? h('a', { onclick: async () => { keepKey(forEnv, null); await applySecretsEverywhere(); pop.remove(); redrawValues(); } }, 'Forget the key') : null);
  const box = anchor.getBoundingClientRect();
  pop.style.top = `${box.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(box.left - 140, window.innerWidth - 340))}px`;
  document.body.append(pop);
  input.focus();
  setTimeout(() => document.addEventListener('mousedown', function away(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', away); }
  }));
}

// ------------------------------------------------------------------ colour by age / author

const dwlLast = new Map();      // resources-relative .dwl path -> Promise<last commit on this branch | null>
function lastDwlChange(path) {
  if (!dwlLast.has(path)) dwlLast.set(path, adapter.history([`src/main/resources/${path}`]).then((r) => r.commits[0] || null, () => null));
  return dwlLast.get(path);
}

/** The .dwl file an element reads itself (not through an element nested in it). */
function resourceOf(node) {
  for (const c of node.children) {
    if (c.attrs['doc:id']) continue;
    if (/\.dwl$/.test(c.attrs.resource || '')) return c.attrs.resource.replace(/^classpath:\/*/, '');
    const r = resourceOf(c);
    if (r) return r;
  }
  return null;
}

async function paintCanvas(file) {
  const main = $('main');
  clearBlame(main);
  const mode = prefs.get('colour');
  if (!mode || diff || project !== live || !adapter.versions || !live.configFor(file)) return;
  const fv = await fileVersions(file);
  const blame = fv.blame();
  const byLines = new Map([...fv.live.byKey].map(([k, n]) => [`${n.line}:${n.endLine}`, [k, n]]));
  // a transform's DataWeave file is part of it: its newer change wins
  const dwl = new Map();
  for (const [, n] of byLines.values()) {
    const r = resourceOf(n);
    if (r && !dwl.has(r)) dwl.set(r, await lastDwlChange(r));
  }
  if (rendered.file !== file || diff || prefs.get('colour') !== mode) return;
  const entryAt = (from, to) => {
    const [k, n] = byLines.get(`${from}:${to}`) || [];
    if (!k) return null;
    const e = blame.get(k) || null;
    const d = dwl.get(resourceOf(n));
    return d && e !== 'uncommitted' && (!e || new Date(d.date) > new Date(e.date)) ? d : e;
  };
  clearBlame(main);
  main.append(paintBlame(main, entryAt, mode));
}

// ------------------------------------------------------------------ which branch is on screen

/** The checked-out branch next to the project name (a dot: uncommitted changes); picking another compares it with yours. */
async function showWhere() {
  const el = $('where');
  if (!adapter.branches) return;
  log.branches ??= await adapter.branches();
  log.all ??= await adapter.history([], '');
  const { current, tips, branches } = log.branches;
  const head = log.all.head?.slice(0, 7);
  const viewing = !diff && project !== live ? readHash().at : null;
  el.hidden = false;
  el.classList.toggle('viewing', !!viewing);
  el.replaceChildren(...[h('span.where-icon'), h('span.where-name', viewing || current || `detached at ${head}`),
    viewing ? h('span.where-tag', 'read-only') : null,
    !viewing && log.all.dirty ? h('span.where-dirty', { title: 'Uncommitted changes in your working copy' }) : null].filter(Boolean));
  el.title = viewing
    ? `Showing ${viewing} as it is on that branch (read-only). Click to open another branch or go back to yours.`
    : adapter.remote ? `Showing ${current}, the branch the page is on. Click to open another branch.`
      : `${current ? `Checked out: ${current}` : `Detached HEAD at ${head}`}${log.all.dirty ? ', with uncommitted changes' : ''}. The canvas shows your working copy; click to open another branch.`;
  $('where-back').hidden = !viewing;
  el.onclick = async () => {
    const r = await pickBranch(el, { branches, current, value: viewing || current, currentLabel: hereLabel(), actions: ['Open', adapter.remote ? `Compare with ${current}` : 'Compare with yours'] });
    if (!r) return;
    const s = readHash();
    if (r.branch === current && r.action === 'Open') return writeHash({ file: s.file, flow: s.flow, rev: null }, true);
    if (r.action === 'Open') return writeHash({ file: s.file, flow: s.flow, rev: null, at: r.branch }, true);
    writeHash({ file: s.file, rev: tips[r.branch], base: tips[current] || log.all.head, ref: r.branch, with: current || head }, true);
  };
  $('where-back').onclick = () => { const s = readHash(); writeHash({ file: s.file, flow: s.flow, rev: null }, true); };
}

// ------------------------------------------------------------------ ⌘K

async function showPalette() {
  if (!live) return;
  if (adapter.branches) log.branches ??= await adapter.branches();
  const { current, tips = {}, branches = [] } = log.branches || {};
  const s = readHash();
  const items = [
    ...[...project.flows.values()].map((f) => ({
      group: 'Flows', label: f.name, hint: f.file.replace(MULE_DIR, ''), icon: icons.url(f.key), run: () => navigate(f.name),
    })),
    ...project.configs.map((c) => ({ group: 'Files', label: c.path.replace(MULE_DIR, ''), run: () => writeHash({ file: c.path }, true) })),
    ...branches.filter((b) => b !== current).map((b) => ({
      group: 'Compare a branch with yours', label: b,
      run: () => writeHash({ file: s.file, rev: tips[b], base: tips[current] || 'HEAD', ref: b, with: current }, true),
    })),
    // a release tag compared with yours: what has changed since it (then Release notes in the bar)
    ...(log.branches?.tags || []).map((t) => ({
      group: 'Compare a tag with yours', label: t,
      run: () => writeHash({ file: s.file, rev: tips[current] || 'HEAD', base: tips[t], with: t }, true),
    })),
    ...[
      ['Branches side by side', () => $('grid-toggle').click(), adapter.history],
      ['History', () => $('history').click(), adapter.history],
      ['Show or hide the XML', () => $('xml-toggle').click(), true],
      ['Light or dark theme', () => $('theme').click(), true],
      ['DataWeave playground', () => $('play-toggle').click(), true],
      // the icon pack is in the toolbar on wide screens only
      ...[...icons.packs].map(([id, pk]) => [`Icons: ${pk.name}`, () => { $('icon-pack').value = id; $('icon-pack').onchange(); }, icons.packs.size > 1]),
      ...(location.protocol === 'chrome-extension:' ? [['Setup guide', () => window.open(chrome.runtime.getURL('setup.html#welcome')), true]] : []),
    ].filter(([, , on]) => on).map(([label, run]) => ({ group: 'Commands', label, run })),
  ];
  openPalette(items, { onLink: openLink, onSearch: adapter.search ? (text) => writeHash({ file: s.file, search: text }, true) : null });
}

// ------------------------------------------------------------------ theme

function setupTheme() {
  const button = $('theme');
  const show = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    button.textContent = dark ? '☾' : '☀';
    button.title = dark ? 'Dark (click for light)' : 'Light (click for dark)';
  };
  button.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    prefs.set('theme', next);
    show();
  };
  // follow the system until a theme is picked here
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!prefs.get('theme')) { document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'; show(); }
  });
  show();
}

function showCallers(flow, anchor) {
  document.querySelector('.popover')?.remove();
  const callers = project.callers.get(flow.name) || [];
  const r = anchor.getBoundingClientRect();
  const pop = h('div.popover', { style: `top:${r.bottom + 4}px;left:${Math.max(8, r.right - 280)}px` },
    h('ul.links', callers.map((c) => h('li',
      h('a', { onclick: () => { pop.remove(); navigate(c.flow.name, c.processor?.id); } }, c.flow.name),
      h('span.muted', ` ${c.flow.file.replace(MULE_DIR, '')}${c.dynamic ? ' · lookup()' : ''}`)))));
  document.body.append(pop);
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }));
}

// ------------------------------------------------------------------ setup

function setupControls() {
  const packSelect = $('icon-pack');
  packSelect.replaceChildren(...[...icons.packs].map(([id, p]) => h('option', { value: id }, p.name)));
  packSelect.value = icons.active;
  $('icons-wrap').hidden = icons.packs.size < 2;
  packSelect.onchange = () => {
    icons.use(packSelect.value);
    prefs.set('icons', packSelect.value);
    rerender();
  };

  $('env-wrap').hidden = !live.environments.length;
  $('env').replaceChildren(...live.environments.map((e) => h('option', { value: e }, e)));
  $('env').value = env || '';
  $('env').onchange = async () => {
    env = $('env').value;
    prefs.set('env', env);
    await applySecretsEverywhere();
    redrawValues();
  };
  $('secure-key').hidden = !secureConfigs(live).length;
  $('secure-key').onclick = () => askKey();

  $('history').hidden = !adapter.history;
  $('colour-wrap').hidden = !adapter.versions;
  $('colour').value = prefs.get('colour') || '';
  $('colour').onchange = () => {
    prefs.set('colour', $('colour').value);
    if (!diff) paintCanvas(rendered.file);
  };
  $('grid-toggle').hidden = !adapter.history;
  showChecksCount();
  $('overview-toggle').onclick = () => {
    const s = readHash();
    writeHash(s.app ? { file: s.file, flow: s.flow } : { file: s.file, app: 'endpoints' }, true);
  };
  $('checks-toggle').onclick = () => {
    const s = readHash();
    writeHash(s.checks ? { file: s.file, flow: s.flow } : { file: s.file, checks: '1' }, true);
  };
  $('play-toggle').onclick = () => {
    const s = readHash();
    writeHash(s.play ? { file: s.file, flow: s.flow } : { file: s.file, play: '1' }, true);
  };
  $('grid-toggle').onclick = async () => {
    const s = readHash();
    if (s.grid) return writeHash({ file: s.file, flow: s.flow }, true);
    log.branches ??= await adapter.branches();
    writeHash({ file: s.file, grid: defaultColumns(log.branches).join(',') }, true);
  };
  $('xml-toggle').hidden = false;
  $('history').onclick = async () => {
    const s = readHash();
    if (s.rev) return writeHash({ file: s.file, flow: s.flow, rev: null }, true);
    const list = await commitList(s.file);
    const first = list.dirty ? WORKTREE : list.commits[0]?.sha;
    if (first) openCommit(first);
  };
  $('branch').onclick = async () => {
    const { branches, current } = log.branches;
    const picked = await pickBranch($('branch'), { branches, current, value: $('branch').dataset.value, currentLabel: hereLabel() });
    if (!picked || picked === $('branch').dataset.value) return;
    const ref = picked === current ? null : picked;
    const list = await commitList(readHash().file, ref || '');
    const first = firstOf(list);
    if (first) openCommit(first, ref);
  };
  $('commit-pick').onclick = async () => {
    const picked = await pickCommit($('commit-pick'), { items: commitItems, value: $('commit').value });
    if (picked && picked !== $('commit').value) openCommit(picked);
  };
  $('impact-toggle').onclick = () => {
    const s = readHash();
    writeHash(s.impact ? { file: s.file, flow: s.flow } : { file: s.file, impact: '1' }, true);
  };
  $('older').onclick = () => { stopReplay(); step(1); };
  $('newer').onclick = () => { stopReplay(); step(-1); };
  $('replay').onclick = toggleReplay;
  let scrubTimer = null;
  $('scrub').oninput = () => {
    stopReplay();
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => openCommit(replaySteps[+$('scrub').value]), 220);
  };
  $('file-only').onchange = async () => {
    log.fileOnly = $('file-only').checked;
    const s = readHash();
    const list = await commitList(s.file || defaultFile(), s.ref || '');
    if (!s.base && (s.rev === WORKTREE ? !list.dirty : !list.commits.some((c) => c.sha === s.rev))) {
      const first = firstOf(list);
      if (first) return openCommit(first);
    }
    renderDiffBar(s);
  };
}

function rerender() {
  rendered.canvas = null;
  keptCanvas = null;
  route();
}

async function open(a) {
  $('main').replaceChildren(h('div.empty-state', 'Loading…'));
  adapter = a;
  [live, engine] = await Promise.all([loadProject(a, catalog), a.dataweave?.().catch(() => null) ?? null]);
  libraries = a.library ? new Libraries(a, catalog) : null;
  libFlows = null;
  // library flows arrive after the first paint; the canvas redraws once they are known
  libraries?.flows().then((m) => { libFlows = m; showChecksCount(); if (m.size && !diff) rerender(); });
  project = live;
  diff = null;
  projectsAt.clear();
  versions.clear();
  Object.assign(log, { ref: null, all: null, file: null, filePath: null, branches: null });
  const saved = prefs.get('env');
  env = live.environments.includes(saved) ? saved : live.environments.find((e) => e === 'local') || live.environments[0] || null;
  $('project-name').textContent = a.name;
  document.title = `${a.name} · Mule Flow Viewer`;
  rendered = { file: null, flow: null, rev: null };
  setupControls();
  showWhere();
  await applySecretsEverywhere();
  route();
  // what a search of every branch reads, read ahead once the page has drawn
  if (a.warm) setTimeout(() => a.warm(), 4000);
}

async function boot() {
  const [, cat] = await Promise.all([
    icons.loadPack('mulesoft', new URL('../icon-packs/mulesoft/', location.href)),
    fetch('../catalog/connectors.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (cat) catalog = cat;
  icons.use(prefs.get('icons') || 'mulesoft');

  $('back').onclick = () => window.history.back();
  $('forward').onclick = () => window.history.forward();
  $('search').oninput = async () => {
    if (!project) return;
    if (/^https?:\/\//.test($('search').value.trim())) return openLink($('search').value.trim());
    if (diff) renderDiffTree(rendered.file, readHash().flow);
    else renderTree(rendered.file, readHash().flow);
  };
  $('open-folder').hidden = !('showDirectoryPicker' in window);
  $('open-folder').onclick = async () => {
    try {
      const a = await localFolderAdapter();
      window.history.replaceState(null, '', location.pathname);
      await open(a);
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
  };
  window.addEventListener('popstate', route);
  installTooltips($('main'));
  setupXmlPane();
  setupPanelResize();
  setupTheme();
  $('palette-open').onclick = showPalette;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); showPalette(); }
  });

  const session = await extensionSession();
  if (session?.remote) return openRemote(session);
  const a = await devServerAdapter('', session?.server).catch(() => null);
  if (a) {
    await open(a);
    // which clone this is: there may be several of one repository
    if (session?.reply?.project) $('project-name').title = session.reply.project;
    if (session?.link) openLink(session.link, session.selection, `${session.title || ''}\n${session.text || ''}`);
  } else if (session !== undefined) {
    $('main').replaceChildren(h('div.empty-state', session
      ? 'The local helper stopped. Click the extension button on the repository page again.'
      : 'Open a repository page (GitHub, GitLab, Bitbucket, Azure DevOps…) and click the extension button, or open a folder.'));
  }
}

/** What the current branch is: the clone's checked-out one, or the one the page showed (read from the code host). */
const hereLabel = () => (adapter?.remote ? 'this page' : 'checked out');

/** A repository read from its code host with the browser's sign-in (Azure DevOps): nothing local is needed. */
async function openRemote(session) {
  $('main').replaceChildren(h('div.empty-state', 'Loading…'));
  let a;
  try {
    const { tokens = {} } = await chrome.storage.local.get('tokens');
    a = await remoteAdapter(session.remote.url, { apiOrigin: session.remote.apiOrigin, dataweave: helperEngine, tokens });
  } catch (e) {
    if (e.code === 'token') return askToken(e, session);
    const site = /^https?:\/\/[^/]+/.exec(session.remote.url)?.[0];
    $('main').replaceChildren(h('div.empty-state', e.message,
      e.code === 'sign-in' && site ? h('div', h('a', { href: site, target: '_blank', rel: 'noopener' }, `Open ${site.replace(/^https:\/\//, '')}`)) : null));
    return;
  }
  await open(a);
  if (session.link) openLink(session.link, session.selection, `${session.title || ''}\n${session.text || ''}`, a.pullRequest);
}

/** A host whose API ignores the browser's sign-in (GitHub): a read-only token, asked for once and kept in this browser. */
function askToken(e, session) {
  const input = h('input.mono', { type: 'password', placeholder: 'Token', spellcheck: 'false', autocomplete: 'off' });
  const save = h('button.run-button', { type: 'submit' }, 'Save');
  const form = h('form.token-form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (!input.value.trim()) return;
      const { tokens = {} } = await chrome.storage.local.get('tokens');
      await chrome.storage.local.set({ tokens: { ...tokens, [e.site]: input.value.trim() } });
      openRemote(session);
    },
  }, input, save);
  $('main').replaceChildren(h('div.empty-state.token-ask',
    h('p', e.message),
    h('p.muted', 'Create one with read-only access to the repositories you want (Contents and Metadata: Read-only). It is kept in this browser and sent only to ', `api.${e.site}`, '.'),
    h('p', h('a', { href: e.tokenUrl, target: '_blank', rel: 'noopener' }, 'Create a token')),
    form));
  input.focus();
}

/** Running DataWeave needs the local helper (MuleSoft's engine is a program, not a web page): null without it. */
async function helperEngine() {
  const r = await chrome.runtime?.sendNativeMessage?.('mule_flow_viewer.helper', { type: 'dw' }).catch(() => null);
  return r?.ok ? serverEngine(r) : null;
}

/**
 * In the extension: what the toolbar button handed over (chrome.storage.session, keyed by #s=), as
 * {server: {base, token}, link, selection}; null when nothing was handed over; undefined outside the extension.
 * The key moves to sessionStorage, so a reload keeps the server but does not jump to the link again.
 */
async function extensionSession() {
  if (location.protocol !== 'chrome-extension:') return undefined;
  const p = new URLSearchParams(location.hash.slice(1));
  let key = p.get('s');
  let fresh = !!key;
  if (key) {
    p.delete('s');
    window.history.replaceState(null, '', `#${p}`);
    sessionStorage.setItem('mfv.session', key);
  } else {
    key = sessionStorage.getItem('mfv.session');
  }
  if (!key) return null;
  const data = (await chrome.storage.session.get(key))[key];
  if (!data) return null;
  if (!fresh) return { server: data.server, reply: data.reply, remote: data.remote };
  return data;
}

boot();
