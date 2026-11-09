// Side panel: properties of a selected element, its DataWeave, and DataWeave modules
// with their dependency graph (imports, importers, transforms that use them).

import { h } from './dom.js';
import { scriptsOf, walkFlow } from './model.js';
import { sourceOf } from './xml.js';
import { dwImports, modulePath, dwPropertyRefs, dwLookups, highlightDataWeave, highlightXml } from './dataweave.js';
import { placeholderKeys } from './properties.js';
import { renderRunner } from './runner.js';
import { scriptSource } from './script-history.js';

export const HIDDEN_ATTRS = /^(xmlns(:.*)?|xsi:schemaLocation|doc:id|doc:name)$/;

/**
 * ctx: {project, icons, env, onNavigate(flowName, selectId?), onSelect(item), openDwl(path), close(), scriptView?(code), engine?}
 * engine: a local DataWeave engine (see runner.js); scripts get a Run block when it is there.
 */
export function renderDetails(item, ctx) {
  const config = ctx.project.configFor(item.file);
  const isFlow = ['flow', 'sub-flow', 'error-handler'].includes(item.kind) && item.name !== undefined;
  return h('div.details',
    header(ctx.icons.url(item.key), isFlow ? item.name : item.label, item.key, ctx),
    item.kind === 'flow-ref' ? flowRefTarget(item, ctx) : null,
    attributes(item.node, ctx),
    item.routes ? routes(item) : null,
    item.key === 'apikit:router' ? apikitRoutes(item, ctx) : null,
    isFlow ? flowLinks(item, ctx) : null,
    !isFlow ? scriptSections(item, ctx) : null,
    item.name && !isFlow ? configUsers(item, ctx) : null,
    config ? xmlSource(item.node, config.source) : null);
}

export function renderDwlDetails(path, ctx) {
  const d = ctx.project.dwl.get(path);
  const users = ctx.project.dwlUsers.get(path) || [];
  const importers = ctx.project.dwlImporters.get(path) || [];
  return h('div.details',
    header(dwIcon(), path.split('/').pop(), path, ctx),
    d ? null : h('p.notice', 'This module is not in the project. It most likely comes from a dependency.'),
    users.length ? section('Used in', h('ul.links', users.map((u) =>
      h('li', h('a', { onclick: () => ctx.onNavigate(u.flow.name, u.processor.id) }, u.processor.label),
        h('span.muted', ` ${u.label} · ${u.flow.name}`))))) : null,
    importers.length ? section('Imported by', h('ul.links', importers.map((p) =>
      h('li', h('a', { onclick: () => ctx.openDwl(p) }, p))))) : null,
    d && dependencies(d.code, ctx) ? section('Depends on', dependencies(d.code, ctx)) : null,
    d ? section('Script', ctx.scriptView ? ctx.scriptView(d.code) : [code(d.code), runnable(d.code) ? runner(d.code, `dwl:${path}`, ctx, users, { source: { path: `src/main/resources/${path}` } }) : null]) : null);
}

export function header(icon, title, subtitle, ctx) {
  return h('header.details-head',
    h('img', { src: icon, alt: '' }),
    h('div', h('h2', title), h('div.muted.mono', subtitle)),
    ctx.toggleWide ? h('button.close.wide-toggle', { title: 'Full window (Esc to leave)', onclick: ctx.toggleWide }) : null,
    h('button.close', { title: 'Close', onclick: ctx.close }, '×'));
}

export const section = (title, ...body) => h('section.details-section', h('h3', title), body);
export const scriptSection = (label, ...body) => h('section.details-section', h('h3.script-label', label), body);

export function code(text, html = highlightDataWeave(text)) {
  return h('pre.code', h('code', { html }));
}

export function dwIcon() {
  return `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#00A1E0"/><text x="24" y="24" dy=".35em" text-anchor="middle" font-family="system-ui" font-weight="700" font-size="15" fill="#fff">DW</text></svg>')}`;
}

/**
 * A resolved property's value: secure:: ones are masked until clicked, and encrypted ones (no key given yet)
 * offer the key dialog.
 */
export function propertyValue(r, ctx, tag = 'span.mono.value') {
  if (r.locked) return h('a.secure-locked', { title: 'Encrypted: enter the key to see it', onclick: (e) => { e.stopPropagation(); ctx.askKey?.(); } }, '🔒 encrypted');
  if (!r.secure) return h(tag, r.value);
  const el = h(`${tag}.secure-masked`, { title: 'Decrypted with your key: click to show', onclick: (e) => {
    e.stopPropagation();
    const shown = el.classList.toggle('shown');
    el.textContent = shown ? r.value : '••••••••';
  } }, '••••••••');
  return el;
}

function resolved(value, ctx) {
  const keys = placeholderKeys(value);
  if (!keys.length) return null;
  return h('div.resolved', keys.map((k) => {
    const r = ctx.project.resolveProperty(k, ctx.env);
    return h('div', { title: r ? `${r.file}:${r.line}` : 'Not found in the project (set at deploy time?)' },
      h('span.mono', k), ' = ', r ? propertyValue(r, ctx) : h('span.muted', 'not set in the project'));
  }));
}

function attributes(node, ctx) {
  const rows = Object.entries(node.attrs).filter(([k]) => !HIDDEN_ATTRS.test(k));
  if (!rows.length) return null;
  return section('Properties', h('table.props', rows.map(([k, v]) => {
    let value = h('span.mono', v);
    if (k === 'config-ref' && ctx.project.globals.has(v)) {
      value = h('a.mono', { onclick: () => ctx.onSelect(ctx.project.globals.get(v)) }, v);
    }
    return h('tr', h('th', k), h('td', value, resolved(v, ctx)));
  })));
}

function flowRefTarget(p, ctx) {
  if (p.dynamic) return h('p.notice', 'The target is computed at runtime.');
  if (!ctx.project.flows.has(p.target)) return h('p.notice', `${p.target} is defined outside this project (a dependency).`);
  return h('p', h('a.button', { onclick: () => ctx.onNavigate(p.target) }, `Go to ${p.target}`));
}

function routes(p) {
  return section('Routes', h('table.props', p.routes.map((r) =>
    h('tr', h('th', r.label), h('td', r.expr ? h('span.mono', r.expr) : h('span.muted', '—'))))));
}

function apikitRoutes(p, ctx) {
  const targets = ctx.project.apikitTargets(p.node.attrs['config-ref']);
  if (!targets.length) return null;
  return section('Routes to', h('table.props', targets.map((t) => h('tr',
    h('th.mono', t.label),
    h('td', ctx.project.flows.has(t.flow) ? h('a', { onclick: () => ctx.onNavigate(t.flow) }, t.flow) : h('span.muted', t.flow))))));
}

function flowLinks(flow, ctx) {
  const callers = ctx.project.callers.get(flow.name) || [];
  const calls = [];
  walkFlow(flow, (p) => { if (p.kind === 'flow-ref') calls.push(p); });
  return [
    ctx.onTrace || ctx.onImage ? h('div.details-actions',
      ctx.onTrace && flow.kind !== 'error-handler' ? h('button', { title: 'Every step as it runs, into the flows it calls, with the variables each sets and reads', onclick: () => ctx.onTrace(flow.name) }, 'Trace') : null,
      ctx.onImage ? h('div.seg.image-actions', { title: 'The flow as drawn here, as an image' },
        h('button', { onclick: (e) => ctx.onImage(flow, 'copy', e.currentTarget) }, 'Copy image'),
        h('button', { onclick: (e) => ctx.onImage(flow, 'png', e.currentTarget) }, 'PNG'),
        h('button', { onclick: (e) => ctx.onImage(flow, 'svg', e.currentTarget) }, 'SVG')) : null) : null,
    ctx.usedBy ? ctx.usedBy(flow.name) : null,
    callers.length ? section('Called by', h('ul.links', callers.map((c) =>
      h('li', h('a', { onclick: () => ctx.onNavigate(c.flow.name, c.processor?.id) }, c.flow.name),
        c.dynamic ? h('span.muted', ' via lookup()') : null)))) : null,
    calls.length ? section('Calls', h('ul.links', calls.map((c) => {
      const known = ctx.project.flows.has(c.target);
      return h('li', known && !c.dynamic
        ? h('a', { onclick: () => ctx.onNavigate(c.target) }, c.target)
        : h('span.muted', c.target, c.dynamic ? ' (dynamic)' : ' (external)'));
    }))) : null,
  ];
}

function scriptSections(p, ctx) {
  return scriptsOf(p).map((s) => {
    const text = ctx.project.scriptCode(s);
    const path = s.resource?.replace(/^classpath:\/*/, '');
    return scriptSection(s.label,
      path ? h('p', h('a.mono', { onclick: () => ctx.openDwl(path) }, path)) : null,
      text == null ? h('p.notice', 'File not found in the project.') : [dependencies(text, ctx), code(text), runner(text, `${p.file}:${p.id}:${s.label}`, ctx, [{ processor: p, flow: ctx.project.byId.get(p.id)?.flow }], { source: scriptSource(p, s) })]);
  });
}

/** A module that only declares functions has no body to run. */
const runnable = (text) => /^\s*---\s*$/m.test(text) || !/^\s*%dw/m.test(text);
const runner = (text, key, ctx, sites, opts) => (ctx.engine ? renderRunner(text, key, ctx, sites.filter((s) => s.flow), opts) : null);

function dependencies(text, ctx) {
  const imports = dwImports(text);
  const props = dwPropertyRefs(text);
  const lookups = dwLookups(text);
  if (!imports.length && !props.length && !lookups.length) return null;
  return h('div.deps',
    imports.map((m) => {
      const path = modulePath(m);
      return path
        ? h('a.chip', { title: path, onclick: () => ctx.openDwl(path) }, `import ${m}`)
        : h('span.chip.muted', `import ${m}`);
    }),
    lookups.map((f) => ctx.project.flows.has(f)
      ? h('a.chip', { onclick: () => ctx.onNavigate(f) }, `lookup ${f}`)
      : h('span.chip.muted', `lookup ${f}`)),
    props.map((k) => {
      const r = ctx.project.resolveProperty(k, ctx.env);
      return h('span.chip', { title: r ? `${r.file}:${r.line}` : 'Not set in the project' },
        k, ' = ', r ? propertyValue(r, ctx, 'b') : h('i', 'unset'));
    }));
}

function configUsers(g, ctx) {
  const users = [];
  for (const { item, flow } of ctx.project.byId.values()) {
    if (item.node?.attrs?.['config-ref'] === g.name && item !== flow) users.push({ item, flow });
  }
  if (!users.length) return null;
  return section('Used by', h('ul.links', users.map((u) =>
    h('li', h('a', { onclick: () => ctx.onNavigate(u.flow.name, u.item.id) }, u.item.label), h('span.muted', ` · ${u.flow.name}`)))));
}

function xmlSource(node, src) {
  const text = sourceOf(node, src);
  const lines = text.split('\n');
  const gutter = lines.map((_, i) => node.line + i).join('\n');
  return h('details.details-section.source-view',
    h('summary', h('h3', `XML · line ${node.line}`)),
    h('div.code-with-gutter', h('pre.gutter', gutter), h('pre.code', h('code', { html: highlightXml(text) }))));
}
