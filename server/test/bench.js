import { startServer, request, makeUpload, sha1 } from './helpers.js';

function summary(times) {
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))].toFixed(2);
  return `p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${times[times.length - 1].toFixed(2)} ms`;
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const r = await fn();
  return [Number(process.hrtime.bigint() - t0) / 1e6, r];
}

async function lookups(server, label, path, headers) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < 200; i++) {
    const [ms, r] = await timed(() => request(server.port, 'GET', path, { headers }));
    if (r.status !== 200 && r.status !== 404) throw new Error(`lookup failed: ${r.status}`);
    times.push(ms);
    bytes = r.raw.length;
  }
  console.log(`${label}: 200 sequential, ${summary(times)}, response ${(bytes / 1024).toFixed(1)} KiB`);
}

for (const cacheSize of ['64', '0']) {
  const server = await startServer({ RESPONSE_CACHE_SIZE: cacheSize });
  try {
    console.log(`-- response cache ${cacheSize === '0' ? 'off' : 'on'}`);
    const keys = [`guid:${sha1('bench')}`];
    // A 3 hour episode: 2160 segments with a full LLM translation.
    const body = makeUpload({ keys, duration: 10800, translation: 'llm' });
    const [upMs, up] = await timed(() => request(server.port, 'POST', '/api/v1/transcripts', { json: body, gzipBody: true }));
    if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${up.text}`);
    console.log(`upload ${body.segments.length} segments (${(JSON.stringify(body).length / 1024).toFixed(0)} KiB JSON, gzip): ${upMs.toFixed(1)} ms`);

    if (cacheSize !== '0') {
      const times = [];
      for (let i = 0; i < 50; i++) {
        const b = makeUpload({ keys: [`guid:${sha1(`bench-${i}`)}`], seed: i + 2, duration: 3600, translation: 'google' });
        const [ms, r] = await timed(() => request(server.port, 'POST', '/api/v1/transcripts', { json: b, gzipBody: true }));
        if (r.status !== 200) throw new Error(`upload failed: ${r.status}`);
        times.push(ms);
      }
      console.log(`uploads: 50 sequential 1h episodes (720 segments), ${summary(times)}`);
    }

    const q = `/api/v1/transcripts?key=${encodeURIComponent(keys[0])}&key=yt:dQw4w9WgXcQ`;
    await lookups(server, 'hit gzip', q, { 'Accept-Encoding': 'gzip' });
    await lookups(server, 'hit identity', q, {});
    await lookups(server, 'miss', `/api/v1/transcripts?key=guid:${sha1('nope')}`, { 'Accept-Encoding': 'gzip' });
  } finally {
    await server.stop();
  }
}
