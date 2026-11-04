// secure.js against values Mule's own encrypter produced (tools/fixtures/SecureFixtures.java, made-up test keys):
// AES (128, 192, 256-bit keys), Rijndael, Blowfish, DES and DESede in every mode, with and without random IVs; and a
// wrong key must say so.
import { readFileSync } from 'node:fs';

const { decrypt } = await import(new URL('../src/core/secure.js', import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/secure-mule.json', import.meta.url)));
const PLAIN = 's3cr3t-värde with spaces & symbols ✓';
let failed = 0;
for (const f of fixtures) {
  const opts = { algorithm: f.algorithm, mode: f.mode, randomIvs: f.random };
  const got = await decrypt(`![${f.cipher}]`, f.key, opts).catch((e) => `ERROR ${e.message}`);
  const wrong = await decrypt(`![${f.cipher}]`, f.key.replace(/^T/, 'X'), opts).then(() => 'decrypted', (e) => e.message);
  const ok = got === PLAIN && wrong === 'wrong key';
  failed += !ok;
  console.log(`${ok ? 'ok ' : 'BAD'} ${`${f.algorithm}-${f.key.length * 8}`.padEnd(12)} ${f.mode} ${f.random ? 'random IVs' : 'fixed IV  '}  ${ok ? '' : `got ${got} / wrong key: ${wrong}`}`);
}
// the guard: a key or value never leaves this computer, but reaches the local helper
const { guardSecrets, remember } = await import(new URL('../src/core/secure.js', import.meta.url));
const sent = [];
const target = { location: { href: 'chrome-extension://x/viewer/index.html' }, fetch: async (u) => { sent.push(String(u)); return 'ok'; } };
guardSecrets(target);
remember('TestKey123456789', 's3cr3t-value');
const tries = [
  ['https://dev.azure.com/o/p/_apis/git/items?path=/src', {}, true],
  ['https://api.github.com/search?q=s3cr3t-value', {}, false],
  ['https://gitlab.com/x', { method: 'POST', body: JSON.stringify({ k: 'TestKey123456789' }) }, false],
  ['https://gitlab.com/x', { headers: { 'X-Thing': 's3cr3t-value' } }, false],
  ['https://bitbucket.org/x?q=s3cr3t%2Dvalue', {}, false],
  ['http://127.0.0.1:5000/api/dw/run', { method: 'POST', body: JSON.stringify({ properties: { a: 's3cr3t-value' } }) }, true],
];
for (const [url, init, allowed] of tries) {
  const got = await target.fetch(url, init).then(() => true, () => false);
  const ok = got === allowed;
  failed += !ok;
  console.log(`${ok ? 'ok ' : 'BAD'} guard ${allowed ? 'lets through' : 'refuses   '} ${url.slice(0, 60)}`);
}
console.log(failed ? `${failed} failed` : `all ${fixtures.length + tries.length} passed`);
process.exit(failed ? 1 : 0);
