// A flow as an image, exactly as the canvas draws it: the card is copied with the page's styles, its icons and
// fonts inlined, into an SVG (an HTML foreignObject), and that is drawn on a canvas for a PNG.

const fontCache = { css: null };
// offline, or a network that blocks the font site: drawn with the fallback fonts rather than waiting
const quick = (url) => fetch(url, { signal: AbortSignal.timeout(3000) });

/** The page's own style rules (other origins' sheets cannot be read, fonts are added separately). */
function pageCss() {
  const out = [];
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) out.push(rule.cssText); } catch { /* another origin */ }
  }
  return out.join('\n');
}

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** The latin subsets of the page's web fonts, as @font-face rules with the files inlined (none when offline). */
async function fontCss() {
  if (fontCache.css != null) return fontCache.css;
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).filter((u) => /fonts\.googleapis\.com/.test(u));
  const parts = [];
  for (const href of links) {
    try {
      const css = await (await quick(href)).text();
      for (const [block] of css.matchAll(/\/\*\s*latin\s*\*\/\s*@font-face\s*\{[^}]*\}/g)) {
        const url = /url\(([^)]+)\)/.exec(block)?.[1];
        if (!url) continue;
        const data = await toDataUrl(await (await quick(url)).blob());
        parts.push(block.replace(url, data));
      }
    } catch { /* drawn with the fallback fonts */ }
  }
  fontCache.css = parts.join('\n');
  return fontCache.css;
}

/** The theme's variables, read from the page (the image has no data-theme to pick them by). */
function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  const out = [];
  for (let i = 0; i < cs.length; i++) if (cs[i].startsWith('--')) out.push(`${cs[i]}: ${cs.getPropertyValue(cs[i])}`);
  return out.join('; ');
}

/** {svg (text), width, height} for an element of the canvas, at its full size (nothing scrolled away). */
export async function elementSvg(el) {
  const clone = el.cloneNode(true);
  clone.classList.remove('collapsed', 'selected');
  clone.querySelectorAll('.selected, .check-error, .check-warning').forEach((x) => x.classList.remove('selected', 'check-error', 'check-warning'));
  clone.querySelectorAll('.flow-toggle, .callers').forEach((x) => x.remove());
  // laid out off screen at its natural width, to measure it
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed; left:-100000px; top:0; width:max-content;';
  const holder = document.createElement('div');
  holder.className = 'canvas export';
  holder.append(clone);
  host.append(holder);
  document.body.append(host);
  clone.querySelectorAll('.flow-scroll').forEach((x) => { x.style.overflow = 'visible'; });
  clone.style.margin = '0';
  clone.style.width = 'max-content';
  const { width, height } = clone.getBoundingClientRect();
  host.remove();

  await Promise.all([...clone.querySelectorAll('img')].map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    try { img.setAttribute('src', await toDataUrl(await (await quick(img.src)).blob())); } catch { img.remove(); }
  }));
  const w = Math.ceil(width) + 2;
  const hgt = Math.ceil(height) + 2;
  const css = `${await fontCss()}\n${pageCss()}`;
  const body = document.createElement('div');
  body.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  body.setAttribute('style', `${themeVars()}; font: 13px/1.45 var(--sans); color: var(--text); background: var(--bg); width: ${w}px; height: ${hgt}px;`);
  const style = document.createElement('style');
  style.textContent = css;
  body.append(style, holder);
  holder.style.padding = '0';
  const xhtml = new XMLSerializer().serializeToString(body);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  return { svg, width: w, height: hgt };
}

/** The same as a PNG blob, at `scale` times its size (sharp on high-density screens and in documents). */
export async function elementPng(el, scale = 2) {
  const { svg, width, height } = await elementSvg(el);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  g.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the image'))), 'image/png'));
}

/** Saves a blob as a file in the browser's downloads. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
