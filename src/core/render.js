// Studio-style canvas: each flow is a card with source, a left-to-right processor
// chain, nested scopes and routers, and an error-handling strip below.

import { h } from './dom.js';
import { walkFlow } from './model.js';

/**
 * ctx: {project, icons, selectedId, onSelect(item), onNavigate(flowName, selectId?), onCallers(flow, anchor), diff?,
 *   libraryFlow?(name) -> {lib} for flows from a shared library, onLibrary?(name), libraryChanged?: Set of their names}
 * With ctx.diff, `config` is a merged config from diff.js: items carry `diff` and unchanged flows are hidden.
 */
export function renderConfig(config, ctx) {
  if (!ctx.diff) {
    return h('div.canvas',
      config.flows.map((f) => renderFlow(f, ctx)),
      config.globals.length ? renderGlobals(config.globals, ctx) : null);
  }
  const unchanged = config.flows.filter((f) => !f.diff).length + config.globals.filter((g) => !g.diff).length;
  const canvas = h('div.canvas.diff',
    !config.status ? h('p.notice', 'No changes to flows in this file (formatting or comments only).') : null,
    config.flows.map((f) => renderFlow(f, ctx)),
    config.globals.length ? renderGlobals(config.globals, ctx) : null,
    unchanged ? h('button.unchanged-toggle', {
      onclick: (e) => {
        const on = canvas.classList.toggle('show-unchanged');
        e.currentTarget.textContent = on ? 'Hide unchanged' : `${unchanged} unchanged`;
      },
    }, `${unchanged} unchanged`) : null);
  return canvas;
}

const diffClass = (item) => (item.diff ? `.diff-${item.diff}` : '');
// merge preview: the other side changed this element too
const conflictClass = (item, ctx) => (ctx.diff?.conflicts?.has(item.id) ? '.conflict' : '');
// XML lines an element spans, for the XML pane (app.js)
const lines = (node) => (node ? { line: node.line, end: node.endLine } : {});

function diffBadge(flow, ctx) {
  let both = ctx.diff.conflicts?.has(flow.id) ? 1 : 0;
  if (ctx.diff.conflicts?.size) walkFlow(flow, (p) => { if (ctx.diff.conflicts.has(p.id)) both++; });
  const conflicts = both ? h('span.diff-badge.conflict', { title: `${both} changed on both sides: merging may conflict` }, `!${both}`) : null;
  if (flow.diff === 'added' || flow.diff === 'removed') return [h(`span.diff-badge.${flow.diff}`, flow.diff), conflicts];
  const c = flow.counts || {};
  return [...[['added', '+'], ['removed', '−'], ['changed', '~']]
    .filter(([k]) => c[k]).map(([k, sign]) => h(`span.diff-badge.${k}`, { title: `${c[k]} ${k}` }, `${sign}${c[k]}`)), conflicts];
}

function renderFlow(flow, ctx) {
  const callers = flow.name ? ctx.project.callers.get(flow.name) || [] : [];
  const head = h('div.flow-head',
    h('button.flow-toggle', { title: 'Collapse', onclick: (e) => { e.stopPropagation(); card.classList.toggle('collapsed'); } }),
    h('img.flow-icon', { src: ctx.icons.url(flow.key), alt: '' }),
    h('span.flow-name', { onclick: () => ctx.onSelect(flow) }, flow.name || '(unnamed)'),
    flow.kind !== 'flow' ? h('span.flow-kind', flow.name && flow.name === ctx.project.defaultErrorHandler ? 'default error handler' : flow.kind) : null,
    h('span.spacer'),
    callers.length
      ? h('button.callers', { title: 'Called by', onclick: (e) => ctx.onCallers(flow, e.currentTarget) }, `← ${callers.length}`)
      : null,
    ctx.diff && flow.diff ? diffBadge(flow, ctx) : null);

  let body;
  if (flow.kind === 'error-handler') {
    body = h('div.flow-body', renderHandlers(flow, ctx));
  } else {
    body = h('div.flow-body',
      flow.kind === 'flow' ? h('div.source', flow.source ? renderItem(flow.source, ctx) : h('div.empty', { title: 'No source' })) : null,
      renderChain(flow.processors, ctx));
  }
  const card = h(`section.flow.kind-${flow.kind}${diffClass(flow)}${ctx.diff && !flow.diff ? '.unchanged.collapsed' : ''}`, { dataset: { flow: flow.name || '', id: flow.id, ...lines(flow.node) } },
    head,
    h('div.flow-scroll', body, flow.errorHandler ? renderErrorHandling(flow.errorHandler, ctx) : null));
  if (ctx.selectedId === flow.id) card.classList.add('selected');
  return card;
}

function renderChain(list, ctx) {
  if (!list?.length) return h('div.chain', h('div.empty'));
  const items = [];
  list.forEach((p, i) => {
    if (i) items.push(h('div.arrow'));
    items.push(renderItem(p, ctx));
  });
  return h('div.chain', items);
}

function renderItem(p, ctx) {
  if (p.kind === 'router') return renderRouter(p, ctx);
  if (p.kind === 'scope') return renderScope(p, ctx);
  return renderNode(p, ctx, lines(p.node));
}

function renderNode(p, ctx, at = {}) {
  const classes = ['node'];
  if (p.diff) classes.push(`diff-${p.diff}`);
  if (conflictClass(p, ctx)) classes.push('conflict');
  let title = p.label;
  let sub = null;
  if (p.kind === 'flow-ref') {
    classes.push('ref');
    if (p.dynamic) {
      classes.push('dynamic');
      title = `Dynamic target: ${p.target}`;
    } else if (!ctx.project.flows.has(p.target) && ctx.libraryFlow?.(p.target)) {
      const { lib } = ctx.libraryFlow(p.target);
      classes.push('library');
      title = `In ${lib.artifactId} ${lib.version}: click to open it`;
      if (ctx.libraryChanged?.has(p.target)) {
        classes.push('lib-changed');
        title = `Changed by the ${lib.artifactId} upgrade: click to see how`;
      }
    } else if (!ctx.project.flows.has(p.target)) {
      classes.push('external');
      title = `${p.target} is defined outside this project (a dependency)`;
    } else {
      title = `Go to ${p.target}`;
    }
    if (p.target !== p.label) sub = p.target;
  }
  const el = h(`div.${classes.join('.')}`, {
    dataset: { id: p.id, ...at },
    title,
    onclick: (e) => {
      e.stopPropagation();
      if (p.kind === 'flow-ref' && !p.dynamic && ctx.project.flows.has(p.target) && !e.altKey) ctx.onNavigate(p.target);
      else if (p.kind === 'flow-ref' && !e.altKey && ctx.libraryFlow?.(p.target)) ctx.onLibrary(p.target);
      else ctx.onSelect(p);
    },
    oncontextmenu: (e) => { e.preventDefault(); ctx.onSelect(p); },
  },
  h('img.icon', { src: ctx.icons.url(p.key), alt: '' }),
  h('div.label', p.label),
  sub ? h('div.sub', sub) : null);
  if (ctx.selectedId === p.id) el.classList.add('selected');
  return el;
}

function scopeHead(p, ctx, extra) {
  return h('div.scope-head', {
    onclick: (e) => { e.stopPropagation(); ctx.onSelect(p); },
  }, h('img', { src: ctx.icons.url(p.key), alt: '' }), h('span', p.label), extra);
}

function renderScope(p, ctx) {
  const isHandler = p.key === 'core:on-error-continue' || p.key === 'core:on-error-propagate';
  const extra = isHandler && (p.errorType || p.when) ? h('span.scope-meta', p.errorType || p.when) : null;
  const el = h(`div.scope${isHandler ? '.handler' : ''}${diffClass(p)}${conflictClass(p, ctx)}`, { dataset: { id: p.id, ...lines(p.node) } },
    scopeHead(p, ctx, extra),
    h('div.scope-body', renderChain(p.body, ctx)),
    p.errorHandler ? renderErrorHandling(p.errorHandler, ctx) : null);
  if (ctx.selectedId === p.id) el.classList.add('selected');
  return el;
}

function renderRouter(p, ctx) {
  const whens = p.routes.filter((r) => r.label === 'When').length;
  let n = 0;
  return h('div.router', { dataset: { id: p.id, ...lines(p.node) } },
    renderNode(p, ctx),
    h('div.routes', p.routes.map((r, i) => {
      const label = r.label === 'When' && whens > 1 ? `When ${++n}` : r.label === 'Route' ? `Route ${i + 1}` : r.label;
      const bare = (expr) => expr.replace(/^#\[([\s\S]*)\]$/, '$1').trim();
      const tip = r.expr
        ? { tipTitle: label, tip: r.diff === 'changed' && r.base?.expr ? `${bare(r.expr)}\n\nwas: ${bare(r.base.expr)}` : bare(r.expr) }
        : r.label === 'Default' ? { tipTitle: 'Default', tip: r.implicit ? 'No otherwise branch: nothing runs when no condition matches' : 'Runs when no condition matches' } : {};
      return h(`div.route${diffClass(r)}`, { dataset: r.implicit ? {} : lines(r.node) },
        h(`div.branch${r.label === 'Default' ? '.default' : ''}`, {
          dataset: tip,
          onclick: (e) => { e.stopPropagation(); ctx.onSelect(p); },
        }, h('img', { src: ctx.icons.url(p.key), alt: '' }), h('span', label)),
        h('div.arrow'),
        renderChain(r.processors, ctx));
    })));
}

function renderHandlers(eh, ctx) {
  if (!eh.handlers.length) return h('div.empty');
  return h('div.handlers', eh.handlers.map((hd) => renderItem(hd, ctx)));
}

function renderErrorHandling(eh, ctx) {
  let content;
  if (eh.ref) {
    const known = ctx.project.flows.has(eh.ref);
    const lib = !known && ctx.libraryFlow?.(eh.ref)?.lib;
    const changed = lib && ctx.libraryChanged?.has(eh.ref);
    content = h(`div.node.ref${known ? '' : lib ? '.library' : '.external'}${changed ? '.lib-changed' : ''}${eh.diff === 'changed' ? '.diff-changed' : ''}`, {
      title: known ? `Go to ${eh.ref}` : lib ? `In ${lib.artifactId} ${lib.version}: click to open it` : `${eh.ref} is defined outside this project (a dependency)`,
      onclick: (e) => { e.stopPropagation(); if (known) ctx.onNavigate(eh.ref); else if (lib) ctx.onLibrary(eh.ref); },
    }, h('img.icon', { src: ctx.icons.url('core:error-handler'), alt: '' }), h('div.label', eh.ref));
  } else {
    content = renderHandlers(eh, ctx);
  }
  return h(`div.errors${eh.diff === 'added' || eh.diff === 'removed' ? diffClass(eh) : ''}`, { dataset: lines(eh.node) },
    h('div.errors-head', 'Error handling'), content);
}

function renderGlobals(globals, ctx) {
  return h('section.globals',
    h('div.globals-head', 'Global elements'),
    h('div.globals-list', globals.map((g) => {
      const el = h(`button.global${diffClass(g)}${conflictClass(g, ctx)}${ctx.diff && !g.diff ? '.unchanged' : ''}`, { dataset: { id: g.id, ...lines(g.node) }, title: g.key, onclick: () => ctx.onSelect(g) },
        h('img', { src: ctx.icons.url(g.key), alt: '' }), h('span', g.label));
      if (ctx.selectedId === g.id) el.classList.add('selected');
      return el;
    })));
}
