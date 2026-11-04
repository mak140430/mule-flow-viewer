// A pull request's source and target from page text as code hosts word it (no host rules in locate.js).
const { locate } = await import(new URL('../src/core/locate.js', import.meta.url));
const repo = { files: ['src/main/mule/a.xml'], branches: ['main', 'origin/main', 'qa', 'origin/feature/7651', 'feature/x', 'origin/feature/x', 'preprod'] };
const cases = [
  ['GitHub', 'Add orders #12\nalice wants to merge 3 commits into main from feature/x\nConversation Commits', 'feature/x', 'main'],
  ['Azure DevOps', 'Pull request 9874\nActive\nfeature/7651 into qa\nOverview Files Updates', 'origin/feature/7651', 'qa'],
  ['GitLab', 'Draft: orders\nbob requested to merge feature/x into preprod 2 days ago', 'feature/x', 'preprod'],
  ['Bitbucket', 'Orders change\nfeature/x → main\nOpen', 'feature/x', 'main'],
  ['not a pull request', 'Branches: main qa preprod feature/x', null, null],
];
let failed = 0;
for (const [name, text, source, target] of cases) {
  const { pr } = await locate({ url: 'https://example.org/acme/repo/pull/1', text }, repo);
  const ok = (pr?.source ?? null) === source && (pr?.target ?? null) === target;
  failed += !ok;
  console.log(`${ok ? 'ok ' : 'BAD'} ${name.padEnd(20)} ${pr ? `${pr.source} into ${pr.target}` : 'no pull request'}`);
}
console.log(failed ? `${failed} failed` : `all ${cases.length} passed`);
process.exit(failed ? 1 : 0);
