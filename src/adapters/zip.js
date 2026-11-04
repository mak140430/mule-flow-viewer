// Reading a .zip in the page (a code host's "download this commit"), and git's id for a file's content, so files
// read that way are cached and compared like the ones other hosts name by id.

/** [{name, data: Uint8Array}] of a zip archive's files (stored or deflated, as code hosts make them). */
export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip archive');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const files = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    files.push({ name, raw, method });
  }
  return Promise.all(files.map(async ({ name, raw, method }) => ({
    name,
    data: method === 0 ? raw : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()),
  })));
}

/** git's blob id of these bytes: sha1("blob <size>\0" + bytes). */
export async function gitBlobId(data) {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}
