// Creates a consistent, gzipped copy of the database with SQLite's VACUUM INTO,
// keeping the newest KEEP snapshots. Intended for cron/systemd timers.
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';

const KEEP = 30;

const config = loadConfig(process.env);
const backupDir = join(config.dataDir, 'backups');
mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tmp = join(backupDir, `subcast-${stamp}.db`);
const db = new DatabaseSync(join(config.dataDir, 'subcast.db'));
db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
db.close();

writeFileSync(`${tmp}.gz`, gzipSync(readFileSync(tmp)));
unlinkSync(tmp);

const files = readdirSync(backupDir).filter((f) => f.endsWith('.db.gz')).sort();
while (files.length > KEEP) unlinkSync(join(backupDir, files.shift()));
process.stdout.write(`backup written: ${tmp}.gz (${files.length} kept)\n`);
