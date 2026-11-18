import { createServer } from 'node:http';
import { createGunzip, gzip as gzipCb } from 'node:zlib';
import { createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Store } from './store.js';
import { RateLimiter } from './ratelimit.js';
import { VERSION } from './config.js';
import { HttpError, validateExistsKeys, validateGuide, validateKeys, validateReport, validateUpload, validateVersionId } from './validate.js';

const gzipAsync = promisify(gzipCb);
const GZIP_MIN = 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HEADERS = 'Content-Type, Content-Encoding';

function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const real = req.headers['x-real-ip'];
  if (LOOPBACK.has(peer) && typeof real === 'string' && real.trim()) return real.trim().slice(0, 64);
  return peer.startsWith('::ffff:') ? peer.slice(7) : peer;
}

function acceptsGzip(req) {
  const ae = req.headers['accept-encoding'];
  if (typeof ae !== 'string') return false;
  for (const part of ae.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name.trim() !== 'gzip') continue;
    const q = params.map((s) => s.trim()).find((s) => s.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

function readBody(req, res, limit) {
  const enc = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (enc !== 'identity' && enc !== 'gzip') {
    return Promise.reject(new HttpError(415, 'unsupported_encoding', 'Content-Encoding must be gzip or identity'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, 'payload_too_large', `body exceeds ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let raw = 0;
    let done = false;
    const gunzip = enc === 'gzip' ? createGunzip() : null;
    const src = gunzip ? req.pipe(gunzip) : req;
    const fail = (err) => {
      if (done) return;
      done = true;
      if (gunzip) { req.unpipe(gunzip); gunzip.destroy(); }
      // Node discards the rest of the body (bounded by server.requestTimeout) so the client
      // can finish sending and read the error instead of hitting EPIPE.
      req.resume();
      reject(err);
    };
    const tooLarge = () => new HttpError(413, 'payload_too_large', `body exceeds ${limit} bytes`);
    if (gunzip) {
      req.on('data', (c) => { raw += c.length; if (raw > limit) fail(tooLarge()); });
      req.on('error', fail);
    }
    src.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) fail(tooLarge());
      else chunks.push(c);
    });
    src.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, size));
    });
    src.on('error', (err) => fail(gunzip ? new HttpError(400, 'invalid_gzip', 'request body is not valid gzip') : err));
  });
}

async function readJson(req, res, limit) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const buf = await readBody(req, res, limit);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'body is not valid JSON');
  }
}

async function send(req, res, status, body, headers = {}) {
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { 'Content-Type': 'application/json; charset=utf-8', ...headers };
  if (!h['Content-Encoding'] && payload.length >= GZIP_MIN && acceptsGzip(req)) {
    payload = await gzipAsync(payload, { level: 6 });
    h['Content-Encoding'] = 'gzip';
  }
  if (h['Content-Encoding'] || payload.length >= GZIP_MIN) h.Vary = appendVary(res.getHeader('Vary'), 'Accept-Encoding');
  h['Content-Length'] = payload.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function appendVary(current, value) {
  return current ? `${current}, ${value}` : value;
}

function sameSecret(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createApp(config) {
  const store = new Store(config.dataDir);
  const limiter = new RateLimiter({ windowMs: config.rate.windowMs, limits: config.rate });
  const cache = new Map();
  const startedAt = Date.now();

  function limit(req, bucket) {
    const r = limiter.hit(bucket, clientIp(req));
    if (!r.ok) throw new HttpError(429, 'rate_limited', 'too many requests', { 'Retry-After': String(r.retryAfter) });
  }

  function requireAdmin(req) {
    if (!config.adminToken) throw new HttpError(404, 'not_found');
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m || !sameSecret(m[1].trim(), config.adminToken)) {
      throw new HttpError(401, 'unauthorized', 'admin token required', { 'WWW-Authenticate': 'Bearer' });
    }
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!config.origins.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After, ETag');
    return true;
  }

  async function lookup(req, res, _match, url) {
    limit(req, 'lookup');
    const keys = validateKeys(url.searchParams.getAll('key'));
    const hit = store.lookup(keys);
    if (!hit) return send(req, res, 404, { error: 'not_found' }, { 'Cache-Control': 'no-store' });
    const headers = { 'Cache-Control': 'public, max-age=300', ETag: hit.etag };
    if (req.headers['if-none-match'] === hit.etag) {
      res.writeHead(304, { ...headers, Vary: appendVary(res.getHeader('Vary'), 'Accept-Encoding') });
      return res.end();
    }
    const gz = acceptsGzip(req);
    let entry = cache.get(hit.etag);
    if (entry) {
      cache.delete(hit.etag);
    } else {
      entry = { json: Buffer.from(hit.build()) };
    }
    if (gz && !entry.gz && entry.json.length >= GZIP_MIN) entry.gz = await gzipAsync(entry.json, { level: 6 });
    cache.set(hit.etag, entry);
    while (cache.size > config.responseCacheSize) cache.delete(cache.keys().next().value);
    if (gz && entry.gz) return send(req, res, 200, entry.gz, { ...headers, 'Content-Encoding': 'gzip' });
    return send(req, res, 200, entry.json, headers);
  }

  // POST { keys: [...] } -> { found: [...] }: which keys already have shared subtitles, so a list of
  // episodes can be marked without fetching every transcript.
  async function exists(req, res) {
    limit(req, 'exists');
    const body = await readJson(req, res, 64 * 1024);
    const keys = validateExistsKeys(body?.keys);
    return send(req, res, 200, { found: store.existing(keys) }, { 'Cache-Control': 'no-store' });
  }

  async function guideLookup(req, res, _match, url) {
    limit(req, 'lookup');
    const hit = store.guide(validateKeys(url.searchParams.getAll('key')));
    if (!hit) return send(req, res, 404, { error: 'not_found' }, { 'Cache-Control': 'no-store' });
    return send(req, res, 200, hit, { 'Cache-Control': 'public, max-age=300' });
  }

  async function guideUpload(req, res) {
    limit(req, 'upload');
    const out = store.uploadGuide(validateGuide(await readJson(req, res, 256 * 1024)));
    res.logNote = `guide=${out.action}`;
    return send(req, res, 200, out, { 'Cache-Control': 'no-store' });
  }

  async function upload(req, res) {
    limit(req, 'upload');
    const body = await readJson(req, res, config.maxBodyBytes);
    const payload = validateUpload(body);
    const result = store.upload(payload);
    res.logNote = `action=${result.action} rank=${result.rank} versions=${result.versions}${result.merged ? ' merged' : ''}`;
    const { merged, ...out } = result;
    return send(req, res, 200, out, { 'Cache-Control': 'no-store' });
  }

  async function report(req, res, id) {
    limit(req, 'report');
    validateVersionId(id);
    const body = validateReport(await readJson(req, res, 16 * 1024));
    const out = store.report(id, body.install, body.reason);
    res.logNote = `reason=${body.reason} counted=${out.counted}`;
    return send(req, res, 200, out, { 'Cache-Control': 'no-store' });
  }

  const routes = [
    { path: /^\/api\/health$/, methods: { GET: (req, res) => send(req, res, 200, { ok: true, version: VERSION, transcripts: store.countTranscripts() }, { 'Cache-Control': 'no-store' }) } },
    { path: /^\/api\/v1\/transcripts$/, methods: { GET: lookup, POST: upload } },
    { path: /^\/api\/v1\/transcripts\/exists$/, methods: { POST: exists } },
    { path: /^\/api\/v1\/guides$/, methods: { GET: guideLookup, POST: guideUpload } },
    { path: /^\/api\/v1\/transcripts\/exists$/, methods: { POST: exists } },
    { path: /^\/api\/v1\/transcripts\/([^/]+)\/report$/, methods: { POST: (req, res, m) => report(req, res, m[1]) } },
    {
      path: /^\/api\/v1\/transcripts\/([^/]+)$/,
      methods: {
        DELETE: (req, res, m) => {
          requireAdmin(req);
          return send(req, res, 200, store.remove(validateVersionId(m[1])), { 'Cache-Control': 'no-store' });
        },
      },
    },
    {
      path: /^\/api\/v1\/stats$/,
      methods: {
        GET: (req, res) => {
          requireAdmin(req);
          const out = {
            ...store.stats(),
            version: VERSION,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            rateLimitEntries: limiter.size,
          };
          return send(req, res, 200, out, { 'Cache-Control': 'no-store' });
        },
      },
    },
  ];

  async function handle(req, res, url) {
    const allowed = cors(req, res);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    if (req.method === 'OPTIONS') {
      if (!allowed || !req.headers['access-control-request-method']) {
        res.writeHead(allowed ? 204 : 403, { 'Content-Length': 0 });
        return res.end();
      }
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Max-Age': '86400',
        'Content-Length': 0,
      });
      return res.end();
    }

    for (const route of routes) {
      const m = route.path.exec(path);
      if (!m) continue;
      const handler = route.methods[req.method];
      if (!handler) {
        throw new HttpError(405, 'method_not_allowed', `use ${Object.keys(route.methods).join(', ')}`, {
          Allow: Object.keys(route.methods).join(', '),
        });
      }
      return handler(req, res, m, url);
    }
    throw new HttpError(404, 'not_found');
  }

  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
    res.on('finish', () => {
      if (!config.logRequests) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const bytes = res.getHeader('Content-Length') ?? 0;
      process.stdout.write(`${new Date().toISOString()} ${req.method} ${url.pathname.slice(0, 120)} ${res.statusCode} ${ms.toFixed(1)}ms ${bytes}B${res.logNote ? ` ${res.logNote}` : ''}\n`);
    });
    try {
      await handle(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) {
        const body = { error: err.code };
        if (err.detail) body.detail = err.detail;
        await send(req, res, err.status, body, { 'Cache-Control': 'no-store', ...err.headers });
      } else {
        process.stderr.write(`${new Date().toISOString()} error ${req.method} ${url.pathname}: ${err?.stack || err}\n`);
        await send(req, res, 500, { error: 'internal' }, { 'Cache-Control': 'no-store' });
      }
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  let closing = null;
  function close() {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      limiter.stop();
      const force = setTimeout(() => server.closeAllConnections(), 10_000);
      force.unref();
      server.close(() => {
        clearTimeout(force);
        store.close();
        resolve();
      });
      server.closeIdleConnections();
    });
    return closing;
  }

  return { server, store, close };
}
