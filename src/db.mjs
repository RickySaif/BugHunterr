// Database access for the hunt, with the safety rules built in.
//   read(cfg, sql)    one SELECT/WITH statement, run in a read-only connection or transaction
//   write(cfg, {...}) one INSERT/UPDATE/DELETE when writes are on ("db": { "write": "local" | "on" }, or hunt
//                     --db-write); never on production; row cap, one transaction, before/after logged to the ledger
// Engines: sqlite (built in), postgres (psql), mysql/mariadb (mysql). Passwords come from "$ENV_VAR" values.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BhError, secret, appendJsonl } from './config.mjs';

export class DbSafetyError extends BhError {}

export const isProd = (env) => /^prod/i.test(String(env || ''));

// off (default) · local: only when environment is local and the database is on this machine · on: any environment but production.
// BH_DB_WRITE=1 (set by hunt --db-write) turns writes on for one hunt.
export function writeLevel(cfg) {
  const w = cfg.db?.write;
  if (process.env.BH_DB_WRITE === '1' && cfg.db) return 'on';
  if (w === true || w === 'on') return 'on';
  if (w === 'local') return 'local';
  return 'off';
}

const quote = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function conf(cfg) {
  if (!cfg.db) throw new BhError('no "db" section in bughunterr.json, so there is no database access');
  return cfg.db;
}

function tsvRows(out) {
  const lines = out.split('\n').filter((l) => l.length);
  if (!lines.length) return [];
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v === 'NULL' ? null : v])));
}

function cli(c, statements) {
  const user = c.user ? secret(c.user, 'database user') : undefined;
  const password = c.password ? secret(c.password, 'database password') : undefined;
  if (c.engine === 'postgres') {
    const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-F', '\t', '--pset=footer=off', '-h', c.host || 'localhost', '-p', String(c.port || 5432), ...(user ? ['-U', user] : []), '-d', c.name];
    for (const s of statements) args.push('-c', s);
    return execFileSync('psql', args, { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password || '' } });
  }
  if (c.engine === 'mysql' || c.engine === 'mariadb') {
    return execFileSync('mysql', ['--batch', '-h', c.host || 'localhost', '-P', String(c.port || 3306), ...(user ? ['-u', user] : []), c.name, '-e', statements.join('; ')],
      { encoding: 'utf8', env: { ...process.env, MYSQL_PWD: password || '' } });
  }
  throw new BhError(`unsupported db engine "${c.engine}" (sqlite, postgres, mysql, mariadb)`);
}

const single = (sql) => !/;\s*\S/.test(sql.trim().replace(/;\s*$/, ''));

export function read(cfg, sql) {
  if (!/^\s*(select|with)\b/i.test(sql) || !single(sql)) throw new DbSafetyError('db read takes one SELECT (or WITH … SELECT) statement');
  const c = conf(cfg);
  sql = sql.trim().replace(/;\s*$/, '');
  if (c.engine === 'sqlite') {
    if (!existsSync(c.file)) throw new BhError(`sqlite file not found: ${c.file} (has the app started once?)`);
    const db = new DatabaseSync(c.file, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }
  if (c.engine === 'postgres') return tsvRows(cli(c, ['BEGIN TRANSACTION READ ONLY', sql, 'ROLLBACK']).replace(/^(BEGIN|ROLLBACK)\n/gm, ''));
  return tsvRows(cli(c, ['SET SESSION TRANSACTION READ ONLY', 'START TRANSACTION', sql, 'ROLLBACK']));
}

// One guarded write, for set-up the UI cannot do (e.g. move a date). `ids` are the primary keys it may touch.
export function write(cfg, { sql, table, ids, why, ledger, maxRows = 20, idColumn = 'id' }) {
  const c = conf(cfg);
  const level = writeLevel(cfg);
  if (level === 'off') throw new DbSafetyError('db writes are off. Turn them on with "db": { "write": "on" } in bughunterr.json, or hunt --db-write');
  if (isProd(cfg.environment)) throw new DbSafetyError(`db writes never run on production (environment "${cfg.environment}")`);
  if (level === 'local' && cfg.environment !== 'local') throw new DbSafetyError(`"write": "local" only allows writes when "environment" is "local" (it is "${cfg.environment}"); use "write": "on" for ${cfg.environment}`);
  if (!table || !/^\w+$/.test(table) || !Array.isArray(ids) || !ids.length) throw new DbSafetyError('a write needs --table and --ids (the rows it touches)');
  if (ids.length > maxRows) throw new DbSafetyError(`the write touches ${ids.length} rows; the cap is ${maxRows}`);
  if (!single(sql) || !/^\s*(insert|update|delete)\b/i.test(sql)) throw new DbSafetyError('a write is one INSERT, UPDATE or DELETE statement');
  if (level === 'local' && c.engine !== 'sqlite' && !['localhost', '127.0.0.1', '::1', undefined].includes(c.host)) throw new DbSafetyError(`db host ${c.host} is not this machine; use "write": "on" for a shared test database`);
  const select = `SELECT * FROM ${table} WHERE ${idColumn} IN (${ids.map(quote).join(', ')})`;
  let before, after;
  if (c.engine === 'sqlite') {
    const db = new DatabaseSync(c.file);
    try {
      before = db.prepare(select).all();
      db.exec('BEGIN');
      const { changes } = db.prepare(sql).run();
      if (changes > maxRows) throw new DbSafetyError(`the statement changed ${changes} rows; the cap is ${maxRows}. Rolled back`);
      db.exec('COMMIT');
      after = db.prepare(select).all();
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    } finally {
      db.close();
    }
  } else {
    before = tsvRows(cli(c, [select]));
    cli(c, c.engine === 'postgres' ? ['BEGIN', sql, 'COMMIT'] : ['START TRANSACTION', sql, 'COMMIT']);
    after = tsvRows(cli(c, [select]));
  }
  if (ledger) appendJsonl(ledger, { at: new Date().toISOString(), kind: 'db-write', table, ids, why, sql, before, after });
  return after;
}
