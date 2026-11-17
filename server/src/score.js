// Scoring for the up-to-3 versions kept per episode. See README "评分 / Scoring".

export const DUPLICATE_THRESHOLD = 0.9;
export const MAX_VERSIONS = 3;
export const PARTIAL_COVERAGE = 0.8;
const PARTIAL_CAP = 0.26;
const CONTENT_WEIGHT = 0.88;
const HIDE_AT = 0.6;

export const REPORT_WEIGHTS = {
  wrong_episode: 0.35,
  bad_text: 0.15,
  bad_translation: 0.08,
  other: 0.1,
};

const ENGINE_WEIGHTS = { llm: 1.0, google: 0.75 };

export function qualityWeight(source, model) {
  const m = String(model || '').toLowerCase();
  switch (source) {
    case 'official':
      return 1.0;
    case 'cloud':
      // Doubao's bigmodel is the most accurate of the cloud services in practice (esp. Chinese),
      // so it wins same-episode contests over the generic cloud tier.
      return /bigmodel|doubao/.test(m) ? 0.92 : 0.9;
    case 'qwen3':
      return 0.9;
    case 'whisper':
      if (/large|turbo/.test(m)) return /distil/.test(m) ? 0.85 : 0.9;
      if (/medium/.test(m)) return 0.8;
      if (/small/.test(m)) return 0.7;
      if (/base|tiny/.test(m)) return 0.5;
      return 0.6;
    default:
      return 0.6;
  }
}

export function engineWeight(engine) {
  return ENGINE_WEIGHTS[engine] ?? 0.75;
}

export function coverageFactor(c) {
  if (c >= 0.98) return 1;
  if (c >= PARTIAL_COVERAGE) return 0.9 + (0.1 * (c - PARTIAL_COVERAGE)) / (0.98 - PARTIAL_COVERAGE);
  return 0.3 * (c / PARTIAL_COVERAGE);
}

export function voteBonus(votes) {
  return Math.min(0.12, 0.04 * Math.log2(1 + Math.max(0, votes)));
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * v: { quality, maxEnd, trRatio, trEngine, votes, reportWeight }
 * refDuration: median of the durations declared by the episode's uploads, so one client
 * declaring a short duration cannot make its partial transcript look complete.
 */
export function scoreOf(v, refDuration) {
  const coverage = refDuration > 0 ? Math.min(1, v.maxEnd / refDuration) : 1;
  const translation = (v.trRatio || 0) * (v.trRatio ? engineWeight(v.trEngine) : 0);
  const content = (0.7 * v.quality + 0.3 * translation) * coverageFactor(coverage);
  let score = CONTENT_WEIGHT * content + voteBonus(v.votes || 0) - (v.reportWeight || 0);
  // Below 80% coverage the score is capped under the lowest possible complete score (0.277),
  // so votes can never lift a partial transcript over a complete one.
  if (coverage < PARTIAL_COVERAGE) score = Math.min(score, PARTIAL_CAP);
  score = Math.max(0, Math.min(1, score));
  const hidden = (v.reportWeight || 0) - voteBonus(v.votes || 0) >= HIDE_AT;
  return { score, coverage, hidden };
}

// Best first: score, then votes, then newest.
export function compareRank(a, b) {
  return (
    b.score - a.score ||
    b.votes - a.votes ||
    b.createdAt - a.createdAt ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}
