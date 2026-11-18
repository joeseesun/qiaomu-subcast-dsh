import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;

export const DEFAULT_ORIGINS = [
  'http://localhost:14327',
  'tauri://localhost',
  'https://subcast.qiaomu.ai',
];

function int(env, name, fallback, min = 0) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

export function loadConfig(env = process.env) {
  const origins = (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env, 'PORT', 8787),
    dataDir: resolve(env.DATA_DIR || './data'),
    adminToken: env.ADMIN_TOKEN || '',
    origins: new Set(origins.length ? origins : DEFAULT_ORIGINS),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 6 * 1024 * 1024, 1024),
    rate: {
      windowMs: int(env, 'RATE_WINDOW_MS', 60 * 60 * 1000, 1000),
      upload: int(env, 'RATE_UPLOADS_PER_HOUR', 30),
      lookup: int(env, 'RATE_LOOKUPS_PER_HOUR', 600),
      exists: int(env, 'RATE_EXISTS_PER_HOUR', 120),
      report: int(env, 'RATE_REPORTS_PER_HOUR', 60),
    },
    responseCacheSize: int(env, 'RESPONSE_CACHE_SIZE', 64),
    logRequests: env.LOG_REQUESTS !== '0',
  };
}
