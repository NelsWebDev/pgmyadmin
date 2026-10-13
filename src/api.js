const express = require('express');
const conn = require('./connections');
const config = require('./config');
const { quoteIdent: q, quoteLiteral: lit, qualified } = conn;

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TYPE_RE = /^[A-Za-z0-9_ ,()\[\]."]+$/;
const INDEX_METHODS = ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist'];
const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;
const MAX_SQL_ROWS = config.maxSqlRows;
const FILTER_OPS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE', '~', '~*'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- auth ----------

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Public settings the login screen and UI need.
router.get('/config', (req, res) => {
  res.json({
    authType: config.authType,
    servers: config.servers.map((s) => ({ id: s.id, label: s.label || `${s.host}:${s.port}`, host: s.host, port: s.port })),
    arbitrary: config.arbitrary,
    defaults: { user: config.authType === 'cookie' ? config.user : '', database: config.database, ssl: config.ssl },
    maxRows: config.maxRows,
    allowNoPassword: config.allowNoPassword,
  });
});

const dbAllowed = (name) => {
  if (!config.dbAllowed(name)) throw new HttpError(403, `Access to database "${name}" is restricted`);
};

router.post(
  '/login',
  wrap(async (req, res) => {
    if (config.authType === 'config') throw new HttpError(403, 'Login is disabled: the server uses a configured account');
    const b = req.body || {};
    let host, port;
    if (b.server !== undefined && b.server !== '' && b.server !== 'custom') {
      const s = config.servers.find((x) => x.id === String(b.server));
      if (!s) throw bad('Unknown server');
      ({ host, port } = s);
    } else if (config.arbitrary) {
      host = String(b.host || 'localhost');
      port = parseInt(b.port, 10) || 5432;
    } else if (config.servers.length === 1) {
      ({ host, port } = config.servers[0]);
    } else throw bad('Choose a server');
    if (port < 1 || port > 65535) throw bad('Invalid port');
    const cfg = {
      host,
      port,
      user: String(b.user || ''),
      password: String(b.password || ''),
      database: String(b.database || config.database),
      ssl: b.ssl === undefined ? config.ssl : !!b.ssl,
    };
    if (!cfg.user) throw bad('Username is required');
    if (!cfg.password && !config.allowNoPassword) throw bad('Login without a password is not allowed');
    if (!config.dbAllowed(cfg.database)) throw new HttpError(403, `Access to database "${cfg.database}" is restricted`);
    const prev = parseCookies(req.headers.cookie).pgm_token;
    if (prev) await conn.logout(prev);
    let result;
    try {
      result = await conn.login(cfg);
    } catch (err) {
      throw new HttpError(401, err.message || 'Connection failed');
    }
    res.setHeader(
      'Set-Cookie',
      `pgm_token=${result.token}; HttpOnly; SameSite=Strict; Path=/${req.secure || config.cookieSecure ? '; Secure' : ''}`
    );
    res.json({ user: cfg.user, host: cfg.host, port: cfg.port, database: result.database, version: result.version });
  })
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    await conn.logout(parseCookies(req.headers.cookie).pgm_token);
    res.setHeader('Set-Cookie', 'pgm_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  })
);

// Everything below requires a live session.
router.use(
  wrap(async (req, res, next) => {
    if (config.authType === 'config') {
      const s = config.servers[0];
      try {
        req.entry = await conn.sharedSession({ host: s.host, port: s.port, user: config.user, password: config.password, database: config.database, ssl: config.ssl });
      } catch (err) {
        throw new HttpError(503, `Could not connect as configured user: ${err.message}`);
      }
      return next();
    }
    const entry = conn.get(parseCookies(req.headers.cookie).pgm_token);
    if (!entry) return res.status(401).json({ error: 'Not logged in', code: 'auth' });
    req.entry = entry;
    next();
  })
);

router.get('/session', (req, res) => {
  const { cfg, version } = req.entry;
  res.json({ user: cfg.user, host: cfg.host, port: cfg.port, database: cfg.database, version });
});

const adminPool = (req) => conn.poolFor(req.entry, req.entry.cfg.database);
const dbPool = (req) => {
  dbAllowed(req.params.db);
  return conn.poolFor(req.entry, req.params.db);
};

// ---------- databases ----------

router.get(
  '/databases',
  wrap(async (req, res) => {
    const { rows } = await adminPool(req).query(`
      SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner,
             pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation,
             CASE WHEN has_database_privilege(d.datname,'CONNECT') THEN pg_database_size(d.datname) END AS size,
             shobj_description(d.oid,'pg_database') AS comment
      FROM pg_database d WHERE NOT d.datistemplate AND d.datallowconn ORDER BY d.datname`);
    res.json(rows.filter((r) => config.dbVisible(r.name)));
  })
);

router.post(
  '/databases',
  wrap(async (req, res) => {
    const { name, owner, encoding, template } = req.body || {};
    if (!name) throw bad('Database name is required');
    dbAllowed(name);
    let sql = `CREATE DATABASE ${q(name)}`;
    if (owner) sql += ` OWNER ${q(owner)}`;
    if (encoding) sql += ` ENCODING ${lit(encoding)}`;
    if (template) sql += ` TEMPLATE ${q(template)}`;
    await adminPool(req).query(sql);
    res.json({ ok: true });
  })
);

router.delete(
  '/databases/:db',
  wrap(async (req, res) => {
    dbAllowed(req.params.db);
    if (req.params.db === req.entry.cfg.database) throw bad('Cannot drop the database you are logged in to');
    await conn.closePool(req.entry, req.params.db);
    await adminPool(req).query(`DROP DATABASE ${q(req.params.db)}`);
    res.json({ ok: true });
  })
);

router.post(
  '/databases/:db/rename',
  wrap(async (req, res) => {
    const name = req.body && req.body.name;
    if (!name) throw bad('New name is required');
    dbAllowed(req.params.db);
    dbAllowed(name);
    if (req.params.db === req.entry.cfg.database) throw bad('Cannot rename the database you are logged in to');
    await conn.closePool(req.entry, req.params.db);
    await adminPool(req).query(`ALTER DATABASE ${q(req.params.db)} RENAME TO ${q(name)}`);
    res.json({ ok: true });
  })
);

// ---------- schema tree / tables ----------

router.get(
  '/db/:db/tree',
  wrap(async (req, res) => {
    const pool = dbPool(req);
    const [schemas, tables] = await Promise.all([
      pool.query(`SELECT n.nspname AS name FROM pg_namespace n WHERE ${SYSTEM_SCHEMAS} ORDER BY 1`),
      pool.query(`
        SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND ${SYSTEM_SCHEMAS}
        ORDER BY 1, 2`),
    ]);
    res.json({ schemas: schemas.rows.map((r) => r.name), tables: tables.rows });
  })
);

router.get(
  '/db/:db/tables',
  wrap(async (req, res) => {
    const schema = req.query.schema || 'public';
    const { rows } = await dbPool(req).query(
      `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS estimated_rows,
              pg_total_relation_size(c.oid) AS size, pg_get_userbyid(c.relowner) AS owner,
              obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
       ORDER BY c.relname`,
      [schema]
    );
    res.json(rows);
  })
);

router.post(
  '/db/:db/schemas',
  wrap(async (req, res) => {
    const name = req.body && req.body.name;
    if (!name) throw bad('Schema name is required');
    await dbPool(req).query(`CREATE SCHEMA ${q(name)}`);
    res.json({ ok: true });
  })
);

router.delete(
  '/db/:db/schemas/:schema',
  wrap(async (req, res) => {
    await dbPool(req).query(`DROP SCHEMA ${q(req.params.schema)}${req.query.cascade === '1' ? ' CASCADE' : ''}`);
    res.json({ ok: true });
  })
);

function colDef(c) {
  if (!c.name) throw bad('Column name is required');
  if (!c.type || !TYPE_RE.test(c.type)) throw bad(`Invalid type for column "${c.name}"`);
  let s = `${q(c.name)} ${c.type}`;
  if (c.notnull) s += ' NOT NULL';
  if (c.default !== undefined && c.default !== null && String(c.default).trim() !== '') s += ` DEFAULT ${c.default}`;
  return s;
}

router.post(
  '/db/:db/tables',
  wrap(async (req, res) => {
    const { schema = 'public', name, columns } = req.body || {};
    if (!name) throw bad('Table name is required');
    if (!Array.isArray(columns) || !columns.length) throw bad('At least one column is required');
    const defs = columns.map(colDef);
    const pk = columns.filter((c) => c.pk).map((c) => q(c.name));
    if (pk.length) defs.push(`PRIMARY KEY (${pk.join(', ')})`);
    await dbPool(req).query(`CREATE TABLE ${qualified(schema, name)} (\n  ${defs.join(',\n  ')}\n)`);
    res.json({ ok: true });
  })
);

// ---------- table metadata ----------

async function relInfo(pool, schema, table) {
  const { rows } = await pool.query(
    `SELECT c.oid, c.relkind AS kind, c.reltuples::bigint AS estimated_rows,
            pg_total_relation_size(c.oid) AS size, pg_relation_size(c.oid) AS data_size,
            pg_get_userbyid(c.relowner) AS owner, obj_description(c.oid,'pg_class') AS comment
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
    [schema, table]
  );
  if (!rows.length) throw new HttpError(404, `Relation ${schema}.${table} not found`);
  return rows[0];
}

async function getColumns(pool, oid) {
  const { rows } = await pool.query(
    `SELECT a.attnum AS position, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default,
            a.attidentity AS identity, a.attgenerated AS generated,
            col_description(a.attrelid, a.attnum) AS comment,
            COALESCE(a.attnum = ANY (SELECT unnest(i.indkey) FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary), false) AS pk
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [oid]
  );
  return rows;
}

async function getIndexes(pool, oid) {
  const { rows } = await pool.query(
    `SELECT ic.relname AS name, am.amname AS method, i.indisunique AS "unique", i.indisprimary AS "primary",
            pg_get_indexdef(i.indexrelid) AS definition, pg_relation_size(i.indexrelid) AS size,
            array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) AND a.attnum > 0) AS columns,
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p','u','x')) AS has_constraint
     FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
     WHERE i.indrelid = $1 ORDER BY ic.relname`,
    [oid]
  );
  return rows;
}

async function getConstraints(pool, oid) {
  const { rows } = await pool.query(
    `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`,
    [oid]
  );
  return rows;
}

const tableRouter = express.Router({ mergeParams: true });
router.use('/db/:db/t/:schema/:table', tableRouter);

tableRouter.use(
  wrap(async (req, res, next) => {
    req.pool = dbPool(req);
    req.info = await relInfo(req.pool, req.params.schema, req.params.table);
    req.qname = qualified(req.params.schema, req.params.table);
    next();
  })
);

tableRouter.get(
  '/structure',
  wrap(async (req, res) => {
    const { pool, info } = req;
    const [columns, indexes, constraints] = await Promise.all([
      getColumns(pool, info.oid),
      getIndexes(pool, info.oid),
      getConstraints(pool, info.oid),
    ]);
    let definition = null;
    if (info.kind === 'v' || info.kind === 'm') {
      definition = (await pool.query('SELECT pg_get_viewdef($1::oid, true) AS d', [info.oid])).rows[0].d;
    }
    const { oid, ...rest } = info;
    const stats = (
      await pool.query(
        `SELECT n_live_tup, n_dead_tup, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del,
                last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
         FROM pg_stat_all_tables WHERE relid = $1`,
        [oid]
      )
    ).rows[0];
    res.json({ ...rest, stats: stats || null, columns, indexes, constraints, definition });
  })
);

// Identify a row by its primary key columns or, failing that, its ctid.
function buildWhere(key, startIndex = 1) {
  const entries = Object.entries(key || {});
  if (!entries.length) throw bad('Row key is required');
  const params = [];
  const parts = entries.map(([col, val]) => {
    params.push(val);
    const p = `$${startIndex + params.length - 1}`;
    return col === '__ctid' ? `ctid = ${p}::tid` : `${q(col)} = ${p}`;
  });
  return { sql: parts.join(' AND '), params };
}

tableRouter.get(
  '/data',
  wrap(async (req, res) => {
    const { pool, info } = req;
    const cols = await getColumns(pool, info.oid);
    const names = cols.map((c) => c.name);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || config.maxRows, 1), 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const params = [];
    const conds = [];
    if (req.query.q) {
      params.push(`%${String(req.query.q).replace(/[\\%_]/g, '\\$&')}%`);
      conds.push(`t::text ILIKE $${params.length}`);
    }
    if (req.query.filters) {
      let filters;
      try {
        filters = JSON.parse(req.query.filters);
      } catch (e) {
        throw bad('Invalid filters');
      }
      for (const f of Array.isArray(filters) ? filters : []) {
        if (!names.includes(f.col)) throw bad(`Unknown column "${f.col}"`);
        const col = `t.${q(f.col)}`;
        if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') conds.push(`${col} ${f.op}`);
        else if (f.op === 'IN' || f.op === 'NOT IN') {
          const vals = String(f.value).split(',').map((v) => v.trim());
          const ps = vals.map((v) => (params.push(v), `$${params.length}`));
          conds.push(`${col}::text ${f.op} (${ps.join(', ')})`);
        } else if (f.op === 'BETWEEN') {
          const [a, b] = String(f.value).split(',').map((v) => v.trim());
          params.push(a, b);
          conds.push(`${col} BETWEEN $${params.length - 1} AND $${params.length}`);
        } else if (FILTER_OPS.includes(f.op)) {
          params.push(f.op.includes('LIKE') && f.contains ? `%${f.value}%` : f.value);
          const textual = /LIKE|~/.test(f.op);
          conds.push(`${col}${textual ? '::text' : ''} ${f.op} $${params.length}${textual ? '' : '::' + cols.find((c) => c.name === f.col).type}`);
        } else throw bad('Unknown operator');
      }
    }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
    let order = '';
    if (req.query.sort) {
      if (!names.includes(req.query.sort)) throw bad('Unknown sort column');
      order = ` ORDER BY ${q(req.query.sort)} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
    } else if (cols.some((c) => c.pk)) {
      order = ' ORDER BY ' + cols.filter((c) => c.pk).map((c) => q(c.name)).join(', ');
    }
    const hasCtid = info.kind === 'r';
    const total = (await pool.query(`SELECT count(*) AS n FROM ${req.qname} t${where}`, params)).rows[0].n;
    const { rows } = await pool.query(
      {
        text: `SELECT ${hasCtid ? 't.ctid::text AS "__ctid", ' : ''}t.* FROM ${req.qname} t${where}${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        values: params,
        types: conn.rawTypes,
      }
    );
    const hasPk = cols.some((c) => c.pk);
    const fkRows = (
      await pool.query(
        `SELECT a.attname::text AS col, rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname::text AS ref_col
         FROM pg_constraint k
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
         JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = k.confkey[1]
         WHERE k.conrelid = $1 AND k.contype = 'f' AND array_length(k.conkey, 1) = 1`,
        [info.oid]
      )
    ).rows;
    res.json({
      fks: Object.fromEntries(fkRows.map((r) => [r.col, r])),
      columns: cols,
      rows,
      total: Number(total),
      page,
      limit,
      editable: info.kind === 'r' || info.kind === 'p' ? hasPk || hasCtid : false,
      keyMode: hasPk ? 'pk' : hasCtid ? 'ctid' : null,
    });
  })
);

function buildValueClauses(values, colNames) {
  const cols = [];
  const exprs = [];
  const params = [];
  for (const [name, spec] of Object.entries(values || {})) {
    if (!colNames.includes(name)) throw bad(`Unknown column "${name}"`);
    cols.push(q(name));
    if (spec.mode === 'default') exprs.push('DEFAULT');
    else if (spec.mode === 'null') exprs.push('NULL');
    else {
      params.push(spec.value == null ? '' : String(spec.value));
      exprs.push(`$${params.length}`);
    }
  }
  return { cols, exprs, params };
}

async function requireTable(req) {
  if (req.info.kind !== 'r' && req.info.kind !== 'p') throw bad('This operation is only available for tables');
}

tableRouter.post(
  '/rows',
  wrap(async (req, res) => {
    await requireTable(req);
    const names = (await getColumns(req.pool, req.info.oid)).map((c) => c.name);
    const { cols, exprs, params } = buildValueClauses(req.body.values, names);
    const sql = cols.length
      ? `INSERT INTO ${req.qname} (${cols.join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${exprs.join(', ')})`
      : `INSERT INTO ${req.qname} DEFAULT VALUES`;
    const r = await req.pool.query(sql, params);
    res.json({ rowCount: r.rowCount });
  })
);

tableRouter.put(
  '/rows',
  wrap(async (req, res) => {
    await requireTable(req);
    const names = (await getColumns(req.pool, req.info.oid)).map((c) => c.name);
    const { cols, exprs, params } = buildValueClauses(req.body.values, names);
    if (!cols.length) throw bad('Nothing to update');
    const where = buildWhere(req.body.key, params.length + 1);
    const set = cols.map((c, i) => `${c} = ${exprs[i]}`).join(', ');
    const r = await req.pool.query(`UPDATE ${req.qname} SET ${set} WHERE ${where.sql}`, [...params, ...where.params]);
    res.json({ rowCount: r.rowCount });
  })
);

tableRouter.delete(
  '/rows',
  wrap(async (req, res) => {
    await requireTable(req);
    const keys = req.body && req.body.keys;
    if (!Array.isArray(keys) || !keys.length) throw bad('No rows selected');
    const client = await req.pool.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      for (const key of keys) {
        const where = buildWhere(key);
        count += (await client.query(`DELETE FROM ${req.qname} WHERE ${where.sql}`, where.params)).rowCount;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ rowCount: count });
  })
);

tableRouter.post(
  '/truncate',
  wrap(async (req, res) => {
    await requireTable(req);
    const b = req.body || {};
    await req.pool.query(`TRUNCATE ${req.qname}${b.restart ? ' RESTART IDENTITY' : ''}${b.cascade ? ' CASCADE' : ''}`);
    res.json({ ok: true });
  })
);

const KIND_SQL = { r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW', f: 'FOREIGN TABLE' };

tableRouter.delete(
  '/',
  wrap(async (req, res) => {
    await req.pool.query(`DROP ${KIND_SQL[req.info.kind]} ${req.qname}${req.query.cascade === '1' ? ' CASCADE' : ''}`);
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/rename',
  wrap(async (req, res) => {
    const name = req.body && req.body.name;
    if (!name) throw bad('New name is required');
    await req.pool.query(`ALTER ${KIND_SQL[req.info.kind]} ${req.qname} RENAME TO ${q(name)}`);
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/move',
  wrap(async (req, res) => {
    const schema = req.body && req.body.schema;
    if (!schema) throw bad('Target schema is required');
    await req.pool.query(`ALTER ${KIND_SQL[req.info.kind]} ${req.qname} SET SCHEMA ${q(schema)}`);
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/comment',
  wrap(async (req, res) => {
    const c = req.body && req.body.comment;
    await req.pool.query(`COMMENT ON ${KIND_SQL[req.info.kind]} ${req.qname} IS ${c ? lit(c) : 'NULL'}`);
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/copy',
  wrap(async (req, res) => {
    await requireTable(req);
    const { name, schema = req.params.schema, data } = req.body || {};
    if (!name) throw bad('New table name is required');
    const target = qualified(schema, name);
    const client = await req.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE ${target} (LIKE ${req.qname} INCLUDING ALL)`);
      if (data) await client.query(`INSERT INTO ${target} SELECT * FROM ${req.qname}`);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/maintenance',
  wrap(async (req, res) => {
    const op = { vacuum: 'VACUUM', analyze: 'ANALYZE', vacuum_analyze: 'VACUUM ANALYZE', reindex: 'REINDEX TABLE' }[
      req.body && req.body.op
    ];
    if (!op) throw bad('Unknown operation');
    await req.pool.query(`${op} ${req.qname}`);
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/columns',
  wrap(async (req, res) => {
    await requireTable(req);
    await req.pool.query(`ALTER TABLE ${req.qname} ADD COLUMN ${colDef(req.body || {})}`);
    res.json({ ok: true });
  })
);

tableRouter.put(
  '/columns/:col',
  wrap(async (req, res) => {
    await requireTable(req);
    const col = q(req.params.col);
    const b = req.body || {};
    const stmts = [];
    const alter = (s) => stmts.push(`ALTER TABLE ${req.qname} ${s}`);
    if (b.type) {
      if (!TYPE_RE.test(b.type)) throw bad('Invalid type');
      alter(`ALTER COLUMN ${col} TYPE ${b.type} USING ${col}::${b.type}`);
    }
    if (b.default !== undefined) {
      alter(
        String(b.default).trim() === '' ? `ALTER COLUMN ${col} DROP DEFAULT` : `ALTER COLUMN ${col} SET DEFAULT ${b.default}`
      );
    }
    if (b.notnull !== undefined) alter(`ALTER COLUMN ${col} ${b.notnull ? 'SET' : 'DROP'} NOT NULL`);
    if (b.comment !== undefined) stmts.push(`COMMENT ON COLUMN ${req.qname}.${col} IS ${b.comment ? lit(b.comment) : 'NULL'}`);
    if (b.name && b.name !== req.params.col) alter(`RENAME COLUMN ${col} TO ${q(b.name)}`);
    if (!stmts.length) throw bad('Nothing to change');
    await runTransaction(req.pool, stmts);
    res.json({ ok: true });
  })
);

tableRouter.delete(
  '/columns/:col',
  wrap(async (req, res) => {
    await requireTable(req);
    await req.pool.query(
      `ALTER TABLE ${req.qname} DROP COLUMN ${q(req.params.col)}${req.query.cascade === '1' ? ' CASCADE' : ''}`
    );
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/primary-key',
  wrap(async (req, res) => {
    await requireTable(req);
    const columns = (req.body && req.body.columns) || [];
    if (!columns.length) throw bad('Select at least one column');
    const { rows } = await req.pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1 AND contype = 'p'`, [req.info.oid]);
    const stmts = rows.map((r) => `ALTER TABLE ${req.qname} DROP CONSTRAINT ${q(r.conname)}`);
    stmts.push(`ALTER TABLE ${req.qname} ADD PRIMARY KEY (${columns.map(q).join(', ')})`);
    await runTransaction(req.pool, stmts);
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/indexes',
  wrap(async (req, res) => {
    await requireTable(req);
    const { name, columns, unique, method = 'btree' } = req.body || {};
    if (!Array.isArray(columns) || !columns.length) throw bad('Select at least one column');
    if (!INDEX_METHODS.includes(method)) throw bad('Unknown index method');
    await req.pool.query(
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name ? q(name) + ' ' : ''}ON ${req.qname} USING ${method} (${columns.map(q).join(', ')})`
    );
    res.json({ ok: true });
  })
);

tableRouter.delete(
  '/indexes/:name',
  wrap(async (req, res) => {
    await req.pool.query(`DROP INDEX ${qualified(req.params.schema, req.params.name)}`);
    res.json({ ok: true });
  })
);

tableRouter.post(
  '/constraints',
  wrap(async (req, res) => {
    await requireTable(req);
    const { name, type, columns, refTable, refColumns, check, onDelete } = req.body || {};
    const cname = name ? `CONSTRAINT ${q(name)} ` : '';
    let def;
    if (type === 'unique') {
      if (!columns || !columns.length) throw bad('Select at least one column');
      def = `UNIQUE (${columns.map(q).join(', ')})`;
    } else if (type === 'check') {
      if (!check) throw bad('Check expression is required');
      def = `CHECK (${check})`;
    } else if (type === 'foreign') {
      if (!columns || !columns.length || !refTable || !refColumns || !refColumns.length) throw bad('Columns and referenced table/columns are required');
      const action = ['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION'].includes(onDelete) ? onDelete : 'NO ACTION';
      def = `FOREIGN KEY (${columns.map(q).join(', ')}) REFERENCES ${refTable.schema ? qualified(refTable.schema, refTable.name) : q(refTable.name)} (${refColumns.map(q).join(', ')}) ON DELETE ${action}`;
    } else throw bad('Unknown constraint type');
    await req.pool.query(`ALTER TABLE ${req.qname} ADD ${cname}${def}`);
    res.json({ ok: true });
  })
);

tableRouter.delete(
  '/constraints/:name',
  wrap(async (req, res) => {
    await req.pool.query(`ALTER TABLE ${req.qname} DROP CONSTRAINT ${q(req.params.name)}`);
    res.json({ ok: true });
  })
);

async function runTransaction(pool, statements) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) await client.query(s);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- SQL console ----------

router.post(
  '/db/:db/sql',
  wrap(async (req, res) => {
    const sql = req.body && req.body.sql;
    if (!sql || !String(sql).trim()) throw bad('SQL is empty');
    const started = Date.now();
    let raw;
    try {
      raw = await dbPool(req).query({ text: String(sql), rowMode: 'array', types: conn.rawTypes });
    } catch (err) {
      return res.status(400).json({ error: err.message, position: err.position ? Number(err.position) : undefined });
    }
    const results = (Array.isArray(raw) ? raw : [raw]).map((r) => ({
      command: r.command,
      rowCount: r.rowCount,
      fields: (r.fields || []).map((f) => f.name),
      rows: (r.fields || []).length ? r.rows.slice(0, MAX_SQL_ROWS) : [],
      truncated: (r.fields || []).length > 0 && r.rows.length > MAX_SQL_ROWS,
    }));
    res.json({ results, ms: Date.now() - started });
  })
);

// ---------- export ----------

const csvCell = (v) => (v == null ? '' : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function* streamRows(pool, qname, columns) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`DECLARE pgm_export NO SCROLL CURSOR FOR SELECT ${columns.map((c) => q(c)).join(', ') || '*'} FROM ${qname}`);
    for (;;) {
      const { rows } = await client.query({ text: 'FETCH 1000 FROM pgm_export', rowMode: 'array', types: conn.rawTypes });
      if (!rows.length) break;
      yield rows;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function tableDdl(pool, schema, table, info) {
  const qname = qualified(schema, table);
  if (info.kind === 'v' || info.kind === 'm') {
    const def = (await pool.query('SELECT pg_get_viewdef($1::oid, true) AS d', [info.oid])).rows[0].d;
    return `CREATE ${KIND_SQL[info.kind]} ${qname} AS\n${def}\n\n`;
  }
  const cols = await getColumns(pool, info.oid);
  const defs = cols.map((c) => {
    let s = `  ${q(c.name)} ${c.type}`;
    if (c.identity) s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
    else if (c.generated && c.default) s += ` GENERATED ALWAYS AS (${c.default}) STORED`;
    else if (c.default != null) s += ` DEFAULT ${c.default}`;
    if (c.notnull) s += ' NOT NULL';
    return s;
  });
  const constraints = await getConstraints(pool, info.oid);
  for (const k of constraints) if (k.type !== 'f') defs.push(`  CONSTRAINT ${q(k.name)} ${k.definition}`);
  let ddl = `CREATE TABLE ${qname} (\n${defs.join(',\n')}\n);\n`;
  for (const idx of await getIndexes(pool, info.oid)) if (!idx.has_constraint) ddl += idx.definition + ';\n';
  return ddl + '\n';
}

function foreignKeyDdl(qname, constraints) {
  return constraints
    .filter((k) => k.type === 'f')
    .map((k) => `ALTER TABLE ${qname} ADD CONSTRAINT ${q(k.name)} ${k.definition};\n`)
    .join('');
}

router.get(
  '/db/:db/export',
  wrap(async (req, res) => {
    const pool = dbPool(req);
    const format = ['sql', 'csv', 'json'].includes(req.query.format) ? req.query.format : 'sql';
    const withStructure = req.query.structure !== '0';
    const withData = req.query.data !== '0';
    const dropFirst = req.query.drop === '1';
    const tables = String(req.query.tables || '')
      .split(',')
      .filter(Boolean)
      .map((t) => {
        const i = t.indexOf('.');
        return { schema: t.slice(0, i), name: t.slice(i + 1) };
      });
    if (!tables.length) throw bad('No tables selected');
    if (format === 'csv' && tables.length > 1) throw bad('CSV export supports one table at a time');

    const infos = [];
    for (const t of tables) infos.push({ ...t, info: await relInfo(pool, t.schema, t.name) });

    const base = tables.length === 1 ? tables[0].name : req.params.db;
    res.setHeader('Content-Type', { sql: 'application/sql', csv: 'text/csv', json: 'application/json' }[format] + '; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base.replace(/[^\w.-]/g, '_')}.${format}"`);

    if (format === 'sql') {
      res.write(`-- pgMyAdmin SQL export\n-- Database: ${req.params.db}\n-- Generated: ${new Date().toISOString()}\n\n`);
      const schemas = [...new Set(infos.map((t) => t.schema))].filter((s) => s !== 'public');
      if (withStructure) for (const s of schemas) res.write(`CREATE SCHEMA IF NOT EXISTS ${q(s)};\n`);
      const deferred = [];
      for (const { schema, name, info } of infos) {
        const qname = qualified(schema, name);
        const isTable = info.kind === 'r' || info.kind === 'p';
        if (withStructure) {
          if (dropFirst) res.write(`DROP ${KIND_SQL[info.kind]} IF EXISTS ${qname} CASCADE;\n`);
          res.write(await tableDdl(pool, schema, name, info));
          if (isTable) deferred.push(foreignKeyDdl(qname, await getConstraints(pool, info.oid)));
        }
        if (withData && isTable) {
          const cols = (await getColumns(pool, info.oid)).filter((c) => !c.generated);
          const names = cols.map((c) => c.name);
          const override = cols.some((c) => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
          let any = false;
          for await (const batch of streamRows(pool, qname, names)) {
            any = true;
            const values = batch.map((r) => '(' + r.map((v) => (v == null ? 'NULL' : lit(v))).join(', ') + ')');
            res.write(`INSERT INTO ${qname} (${names.map(q).join(', ')})${override} VALUES\n${values.join(',\n')};\n`);
          }
          if (any) res.write('\n');
        }
      }
      for (const d of deferred) res.write(d);
    } else if (format === 'csv') {
      const { schema, name, info } = infos[0];
      const names = (await getColumns(pool, info.oid)).map((c) => c.name);
      res.write(names.map(csvCell).join(',') + '\r\n');
      for await (const batch of streamRows(pool, qualified(schema, name), names)) {
        res.write(batch.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
      }
    } else {
      res.write('{');
      let firstTable = true;
      for (const { schema, name, info } of infos) {
        const names = (await getColumns(pool, info.oid)).map((c) => c.name);
        res.write(`${firstTable ? '' : ','}\n${JSON.stringify(`${schema}.${name}`)}: [`);
        firstTable = false;
        let first = true;
        for await (const batch of streamRows(pool, qualified(schema, name), names)) {
          for (const r of batch) {
            const obj = {};
            names.forEach((n, i) => (obj[n] = r[i]));
            res.write(`${first ? '' : ','}\n  ${JSON.stringify(obj)}`);
            first = false;
          }
        }
        res.write('\n]');
      }
      res.write('\n}\n');
    }
    res.end();
  })
);

// ---------- server info ----------

router.get(
  '/server/status',
  wrap(async (req, res) => {
    const pool = adminPool(req);
    const [info, dbs, activity] = await Promise.all([
      pool.query(`SELECT version() AS version, pg_postmaster_start_time() AS started,
                         now() - pg_postmaster_start_time() AS uptime, current_user AS "user",
                         inet_server_addr()::text AS address, inet_server_port() AS port`),
      pool.query(`SELECT datname AS name, numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
                         tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, deadlocks
                  FROM pg_stat_database WHERE datname IS NOT NULL ORDER BY datname`),
      pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE state = 'active') AS active FROM pg_stat_activity`),
    ]);
    res.json({ ...info.rows[0], databases: dbs.rows, connections: activity.rows[0] });
  })
);

router.get(
  '/server/variables',
  wrap(async (req, res) => {
    const { rows } = await adminPool(req).query(
      `SELECT name, setting, unit, category, short_desc AS description, context, source FROM pg_settings ORDER BY name`
    );
    res.json(rows);
  })
);

router.get(
  '/server/processes',
  wrap(async (req, res) => {
    const { rows } = await adminPool(req).query(
      `SELECT pid, datname, usename, application_name, client_addr::text AS client, state, wait_event_type,
              backend_start, query_start, left(query, 500) AS query
       FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start NULLS LAST`
    );
    res.json(rows);
  })
);

router.delete(
  '/server/processes/:pid',
  wrap(async (req, res) => {
    const pid = parseInt(req.params.pid, 10);
    if (!pid) throw bad('Invalid pid');
    const fn = req.query.cancel === '1' ? 'pg_cancel_backend' : 'pg_terminate_backend';
    const { rows } = await adminPool(req).query(`SELECT ${fn}($1) AS ok`, [pid]);
    res.json({ ok: rows[0].ok });
  })
);

router.get(
  '/server/roles',
  wrap(async (req, res) => {
    const { rows } = await adminPool(req).query(
      `SELECT rolname AS name, rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole,
              rolcanlogin AS login, rolreplication AS replication, rolconnlimit AS connlimit, rolvaliduntil AS valid_until,
              ARRAY(SELECT b.rolname::text FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid) AS member_of
       FROM pg_roles r WHERE rolname !~ '^pg_' ORDER BY rolname`
    );
    res.json(rows);
  })
);

router.post(
  '/server/roles',
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) throw bad('Role name is required');
    let sql = `CREATE ROLE ${q(b.name)} ${b.login ? 'LOGIN' : 'NOLOGIN'} ${b.superuser ? 'SUPERUSER' : 'NOSUPERUSER'} ${b.createdb ? 'CREATEDB' : 'NOCREATEDB'} ${b.createrole ? 'CREATEROLE' : 'NOCREATEROLE'}`;
    if (b.password) sql += ` PASSWORD ${lit(b.password)}`;
    await adminPool(req).query(sql);
    res.json({ ok: true });
  })
);

router.delete(
  '/server/roles/:name',
  wrap(async (req, res) => {
    if (req.params.name === req.entry.cfg.user) throw bad('Cannot drop the current user');
    await adminPool(req).query(`DROP ROLE ${q(req.params.name)}`);
    res.json({ ok: true });
  })
);

require('./extras')(router, { tableRouter, wrap, bad, HttpError, adminPool, dbPool, getColumns, relInfo, runTransaction });

// ---------- errors ----------

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

router.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();
  const status = err.status || (err.code && /^[0-9A-Z]{5}$/.test(err.code) ? 400 : 500);
  res.status(status).json({ error: err.message || 'Internal error', detail: err.detail, hint: err.hint });
});

module.exports = router;
