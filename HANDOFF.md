# Handoff notes: pitfalls

- The helper starts serve.py with `--token=VALUE` in one argument: a random token can start with `-`, which
  argparse reads as an option, and the server then never starts (intermittent "The server did not start").
- Image export inlines Google Fonts with a 3 s limit: where the font site is blocked or offline, fetches hang
  forever without it. Icons are inlined the same way.
- Properties: keys only a library reads are the library's to define; they mark the app's keys as read but are not
  rows. Names built at run time (`p("crm.entities." ++ name)`) count every key under that prefix as read (lint too).
- Dependency versions can come from the parent pom's `dependencyManagement`: use `resolvedDeps()` in git-host.js.
- Don't run tools/test_helper_protocol.py while tools/e2e_chrome.mjs runs: both start helper servers on the demo
  repository, and the Chrome run's helper viewer then fails to load.
- tools/smoke.mjs and diff-smoke.mjs need a project path; e2e_core's link step needs a page URL that names a file.
- Azure stand-in: pass the API origin with the organization (`http://127.0.0.1:PORT/ORG`).
- Toolbar views (Overview, Checks, Branches, Search, Trace) must not be gated on `!rev`: during a comparison they read
  its newer side (`shownLibFlows()` for its library flows). The canvas is kept while a view is open (`leaveCanvas()`),
  so coming back does not redraw every changed file.
- The XML pane works in comparisons: it shows the newer side of the file the selected element is in; removed
  elements (`was:` ids) are never pointed at.
- Remote search: the first one reads every branch's tree and every distinct file version (an app with 173 branches: 926 requests).
  `adapter.warm()` reads them ahead after opening; GitHub and GitLab stop at 400 files (hourly request limits).
- Chrome's WebCrypto has no 192-bit AES: 24-character keys go through ciphers.js. Mule's Rijndael needs Bouncy Castle
  registered as a provider to make fixtures; with 128-bit blocks it equals AES.
- serve.py's default listen queue (5) drops connections when a client fetches a project's files all at once.
- Never put a <link rel=stylesheet> to another site in a page's head: it holds back the page's scripts until it loads (a stalled Google Fonts kept the viewer blank). theme.js adds the font link.
- `resolveProperty(key, env)` never falls back to another environment's file: a key only in config-prod.yaml has no
  value in qa (it used to show prod's value there, so "missing in qa" was never reported).
- A secret-looking key with a plain value counts as plain text in a secure properties file too.
- tools/store_screenshots.mjs needs the demo repository's remote on a host the viewer does not read itself
  (git.acme.example), so it goes through the helper; its node process does not exit on its own after the last shot.
