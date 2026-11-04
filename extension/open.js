// Opening the viewer on a page; shared by the toolbar button and the setup page. Repositories on a host the viewer
// reads directly (Azure DevOps) need nothing else; other pages go to the local helper, which finds a clone.

import { readsDirectly } from './src/adapters/remote.js';

export const HOST = 'mule_flow_viewer.helper';
export const DEFAULTS = { roots: [] };

export const ask = (msg) => chrome.runtime.sendNativeMessage(HOST, msg)
  .catch((e) => ({ ok: false, error: 'no-helper', message: e.message }));

/**
 * page: {url, title, selection}. Opens the viewer, or the setup page when the helper could not serve it.
 * where: {index, openerTabId} for a new tab, or {replace: tabId} to load it in that tab.
 */
export async function openPage(page, where = {}) {
  const key = crypto.randomUUID();
  let ok = true;
  if (readsDirectly(page.url)) {
    // read in the viewer with the browser's own sign-in (apiOrigin: tests' stand-in for the host)
    await chrome.storage.session.set({ [key]: { ...page, link: page.url, remote: { url: page.url, apiOrigin: page.apiOrigin || '' } } });
  } else {
    const { roots } = await chrome.storage.sync.get(DEFAULTS);
    const reply = await ask({ type: 'open', url: page.url, title: page.title, text: page.text || '', roots });
    ok = reply.ok;
    // handed over by key, so the token never appears in a URL or the history
    await chrome.storage.session.set({ [key]: { ...page, link: page.url, server: reply.ok ? { base: reply.base, token: reply.token } : null, reply } });
  }
  const url = chrome.runtime.getURL(ok ? `viewer/index.html#s=${key}` : `setup.html#s=${key}`);
  if (where.replace != null) return chrome.tabs.update(where.replace, { url });
  return chrome.tabs.create({ url, ...(where.index != null ? { index: where.index } : {}), ...(where.openerTabId != null ? { openerTabId: where.openerTabId } : {}) });
}
