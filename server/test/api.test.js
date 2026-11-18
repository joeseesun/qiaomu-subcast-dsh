import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { startServer, request, makeUpload, makeSegments, sha1, install } from './helpers.js';
import { computeSketch, similarity } from '../src/textsim.js';

const ADMIN = 'test-admin-token';
let srv;
let db;

const post = (json, opts = {}) => request(srv.port, 'POST', '/api/v1/transcripts', { json, ...opts });
const lookup = (keys, headers = {}) =>
  request(srv.port, 'GET', `/api/v1/transcripts?${keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')}`, { headers });
const report = (id, reason, installId = install()) =>
  request(srv.port, 'POST', `/api/v1/transcripts/${id}/report`, { json: { reason, install: installId } });
const versionsFor = (key) => db.prepare(
  `SELECT v.id, v.model, v.votes, v.score, v.tr_engine FROM versions v
   JOIN episode_keys k ON k.episode_id = v.episode_id WHERE k.key = ? ORDER BY v.score DESC`,
).all(key);

before(async () => {
  srv = await startServer({ ADMIN_TOKEN: ADMIN });
  db = new DatabaseSync(join(srv.dataDir, 'subcast.db'));
});

after(async () => {
  db.close();
  const { code } = await srv.stop();
  assert.equal(code, 0, 'graceful SIGTERM shutdown exits 0');
});

describe('basics', () => {
  test('health', async () => {
    const r = await request(srv.port, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.version, '0.1.0');
    assert.equal(typeof r.json.transcripts, 'number');
  });

  test('lookup miss returns 404 not_found and is not cached', async () => {
    const r = await lookup(['yt:missMiss001']);
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not_found' });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('upload then lookup hit returns the stored transcript', async () => {
    const keys = ['yt:hitHitHit01', `guid:${sha1('hit')}`];
    const body = makeUpload({ keys, translation: 'llm', trRatio: 0.5 });
    const up = await post(body);
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.stored, true);
    assert.equal(up.json.rank, 1);
    assert.equal(up.json.versions, 1);
    assert.match(up.json.id, /^[A-Za-z0-9_-]{12}$/);

    // Upper-case hex is normalised; a non-matching extra key does not prevent the hit.
    const r = await lookup([`guid:${sha1('hit').toUpperCase()}`, 'yt:otherVid012']);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers['cache-control'], 'public, max-age=300');
    assert.ok(r.headers.etag);
    const t = r.json;
    assert.deepEqual(Object.keys(t).sort(), ['createdAt', 'id', 'language', 'model', 'score', 'segments', 'source', 'translation', 'versions'].sort());
    assert.equal(t.id, up.json.id);
    assert.equal(t.source, 'whisper');
    assert.equal(t.model, 'large-v3-turbo');
    assert.equal(t.language, 'en');
    assert.deepEqual(t.segments, body.segments);
    assert.equal(t.translation.lang, 'zh-CN');
    assert.equal(t.translation.engine, 'llm');
    assert.equal(t.translation.model, 'deepseek-chat');
    assert.equal(t.translation.items.length, t.segments.length);
    assert.equal(t.translation.items[0], '译文 0');
    assert.equal(t.translation.items.at(-1), null);
    assert.ok(t.score > 0 && t.score <= 1);
    assert.equal(t.versions, 1);
    assert.ok(Math.abs(t.createdAt - Date.now()) < 60_000);

    const again = await lookup(['yt:hitHitHit01'], { 'If-None-Match': r.headers.etag });
    assert.equal(again.status, 304);
  });

  test('control characters are stripped from text', async () => {
    const keys = ['yt:ctrlChars01'];
    const body = makeUpload({ keys, title: 'Bad\u0007 title\u202E' });
    body.segments[0].text = 'hello\u0007\u0000 world\u202E\nnext';
    const up = await post(body);
    assert.equal(up.status, 200, up.text);
    const r = await lookup(keys);
    assert.equal(r.json.segments[0].text, 'hello world next');
  });
});

describe('episodes and versions', () => {
  test('keys that overlap merge into one episode', async () => {
    const yt = 'yt:mergeVideo1';
    const guid = `guid:${sha1('merge-guid')}`;
    const audio = `audio:${sha1('merge-audio')}`;
    const a = await post(makeUpload({ keys: [yt], seed: 101, model: 'large-v3' }));
    const b = await post(makeUpload({ keys: [guid], seed: 102, model: 'small' }));
    assert.equal(a.json.versions, 1);
    assert.equal(b.json.versions, 1);
    assert.equal((await lookup([guid])).json.id, b.json.id, 'separate episodes before the overlap');

    const c = await post(makeUpload({ keys: [yt, guid], seed: 103, model: 'medium' }));
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.versions, 3, 'both episodes merged');
    assert.equal(c.json.rank, 2);

    const viaGuid = await lookup([guid]);
    assert.equal(viaGuid.json.id, a.json.id, 'best version across the merged episode');
    assert.equal(viaGuid.json.versions, 3);

    const d = await post(makeUpload({ keys: [audio, yt], seed: 104, model: 'tiny' }));
    assert.equal(d.json.stored, false, 'tiny ranks below the 3 kept versions');
    assert.equal((await lookup([audio])).json.id, a.json.id, 'new key was merged into the episode');

    const episodes = db.prepare('SELECT COUNT(DISTINCT episode_id) AS n FROM episode_keys WHERE key IN (?, ?, ?)').get(yt, guid, audio).n;
    assert.equal(episodes, 1);
  });

  test('keeps 3 versions and replaces the lowest only when the new one scores higher', async () => {
    const keys = ['yt:capTest0001'];
    const base = await post(makeUpload({ keys, seed: 11, model: 'base' }));
    const small = await post(makeUpload({ keys, seed: 12, model: 'small' }));
    const large = await post(makeUpload({ keys, seed: 13, model: 'large-v3' }));
    assert.deepEqual([base.json.rank, small.json.rank, large.json.rank], [1, 1, 1]);
    assert.equal(large.json.versions, 3);

    const tiny = await post(makeUpload({ keys, seed: 14, model: 'tiny' }));
    assert.equal(tiny.status, 200);
    assert.deepEqual(tiny.json, { id: null, stored: false, rank: 4, versions: 3, action: 'rejected' });

    const qwen = await post(makeUpload({ keys, seed: 15, source: 'qwen3', model: 'Qwen3-ASR-1.7B' }));
    assert.equal(qwen.json.stored, true);
    assert.equal(qwen.json.action, 'replaced_lowest');
    assert.equal(qwen.json.rank, 1, 'ties with large-v3 on score and votes, newest wins');
    assert.equal(qwen.json.versions, 3);
    assert.equal((await report(base.json.id, 'other')).status, 404, 'lowest (base) was dropped');

    const medium = await post(makeUpload({ keys, seed: 16, model: 'medium' }));
    assert.equal(medium.json.action, 'replaced_lowest');
    assert.equal(medium.json.rank, 3);
    assert.deepEqual(versionsFor(keys[0]).map((v) => v.model).sort(), ['Qwen3-ASR-1.7B', 'large-v3', 'medium']);
    assert.equal((await lookup(keys)).json.id, qwen.json.id);
  });

  test('near-duplicates count as votes and can upgrade the translation in place', async () => {
    assert.ok(similarity(computeSketch(makeSegments({ seed: 21 })), computeSketch(makeSegments({ seed: 21, noise: 0.01 }))) >= 0.9);
    assert.ok(similarity(computeSketch(makeSegments({ seed: 21 })), computeSketch(makeSegments({ seed: 21, noise: 0.3 }))) < 0.9);

    const keys = [`guid:${sha1('dup')}`];
    const first = await post(makeUpload({ keys, seed: 21 }));
    const voter = install();
    const dup = await post(makeUpload({ keys, seed: 21, noise: 0.01, installId: voter }));
    assert.equal(dup.json.id, first.json.id);
    assert.equal(dup.json.stored, true);
    assert.equal(dup.json.action, 'confirmed');
    assert.equal(dup.json.versions, 1);
    assert.equal(versionsFor(keys[0])[0].votes, 1);

    const again = await post(makeUpload({ keys, seed: 21, noise: 0.01, noiseSeed: 7, installId: voter }));
    assert.equal(again.json.action, 'confirmed');
    assert.equal(versionsFor(keys[0])[0].votes, 1, 'one vote per install');

    const before = (await lookup(keys)).json;
    assert.equal(before.translation, null);
    const better = await post(makeUpload({ keys, seed: 21, noise: 0.01, noiseSeed: 9, translation: 'llm' }));
    assert.equal(better.json.id, first.json.id);
    assert.equal(better.json.action, 'upgraded');
    const after = (await lookup(keys)).json;
    assert.equal(after.id, first.json.id);
    assert.equal(after.translation.engine, 'llm');
    assert.equal(after.translation.items.length, after.segments.length);
    assert.ok(after.score > before.score);
    const rows = versionsFor(keys[0]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].votes, 2);
  });

  test('a near-duplicate with better coverage replaces the segments in place', async () => {
    const keys = [`audio:${sha1('dup-coverage')}`];
    const first = await post(makeUpload({ keys, seed: 22, coverage: 0.95 }));
    const full = await post(makeUpload({ keys, seed: 22, coverage: 1 }));
    assert.equal(full.json.id, first.json.id);
    assert.equal(full.json.action, 'upgraded');
    const r = (await lookup(keys)).json;
    assert.equal(r.segments.at(-1).end, 599.8);
  });

  test('a partial transcript never beats a complete one', async () => {
    const keys = ['yt:partial0001'];
    const partial = await post(makeUpload({ keys, seed: 31, coverage: 0.5, model: 'large-v3', translation: 'llm' }));
    await post(makeUpload({ keys, seed: 31, coverage: 0.5, noise: 0.01 }));
    await post(makeUpload({ keys, seed: 31, coverage: 0.5, noise: 0.01, noiseSeed: 3 }));
    assert.equal(versionsFor(keys[0])[0].votes, 2);
    const complete = await post(makeUpload({ keys, seed: 32, model: 'tiny' }));
    assert.equal(complete.json.rank, 1);
    assert.equal((await lookup(keys)).json.id, complete.json.id);
    assert.notEqual(partial.json.id, complete.json.id);

    // Declaring a short duration does not make a partial transcript look complete.
    const keys2 = ['yt:partial0002'];
    const honest = await post(makeUpload({ keys: keys2, seed: 33, model: 'tiny', duration: 600 }));
    const liar = makeUpload({ keys: keys2, seed: 34, model: 'large-v3', translation: 'llm', duration: 300 });
    const lied = await post(liar);
    assert.equal(lied.json.rank, 2);
    assert.equal((await lookup(keys2)).json.id, honest.json.id);
  });

  test('the same install re-uploading replaces its own version', async () => {
    const keys = ['yt:sameInstal1'];
    const me = install();
    const v1 = await post(makeUpload({ keys, seed: 41, installId: me, model: 'small' }));
    const v2 = await post(makeUpload({ keys, seed: 42, installId: me, model: 'large-v3' }));
    assert.equal(v2.json.action, 'replaced_own');
    assert.notEqual(v2.json.id, v1.json.id);
    assert.equal(v2.json.versions, 1);
    assert.equal((await lookup(keys)).json.id, v2.json.id);
    assert.equal((await report(v1.json.id, 'other')).status, 404);
  });

  test('reports lower the rank, one per install per version', async () => {
    const keys = ['yt:reportTest1'];
    const a = await post(makeUpload({ keys, seed: 51, model: 'large-v3' }));
    const b = await post(makeUpload({ keys, seed: 52, model: 'medium' }));
    assert.equal(b.json.rank, 2);
    assert.equal((await lookup(keys)).json.id, a.json.id);

    const reporter = install();
    const r1 = await report(a.json.id, 'bad_text', reporter);
    assert.equal(r1.status, 200, r1.text);
    assert.deepEqual(r1.json, { ok: true, counted: true });
    assert.equal((await lookup(keys)).json.id, b.json.id);

    const r2 = await report(a.json.id, 'wrong_episode', reporter);
    assert.deepEqual(r2.json, { ok: true, counted: false });
    assert.equal(db.prepare('SELECT reports FROM versions WHERE id = ?').get(a.json.id).reports, 1);

    assert.equal((await report(a.json.id, 'spam')).status, 400);
    assert.equal((await report('AAAAAAAAAAAA', 'other')).status, 404);
    assert.equal((await report('bad%20id!', 'other')).status, 404);
  });

  test('heavily reported versions stop being served', async () => {
    const keys = ['yt:hiddenTest1'];
    const a = await post(makeUpload({ keys, seed: 61 }));
    await report(a.json.id, 'wrong_episode');
    assert.equal((await lookup(keys)).status, 200);
    await report(a.json.id, 'wrong_episode');
    assert.equal((await lookup(keys)).status, 404);
  });
});

describe('validation', () => {
  const ok = () => makeUpload({ keys: ['yt:validate001'], seed: 71 });

  test('bad keys', async () => {
    for (const keys of [[], ['yt:short'], ['foo:bar'], [`guid:${'z'.repeat(40)}`], ['audio:abc'], ['qm:'], ['yt:a', 'yt:b', 'yt:c', 'yt:d', 'yt:e'], 'yt:dQw4w9WgXcQ', [42]]) {
      const r = await post({ ...ok(), keys });
      assert.equal(r.status, 400, `keys ${JSON.stringify(keys)}`);
      assert.equal(r.json.error, 'invalid_key');
    }
    assert.equal((await lookup(['yt:bad'])).status, 400);
    assert.equal((await request(srv.port, 'GET', '/api/v1/transcripts')).status, 400);
    assert.equal((await lookup(['qm:ep-123.4_x', `guid:${sha1('x')}`])).status, 404, 'valid formats');
  });

  test('translation length must match segments', async () => {
    const body = makeUpload({ keys: ['yt:validate002'], translation: 'google' });
    body.translation.items.pop();
    const r = await post(body);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'translation_mismatch');
  });

  test('field rules', async () => {
    const cases = [
      ['unknown top-level field', (b) => { b.extra = 1; }, 'unknown_field'],
      ['unknown segment field', (b) => { b.segments[0].words = []; }, 'unknown_field'],
      ['unknown client field', (b) => { b.client.ip = 'x'; }, 'unknown_field'],
      ['end before start', (b) => { b.segments[1].end = b.segments[1].start - 1; }],
      ['segments going backwards', (b) => { b.segments[5].start = 1; b.segments[5].end = 2; }],
      ['negative start', (b) => { b.segments[0].start = -1; }],
      ['non-finite end', (b) => { b.segments[0].end = '3'; }],
      ['end far past duration', (b) => { b.segments.at(-1).end = 9999; }],
      ['too long text', (b) => { b.segments[0].text = 'a'.repeat(2001); }],
      ['empty segments', (b) => { b.segments = []; }],
      ['too many segments', (b) => { b.segments = Array.from({ length: 30001 }, (_, i) => ({ start: i * 0.01, end: i * 0.01, text: 'x' })); }],
      ['bad language', (b) => { b.language = 'english'; }],
      ['zero duration', (b) => { b.duration = 0; }],
      ['duration over 24h', (b) => { b.duration = 86400; }],
      ['title too long', (b) => { b.title = 't'.repeat(301); }],
      ['bad source', (b) => { b.source = 'official'; }],
      ['missing install', (b) => { delete b.client.install; }],
      ['bad translation engine', (b) => { b.translation = { lang: 'zh-CN', engine: 'deepl', items: b.segments.map(() => 'x') }; }],
    ];
    for (const [name, mutate, code = 'invalid_request'] of cases) {
      const b = ok();
      mutate(b);
      const r = await post(b);
      assert.equal(r.status, 400, `${name}: ${r.text}`);
      assert.equal(r.json.error, code, name);
    }
    const good = ok();
    good.language = 'auto';
    good.segments[3].start -= 3;
    assert.equal((await post(good)).status, 200, 'auto language and small overlap are accepted');
  });

  test('body format errors', async () => {
    const path = '/api/v1/transcripts';
    const bad = await request(srv.port, 'POST', path, { body: '{nope', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.json.error, 'invalid_json');
    const type = await request(srv.port, 'POST', path, { body: '{}', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(type.status, 415);
    const br = await request(srv.port, 'POST', path, { body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' } });
    assert.equal(br.status, 415);
    const notGzip = await request(srv.port, 'POST', path, { body: 'plain', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } });
    assert.equal(notGzip.status, 400);
    assert.equal(notGzip.json.error, 'invalid_gzip');
    const method = await request(srv.port, 'PUT', path);
    assert.equal(method.status, 405);
    assert.equal((await request(srv.port, 'GET', '/api/nope')).status, 404);
  });

  test('oversize bodies are rejected, raw or gzip-compressed', async () => {
    const big = Buffer.alloc(7 * 1024 * 1024, 0x20);
    const raw = await request(srv.port, 'POST', '/api/v1/transcripts', { body: big, headers: { 'Content-Type': 'application/json' } });
    assert.equal(raw.status, 413);
    assert.equal(raw.json.error, 'payload_too_large');

    const bomb = gzipSync(big);
    assert.ok(bomb.length < 100_000);
    const gz = await request(srv.port, 'POST', '/api/v1/transcripts', {
      body: bomb, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    });
    assert.equal(gz.status, 413);
    assert.equal((await request(srv.port, 'GET', '/api/health')).status, 200, 'server still healthy');
  });
});

describe('transport', () => {
  test('gzip request bodies and gzip responses', async () => {
    const keys = ['yt:gzipTest001'];
    const body = makeUpload({ keys, seed: 81, translation: 'google' });
    const up = await post(body, { gzipBody: true });
    assert.equal(up.status, 200, up.text);

    const gz = await lookup(keys, { 'Accept-Encoding': 'gzip, deflate' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(gz.headers.vary, /Accept-Encoding/);
    assert.ok(gz.raw.length < gz.text.length / 2, `compressed ${gz.raw.length} of ${gz.text.length}`);
    assert.deepEqual(JSON.parse(gunzipSync(gz.raw).toString()).segments, body.segments);

    const plain = await lookup(keys);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.json.id, up.json.id);
    assert.equal(plain.text, gz.text);

    const refused = await lookup(keys, { 'Accept-Encoding': 'gzip;q=0' });
    assert.equal(refused.headers['content-encoding'], undefined);
  });

  test('CORS preflight and simple requests', async () => {
    for (const origin of ['http://localhost:14327', 'tauri://localhost', 'https://subcast.qiaomu.ai']) {
      const r = await request(srv.port, 'OPTIONS', '/api/v1/transcripts', {
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, content-encoding' },
      });
      assert.equal(r.status, 204, origin);
      assert.equal(r.headers['access-control-allow-origin'], origin);
      assert.equal(r.headers['access-control-allow-methods'], 'GET, POST');
      assert.match(r.headers['access-control-allow-headers'], /Content-Type/);
      assert.match(r.headers['access-control-allow-headers'], /Content-Encoding/);
      assert.match(r.headers.vary, /Origin/);
    }
    const evil = await request(srv.port, 'OPTIONS', '/api/v1/transcripts', {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers['access-control-allow-origin'], undefined);

    const simple = await request(srv.port, 'GET', '/api/health', { headers: { Origin: 'tauri://localhost' } });
    assert.equal(simple.headers['access-control-allow-origin'], 'tauri://localhost');
    const other = await request(srv.port, 'GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });

  test('admin endpoints need the bearer token', async () => {
    const keys = ['yt:adminTest01'];
    const up = await post(makeUpload({ keys, seed: 91 }));
    assert.equal((await request(srv.port, 'GET', '/api/v1/stats')).status, 401);
    assert.equal((await request(srv.port, 'GET', '/api/v1/stats', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const stats = await request(srv.port, 'GET', '/api/v1/stats', { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(stats.status, 200);
    for (const k of ['episodes', 'keys', 'versions', 'reports', 'confirmations', 'bySource', 'dbBytes', 'uptimeSec']) assert.ok(k in stats.json, k);

    assert.equal((await request(srv.port, 'DELETE', `/api/v1/transcripts/${up.json.id}`)).status, 401);
    const del = await request(srv.port, 'DELETE', `/api/v1/transcripts/${up.json.id}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(del.status, 200);
    assert.equal((await lookup(keys)).status, 404);
  });

  test('privacy: salted install hashes, no IPs stored', async () => {
    const me = install();
    await post(makeUpload({ keys: ['yt:privacy0001'], seed: 95, installId: me }));
    const salt = statSync(join(srv.dataDir, 'salt'));
    assert.equal(salt.mode & 0o777, 0o600);
    const rows = db.prepare('SELECT install_hash FROM versions').all();
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.install_hash) && r.install_hash !== me));
    const dump = readFileSync(join(srv.dataDir, 'subcast.db')).toString('latin1') + readFileSync(join(srv.dataDir, 'subcast.db-wal')).toString('latin1');
    assert.ok(!dump.includes(me) && !dump.includes('127.0.0.1'));
  });
});

describe('rate limiting', () => {
  let limited;
  before(async () => {
    limited = await startServer({ RATE_LOOKUPS_PER_HOUR: '3', RATE_UPLOADS_PER_HOUR: '2', RATE_REPORTS_PER_HOUR: '1', LOG_REQUESTS: '1' });
  });
  after(async () => {
    const { code } = await limited.stop();
    assert.equal(code, 0);
  });

  test('lookups and uploads return 429 with Retry-After per IP', async () => {
    const path = '/api/v1/transcripts?key=yt:rateLimit01';
    for (let i = 0; i < 3; i++) assert.equal((await request(limited.port, 'GET', path)).status, 404);
    const blocked = await request(limited.port, 'GET', path);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error, 'rate_limited');
    const retry = Number(blocked.headers['retry-after']);
    assert.ok(retry > 0 && retry <= 3600, `Retry-After ${retry}`);

    const otherIp = await request(limited.port, 'GET', path, { headers: { 'X-Real-IP': '203.0.113.9' } });
    assert.equal(otherIp.status, 404, 'X-Real-IP from 127.0.0.1 is trusted');
    assert.equal((await request(limited.port, 'GET', '/api/health')).status, 200, 'health is not limited');

    const keys = ['yt:rateLimit02'];
    const up = (seed) => request(limited.port, 'POST', '/api/v1/transcripts', { json: makeUpload({ keys, seed }) });
    assert.equal((await up(1)).status, 200);
    assert.equal((await up(2)).status, 200);
    const third = await up(3);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers['retry-after']) > 0);
  });

  test('request log has no IPs or query strings', async () => {
    await new Promise((r) => setTimeout(r, 50));
    const logs = limited.logs();
    assert.match(logs, /GET \/api\/v1\/transcripts 429/);
    assert.ok(!logs.includes('203.0.113.9'));
    assert.ok(!logs.includes('127.0.0.1:') || logs.split('\n').filter((l) => l.includes('127.0.0.1')).every((l) => l.includes('listening')));
    assert.ok(!logs.includes('rateLimit01'));
  });

  test('admin endpoints are hidden without ADMIN_TOKEN', async () => {
    assert.equal((await request(limited.port, 'GET', '/api/v1/stats', { headers: { Authorization: 'Bearer x' } })).status, 404);
  });
});

describe('exists (batch)', () => {
  const exists = (json) => request(srv.port, 'POST', '/api/v1/transcripts/exists', { json });

  test('returns only the keys that have shared subtitles, normalized, skipping bad ones', async () => {
    const keys = ['yt:existsHit01', `guid:${sha1('exists-hit')}`];
    assert.equal((await post(makeUpload({ keys }))).status, 200);
    const r = await exists({ keys: ['yt:existsMis01', keys[0], `guid:${sha1('exists-hit').toUpperCase()}`, 'nope', 42] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.json.found.sort(), [...keys].sort());
  });

  test('empty list is fine; too many keys or a non-array is 400', async () => {
    assert.deepEqual((await exists({ keys: [] })).json, { found: [] });
    const many = Array.from({ length: 401 }, (_, i) => `guid:${sha1(`k${i}`)}`);
    assert.equal((await exists({ keys: many })).status, 400);
    assert.equal((await exists({ keys: 'yt:existsHit01' })).status, 400);
  });
});

describe('guides (导读)', () => {
  const guideText = `# 导读\n\n${'这期节目讨论了人工智能如何改变工作方式，嘉宾分享了很多具体的例子。'.repeat(8)}`;
  const putGuide = (json) => request(srv.port, 'POST', '/api/v1/guides', { json });
  const getGuide = (keys) => request(srv.port, 'GET', `/api/v1/guides?${keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')}`);
  const body = (over = {}) => ({ keys: ['yt:guideGuide1'], title: 'T', show: 'S', lang: 'zh', model: 'deepseek-v4', text: guideText, client: { app: 'subcast', version: '0.2.7', install: install() }, ...over });

  test('miss is 404; upload then lookup returns the text with line breaks kept', async () => {
    assert.equal((await getGuide(['yt:guideGuide1'])).status, 404);
    const up = await putGuide(body());
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.action, 'stored');
    const r = await getGuide(['yt:guideGuide1', `guid:${sha1('other')}`]);
    assert.equal(r.status, 200);
    assert.equal(r.json.text, guideText.trim());
    assert.equal(r.json.model, 'deepseek-v4');
  });

  test('another install keeps the first; the same install may replace it', async () => {
    const me = install();
    const keys = ['yt:guideGuide2'];
    assert.equal((await putGuide(body({ keys, client: { install: me } }))).json.action, 'stored');
    assert.equal((await putGuide(body({ keys, text: `${guideText}\n\n别人`, client: { install: install() } }))).json.action, 'kept');
    assert.equal((await putGuide(body({ keys, text: `${guideText}\n\n重写`, client: { install: me } }))).json.action, 'replaced');
    assert.match((await getGuide(keys)).json.text, /重写$/);
  });

  test('rejects short, non-Chinese or non-zh guides', async () => {
    assert.equal((await putGuide(body({ text: '太短了' }))).status, 400);
    assert.equal((await putGuide(body({ text: 'english only '.repeat(40) }))).status, 400);
    assert.equal((await putGuide(body({ lang: 'en' }))).status, 400);
  });
});
