# Mule Flow Viewer: privacy policy

Mule Flow Viewer runs in your browser. It collects nothing and sends nothing to its authors or to anyone else.

**What it reads.** When you click its button (or use its shortcut or context menu), it reads that tab's address, the text you have selected, and the page's header text. It uses them to find the repository, file, lines or pull request the page shows. It reads nothing at any other time and from no other tab.

**Where your code comes from and goes.** For Azure DevOps, GitHub, GitLab and Bitbucket, the viewer reads the repository you opened, the shared libraries it uses and, when you ask who uses a library, the other repositories of the same owner, from that host's own API with the sign-in your browser already has; the extension never sees or stores your password. GitHub's API ignores the browser's sign-in, so for GitHub you give it a read-only token: it is kept in this browser's extension storage, sent only to api.github.com, and removed from the setup page. Files, commits and versions it has read are kept in the browser's cache so they need not be read twice. Nothing is sent anywhere else. With the optional helper program, DataWeave scripts run with the DataWeave CLI on your computer, and for other code hosts the helper serves your local clone to the viewer on `127.0.0.1` (your own machine), protected by a random token; it updates that clone with your own git setup and credentials.

**Keys you enter.** A key for `secure::` properties stays in that browser tab, is used there to decrypt values, and is forgotten when the tab closes. It is never saved or sent anywhere: the extension's pages may only connect to the code hosts named here, Google Fonts and your own computer, and they refuse any request off your computer that would carry the key or a decrypted value.

**What it stores.** Your settings (folders with your clones, theme, layout), your Playground scripts and the cache of repository files are stored in your browser. The helper, if you install it, keeps a small list of found clones and running servers in `~/.mule-flow-viewer` on your computer.

**Third parties.** None: no analytics, no tracking, no advertising. Links you open (for example the setup guide's download links) go to those sites as usual.

Questions: open an issue at https://github.com/mak140430/mule-flow-viewer/issues.
