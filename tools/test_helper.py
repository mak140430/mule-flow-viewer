"""Checks the helper's clone matching against remote and page URLs of the common code hosts (no host rules in it)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "helper"))
from mfv_helper import match_score  # noqa: E402

CASES = [
    # (remote, page, should match)
    ("git@github.com:acme/orders-api.git", "https://github.com/acme/orders-api/blob/main/src/main/mule/a.xml#L3", True),
    ("https://github.com/acme/orders-api.git", "https://github.com/acme/orders-api/pull/12/files", True),
    ("git@github.com:other/orders-api.git", "https://github.com/acme/orders-api", False),
    ("git@gitlab.com:grp/sub/orders-api.git", "https://gitlab.com/grp/sub/orders-api/-/blob/qa/pom.xml", True),
    ("git@bitbucket.org:acme/orders-api.git", "https://bitbucket.org/acme/orders-api/src/main/pom.xml", True),
    ("git@ssh.dev.azure.com:v3/contoso/Integration/crm-leads-sapi",
     "https://dev.azure.com/contoso/Integration/_git/crm-leads-sapi?path=/src/main/mule/leads.xml&version=GBqa", True),
    ("https://contoso@dev.azure.com/contoso/Integration/_git/crm-leads-sapi",
     "https://dev.azure.com/contoso/Integration/_git/crm-leads-sapi/pullrequest/9874", True),
    ("https://contoso.visualstudio.com/Integration/_git/crm-leads-sapi",
     "https://dev.azure.com/contoso/Integration/_git/crm-leads-sapi", True),
    ("git@ssh.dev.azure.com:v3/contoso/Integration/finance-papi",
     "https://dev.azure.com/contoso/Integration/_git/crm-leads-sapi", False),
    ("ssh://git@git.internal:7999/mule/orders-api.git", "https://git.internal/projects/MULE/repos/orders-api/browse/pom.xml", True),
    ("https://gitea.example.org/team/orders-api.git", "https://gitea.example.org/team/orders-api/src/branch/main/pom.xml", True),
]

failed = 0
for remote, page, want in CASES:
    got = match_score(remote, page) > 0
    mark = "ok " if got == want else "BAD"
    failed += got != want
    print(f"{mark} {'match' if got else 'no   '}  {remote}  ~  {page}")
print("all passed" if not failed else f"{failed} failed")
sys.exit(1 if failed else 0)
