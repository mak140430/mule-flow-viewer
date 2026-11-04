// Before first paint, so a dark system never flashes light: the theme picked here, else the system's.
// A file, not an inline script: extension pages only run scripts from the extension.
(() => {
  let picked = null;
  try { picked = localStorage.getItem('mfv.theme'); } catch { /* storage unavailable */ }
  const dark = picked ? picked === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();

// The web fonts, added from here rather than as a <link> in the page: a stylesheet in the page holds back the page's
// scripts until it loads, so a network that blocks or stalls Google Fonts would keep the viewer from starting. Added
// this way it blocks nothing; the system fonts show until it arrives (or for good, offline).
(() => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap';
  document.head.append(link);
})();
