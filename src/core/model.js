// Turns a parsed Mule configuration file into the structure Studio draws:
// flows -> (source, processor chain, error handling), with scopes and routers nested.

const KNOWN_NS = {
  'http://www.mulesoft.org/schema/mule/core': 'core',
  'http://www.mulesoft.org/schema/mule/ee/core': 'ee',
  'http://www.mulesoft.org/schema/mule/batch': 'batch',
  'http://www.mulesoft.org/schema/mule/ee/batch': 'batch',
  'http://www.mulesoft.org/schema/mule/documentation': 'doc',
};

const ROUTERS = {
  'core:choice': ['when', 'otherwise'],
  'core:scatter-gather': ['route'],
  'core:first-successful': ['route'],
  'core:round-robin': ['route'],
};

const SCOPES = new Set([
  'core:try', 'core:foreach', 'core:parallel-foreach', 'core:until-successful', 'core:async',
  'ee:cache', 'batch:job', 'batch:step', 'batch:aggregator', 'batch:on-complete',
]);

const CORE_SOURCES = new Set(['core:scheduler']);
const LABELS = {
  'ee:transform': 'Transform Message',
  'core:flow-ref': 'Flow Reference',
  'core:foreach': 'For Each',
  'core:parallel-foreach': 'Parallel For Each',
  'core:async': 'Async',
  'core:on-error-continue': 'On Error Continue',
  'core:on-error-propagate': 'On Error Propagate',
};

/** Canonical prefix for a namespace URI: what icons and the catalog are keyed by. */
export function canonicalPrefix(node, catalog) {
  if (!node.ns) return node.prefix || 'core';
  const known = KNOWN_NS[node.ns] ?? catalog?.byNamespace?.[node.ns];
  if (known) return known;
  return node.ns.replace(/\/+$/, '').split('/').pop().replace(/^mule-/, '');
}

export const keyOf = (node, catalog) => `${canonicalPrefix(node, catalog)}:${node.local}`;

export function defaultLabel(key) {
  if (LABELS[key]) return LABELS[key];
  const local = key.split(':')[1];
  return local.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function isSource(key, catalog) {
  if (CORE_SOURCES.has(key)) return true;
  const [prefix, local] = key.split(':');
  const known = catalog?.connectors?.[prefix]?.sources;
  if (known) return known.includes(local);
  return /listener$|^on-new|trigger$|polling-source$/.test(local);
}

export function buildConfig(path, parsed, catalog) {
  const ctx = { path, catalog, seq: 0 };
  const config = { path, source: parsed.source, flows: [], globals: [], errorHandlers: [] };

  for (const node of parsed.root.children) {
    const key = keyOf(node, catalog);
    if (key === 'core:flow' || key === 'core:sub-flow') {
      config.flows.push(buildFlow(node, key, ctx));
    } else if (key === 'core:error-handler') {
      const handler = buildErrorHandler(node, ctx);
      handler.kind = 'error-handler';
      handler.name = node.attrs.name;
      config.flows.push(handler);
      config.errorHandlers.push(handler);
    } else if (canonicalPrefix(node, catalog) !== 'doc') {
      config.globals.push({
        key,
        node,
        file: path,
        name: node.attrs.name,
        label: node.attrs['doc:name'] || node.attrs.name || defaultLabel(key),
        id: node.attrs['doc:id'] || `${path}:${node.line}`,
      });
    }
  }
  return config;
}

function buildFlow(node, key, ctx) {
  const flow = {
    kind: key === 'core:flow' ? 'flow' : 'sub-flow',
    key,
    name: node.attrs.name,
    node,
    file: ctx.path,
    id: node.attrs['doc:id'] || `${ctx.path}:${node.line}`,
    source: null,
    processors: [],
    errorHandler: null,
  };
  node.children.forEach((child, i) => {
    const childKey = keyOf(child, ctx.catalog);
    if (childKey === 'core:error-handler') flow.errorHandler = buildErrorHandler(child, ctx);
    else if (i === 0 && flow.kind === 'flow' && isSource(childKey, ctx.catalog)) flow.source = buildProcessor(child, ctx, 'source');
    else if (canonicalPrefix(child, ctx.catalog) !== 'doc') flow.processors.push(buildProcessor(child, ctx));
  });
  return flow;
}

function buildErrorHandler(node, ctx) {
  return {
    key: 'core:error-handler',
    node,
    file: ctx.path,
    id: node.attrs['doc:id'] || `${ctx.path}:${node.line}`,
    ref: node.attrs.ref || null,
    handlers: node.children.map((child) => {
      const p = buildProcessor(child, ctx, 'scope');
      p.errorType = child.attrs.type || null;
      p.when = child.attrs.when || null;
      return p;
    }),
  };
}

function buildProcessor(node, ctx, forcedKind) {
  const key = keyOf(node, ctx.catalog);
  const p = {
    key,
    node,
    file: ctx.path,
    id: node.attrs['doc:id'] || `${ctx.path}:${node.line}:${ctx.seq++}`,
    label: node.attrs['doc:name'] || defaultLabel(key),
    kind: forcedKind || 'processor',
  };

  if (ROUTERS[key]) {
    p.kind = 'router';
    p.routes = node.children
      .filter((c) => ROUTERS[key].includes(c.local))
      .map((r) => ({
        node: r,
        label: r.local === 'otherwise' ? 'Default' : r.local === 'when' ? 'When' : 'Route',
        expr: r.attrs.expression || null,
        processors: r.children.map((c) => buildProcessor(c, ctx)),
      }));
    // Studio always draws the Default branch of a Choice, even without <otherwise>
    if (key === 'core:choice' && !p.routes.some((r) => r.label === 'Default')) {
      p.routes.push({ node, label: 'Default', expr: null, processors: [], implicit: true });
    }
  } else if (SCOPES.has(key) || forcedKind === 'scope') {
    p.kind = 'scope';
    p.body = [];
    for (const child of node.children) {
      const childKey = keyOf(child, ctx.catalog);
      if (childKey === 'core:error-handler') p.errorHandler = buildErrorHandler(child, ctx);
      else if (childKey === 'batch:process-records') p.body.push(...child.children.map((c) => buildProcessor(c, ctx)));
      else p.body.push(buildProcessor(child, ctx));
    }
  } else if (key === 'core:flow-ref') {
    p.kind = 'flow-ref';
    p.target = node.attrs.name || '';
    p.dynamic = p.target.startsWith('#[');
  }
  return p;
}

/** Visit every processor of a flow (source, chain, routes, scopes, error handling). */
export function walkFlow(flow, fn) {
  const visitList = (list) => list?.forEach(visit);
  const visitHandler = (eh) => eh?.handlers?.forEach(visit);
  function visit(p) {
    fn(p);
    p.routes?.forEach((r) => visitList(r.processors));
    visitList(p.body);
    visitHandler(p.errorHandler);
  }
  if (flow.source) visit(flow.source);
  visitList(flow.processors);
  visitHandler(flow.kind === 'error-handler' ? flow : flow.errorHandler);
}

/**
 * DataWeave scripts carried by a processor: Transform Message targets, plus any
 * child element whose text is a script (http:headers, os:value, ...).
 */
export function scriptsOf(p) {
  const scripts = [];
  const push = (label, n) => {
    const code = n.text.trim();
    if (n.attrs.resource) scripts.push({ label, resource: n.attrs.resource, line: n.line });
    else if (code) scripts.push({ label, code, line: n.line });
  };
  if (p.key === 'ee:transform') {
    for (const group of p.node.children) {
      for (const target of group.local === 'message' || group.local === 'variables' ? group.children : [group]) {
        if (target.local === 'set-payload') push('payload', target);
        else if (target.local === 'set-attributes') push('attributes', target);
        else if (target.local === 'set-variable') push(`vars.${target.attrs.variableName}`, target);
      }
    }
    return scripts;
  }
  const visit = (n) => {
    for (const c of n.children) {
      if (c.children.length) visit(c);
      else if (c.text.trim() || c.attrs.resource) push(c.local, c);
    }
  };
  if (p.kind === 'processor' || p.kind === 'source' || p.kind === 'flow-ref') visit(p.node);
  return scripts;
}
