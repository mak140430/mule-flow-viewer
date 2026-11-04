// The code hosts the viewer reads directly from the browser (no clone, no helper): Azure DevOps, GitHub, GitLab and
// Bitbucket. Each is a few calls in its own file; git-host.js does the rest. Other hosts (self-hosted servers) go
// through the local helper and a clone.

import { gitHostAdapter } from './git-host.js';
import { azureRepo, azureHost } from './azure-devops.js';
import { githubRepo, githubHost } from './github.js';
import { gitlabRepo, gitlabHost } from './gitlab.js';
import { bitbucketRepo, bitbucketHost } from './bitbucket.js';

// opts.tokens: {site: token} the user saved (GitHub only: its API ignores the browser's sign-in)
const HOSTS = [
  { match: azureRepo, make: azureHost },
  { match: githubRepo, make: (loc, opts) => githubHost(loc, { ...opts, token: opts.tokens?.['github.com'] || '' }) },
  { match: gitlabRepo, make: gitlabHost },
  { match: bitbucketRepo, make: bitbucketHost },
];

/** Whether the page is a repository on a host read directly. */
export const readsDirectly = (url) => HOSTS.some((h) => h.match(url));

/** The adapter for the page's repository, or null when its host is not one of these. opts: see gitHostAdapter, plus fetch/apiOrigin. */
export async function remoteAdapter(url, opts = {}) {
  for (const h of HOSTS) {
    const loc = h.match(url);
    if (loc) return gitHostAdapter(h.make(loc, opts), { url, dataweave: opts.dataweave });
  }
  return null;
}
