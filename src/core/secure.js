// `secure::` properties: values a <secure-properties:config> file holds encrypted ("![base64]"), decrypted in the
// page with the key the user types. The key and the plain values stay in this browser tab (they reach the local
// DataWeave engine only as property values of a run). Mule's format, checked against its own encrypter
// (tools/test_secure.mjs): the key is the UTF-8 bytes of the key text; without random IVs the IV is the key's first
// block; with them, a random IV leads the ciphertext; PKCS5 padding in every mode.
// AES (Mule's default; WebCrypto, or ciphers.js for 24-byte keys), Rijndael, Blowfish, DES and DESede in all four
// modes; the module's rarer algorithms are reported, not guessed.

import { aes as aesJs, blowfish, des, tripleDes } from './ciphers.js';

const MODES = new Set(['CBC', 'CFB', 'ECB', 'OFB']);
export const ENCRYPTED = /^!\[(.*)\]$/s;
/** The algorithms decrypted here (Rijndael with Mule's 128-bit blocks is AES); the module's others are reported. */
export const ALGORITHMS = ['AES', 'Rijndael', 'Blowfish', 'DES', 'DESede'];

/** The project's <secure-properties:config> elements: file pattern, key expression, algorithm, mode, random IVs. */
export function secureConfigs(project) {
  const out = [];
  for (const config of project.configs) {
    for (const g of config.globals) {
      // by namespace, or by prefix where the file does not declare it (Mule resolves those anyway)
      if (g.node.local !== 'config' || !(/secure-properties/.test(g.node.ns) || g.key === 'secure-properties:config')) continue;
      const enc = g.node.children.find((c) => c.local === 'encrypt');
      out.push({
        name: g.name,
        file: g.node.attrs.file || '',
        key: g.node.attrs.key || '',
        algorithm: enc?.attrs.algorithm || 'AES',
        mode: enc?.attrs.mode || 'CBC',
        randomIvs: enc?.attrs.useRandomIVs === 'true',
      });
    }
  }
  return out;
}

const subtle = () => globalThis.crypto.subtle;
const bytes = (s) => new TextEncoder().encode(s);
const xor = (a, b) => a.map((x, i) => x ^ b[i]);

function unpad(data, size) {
  const n = data[data.length - 1];
  if (!n || n > size || data.length < n || data.subarray(data.length - n).some((x) => x !== n)) throw new Error('wrong key');
  return data.subarray(0, data.length - n);
}

/** AES through WebCrypto (16- and 32-byte keys): its CBC, and single blocks from it. */
async function aesWebCrypto(keyBytes) {
  const zero = new Uint8Array(16);
  const key = await subtle().importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const encrypt = async (b) => new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: zero }, key, b)).subarray(0, 16);
  return {
    size: 16,
    encrypt,
    async decrypt(c) {
      // CBC-decrypting [c, E(pad ^ c)] gives D(c), then pad ^ c ^ c = a valid padding block, so WebCrypto accepts it
      const pad = new Uint8Array(16).fill(16);
      const two = new Uint8Array(32);
      two.set(c);
      two.set(await encrypt(xor(pad, c)), 16);
      return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: zero }, key, two));
    },
    cbc: async (iv, data) => new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, key, data)),
  };
}

/** The block cipher for an algorithm and key: {size, encrypt(block), decrypt(block)} (sync or async). */
async function cipher(algorithm, keyBytes) {
  switch (algorithm) {
    case 'AES': case 'Rijndael':
      return keyBytes.length === 16 || keyBytes.length === 32 ? aesWebCrypto(keyBytes) : aesJs(keyBytes);
    case 'Blowfish': return blowfish(keyBytes);
    case 'DES': return des(keyBytes);
    case 'DESede': return tripleDes(keyBytes);
    default: throw new Error(`${algorithm} is not decrypted here (${ALGORITHMS.join(', ')} are)`);
  }
}

/** One "![...]" value (or its base64 inside) -> plain text. Throws 'wrong key' when the key does not fit it. */
export async function decrypt(value, key, { algorithm = 'AES', mode = 'CBC', randomIvs = false } = {}) {
  if (!MODES.has(mode)) throw new Error(`mode ${mode} is not supported`);
  const keyBytes = bytes(key);
  const raw = Uint8Array.from(atob((ENCRYPTED.exec(value)?.[1] ?? value).trim()), (c) => c.charCodeAt(0));
  const c = await cipher(algorithm, keyBytes);
  const n = c.size;
  // without random IVs the IV is the key's first block; with them it leads the value (ECB has none)
  const ivFirst = randomIvs && mode !== 'ECB';
  const iv = ivFirst ? raw.subarray(0, n) : keyBytes.subarray(0, n);
  const data = ivFirst ? raw.subarray(n) : raw;
  if (!data.length || data.length % n) throw new Error('wrong key');
  let plain;
  if (mode === 'CBC' && c.cbc) {
    plain = await c.cbc(iv, data).catch(() => { throw new Error('wrong key'); });
  } else {
    const out = new Uint8Array(data.length);
    let prev = iv;
    for (let i = 0; i < data.length; i += n) {
      const block = data.subarray(i, i + n);
      let p;
      if (mode === 'ECB') p = await c.decrypt(block);
      else if (mode === 'CBC') { p = xor(await c.decrypt(block), prev); prev = block; }
      else if (mode === 'CFB') { p = xor(block, await c.encrypt(prev)); prev = block; }
      else { prev = await c.encrypt(prev); p = xor(block, prev); }
      out.set(p, i);
    }
    plain = unpad(out, n);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    throw new Error('wrong key');
  }
}

// ------------------------------------------------------------------ what never leaves this computer

const SECRETS = new Set();
// too short or too common to tell apart from ordinary text in a request
const ORDINARY = /^(true|false|null|\d{1,5})$/i;
/** The key and the values decrypted with it: the guard below keeps them from leaving this computer. */
export function remember(...values) {
  for (const v of values) if (typeof v === 'string' && v.length >= 6 && !ORDINARY.test(v)) SECRETS.add(v);
}
const LOCAL = /^(chrome-extension:|moz-extension:|blob:|data:|about:)|^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Wraps fetch so that a request leaving this computer (to a code host, say) that would carry a remembered key or
 * value in its address, headers or body is refused instead. Requests to this computer (the local helper) pass:
 * DataWeave runs there use the plain values. Install once, before any adapter takes fetch.
 */
export function guardSecrets(target = globalThis) {
  if (target.fetch?.guarded) return;
  const real = target.fetch.bind(target);
  const guarded = (input, init = {}) => {
    if (SECRETS.size) {
      const url = new URL(typeof input === 'string' ? input : input?.url || String(input), target.location?.href).href;
      if (!LOCAL.test(url)) {
        let plainUrl = url;
        try { plainUrl = decodeURIComponent(url); } catch { /* not encoded */ }
        const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
        const headers = [...new Headers(init.headers || (input instanceof Request ? input.headers : {})).values()].join('\n');
        const text = `${url}\n${plainUrl}\n${body}\n${headers}`;
        for (const v of SECRETS) {
          if (text.includes(v)) return Promise.reject(new Error('Refused: the request would have carried a secure property off this computer'));
        }
      }
    }
    return real(input, init);
  };
  guarded.guarded = true;
  target.fetch = guarded;
}

/**
 * Every encrypted value of the environment's secure files, decrypted: Map(property key -> plain text), plus
 * errors [{key, file, message}]. A key that decrypts nothing is a wrong key (one bad value is reported alone).
 */
export async function decryptAll(project, env, key) {
  const configs = secureConfigs(project);
  remember(key);   // a mistyped key too
  const values = new Map();
  const errors = [];
  for (const cfg of configs) {
    const path = `src/main/resources/${cfg.file.replace(/\$\{[^}]*env[^}]*\}/i, env)}`;
    const pf = project.propertyFiles.find((f) => f.path === path);
    if (!pf) continue;
    for (const [k, { value }] of Object.entries(pf.values)) {
      if (!ENCRYPTED.test(value)) continue;
      try {
        values.set(k, await decrypt(value, key, cfg));
        remember(values.get(k));
      } catch (e) {
        errors.push({ key: k, file: pf.path, message: e.message });
      }
    }
  }
  return { values, errors, configs };
}
