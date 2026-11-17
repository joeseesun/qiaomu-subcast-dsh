export class HttpError extends Error {
  constructor(status, code, detail, headers) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

const invalid = (detail) => new HttpError(400, 'invalid_request', detail);

export const SOURCES_UPLOAD = new Set(['whisper', 'qwen3', 'cloud']);
export const ENGINES = new Set(['google', 'llm']);
export const REPORT_REASONS = new Set(['wrong_episode', 'bad_text', 'bad_translation', 'other']);

export const MAX_KEYS = 4;
export const MAX_SEGMENTS = 30_000;
export const MAX_SEGMENT_TEXT = 2000;
export const MAX_TRANSLATION_TEXT = 4000;
export const MAX_DURATION = 24 * 60 * 60;
// Segments may start up to this many seconds before the latest start seen so far.
export const ALLOWED_BACKTRACK = 5;

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_ID_RE = /^[A-Za-z0-9_-]{12}$/;
const KEY_RES = {
  yt: /^[A-Za-z0-9_-]{11}$/,
  guid: /^[0-9a-f]{40}$/,
  audio: /^[0-9a-f]{40}$/,
  qm: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
};

// C0/C1 controls (except tab/newline/CR, which become spaces), bidi overrides and BOM.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const BREAKS = /[\t\n\r]+/g;

export function clean(str) {
  return str.toWellFormed().replace(BREAKS, ' ').replace(CONTROL, '').trim();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkFields(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new HttpError(400, 'unknown_field', `unknown field "${where ? `${where}.` : ''}${k}"`);
  }
}

function optString(v, name, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw invalid(`${name} must be a string`);
  const s = clean(v);
  if (s.length > max) throw invalid(`${name} must be at most ${max} characters`);
  return s;
}

export function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const prefix = s.slice(0, i);
  let value = s.slice(i + 1);
  const re = KEY_RES[prefix];
  if (!re) return null;
  if (prefix === 'guid' || prefix === 'audio') value = value.toLowerCase();
  return re.test(value) ? `${prefix}:${value}` : null;
}

export function validateKeys(list) {
  if (!Array.isArray(list) || list.length < 1) throw new HttpError(400, 'invalid_key', 'between 1 and 4 keys are required');
  if (list.length > MAX_KEYS) throw new HttpError(400, 'invalid_key', `at most ${MAX_KEYS} keys are allowed`);
  const out = [];
  for (const raw of list) {
    const key = normalizeKey(raw);
    if (!key) {
      const shown = typeof raw === 'string' ? raw.slice(0, 60) : typeof raw;
      throw new HttpError(400, 'invalid_key', `invalid key "${shown}"; expected yt:<11 chars>, guid:<sha1>, audio:<sha1> or qm:<id>`);
    }
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

const GUIDE_FIELDS = new Set(['keys', 'title', 'show', 'lang', 'model', 'text', 'client']);

// A 导读 (Markdown, Chinese). Line breaks are kept; control characters go.
export function validateGuide(body) {
  if (!isPlainObject(body)) throw invalid('body must be a JSON object');
  checkFields(body, GUIDE_FIELDS, '');
  const keys = validateKeys(body.keys);
  const title = optString(body.title, 'title', 300);
  const show = optString(body.show, 'show', 300);
  if (typeof body.lang !== 'string' || !/^zh(-[A-Za-z]{2,4})?$/.test(body.lang)) throw invalid('lang must be zh or zh-XX');
  if (typeof body.model !== 'string') throw invalid('model must be a string');
  const model = body.model.replace(CONTROL, '').trim().slice(0, 120);
  if (typeof body.text !== 'string') throw invalid('text must be a string');
  const text = body.text.replace(CONTROL, '').trim();
  if (text.length < 200 || text.length > 60000) throw invalid('text must be 200 to 60000 characters');
  if ((text.match(/[\u4e00-\u9fff]/g) ?? []).length < 100) throw invalid('text must be mostly Chinese');
  return { keys, title, show, lang: body.lang, model, text, client: validateClient(body.client) };
}

export const MAX_EXISTS_KEYS = 400;

// For the batch "which of these exist" check: unknown or malformed keys are skipped, not an error,
// so one odd episode never hides the answer for the rest of a list.
export function validateExistsKeys(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'invalid_key', 'keys must be an array');
  if (list.length > MAX_EXISTS_KEYS) throw new HttpError(400, 'invalid_key', `at most ${MAX_EXISTS_KEYS} keys are allowed`);
  const out = new Set();
  for (const raw of list) { const k = normalizeKey(raw); if (k) out.add(k); }
  return [...out];
}

export function validateVersionId(id) {
  if (!VERSION_ID_RE.test(id)) throw new HttpError(404, 'not_found', 'unknown transcript id');
  return id;
}

function validLang(v, name, allowAuto) {
  if (typeof v !== 'string' || !(LANG_RE.test(v) || (allowAuto && v === 'auto'))) {
    throw invalid(`${name} must look like "en", "zh-CN"${allowAuto ? ' or be "auto"' : ''}`);
  }
  return v;
}

function finiteNonNeg(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalid(`${name} must be a finite number >= 0`);
  return v;
}

const round3 = (x) => Math.round(x * 1000) / 1000;
const SEGMENT_FIELDS = new Set(['start', 'end', 'text']);

function validateSegments(segs, duration) {
  if (!Array.isArray(segs) || segs.length < 1 || segs.length > MAX_SEGMENTS) {
    throw invalid(`segments must be an array of 1 to ${MAX_SEGMENTS} items`);
  }
  const endLimit = duration + Math.max(60, duration * 0.05);
  const out = new Array(segs.length);
  let maxStart = 0;
  let maxEnd = 0;
  let nonEmpty = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const where = `segments[${i}]`;
    if (!isPlainObject(s)) throw invalid(`${where} must be an object`);
    checkFields(s, SEGMENT_FIELDS, where);
    const start = finiteNonNeg(s.start, `${where}.start`);
    const end = finiteNonNeg(s.end, `${where}.end`);
    if (end < start) throw invalid(`${where}.end must be >= start`);
    if (start < maxStart - ALLOWED_BACKTRACK) throw invalid(`${where}.start goes back more than ${ALLOWED_BACKTRACK}s`);
    if (end > endLimit) throw invalid(`${where}.end is past the episode duration`);
    if (typeof s.text !== 'string') throw invalid(`${where}.text must be a string`);
    const text = clean(s.text);
    if (text.length > MAX_SEGMENT_TEXT) throw invalid(`${where}.text must be at most ${MAX_SEGMENT_TEXT} characters`);
    if (text) nonEmpty++;
    if (start > maxStart) maxStart = start;
    if (end > maxEnd) maxEnd = end;
    out[i] = { start: round3(start), end: round3(end), text };
  }
  if (!nonEmpty) throw invalid('segments contain no text');
  return { segments: out, maxEnd };
}

const TRANSLATION_FIELDS = new Set(['lang', 'engine', 'model', 'items']);

function validateTranslation(t, segCount) {
  if (t === undefined || t === null) return null;
  if (!isPlainObject(t)) throw invalid('translation must be an object or null');
  checkFields(t, TRANSLATION_FIELDS, 'translation');
  const lang = validLang(t.lang, 'translation.lang', false);
  if (!ENGINES.has(t.engine)) throw invalid('translation.engine must be "google" or "llm"');
  const model = optString(t.model, 'translation.model', 100);
  if (!Array.isArray(t.items)) throw invalid('translation.items must be an array');
  if (t.items.length !== segCount) {
    throw new HttpError(400, 'translation_mismatch', `translation.items has ${t.items.length} items but there are ${segCount} segments`);
  }
  let translated = 0;
  const items = new Array(segCount);
  for (let i = 0; i < segCount; i++) {
    const it = t.items[i];
    if (it === null) { items[i] = null; continue; }
    if (typeof it !== 'string') throw invalid(`translation.items[${i}] must be a string or null`);
    const s = clean(it);
    if (s.length > MAX_TRANSLATION_TEXT) throw invalid(`translation.items[${i}] must be at most ${MAX_TRANSLATION_TEXT} characters`);
    items[i] = s || null;
    if (s) translated++;
  }
  if (!translated) return null;
  return { lang, engine: t.engine, model, items, ratio: translated / segCount };
}

const CLIENT_FIELDS = new Set(['app', 'version', 'install']);

function validateClient(c) {
  if (!isPlainObject(c)) throw invalid('client must be an object with an install id');
  checkFields(c, CLIENT_FIELDS, 'client');
  if (typeof c.install !== 'string' || !UUID_RE.test(c.install)) throw invalid('client.install must be a UUID');
  return {
    app: optString(c.app, 'client.app', 40),
    version: optString(c.version, 'client.version', 40),
    install: c.install.toLowerCase(),
  };
}

const UPLOAD_FIELDS = new Set(['keys', 'title', 'show', 'duration', 'source', 'model', 'language', 'segments', 'translation', 'client']);

export function validateUpload(body) {
  if (!isPlainObject(body)) throw invalid('body must be a JSON object');
  checkFields(body, UPLOAD_FIELDS, '');
  const keys = validateKeys(body.keys);
  const title = optString(body.title, 'title', 300);
  const show = optString(body.show, 'show', 300);
  const d = body.duration;
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d >= MAX_DURATION) {
    throw invalid('duration must be a number of seconds between 0 and 86400');
  }
  if (!SOURCES_UPLOAD.has(body.source)) throw invalid('source must be one of whisper, qwen3, cloud');
  if (typeof body.model !== 'string') throw invalid('model must be a string');
  const model = clean(body.model);
  if (!model || model.length > 100) throw invalid('model must be 1 to 100 characters');
  const language = validLang(body.language, 'language', true);
  const { segments, maxEnd } = validateSegments(body.segments, d);
  const translation = validateTranslation(body.translation, segments.length);
  const client = validateClient(body.client);
  return { keys, title, show, duration: round3(d), source: body.source, model, language, segments, maxEnd, translation, client };
}

const REPORT_FIELDS = new Set(['reason', 'install']);

export function validateReport(body) {
  if (!isPlainObject(body)) throw invalid('body must be a JSON object');
  checkFields(body, REPORT_FIELDS, '');
  if (!REPORT_REASONS.has(body.reason)) throw invalid('reason must be one of wrong_episode, bad_text, bad_translation, other');
  if (typeof body.install !== 'string' || !UUID_RE.test(body.install)) throw invalid('install must be a UUID');
  return { reason: body.reason, install: body.install.toLowerCase() };
}
