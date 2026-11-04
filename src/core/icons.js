// Icon packs are swappable. "builtin" is drawn here and contains no MuleSoft assets;
// file packs (e.g. icon-packs/studio-extracted) are a manifest mapping element keys to files.
// When a file pack is active and has no icon for an element, the built-in one is used.

const CORE = '#5F67FA';

// 24x24 stroke glyphs, drawn for this project.
const GLYPHS = {
  'core:flow': 'M5 12h12M13 8l4 4-4 4',
  'core:sub-flow': 'M4 12h8M9 9l3 3-3 3M14 7h6v10h-6',
  'core:flow-ref': 'M7 18v-7a4 4 0 0 1 4-4h7M15 4l3 3-3 3',
  'core:choice': 'M4 12h5l5-5h5M9 12l5 5h5M16 5l3 2-3 2M16 15l3 2-3 2',
  'core:scatter-gather': 'M4 12h4l4-5h7M8 12h11M8 12l4 5h7',
  'core:foreach': 'M18 9a6.5 6.5 0 1 0 1 5M19 4v5h-5',
  'core:parallel-foreach': 'M17 8a6 6 0 1 0 1 5M18 4v4h-4M8 12h4M8 15h4',
  'core:try': 'M12 3.5l7 3v5.5c0 4.2-3 7.2-7 8.5-4-1.3-7-4.3-7-8.5V6.5zM9 12l2 2 4-4',
  'core:until-successful': 'M5 12a7 7 0 0 1 12-5l2 2M19 4v5h-5M19 12a7 7 0 0 1-12 5',
  'core:first-successful': 'M5 12h9M11 8l4 4-4 4M18 6v12',
  'core:round-robin': 'M12 5a7 7 0 1 1-7 7M5 7v5h5',
  'core:async': 'M13 3L6 13h5l-1 8 7-10h-5z',
  'core:scheduler': 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM12 8v4.5l3 2',
  'core:logger': 'M7 6h10M7 10h10M7 14h10M7 18h6',
  'core:set-payload': 'M6 6h12v12H6zM9 12h6M12 9v6',
  'core:set-variable': 'M5 8l5 8M10 8l-5 8M13 10h6M13 14h6',
  'core:remove-variable': 'M5 8l5 8M10 8l-5 8M13 12h6',
  'core:raise-error': 'M12 4l8.5 15h-17zM12 10v4M12 16.5v.5',
  'core:error-handler': 'M12 4l8.5 15h-17zM12 10v4M12 16.5v.5',
  'core:on-error-continue': 'M10 5l7 12H3zM10 10v3M10 15v.5M18 9l3 3-3 3',
  'core:on-error-propagate': 'M12 6l7 12H5zM12 11v3M12 16v.5M12 2v2',
  'ee:transform': 'M5 9h12l-3-3M19 15H7l3 3',
  'ee:cache': 'M6 7c0-1.7 2.7-3 6-3s6 1.3 6 3-2.7 3-6 3-6-1.3-6-3zM6 7v10c0 1.7 2.7 3 6 3s6-1.3 6-3V7M6 12c0 1.7 2.7 3 6 3s6-1.3 6-3',
  'batch:job': 'M4 8l8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4',
  'batch:step': 'M4 10l8-4 8 4-8 4zM4 14l8 4 8-4',
  'batch:aggregator': 'M6 6h12M8 10h8M10 14h4M12 18v.5',
  'http:listener': 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16',
  'http:request': 'M11 4a7 7 0 1 0 0 14M4 11h7M11 4c-2 2-2 12 0 14M15 13l5 5M20 13v5h-5',
  'apikit:router': 'M4 12h5M9 12l5-6h6M9 12h11M9 12l5 6h6',
  generic: 'M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01',
};
const ALIASES = {
  'core:when': 'core:choice', 'core:otherwise': 'core:choice', 'core:route': 'core:scatter-gather',
  'core:idempotent-message-validator': 'core:try', 'core:parse-template': 'ee:transform',
  'ee:dynamic-evaluate': 'ee:transform', 'ee:invalidate-cache': 'ee:cache', 'ee:invalidate-key': 'ee:cache',
  'batch:on-complete': 'batch:aggregator',
};

const svgUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

function glyphIcon(path, color = CORE) {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="${color}"/>` +
    `<g transform="translate(12 12)" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></g></svg>`);
}

function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function monogram(prefix) {
  const text = prefix.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || '?';
  const size = text.length <= 2 ? 17 : text.length === 3 ? 14 : 11;
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="hsl(${hue(prefix)} 55% 46%)"/>` +
    `<text x="24" y="24" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="600" font-size="${size}" fill="#fff">${text}</text></svg>`);
}

export class Icons {
  constructor() {
    this.packs = new Map([['builtin', { name: 'Built-in' }]]);
    this.active = 'builtin';
    this.cache = new Map();
  }

  /** Load a file pack; silently skipped when it does not exist (e.g. never extracted). */
  async loadPack(id, baseUrl) {
    try {
      const res = await fetch(new URL('pack.json', baseUrl));
      if (!res.ok) return false;
      const manifest = await res.json();
      this.packs.set(id, { name: manifest.name, base: baseUrl, manifest });
      return true;
    } catch {
      return false;
    }
  }

  use(id) {
    if (this.packs.has(id)) {
      this.active = id;
      this.cache.clear();
    }
  }

  url(key) {
    if (!this.cache.has(key)) this.cache.set(key, this.#resolve(key));
    return this.cache.get(key);
  }

  #resolve(key) {
    const [prefix] = key.split(':');
    const pack = this.packs.get(this.active);
    const icons = pack.manifest?.icons;
    if (icons) {
      const file = icons[key] ?? icons[ALIASES[key]] ?? icons[`${prefix}:*`];
      if (file) return new URL(file, pack.base).href;
    }
    const glyph = GLYPHS[key] ?? GLYPHS[ALIASES[key]];
    if (glyph) return glyphIcon(glyph);
    if (prefix === 'core' || prefix === 'ee') return glyphIcon(GLYPHS.generic);
    return monogram(prefix);
  }
}
