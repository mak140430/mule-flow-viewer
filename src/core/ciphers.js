// Block ciphers for secure:: properties beyond what WebCrypto offers (AES with 24-byte keys, Blowfish, DES,
// Triple DES), in plain JavaScript, running in the page: the key never leaves it. Each is a {size, encrypt(block),
// decrypt(block)} on Uint8Arrays of one block; the modes are in secure.js. Checked against values Mule's own
// encrypter produced (tools/test_secure.mjs). Constant tables are computed where they can be (AES's S-box from its
// definition, Blowfish's from the digits of pi), so no long table is copied by hand.

// ------------------------------------------------------------------ AES (any key size)

let aesTables = null;
function aesInit() {
  if (aesTables) return aesTables;
  const sbox = new Uint8Array(256);
  const inv = new Uint8Array(256);
  // multiplicative inverses in GF(2^8) through the generator 3, then the affine transform
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 0; i < 256; i++) {
    const v = i ? exp[(255 - log[i]) % 255] : 0;
    let s = v;
    for (let r = 1; r < 5; r++) s ^= ((v << r) | (v >> (8 - r))) & 0xff;
    s ^= 0x63;
    sbox[i] = s;
    inv[s] = i;
  }
  const mul = (a, b) => (a && b ? exp[(log[a] + log[b]) % 255] : 0);
  aesTables = { sbox, inv, mul };
  return aesTables;
}

export function aes(key) {
  const { sbox, inv, mul } = aesInit();
  if (![16, 24, 32].includes(key.length)) throw new Error(`the key is ${key.length} bytes; AES keys must be 16, 24 or 32 characters`);
  const nk = key.length / 4;
  const rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  for (let i = nk, rcon = 1; i < 4 * (rounds + 1); i++) {
    let t = w.slice(4 * (i - 1), 4 * i);
    if (i % nk === 0) {
      t = Uint8Array.of(sbox[t[1]] ^ rcon, sbox[t[2]], sbox[t[3]], sbox[t[0]]);
      rcon = mul(rcon, 2);
    } else if (nk > 6 && i % nk === 4) t = t.map((b) => sbox[b]);
    for (let j = 0; j < 4; j++) w[4 * i + j] = w[4 * (i - nk) + j] ^ t[j];
  }
  const addKey = (s, r) => { for (let i = 0; i < 16; i++) s[i] ^= w[16 * r + i]; };
  // state in column order (byte i = row i % 4, column i / 4)
  const shift = (s, dir) => {
    const o = s.slice();
    for (let c = 0; c < 4; c++) for (let r = 1; r < 4; r++) s[4 * c + r] = o[4 * ((c + dir * r + 16) % 4) + r];
  };
  const mix = (s, m) => {
    for (let c = 0; c < 4; c++) {
      const a = s.slice(4 * c, 4 * c + 4);
      for (let r = 0; r < 4; r++) s[4 * c + r] = mul(a[0], m[(4 - r) % 4]) ^ mul(a[1], m[(5 - r) % 4]) ^ mul(a[2], m[(6 - r) % 4]) ^ mul(a[3], m[(7 - r) % 4]);
    }
  };
  return {
    size: 16,
    encrypt(block) {
      const s = block.slice();
      addKey(s, 0);
      for (let r = 1; r <= rounds; r++) {
        for (let i = 0; i < 16; i++) s[i] = sbox[s[i]];
        shift(s, 1);
        if (r < rounds) mix(s, [2, 3, 1, 1]);
        addKey(s, r);
      }
      return s;
    },
    decrypt(block) {
      const s = block.slice();
      addKey(s, rounds);
      for (let r = rounds - 1; r >= 0; r--) {
        shift(s, -1);
        for (let i = 0; i < 16; i++) s[i] = inv[s[i]];
        addKey(s, r);
        if (r > 0) mix(s, [14, 11, 13, 9]);
      }
      return s;
    },
  };
}

// ------------------------------------------------------------------ Blowfish

let piWords = null;
/** The first n 32-bit words of pi's fractional part in hex (Blowfish's P-array and S-boxes), by Machin's formula. */
function pi(n) {
  if (piWords && piWords.length >= n) return piWords;
  const bits = BigInt(n * 32 + 64);
  const one = 1n << bits;
  const atanInv = (x) => {
    const x2 = x * x;
    let term = one / x;
    let sum = term;
    for (let k = 1n; term; k++) {
      term /= x2;
      sum += (k % 2n ? -term : term) / (2n * k + 1n);
    }
    return sum;
  };
  const value = 16n * atanInv(5n) - 4n * atanInv(239n);          // pi, scaled by 2^bits
  const frac = (value - 3n * one) >> 64n;                         // drop the guard bits
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = Number((frac >> BigInt((n - 1 - i) * 32)) & 0xffffffffn);
  piWords = out;
  return out;
}

export function blowfish(key) {
  if (key.length < 4 || key.length > 56) throw new Error(`the key is ${key.length} bytes; Blowfish keys must be 4 to 56 characters`);
  const words = pi(18 + 4 * 256);
  const P = Uint32Array.from(words.subarray(0, 18));
  const S = [0, 1, 2, 3].map((i) => Uint32Array.from(words.subarray(18 + 256 * i, 18 + 256 * (i + 1))));
  const F = (x) => ((((S[0][x >>> 24] + S[1][(x >>> 16) & 255]) >>> 0) ^ S[2][(x >>> 8) & 255]) + S[3][x & 255]) >>> 0;
  const enc = (l, r) => {
    for (let i = 0; i < 16; i++) {
      l = (l ^ P[i]) >>> 0;
      r = (r ^ F(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    return [(l ^ P[17]) >>> 0, (r ^ P[16]) >>> 0];
  };
  const dec = (l, r) => {
    for (let i = 17; i > 1; i--) {
      l = (l ^ P[i]) >>> 0;
      r = (r ^ F(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    return [(l ^ P[0]) >>> 0, (r ^ P[1]) >>> 0];
  };
  for (let i = 0, j = 0; i < 18; i++) {
    let d = 0;
    for (let k = 0; k < 4; k++, j++) d = ((d << 8) | key[j % key.length]) >>> 0;
    P[i] = (P[i] ^ d) >>> 0;
  }
  let l = 0;
  let r = 0;
  for (let i = 0; i < 18; i += 2) { [l, r] = enc(l, r); P[i] = l; P[i + 1] = r; }
  for (const box of S) for (let i = 0; i < 256; i += 2) { [l, r] = enc(l, r); box[i] = l; box[i + 1] = r; }
  const view = (b) => new DataView(b.buffer, b.byteOffset, 8);
  const run = (fn) => (block) => {
    const v = view(block);
    const [a, b] = fn(v.getUint32(0), v.getUint32(4));
    const out = new Uint8Array(8);
    const o = view(out);
    o.setUint32(0, a);
    o.setUint32(4, b);
    return out;
  };
  return { size: 8, encrypt: run(enc), decrypt: run(dec) };
}

// ------------------------------------------------------------------ DES and Triple DES (FIPS 46-3 tables)

const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const PERM = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

// bits as arrays of 0/1, most significant first: slow, but values are a few blocks long
const toBits = (bytes) => [...bytes].flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));
const fromBits = (bits) => Uint8Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(8 * i, 8 * i + 8).reduce((a, b) => (a << 1) | b, 0));
const permute = (bits, table) => table.map((i) => bits[i - 1]);

function desKeys(key) {
  const k = permute(toBits(key), PC1);
  let c = k.slice(0, 28);
  let d = k.slice(28);
  return SHIFTS.map((n) => {
    c = [...c.slice(n), ...c.slice(0, n)];
    d = [...d.slice(n), ...d.slice(0, n)];
    return permute([...c, ...d], PC2);
  });
}

function desBlock(block, keys) {
  const bits = permute(toBits(block), IP);
  let l = bits.slice(0, 32);
  let r = bits.slice(32);
  for (const k of keys) {
    const x = permute(r, E).map((b, i) => b ^ k[i]);
    const s = [];
    for (let j = 0; j < 8; j++) {
      const six = x.slice(6 * j, 6 * j + 6);
      const v = SBOX[j][(six[0] << 5) | (six[5] << 4) | (six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4]];
      s.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    const f = permute(s, PERM);
    [l, r] = [r, l.map((b, i) => b ^ f[i])];
  }
  return fromBits(permute([...r, ...l], FP));
}

export function des(key) {
  if (key.length !== 8) throw new Error(`the key is ${key.length} bytes; DES keys must be 8 characters`);
  const keys = desKeys(key);
  const back = [...keys].reverse();
  return { size: 8, encrypt: (b) => desBlock(b, keys), decrypt: (b) => desBlock(b, back) };
}

/** Triple DES (DESede): encrypt with the first key, decrypt with the second, encrypt with the third. */
export function tripleDes(key) {
  if (key.length !== 24) throw new Error(`the key is ${key.length} bytes; DESede keys must be 24 characters`);
  const [a, b, c] = [0, 8, 16].map((i) => des(key.subarray(i, i + 8)));
  return { size: 8, encrypt: (x) => c.encrypt(b.decrypt(a.encrypt(x))), decrypt: (x) => a.decrypt(b.encrypt(c.decrypt(x))) };
}
