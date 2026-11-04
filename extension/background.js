// The toolbar button (or Alt+Shift+M, or the page's context menu): hand the page to the local helper, which finds
// its clone and starts a server for it, then open the viewer on what the page shows (file, lines, branch).
// Nothing here knows any code host: the page's URL, selection and title are all it sends.

import { openPage } from './open.js';

// the setup guide on install, and once after an update that brings a guide not seen yet
const GUIDE_VERSION = 1;
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.create({ id: 'open', title: 'Open in Mule Flow Viewer', contexts: ['page', 'selection', 'link'] });
  const { guideSeen = 0 } = await chrome.storage.local.get('guideSeen');
  if (reason === 'install' || (reason === 'update' && guideSeen < GUIDE_VERSION)) chrome.tabs.create({ url: 'setup.html#welcome' });
});

chrome.action.onClicked.addListener((tab) => openFrom(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => openFrom(tab, info.selectionText || '', info.linkUrl));

/** What the page shows: its URL, the selected text, its title and its first text (where a pull request names its branches). */
async function pageOf(tab, selection, link) {
  const page = { url: link || tab.url || '', title: tab.title || '', selection: selection || '', text: '' };
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ selection: String(getSelection() || ''), text: (document.body?.innerText || '').slice(0, 8000) }),
    });
    page.selection ||= result.selection;
    page.text = result.text;
  } catch { /* a page scripts may not run on (the Web Store, chrome://): the URL is enough */ }
  return page;
}

async function openFrom(tab, selection = '', link = '') {
  // the viewer's or setup's own tab names no repository: nothing to open there
  if ((link || tab.url || '').startsWith(chrome.runtime.getURL(''))) return;
  const page = await pageOf(tab, selection, link);
  // the first open of a repository you have no clone of downloads it: show that something is happening
  const busy = { tabId: tab.id };
  chrome.action.setBadgeText({ ...busy, text: '…' });
  chrome.action.setTitle({ ...busy, title: 'Mule Flow Viewer: getting the repository…' });
  try {
    return await openPage(page, { index: tab.index + 1, openerTabId: tab.id });
  } finally {
    chrome.action.setBadgeText({ ...busy, text: '' }).catch(() => {});
    chrome.action.setTitle({ ...busy, title: '' }).catch(() => {});
  }
}

// tests drive it from the service worker
globalThis.mfvOpen = (page) => openPage(page);
