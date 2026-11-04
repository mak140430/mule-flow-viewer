# Publishing to the Chrome Web Store

1. Register at https://chrome.google.com/webstore/devconsole with the Google account that will own the listing.
   It costs a one-time $5 fee.
2. Run `python3 tools/build_extension.py`. It writes `dist/store/mule-flow-viewer-<version>-chrome-web-store.zip`,
   which has no manifest `key`, because the store assigns the extension's id.
3. In the developer console, click **New item** and upload that zip.
4. Fill in the **Store listing** and **Privacy practices** tabs from the sections below.
5. Choose the visibility: Public, Unlisted (anyone with the link) or Private (your Google Workspace domain or listed
   testers). Then submit it for review, which usually takes a few days.
6. Once it's approved, add the store's extension id to `EXTENSION_IDS` in `helper/install.py`, so the helper accepts
   it. Then publish the helper zip (`dist/store/mule-flow-viewer-helper-<version>.zip`) as a GitHub release asset.
   Rebuild with `--helper-url <its download link>` so the setup guide links to it.

To ship an update, raise `version` in `extension/manifest.json`, rebuild, and upload the new zip under **Package**.

# Store listing: what to paste where

## Store listing

**Name:** Mule Flow Viewer

**Summary** (132 characters max):
Mule 4 flows as Studio draws them, from Azure DevOps, GitHub, GitLab or Bitbucket: branches, history, pull requests, checks.

**Description:**
Open a Mule 4 project's page on Azure DevOps, GitHub, GitLab or Bitbucket (a file, a branch or a pull request) and see its flows as Anypoint Studio draws them. Nothing to install: it reads the repository with the sign-in your browser already has (GitHub asks once for a read-only token).

- Every flow, scope, router and error handler, with Studio's icons. Click a component for its settings, resolved properties and DataWeave.
- History: any commit, branch or pull request as a visual diff. Changed, added and removed elements are marked on the canvas, and conflicts in a merge preview are flagged.
- Branches side by side: see whether a change has reached qa, preprod or main.
- Element history and blame: who changed an element, when, and on which branches it differs.
- DataWeave: run any script with inputs from your MUnit tests, compare old and new outputs, or write your own in the Playground. It all runs on your computer.
- Shared libraries: flows your project calls from a common library, read from the library's own repository at the version your pom.xml uses, and which apps call each of a library's flows.
- Checks: missing flows and configurations, secrets in plain text, loggers that write whole payloads, entry flows without error handling, unused flows and properties.
- Trace: a flow's every step as it runs, into the flows it calls, with where each variable is set and read.
- Impact: the endpoints, schedules and listeners a pull request reaches, the properties it adds and the environments missing them.
- Overview: every endpoint with the errors it can return and the HTTP status for each, the systems the app calls, properties side by side per environment, and which apps use old versions of a shared library.
- Copy or save any flow as an image (PNG or SVG) for documents.
- Search all branches, release notes as Markdown, and secure:: properties decrypted with your key, which never leaves the tab.

Optional: the free local helper (Python 3.8+) runs DataWeave scripts on your computer, and opens repositories on self-hosted servers from your clones. Your code goes only between your browser and your code host.

**Category:** Developer Tools
**Language:** English

## Graphics (in `store/screenshots/`, taken on a made-up demo project)

- Store icon 128×128: `extension/icons/icon128.png`
- Screenshots 1280×800 (the store takes up to 5), in this order:
  1. `1-flows.png`: flows as Studio draws them, with the XML of the selected lines.
  2. `2-merge-preview.png`: a branch's merge preview, with an element both sides changed.
  3. `6-impact.png`: the entry points a branch reaches, and a property missing in qa.
  4. `7-entry-points.png`: an endpoint's errors, their handlers and the HTTP status of each.
  5. `4-dataweave.png`: a transform run with its MUnit test's inputs.
- Small promo tile 440×280: `promo-tile-440x280.png`

To retake them: `python3 tools/demo/make_demo_repo.py <folder>/orders-api`, then
`node tools/store_screenshots.mjs "<chrome binary>" <folder>/orders-api store/screenshots` and `python3 tools/make_promo_tile.py`.

## Privacy practices tab

**Single purpose:** Show Mule 4 projects from the page you are on as flow diagrams, with their version history, read from the code host with your existing sign-in (or from a local clone).

**Permission justifications:**
- `activeTab`, `scripting`: when you click the button, read the current tab's URL, selected text and visible header text, to find which repository, file, lines or pull request it shows. This only happens on that click and only for that tab.
- `nativeMessaging`: talk to the optional local helper program, which runs DataWeave scripts and, for code hosts not read directly, finds your clone and starts a server for it on your computer.
- `storage`: remember your settings (folders with your clones, theme) and hand the page (and the local server's address, if any) to the viewer tab.
- `contextMenus`: the "Open in Mule Flow Viewer" item on the page's right-click menu.
- Host permissions `https://dev.azure.com/*`, `https://*.visualstudio.com/*`, `https://gitlab.com/*`, `https://bitbucket.org/*`, `https://api.github.com/*`: the viewer reads the repository you opened (files, branches, commits), its libraries and the other repositories of the same owner (for "used by") from that host's API, signed in as you are in this browser (GitHub: with the read-only token you give it). Only read requests, only after your click.
- Host permission `http://127.0.0.1/*`: the optional helper's server on your own computer. No other host is contacted.

**Remote code:** No. All code is in the package.

**Data usage:** Check none of the data types. Nothing is collected or sent to the authors or anyone else: the repository is read from your code host into your browser on your click, and stays there.

**Privacy policy URL:** https://github.com/mak140430/mule-flow-viewer/blob/main/store/privacy-policy.md
