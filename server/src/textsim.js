// Near-duplicate detection: a bottom-k MinHash sketch over word 3-gram shingles of the whole
// transcript. Working on the full text (not segment indices) keeps it independent of how each
// ASR engine splits segments.

export const SKETCH_K = 256;
const MAX_TOKENS = 300_000;
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // murmur3 fmix32 so the low end of the hash space is uniformly populated for bottom-k.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function tokenize(segments) {
  const out = [];
  for (const seg of segments) {
    const text = seg.text.normalize('NFKC').toLowerCase();
    for (const m of text.matchAll(WORD)) {
      const w = m[0];
      if (NO_SPACE_SCRIPT.test(w)) for (const ch of w) out.push(ch);
      else out.push(w);
      if (out.length >= MAX_TOKENS) return out;
    }
  }
  return out;
}

export function computeSketch(segments) {
  const tokens = tokenize(segments);
  const n = tokens.length;
  if (n === 0) return new Uint32Array(0);
  const count = n < 3 ? 1 : n - 2;
  const hashes = new Uint32Array(count);
  if (n < 3) hashes[0] = fnv1a(tokens.join(' '));
  else for (let i = 0; i < count; i++) hashes[i] = fnv1a(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  hashes.sort();
  const out = [];
  for (let i = 0; i < hashes.length && out.length < SKETCH_K; i++) {
    if (i === 0 || hashes[i] !== hashes[i - 1]) out.push(hashes[i]);
  }
  return Uint32Array.from(out);
}

// Estimated Jaccard index of the two shingle sets.
export function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  let i = 0, j = 0, taken = 0, both = 0;
  while (taken < SKETCH_K && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) i++;
    else if (i >= a.length || b[j] < a[i]) j++;
    else { both++; i++; j++; }
    taken++;
  }
  return taken ? both / taken : 0;
}

export function sketchToBuffer(sketch) {
  return Buffer.from(sketch.buffer, sketch.byteOffset, sketch.byteLength);
}

export function sketchFromBlob(blob) {
  const copy = Uint8Array.from(blob);
  return new Uint32Array(copy.buffer, 0, copy.byteLength >>> 2);
}
