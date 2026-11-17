import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { HttpError } from './validate.js';
import { computeSketch, similarity, sketchFromBlob, sketchToBuffer } from './textsim.js';
import {
  DUPLICATE_THRESHOLD, MAX_VERSIONS, REPORT_WEIGHTS, compareRank, median, qualityWeight, scoreOf,
} from './score.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  show TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS episode_keys (
  key TEXT PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS episode_keys_episode ON episode_keys(episode_id);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  install_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  language TEXT NOT NULL,
  duration REAL NOT NULL,
  max_end REAL NOT NULL,
  seg_count INTEGER NOT NULL,
  quality REAL NOT NULL,
  segments BLOB NOT NULL,
  sketch BLOB NOT NULL,
  tr_lang TEXT,
  tr_engine TEXT,
  tr_model TEXT,
  tr_ratio REAL NOT NULL DEFAULT 0,
  translation BLOB,
  votes INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  report_weight REAL NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  client_version TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_episode ON versions(episode_id);
CREATE TABLE IF NOT EXISTS reports (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  install_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (version_id, install_hash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS confirmations (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  install_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (version_id, install_hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS confirmations_install ON confirmations(install_hash);
CREATE TABLE IF NOT EXISTS guides (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  install_hash TEXT NOT NULL,
  lang TEXT NOT NULL,
  model TEXT NOT NULL,
  text BLOB NOT NULL,
  chars INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
PRAGMA user_version = 1;
`;

const META_COLUMNS = `id, episode_id, install_hash, source, model, duration, max_end, seg_count, quality, sketch,
  tr_engine, tr_ratio, votes, report_weight, score, created_at`;

function loadSalt(dataDir) {
  const file = join(dataDir, 'salt');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const salt = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, `${salt}\n`, { mode: 0o600, flag: 'wx' });
    return salt;
  } catch (err) {
    if (err.code === 'EEXIST') return readFileSync(file, 'utf8').trim();
    throw err;
  }
}

const newId = () => randomBytes(9).toString('base64url');
const gz = (str) => gzipSync(str, { level: 6 });
const unz = (blob) => gunzipSync(blob).toString('utf8');

function toMeta(row) {
  return {
    id: row.id,
    episodeId: row.episode_id,
    installHash: row.install_hash,
    source: row.source,
    model: row.model,
    duration: row.duration,
    maxEnd: row.max_end,
    segCount: row.seg_count,
    quality: row.quality,
    sketch: row.sketch ? sketchFromBlob(row.sketch) : null,
    trEngine: row.tr_engine,
    trRatio: row.tr_ratio,
    votes: row.votes,
    reportWeight: row.report_weight,
    score: row.score,
    createdAt: row.created_at,
  };
}

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dbPath = join(dataDir, 'subcast.db');
    this.salt = loadSalt(dataDir);
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    this.db = db;
    const p = (sql) => db.prepare(sql);
    this.q = {
      episodesForKeys: p('SELECT DISTINCT episode_id AS id FROM episode_keys WHERE key IN (?, ?, ?, ?) ORDER BY episode_id'),
      insertEpisode: p('INSERT INTO episodes (title, show, duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
      touchEpisode: p(`UPDATE episodes SET title = CASE WHEN ? <> '' THEN ? ELSE title END,
        show = CASE WHEN ? <> '' THEN ? ELSE show END, updated_at = ? WHERE id = ?`),
      finishEpisode: p('UPDATE episodes SET duration = ?, rev = rev + 1, updated_at = ? WHERE id = ?'),
      deleteEpisode: p('DELETE FROM episodes WHERE id = ?'),
      moveKeys: p('UPDATE episode_keys SET episode_id = ? WHERE episode_id = ?'),
      moveVersions: p('UPDATE versions SET episode_id = ? WHERE episode_id = ?'),
      moveGuide: p('UPDATE OR IGNORE guides SET episode_id = ? WHERE episode_id = ?'),
      guideFor: p(`SELECT g.lang, g.model, g.text, g.created_at FROM guides g
        WHERE g.episode_id IN (SELECT episode_id FROM episode_keys WHERE key IN (?, ?, ?, ?)) ORDER BY g.created_at LIMIT 1`),
      guideOf: p('SELECT install_hash FROM guides WHERE episode_id = ?'),
      putGuide: p(`INSERT INTO guides (episode_id, install_hash, lang, model, text, chars, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(episode_id) DO UPDATE SET install_hash = excluded.install_hash, lang = excluded.lang, model = excluded.model,
        text = excluded.text, chars = excluded.chars, updated_at = excluded.updated_at`),
      insertKey: p('INSERT OR IGNORE INTO episode_keys (key, episode_id) VALUES (?, ?)'),
      versionsMeta: p(`SELECT ${META_COLUMNS} FROM versions WHERE episode_id = ?`),
      versionMeta: p(`SELECT ${META_COLUMNS} FROM versions WHERE id = ?`),
      insertVersion: p(`INSERT INTO versions (id, episode_id, install_hash, source, model, language, duration, max_end,
        seg_count, quality, segments, sketch, tr_lang, tr_engine, tr_model, tr_ratio, translation, client_version,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      replaceContent: p(`UPDATE versions SET source = ?, model = ?, language = ?, duration = ?, max_end = ?, seg_count = ?,
        quality = ?, segments = ?, sketch = ?, tr_lang = ?, tr_engine = ?, tr_model = ?, tr_ratio = ?, translation = ?,
        updated_at = ? WHERE id = ?`),
      replaceTranslation: p(`UPDATE versions SET tr_lang = ?, tr_engine = ?, tr_model = ?, tr_ratio = ?, translation = ?,
        updated_at = ? WHERE id = ?`),
      deleteVersion: p('DELETE FROM versions WHERE id = ?'),
      setScore: p('UPDATE versions SET votes = ?, score = ?, hidden = ? WHERE id = ?'),
      countVotes: p('SELECT COUNT(*) AS n FROM confirmations WHERE version_id = ?'),
      dropInstallVotes: p(`DELETE FROM confirmations WHERE install_hash = ?
        AND version_id IN (SELECT id FROM versions WHERE episode_id = ?)`),
      addVote: p('INSERT OR IGNORE INTO confirmations (version_id, install_hash, created_at) VALUES (?, ?, ?)'),
      addReport: p('INSERT OR IGNORE INTO reports (version_id, install_hash, reason, created_at) VALUES (?, ?, ?, ?)'),
      bumpReports: p('UPDATE versions SET reports = reports + 1, report_weight = report_weight + ? WHERE id = ?'),
      best: p(`SELECT v.id, v.episode_id, v.source, v.model, v.language, v.segments, v.tr_lang, v.tr_engine, v.tr_model,
          v.translation, v.score, v.created_at, e.rev
        FROM versions v JOIN episodes e ON e.id = v.episode_id
        WHERE v.episode_id IN (SELECT episode_id FROM episode_keys WHERE key IN (?, ?, ?, ?)) AND v.hidden = 0
        ORDER BY v.score DESC, v.votes DESC, v.created_at DESC, v.id DESC LIMIT 1`),
      keyHasVersion: p(`SELECT 1 AS ok FROM episode_keys k JOIN versions v ON v.episode_id = k.episode_id
        WHERE k.key = ? AND v.hidden = 0 LIMIT 1`),
      countEpisodeVersions: p('SELECT COUNT(*) AS n FROM versions WHERE episode_id = ? AND hidden = 0'),
      countVersions: p('SELECT COUNT(*) AS n FROM versions'),
      stats: p(`SELECT (SELECT COUNT(*) FROM episodes) AS episodes, (SELECT COUNT(*) FROM episode_keys) AS keys,
        (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM versions WHERE hidden = 1) AS hidden,
        (SELECT COUNT(*) FROM versions WHERE translation IS NOT NULL) AS translated,
        (SELECT COUNT(*) FROM reports) AS reports, (SELECT COUNT(*) FROM confirmations) AS confirmations,
        (SELECT COUNT(*) FROM versions WHERE created_at > ?) AS versions24h`),
      bySource: p('SELECT source, COUNT(*) AS n FROM versions GROUP BY source ORDER BY n DESC'),
    };
  }

  hashInstall(install) {
    return createHash('sha256').update(this.salt).update(':').update(install).digest('hex');
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  countTranscripts() {
    return this.q.countVersions.get().n;
  }

  // The keys (of those given) that lead to at least one visible version.
  existing(keys) {
    return keys.filter((k) => this.q.keyHasVersion.get(k));
  }

  // Returns { etag, json } or null. json is assembled from the stored JSON so the segment
  // arrays are never re-parsed.
  lookup(keys) {
    const k = [0, 1, 2, 3].map((i) => keys[i] ?? keys[0]);
    const row = this.q.best.get(...k);
    if (!row) return null;
    const versions = this.q.countEpisodeVersions.get(row.episode_id).n;
    return {
      etag: `"${row.id}.${row.rev}"`,
      build: () => {
        const translation = row.translation
          ? `{"lang":${JSON.stringify(row.tr_lang)},"engine":${JSON.stringify(row.tr_engine)},"model":${JSON.stringify(row.tr_model || '')},"items":${unz(row.translation)}}`
          : 'null';
        return `{"id":${JSON.stringify(row.id)},"source":${JSON.stringify(row.source)},"model":${JSON.stringify(row.model)},`
          + `"language":${JSON.stringify(row.language)},"segments":${unz(row.segments)},"translation":${translation},`
          + `"score":${Math.round(row.score * 1000) / 1000},"versions":${versions},"createdAt":${row.created_at}}`;
      },
    };
  }

  // Recomputes votes, scores and visibility for an episode, trims it to MAX_VERSIONS and
  // returns the kept versions best first.
  rescore(episodeId, now) {
    const list = this.q.versionsMeta.all(episodeId).map(toMeta);
    const ref = median(list.map((v) => v.duration));
    for (const v of list) {
      v.votes = this.q.countVotes.get(v.id).n;
      const s = scoreOf(v, ref);
      v.score = s.score;
      v.hidden = s.hidden;
      this.q.setScore.run(v.votes, v.score, v.hidden ? 1 : 0, v.id);
    }
    list.sort(compareRank);
    for (const extra of list.splice(MAX_VERSIONS)) this.q.deleteVersion.run(extra.id);
    if (list.length) this.q.finishEpisode.run(ref, now, episodeId);
    else this.q.deleteEpisode.run(episodeId);
    return list;
  }

  resolveEpisode(keys, meta, now) {
    const k = [0, 1, 2, 3].map((i) => keys[i] ?? keys[0]);
    const ids = this.q.episodesForKeys.all(...k).map((r) => r.id);
    let episodeId;
    if (!ids.length) {
      episodeId = Number(this.q.insertEpisode.run(meta.title, meta.show, meta.duration, now, now).lastInsertRowid);
    } else {
      episodeId = ids[0];
      for (const other of ids.slice(1)) {
        this.q.moveKeys.run(episodeId, other);
        this.q.moveVersions.run(episodeId, other);
        this.q.moveGuide.run(episodeId, other);
        this.q.deleteEpisode.run(other);
      }
    }
    for (const key of keys) this.q.insertKey.run(key, episodeId);
    this.q.touchEpisode.run(meta.title, meta.title, meta.show, meta.show, now, episodeId);
    return { episodeId, merged: ids.length > 1 };
  }

  // 导读: one per episode. The first one stays; the install that wrote it may replace it (regenerated).
  uploadGuide(p) {
    const now = Date.now();
    const installHash = this.hashInstall(p.client.install);
    return this.tx(() => {
      const { episodeId } = this.resolveEpisode(p.keys, { title: p.title, show: p.show, duration: 0 }, now);
      const have = this.q.guideOf.get(episodeId);
      if (have && have.install_hash !== installHash) return { action: 'kept' };
      this.q.putGuide.run(episodeId, installHash, p.lang, p.model, gzipSync(Buffer.from(p.text, 'utf8')), p.text.length, now, now);
      return { action: have ? 'replaced' : 'stored' };
    });
  }

  guide(keys) {
    const k = [0, 1, 2, 3].map((i) => keys[i] ?? keys[0]);
    const row = this.q.guideFor.get(...k);
    return row ? { lang: row.lang, model: row.model, text: unz(row.text), createdAt: row.created_at } : null;
  }

  upload(p) {
    const now = Date.now();
    const installHash = this.hashInstall(p.client.install);
    const tr = p.translation;
    const sketch = computeSketch(p.segments);
    const cand = {
      id: newId(),
      installHash,
      source: p.source,
      model: p.model,
      language: p.language,
      duration: p.duration,
      maxEnd: p.maxEnd,
      segCount: p.segments.length,
      quality: qualityWeight(p.source, p.model),
      sketch,
      trEngine: tr ? tr.engine : null,
      trRatio: tr ? tr.ratio : 0,
      votes: 0,
      reportWeight: 0,
      createdAt: now,
    };
    const segBlob = gz(JSON.stringify(p.segments));
    const trBlob = tr ? gz(JSON.stringify(tr.items)) : null;
    const sketchBlob = sketchToBuffer(sketch);

    const insert = (episodeId) => this.q.insertVersion.run(
      cand.id, episodeId, installHash, cand.source, cand.model, cand.language, cand.duration, cand.maxEnd,
      cand.segCount, cand.quality, segBlob, sketchBlob, tr?.lang ?? null, tr?.engine ?? null, tr?.model ?? null,
      cand.trRatio, trBlob, p.client.version, now, now,
    );

    return this.tx(() => {
      const { episodeId, merged } = this.resolveEpisode(p.keys, p, now);
      this.q.dropInstallVotes.run(installHash, episodeId);
      const existing = this.q.versionsMeta.all(episodeId).map(toMeta);
      const own = existing.filter((v) => v.installHash === installHash);
      const others = existing.filter((v) => v.installHash !== installHash);

      let dup = null;
      let bestSim = 0;
      for (const v of others) {
        const sim = similarity(sketch, v.sketch);
        if (sim >= DUPLICATE_THRESHOLD && sim > bestSim) { dup = v; bestSim = sim; }
      }

      const ref = median([...others.map((v) => v.duration), cand.duration]);
      let action;
      let resultId = cand.id;

      if (dup) {
        for (const v of own) this.q.deleteVersion.run(v.id);
        this.q.addVote.run(dup.id, installHash, now);
        resultId = dup.id;
        action = 'confirmed';
        // Keep the confirmed version's identity, votes and reports, but take whichever content
        // (its own, the new upload's, or its segments with the new translation) scores highest.
        const base = { ...dup, votes: this.q.countVotes.get(dup.id).n };
        const current = scoreOf(base, ref).score;
        const asNew = scoreOf({ ...base, quality: cand.quality, maxEnd: cand.maxEnd, trRatio: cand.trRatio, trEngine: cand.trEngine }, ref).score;
        const withTr = tr && cand.segCount === dup.segCount
          ? scoreOf({ ...base, trRatio: cand.trRatio, trEngine: cand.trEngine }, ref).score
          : -1;
        const EPS = 0.005;
        if (asNew > current + EPS && asNew >= withTr) {
          this.q.replaceContent.run(cand.source, cand.model, cand.language, cand.duration, cand.maxEnd, cand.segCount,
            cand.quality, segBlob, sketchBlob, tr?.lang ?? null, tr?.engine ?? null, tr?.model ?? null, cand.trRatio,
            trBlob, now, dup.id);
          action = 'upgraded';
        } else if (withTr > current + EPS) {
          this.q.replaceTranslation.run(tr.lang, tr.engine, tr.model, cand.trRatio, trBlob, now, dup.id);
          action = 'upgraded';
        }
      } else if (own.length) {
        for (const v of own) this.q.deleteVersion.run(v.id);
        insert(episodeId);
        action = 'replaced_own';
      } else if (others.length < MAX_VERSIONS) {
        insert(episodeId);
        action = 'created';
      } else {
        const ranked = others.map((v) => ({ ...v, ...scoreOf(v, ref) }));
        ranked.sort(compareRank);
        const lowest = ranked[ranked.length - 1];
        const candScore = scoreOf(cand, ref).score;
        if (candScore > lowest.score) {
          this.q.deleteVersion.run(lowest.id);
          insert(episodeId);
          action = 'replaced_lowest';
        } else {
          action = 'rejected';
          resultId = null;
        }
      }

      const kept = this.rescore(episodeId, now);
      const idx = resultId ? kept.findIndex((v) => v.id === resultId) : -1;
      const stored = idx >= 0;
      return {
        id: stored ? resultId : null,
        stored,
        rank: stored ? idx + 1 : kept.length + 1,
        versions: kept.length,
        action: stored ? action : 'rejected',
        merged,
      };
    });
  }

  report(id, install, reason) {
    const installHash = this.hashInstall(install);
    const now = Date.now();
    return this.tx(() => {
      const v = this.q.versionMeta.get(id);
      if (!v) throw new HttpError(404, 'not_found', 'unknown transcript id');
      const counted = Number(this.q.addReport.run(id, installHash, reason, now).changes) === 1;
      if (counted) {
        this.q.bumpReports.run(REPORT_WEIGHTS[reason], id);
        this.rescore(v.episode_id, now);
      }
      return { ok: true, counted };
    });
  }

  remove(id) {
    return this.tx(() => {
      const v = this.q.versionMeta.get(id);
      if (!v) throw new HttpError(404, 'not_found', 'unknown transcript id');
      this.q.deleteVersion.run(id);
      const kept = this.rescore(v.episode_id, Date.now());
      return { ok: true, deleted: id, versions: kept.length };
    });
  }

  stats() {
    const s = { ...this.q.stats.get(Date.now() - 24 * 60 * 60 * 1000) };
    s.bySource = Object.fromEntries(this.q.bySource.all().map((r) => [r.source, r.n]));
    let bytes = 0;
    for (const suffix of ['', '-wal']) {
      try { bytes += statSync(this.dbPath + suffix).size; } catch {}
    }
    s.dbBytes = bytes;
    return s;
  }

  close() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    this.db.close();
  }
}

