# SubCast 共享字幕 API 服务器

声渡（SubCast）桌面应用的共享字幕服务。应用在自己转写（本地 Whisper / Qwen3-ASR 或云端 ASR）之后上传字幕与中文翻译；转写之前先查询本服务，命中就直接使用别人共享的结果，大多数用户无需自己转写。

- 纯 Node.js（≥ 22.13），**零依赖**：HTTP 用 `node:http` + `node:zlib`，数据库用内置 `node:sqlite`（WAL 模式，预编译语句）。
- 字幕与翻译以 gzip 压缩的 JSON blob 存储；每集最多保留 3 个版本，自动选出最佳版本。
- 隐私：数据库不存 IP；安装 ID 只存加盐 SHA-256（盐在 `DATA_DIR/salt`，首次运行生成）；限流计数只在内存中。

## 快速开始

```bash
cd server
npm start          # 默认监听 127.0.0.1:8787，数据目录 ./data
npm test           # node --test，随机端口 + 临时数据目录，24 个用例
npm run bench      # 上传/查询延迟基准（p50/p95）
npm run backup     # VACUUM INTO + gzip 快照到 data/backups/（保留最近 30 份）
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（生产只绑回环，由 Nginx 反代） |
| `DATA_DIR` | `./data` | 数据目录（`subcast.db`、`salt`、`backups/`） |
| `ADMIN_TOKEN` | 空 | 设置后启用管理接口（Bearer 认证） |
| `MAX_BODY_BYTES` | `6291456` | 请求体上限（解压后 6 MB） |
| `RATE_UPLOADS_PER_HOUR` | `30` | 每 IP 每小时上传上限 |
| `RATE_LOOKUPS_PER_HOUR` | `600` | 每 IP 每小时查询上限 |
| `RATE_EXISTS_PER_HOUR` | `120` | 每 IP 每小时批量查询上限 |
| `RATE_REPORTS_PER_HOUR` | `60` | 每 IP 每小时举报上限 |
| `RATE_WINDOW_MS` | `3600000` | 限流窗口（固定窗口，内存计数） |
| `CORS_ORIGINS` | 见下 | 逗号分隔的来源白名单 |
| `RESPONSE_CACHE_SIZE` | `64` | 热门响应的内存缓存条数（`0` 关闭） |
| `LOG_REQUESTS` | `1` | 每请求一行日志（不含 IP 与查询串） |

默认 CORS 白名单：`http://localhost:14327`（发行版）、`tauri://localhost`（开发）、`https://subcast.qiaomu.ai`。仅允许 GET/POST 与 `Content-Type`、`Content-Encoding` 头。

## API

全部为 JSON。请求体可带 `Content-Encoding: gzip`；客户端发送 `Accept-Encoding: gzip` 时响应会压缩。路径以 `/api` 开头（Nginx 原样转发完整路径）。

### 剧集键（episode keys）

每集发送 1–4 个键，任一键命中即视为同一集：

- `yt:<11 位视频 ID>`
- `guid:<40 位十六进制 sha1>`
- `audio:<40 位十六进制 sha1>`
- `qm:<id>`

格式不符一律 `400 invalid_key`。

### `GET /api/health`

`{ ok: true, version, transcripts: <版本总数> }`

### `GET /api/v1/transcripts?key=..&key=..`

命中返回 200（最佳版本），未命中返回 404 `{ "error": "not_found" }`。命中带 `Cache-Control: public, max-age=300` 与 `ETag`（支持 `If-None-Match` → 304）。

```json
{
  "id": "AbCdEfGhIjKl",
  "source": "whisper|qwen3|cloud|official",
  "model": "large-v3-turbo",
  "language": "en",
  "segments": [{ "start": 0.0, "end": 3.2, "text": "..." }],
  "translation": { "lang": "zh-CN", "engine": "google|llm", "model": "deepseek-chat", "items": ["...", null] },
  "score": 0.87,
  "versions": 2,
  "createdAt": 1731800000000
}
```

`translation.items` 与 `segments` 一一对齐，`null` 表示该行未翻译；整集无翻译时 `translation` 为 `null`。

### `POST /api/v1/transcripts/exists`

请求体 `{ "keys": [...] }`，最多 400 个键 → `{ "found": [...] }`：其中已有共享字幕的键（规范化后）。格式不对的键直接跳过。客户端用它给单集列表标「有字幕」，不必逐集取整份字幕。限流 `RATE_EXISTS_PER_HOUR`（默认 120）。

### `GET /api/v1/guides?key=..` / `POST /api/v1/guides`

导读（中文 Markdown）。每集一份：先到的保留，同一安装（install）可以覆盖自己的。GET 未命中 404，命中返回 `{ lang, model, text, createdAt }`。POST 请求体 `{ keys, title, show, lang: "zh", model, text, client }`，`text` 200–60000 字、至少 100 个汉字 → `{ action: stored | replaced | kept }`。限流沿用查询 / 上传。

### `POST /api/v1/transcripts`

```json
{
  "keys": ["yt:..."],
  "title": "...", "show": "...", "duration": 3600.5,
  "source": "whisper|qwen3|cloud", "model": "large-v3-turbo", "language": "en",
  "segments": [...],
  "translation": { "lang": "zh-CN", "engine": "llm", "model": "deepseek-chat", "items": [...] },
  "client": { "app": "subcast", "version": "0.2.0", "install": "<每安装一个随机 UUID v4>" }
}
```

响应：`{ id, stored, rank, versions, action }`

- `stored=false`（`id=null`，`rank=4`）表示该集已有 3 个更高分版本，本次未入库。
- `action` 是诊断字段：`created` / `replaced_own` / `replaced_lowest` / `rejected` / `confirmed`（近似重复，计为确认票）/ `upgraded`（确认同时升级了字幕或翻译）。

### `POST /api/v1/transcripts/:id/report`

`{ "reason": "wrong_episode|bad_text|bad_translation|other", "install": "<uuid>" }` → `{ ok: true, counted }`。每个安装对同一版本只计一次（重复提交返回 `counted: false`）。举报会扣减版本得分，扣分过重（净扣分 ≥ 0.6）的版本不再对外返回。

### 管理接口（设置 `ADMIN_TOKEN` 后启用，否则一律 404）

- `DELETE /api/v1/transcripts/:id`（Bearer）→ `{ ok, deleted, versions }`
- `GET /api/v1/stats`（Bearer）→ 剧集/键/版本/举报/确认数、按来源统计、库大小、运行时长

## 版本评分与去重

每集最多保留 3 个版本，查询返回得分最高者（同分按票数、再按新旧）。

### 评分公式（0–1）

```
score = clamp(0.88 × content + voteBonus − reportWeight, 0, 1)
content = (0.7 × quality + 0.3 × translation) × coverageFactor(coverage)
```

- **来源/模型权重 quality**：official 1.0；cloud ≈ qwen3 ≈ whisper large(-v3/-turbo) 0.9（distil 0.85）；whisper medium 0.8、small 0.7、base/tiny 0.5；未知 0.6。
- **覆盖度 coverage**：最后一个分句的 end ÷ 参考时长，封顶 1。参考时长取该集所有版本声明时长的**中位数**，防止客户端虚报短时长把半成品伪装成完整版。`coverageFactor`：≥ 0.98 → 1.0；0.8–0.98 → 0.9–1.0 线性；< 0.8 → 0.3×(c/0.8)，并且**总分硬顶 0.26**——低于可能的最低完整版本得分（0.277），保证不完整转写永远不会排到完整转写前面。
- **翻译 translation**：非空条目占比 × 引擎权重（llm 1.0，google 0.75，其他 0.75）；无翻译记 0。
- **确认票 voteBonus**：`min(0.12, 0.04 × log2(1 + votes))`，每个安装对每个版本只计一票。
- **举报 reportWeight**：wrong_episode 0.35、bad_text 0.15、other 0.10、bad_translation 0.08 累加；净扣分（reportWeight − voteBonus）≥ 0.6 的版本标记为隐藏，不再返回也不计入 `versions`。

### 近似重复 = 确认票

新上传与现有版本的相似度 ≥ 0.9 时，不另存新版本，而是给匹配版本投一张确认票。相似度用 bottom-k（k=256）MinHash：对全文（跨分句）做词级 3-gram shingle（CJK 等无空格文字按字切分），对 FNV-1a + murmur3 混合哈希取最小 k 个估计 Jaccard 指数。分句方式不同不影响结果。

若新版本带来更好的翻译或覆盖度（重算得分比当前高 0.005 以上），则**原地升级**该版本：优先整体替换（字幕 + 翻译），其次只换翻译（要求分句数一致以对齐），版本的 id、票数、举报记录保持不变。

### 合并与替换

- 一键命中即同集：上传时把所有命中键的剧集合并成一个，新键并入。
- 同一安装再次上传会替换自己之前的版本。
- 不足 3 版直接入库；满 3 版时仅当新版本得分高于最低分版本才替换之。

## 校验与限额

- 解压后请求体 ≤ 6 MB；分句 1–30000 条，每条文本 ≤ 2000 字符；`end ≥ start ≥ 0`，时间大致递增（允许 5 秒回退），末尾不得超过声明时长 +5%；`0 < duration < 24h`。
- `language` 匹配 `^[a-z]{2,3}(-[A-Za-z]{2,4})?$` 或为 `auto`；`title`/`show` ≤ 300 字符。
- 有翻译时 `items.length` 必须等于 `segments.length`（否则 `400 translation_mismatch`）。
- 控制字符（含 bidi 控制符）会被剔除；未知字段报 `400 unknown_field`。
- 超限返回 `429` 并带 `Retry-After`。`X-Real-IP` 仅在对端为 127.0.0.1（即来自本机 Nginx）时才被信任。

## 数据与日志

- SQLite（WAL）：`episodes`、`episode_keys`、`versions`、`reports`、`confirmations` 五张表；分句与翻译为 gzip JSON blob，另有 1KB 的 MinHash 草图用于去重。
- 日志每请求一行：`时间 方法 路径 状态码 耗时 字节数`，不含 IP 与查询串。
- `SIGTERM`/`SIGINT` 优雅退出：停止接收连接（最多等 10 秒），WAL checkpoint 后关闭数据库。

## 部署

见 `deploy/README.md`（systemd + Nginx，运行于 `https://subcast.qiaomu.ai/api/`）。

---

# SubCast Shared Transcripts API

Shared-subtitles service for SubCast (声渡), a Tauri desktop app for listening to overseas podcasts and YouTube with Chinese subtitles. When the app transcribes an episode itself (local Whisper / Qwen3-ASR or a cloud ASR service), it uploads the subtitles and their Chinese translation; before transcribing it asks this server whether someone already shared that episode, so most users never need to transcribe.

- Pure Node.js (≥ 22.13), **zero dependencies**: `node:http` + `node:zlib` for transport, built-in `node:sqlite` (WAL, prepared statements) for storage.
- Segments and translations are stored as gzip-compressed JSON blobs; at most 3 versions are kept per episode and the best one is served.
- Privacy: no IPs in the database; install ids are stored only as salted SHA-256 (salt in `DATA_DIR/salt`, generated on first run); rate limiting lives in memory only.

## Quick start

```bash
cd server
npm start          # listens on 127.0.0.1:8787, data dir ./data
npm test           # node --test, random port + temp data dir, 24 cases
npm run bench      # upload/lookup latency benchmark (p50/p95)
npm run backup     # VACUUM INTO + gzip snapshot to data/backups/ (keeps 30)
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address (loopback only in production, behind Nginx) |
| `DATA_DIR` | `./data` | Data directory (`subcast.db`, `salt`, `backups/`) |
| `ADMIN_TOKEN` | empty | Enables the admin endpoints (Bearer auth) when set |
| `MAX_BODY_BYTES` | `6291456` | Request body limit (6 MB after decompression) |
| `RATE_UPLOADS_PER_HOUR` | `30` | Uploads per IP per hour |
| `RATE_LOOKUPS_PER_HOUR` | `600` | Lookups per IP per hour |
| `RATE_EXISTS_PER_HOUR` | `120` | Batch existence checks per IP per hour |
| `RATE_REPORTS_PER_HOUR` | `60` | Reports per IP per hour |
| `RATE_WINDOW_MS` | `3600000` | Rate limit window (fixed window, in memory) |
| `CORS_ORIGINS` | see below | Comma-separated origin allowlist |
| `RESPONSE_CACHE_SIZE` | `64` | In-memory hot-response cache entries (`0` disables) |
| `LOG_REQUESTS` | `1` | One log line per request (no IPs, no query strings) |

Default CORS allowlist: `http://localhost:14327` (release build), `tauri://localhost` (dev), `https://subcast.qiaomu.ai`. Only GET/POST with `Content-Type` and `Content-Encoding` headers are allowed.

## API

All JSON. Request bodies may use `Content-Encoding: gzip`; responses are gzipped when the client sends `Accept-Encoding: gzip`. Paths live under `/api` (Nginx passes the full path through).

### Episode keys

Clients send 1–4 keys per episode; a match on any key identifies the episode:

- `yt:<11-char video id>`
- `guid:<40-hex sha1>`
- `audio:<40-hex sha1>`
- `qm:<id>`

Anything else is rejected with `400 invalid_key`.

### `GET /api/health`

`{ ok: true, version, transcripts: <version count> }`

### `GET /api/v1/transcripts?key=..&key=..`

200 with the best version, or 404 `{ "error": "not_found" }`. Hits carry `Cache-Control: public, max-age=300` and an `ETag` (`If-None-Match` → 304).

```json
{
  "id": "AbCdEfGhIjKl",
  "source": "whisper|qwen3|cloud|official",
  "model": "large-v3-turbo",
  "language": "en",
  "segments": [{ "start": 0.0, "end": 3.2, "text": "..." }],
  "translation": { "lang": "zh-CN", "engine": "google|llm", "model": "deepseek-chat", "items": ["...", null] },
  "score": 0.87,
  "versions": 2,
  "createdAt": 1731800000000
}
```

`translation.items` is aligned 1:1 with `segments`; `null` means that line is untranslated. `translation` is `null` when the episode has no translation.

### `POST /api/v1/transcripts/exists`

Body `{ "keys": [...] }`, at most 400 keys → `{ "found": [...] }`: the (normalized) keys that already have shared subtitles. Malformed keys are skipped. The app uses it to mark episode lists without fetching each transcript. Rate limit `RATE_EXISTS_PER_HOUR` (default 120).

### `GET /api/v1/guides?key=..` / `POST /api/v1/guides`

Episode guides (Chinese Markdown). One per episode: the first stays, and the install that wrote it may replace it. GET → 404 or `{ lang, model, text, createdAt }`. POST `{ keys, title, show, lang: "zh", model, text, client }` with 200–60000 characters, at least 100 of them Chinese → `{ action: stored | replaced | kept }`. Uses the lookup / upload rate limits.

### `POST /api/v1/transcripts`

Body as in the contract: `keys`, `title`, `show`, `duration`, `source` (`whisper|qwen3|cloud`), `model`, `language`, `segments`, optional `translation`, and `client` (`app`, `version`, `install` — a random UUID v4 per install).

Response: `{ id, stored, rank, versions, action }`

- `stored=false` (`id=null`, `rank=4`): the episode already keeps 3 higher-scored versions.
- `action` is a diagnostic field: `created` / `replaced_own` / `replaced_lowest` / `rejected` / `confirmed` (near-duplicate counted as a vote) / `upgraded` (confirmed and improved the version in place).

### `POST /api/v1/transcripts/:id/report`

`{ "reason": "wrong_episode|bad_text|bad_translation|other", "install": "<uuid>" }` → `{ ok: true, counted }`. One report per install per version (`counted: false` on repeats). Reports subtract from the version score; heavily reported versions stop being served.

### Admin (only when `ADMIN_TOKEN` is set, Bearer auth; 404 otherwise)

- `DELETE /api/v1/transcripts/:id` → `{ ok, deleted, versions }`
- `GET /api/v1/stats` → episode/key/version/report/confirmation counts, per-source breakdown, db size, uptime

## Scoring and deduplication

At most 3 versions are kept per episode; lookups return the highest score, breaking ties by votes and then by newest.

### Score (0–1)

```
score = clamp(0.88 × content + voteBonus − reportWeight, 0, 1)
content = (0.7 × quality + 0.3 × translation) × coverageFactor(coverage)
```

- **quality**: official 1.0; cloud ≈ qwen3 ≈ whisper large(-v3/-turbo) 0.9 (distil 0.85); whisper medium 0.8, small 0.7, base/tiny 0.5; unknown 0.6.
- **coverage**: last segment end ÷ reference duration, capped at 1. The reference duration is the **median** of the durations declared by the episode's versions, so a client declaring a short duration cannot make its partial transcript look complete. `coverageFactor`: ≥ 0.98 → 1.0; 0.8–0.98 → linear 0.9–1.0; below 0.8 → 0.3×(c/0.8) **and the total score is hard-capped at 0.26** — below the lowest possible complete score (0.277) — so a partial transcript can never beat a complete one.
- **translation**: share of non-null items × engine weight (llm 1.0, google 0.75, other 0.75); 0 when absent.
- **voteBonus**: `min(0.12, 0.04 × log2(1 + votes))`; one vote per install per version.
- **reportWeight**: wrong_episode 0.35, bad_text 0.15, other 0.10, bad_translation 0.08. When the net penalty (reportWeight − voteBonus) reaches 0.6 the version is hidden: not served and not counted in `versions`.

### Near-duplicates count as votes

When a new upload is ≥ 0.9 similar to an existing version it is not stored; instead it casts a confirmation vote for that version. Similarity is a bottom-k (k=256) MinHash estimate of the Jaccard index over word 3-gram shingles of the full text (CJK and other no-space scripts are split per character), using FNV-1a with a murmur3 finalizer. The sketch is computed over the whole transcript, so different segmentations of the same audio still match.

If the new upload has a better translation or coverage (its rescored value beats the current one by more than 0.005), the confirmed version is **upgraded in place** — full replacement (segments + translation) when possible, otherwise translation only (requires equal segment counts for alignment) — keeping its id, votes and report history.

### Merging and replacement

- Any key overlap merges episodes: all matching episodes are merged into one and the new keys are added.
- The same install re-uploading replaces its own previous version for that episode.
- With fewer than 3 versions the new one is stored; with 3, it replaces the lowest-scored version only when its own score is higher.

## Validation and limits

- Body ≤ 6 MB after decompression; 1–30000 segments; each text ≤ 2000 chars; `end ≥ start ≥ 0`, roughly non-decreasing (5 s backtrack allowed), and segment ends may not exceed the declared duration by more than 5%; `0 < duration < 24h`.
- `language` matches `^[a-z]{2,3}(-[A-Za-z]{2,4})?$` or is `auto`; `title`/`show` ≤ 300 chars.
- If a translation is present, `items.length` must equal `segments.length` (`400 translation_mismatch` otherwise).
- Control characters (including bidi overrides) are stripped; unknown fields are rejected with `400 unknown_field`.
- Over-limit requests get `429` with `Retry-After`. `X-Real-IP` is trusted only from 127.0.0.1 (i.e. from the local Nginx).

## Storage and logging

- SQLite (WAL) with five tables: `episodes`, `episode_keys`, `versions`, `reports`, `confirmations`. Segments and translations are gzip JSON blobs; each version also stores a 1 KB MinHash sketch for deduplication.
- One log line per request: `timestamp method path status latency bytes` — no IPs, no query strings.
- `SIGTERM`/`SIGINT` shut down gracefully: stop accepting connections (10 s grace), checkpoint the WAL and close the database.

## Deployment

See `deploy/README.md` (systemd + Nginx, served at `https://subcast.qiaomu.ai/api/`).
