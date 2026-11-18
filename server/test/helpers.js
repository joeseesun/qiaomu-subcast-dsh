import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

export async function startServer(env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'subcast-api-test-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      LOG_REQUESTS: '0',
      RATE_UPLOADS_PER_HOUR: '100000',
      RATE_LOOKUPS_PER_HOUR: '100000',
      RATE_REPORTS_PER_HOUR: '100000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 10_000);
    proc.stdout.on('data', (c) => {
      stdout += c;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on('exit', () => reject(new Error(`server exited early: ${stderr}`)));
  });
  return {
    port,
    dataDir,
    logs: () => stdout,
    errors: () => stderr,
    async stop() {
      proc.kill('SIGTERM');
      const result = await exited;
      rmSync(dataDir, { recursive: true, force: true });
      return result;
    },
  };
}

export function request(port, method, path, { json, body, headers = {}, gzipBody = false } = {}) {
  return new Promise((resolve, reject) => {
    let payload = body;
    const h = { ...headers };
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      h['Content-Type'] ??= 'application/json';
    }
    if (payload !== undefined && gzipBody) {
      payload = gzipSync(payload);
      h['Content-Encoding'] = 'gzip';
    }
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    let settled = false;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        settled = true;
        const raw = Buffer.concat(chunks);
        const decoded = res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
        const text = decoded.toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, text, json: parsed });
      });
      res.on('error', (e) => { if (!settled) reject(e); });
    });
    // The server may close the socket after answering 413 before the upload finishes.
    req.on('error', (e) => { if (!settled) setTimeout(() => { if (!settled) reject(e); }, 200); });
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
export const install = () => randomUUID();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'ri', 'po', 've', 'du', 'xa', 'gi', 'bo', 'fe', 'zu', 'ha', 'jo', 'qe', 'wi', 'yu'];
const WORDS = [];
for (const a of SYL) for (const b of SYL) WORDS.push(a + b);

/** Deterministic transcript. Same seed gives the same text; noise swaps that share of words. */
export function makeSegments({ seed = 1, duration = 600, coverage = 1, noise = 0, noiseSeed = 4242, segLen = 5, wordsPerSeg = 12 } = {}) {
  const rand = mulberry32(seed);
  const noiseRand = mulberry32(noiseSeed);
  const segs = [];
  const until = duration * coverage;
  for (let t = 0; t + segLen <= until + 1e-9; t += segLen) {
    const words = [];
    for (let i = 0; i < wordsPerSeg; i++) {
      let w = WORDS[Math.floor(rand() * WORDS.length)];
      if (noise && noiseRand() < noise) w = `x${Math.floor(noiseRand() * 1e6)}`;
      words.push(w);
    }
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    segs.push({ start: t, end: t + segLen - 0.2, text: `${words.join(' ')}.` });
  }
  return segs;
}

export function makeUpload({
  keys, installId = install(), source = 'whisper', model = 'large-v3-turbo', duration = 600, coverage = 1,
  seed = 1, noise = 0, noiseSeed, translation = null, trRatio = 1, ...rest
}) {
  const segments = makeSegments({ seed, duration, coverage, noise, noiseSeed });
  let tr = null;
  if (translation) {
    const cut = Math.round(segments.length * trRatio);
    tr = {
      lang: 'zh-CN',
      engine: translation,
      model: translation === 'llm' ? 'deepseek-chat' : '',
      items: segments.map((s, i) => (i < cut ? `译文 ${i}` : null)),
    };
  }
  return {
    keys, title: 'Test episode', show: 'Test show', duration, source, model, language: 'en', segments,
    translation: tr, client: { app: 'subcast', version: '0.2.0', install: installId }, ...rest,
  };
}
