const { quoteIdent: q, quoteLiteral: lit, qualified } = require('./connections');
const conn = require('./connections');

const SYSTEM = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;
const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

// RFC 4180-style parser supporting quoted fields, escaped quotes and embedded newlines.
function parseCsv(text, delimiter) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') endRow();
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
    else field += ch;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

module.exports = function extras(router, h) {
  const { tableRouter, wrap, bad, adminPool, dbPool, getColumns, runTransaction } = h;

  // ---------- import ----------

  router.post(
    '/db/:db/import',
    wrap(async (req, res) => {
      const sql = req.body && req.body.sql;
      if (!sql || !String(sql).trim()) throw bad('Nothing to import');
      const started = Date.now();
      const client = await dbPool(req).connect();
      try {
        const raw = await client.query(String(sql));
        const results = Array.isArray(raw) ? raw : [raw];
        res.json({ statements: results.length, ms: Date.now() - started });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(400).json({ error: err.message, position: err.position ? Number(err.position) : undefined });
      } finally {
        client.release();
      }
    })
  );

  tableRouter.post(
    '/import-csv',
    wrap(async (req, res) => {
      if (req.info.kind !== 'r' && req.info.kind !== 'p') throw bad('Import is only available for tables');
      const { csv, header = true, delimiter = ',', emptyAsNull = true } = req.body || {};
      if (!csv || !String(csv).trim()) throw bad('CSV is empty');
      if (String(delimiter).length !== 1) throw bad('Delimiter must be a single character');
      const cols = (await getColumns(req.pool, req.info.oid)).filter((c) => !c.generated);
      const names = cols.map((c) => c.name);
      const rows = parseCsv(String(csv), delimiter);
      let target = names;
      if (header) {
        target = (rows.shift() || []).map((s) => s.trim());
        const unknown = target.filter((n) => !names.includes(n));
        if (unknown.length) throw bad(`Unknown column(s) in header: ${unknown.join(', ')}`);
      }
      if (!rows.length) throw bad('No data rows found');
      const width = target.length;
      rows.forEach((r, i) => {
        if (r.length !== width) throw bad(`Row ${i + 1 + (header ? 1 : 0)} has ${r.length} fields, expected ${width}`);
      });
      const perBatch = Math.max(1, Math.floor(60000 / width));
      const colList = target.map(q).join(', ');
      const client = await req.pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < rows.length; i += perBatch) {
          const batch = rows.slice(i, i + perBatch);
          const params = [];
          const tuples = batch.map((r) => '(' + r.map((v) => (params.push(emptyAsNull && v === '' ? null : v), `$${params.length}`)).join(', ') + ')');
          await client.query(`INSERT INTO ${req.qname} (${colList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`, params);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      res.json({ rowCount: rows.length });
    })
  );

  // ---------- database-wide search ----------

  router.get(
    '/db/:db/search',
    wrap(async (req, res) => {
      const term = String(req.query.q || '');
      if (!term) throw bad('Search term is required');
      const mode = req.query.mode || 'contains';
      const pool = dbPool(req);
      const { rows: tables } = await pool.query(
        `SELECT n.nspname AS schema, c.relname AS name,
                array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS cols
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p','m') AND NOT c.relispartition AND ${SYSTEM} ORDER BY 1, 2`
      );
      const only = req.query.tables ? new Set(String(req.query.tables).split(',')) : null;
      const value = mode === 'contains' ? `%${term.replace(/[\\%_]/g, '\\$&')}%` : term;
      const op = { contains: 'ILIKE', exact: '=', regex: '~*' }[mode];
      if (!op) throw bad('Unknown search mode');
      const results = [];
      for (const t of tables) {
        if (only && !only.has(`${t.schema}.${t.name}`)) continue;
        if (!t.cols.length) continue;
        const where = t.cols.map((c) => `${q(c)}::text ${op} $1`).join(' OR ');
        const n = (await pool.query(`SELECT count(*) AS n FROM ${qualified(t.schema, t.name)} WHERE ${where}`, [value])).rows[0].n;
        results.push({ schema: t.schema, name: t.name, matches: Number(n) });
      }
      res.json(results);
    })
  );

  // ---------- routines, triggers, sequences, extensions ----------

  router.get(
    '/db/:db/objects',
    wrap(async (req, res) => {
      const pool = dbPool(req);
      const [routines, triggers, sequences, extensions, available] = await Promise.all([
        pool.query(
          `SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
                  pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS returns,
                  l.lanname AS language, pg_get_userbyid(p.proowner) AS owner, pg_get_functiondef(p.oid) AS definition
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
           WHERE p.prokind IN ('f','p') AND ${SYSTEM}
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
           ORDER BY 2, 3`
        ),
        pool.query(
          `SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name, t.tgenabled <> 'D' AS enabled, pg_get_triggerdef(t.oid) AS definition
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE NOT t.tgisinternal AND ${SYSTEM} ORDER BY 1, 2, 3`
        ),
        pool.query(
          `SELECT schemaname AS schema, sequencename AS name, data_type::text AS type, start_value, min_value, max_value, increment_by, cycle, last_value
           FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2`
        ),
        pool.query(`SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema, c.description FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace LEFT JOIN pg_description c ON c.objoid = e.oid ORDER BY 1`),
        pool.query(`SELECT name, default_version, comment FROM pg_available_extensions WHERE installed_version IS NULL ORDER BY name`),
      ]);
      res.json({ routines: routines.rows, triggers: triggers.rows, sequences: sequences.rows, extensions: extensions.rows, availableExtensions: available.rows });
    })
  );

  router.delete(
    '/db/:db/routines/:oid',
    wrap(async (req, res) => {
      const oid = parseInt(req.params.oid, 10);
      if (!oid) throw bad('Invalid routine id');
      const pool = dbPool(req);
      const r = await pool.query(`SELECT p.oid::regprocedure::text AS sig, p.prokind AS kind FROM pg_proc p WHERE p.oid = $1`, [oid]);
      if (!r.rows.length) throw bad('Routine not found');
      await pool.query(`DROP ${r.rows[0].kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} ${r.rows[0].sig}`);
      res.json({ ok: true });
    })
  );

  router.post(
    '/db/:db/triggers/toggle',
    wrap(async (req, res) => {
      const { schema, table, name, enabled } = req.body || {};
      if (!schema || !table || !name) throw bad('Trigger identity is required');
      await dbPool(req).query(`ALTER TABLE ${qualified(schema, table)} ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${q(name)}`);
      res.json({ ok: true });
    })
  );

  router.post(
    '/db/:db/triggers/drop',
    wrap(async (req, res) => {
      const { schema, table, name } = req.body || {};
      if (!schema || !table || !name) throw bad('Trigger identity is required');
      await dbPool(req).query(`DROP TRIGGER ${q(name)} ON ${qualified(schema, table)}`);
      res.json({ ok: true });
    })
  );

  router.post(
    '/db/:db/sequences/setval',
    wrap(async (req, res) => {
      const { schema, name, value } = req.body || {};
      if (!schema || !name || !/^-?\d+$/.test(String(value))) throw bad('Sequence and integer value are required');
      await dbPool(req).query('SELECT setval($1::regclass, $2::bigint)', [qualified(schema, name), String(value)]);
      res.json({ ok: true });
    })
  );

  router.post(
    '/db/:db/sequences/drop',
    wrap(async (req, res) => {
      const { schema, name } = req.body || {};
      if (!schema || !name) throw bad('Sequence is required');
      await dbPool(req).query(`DROP SEQUENCE ${qualified(schema, name)}`);
      res.json({ ok: true });
    })
  );

  router.post(
    '/db/:db/extensions',
    wrap(async (req, res) => {
      const name = req.body && req.body.name;
      if (!name) throw bad('Extension name is required');
      await dbPool(req).query(`CREATE EXTENSION ${q(name)}`);
      res.json({ ok: true });
    })
  );

  router.delete(
    '/db/:db/extensions/:name',
    wrap(async (req, res) => {
      await dbPool(req).query(`DROP EXTENSION ${q(req.params.name)}`);
      res.json({ ok: true });
    })
  );

  // ---------- SQL editor support: completion metadata and checking ----------

  router.get(
    '/db/:db/completion',
    wrap(async (req, res) => {
      const { rows } = await dbPool(req).query(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
                COALESCE((SELECT json_agg(json_build_object('name', a.attname::text, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
                          FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]') AS columns
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND ${SYSTEM} ORDER BY 1, 2`
      );
      const schemas = (
        await dbPool(req).query(`SELECT n.nspname AS name FROM pg_namespace n WHERE ${SYSTEM} ORDER BY 1`)
      ).rows.map((r) => r.name);
      res.json({ schemas, tables: rows });
    })
  );

  // Splits a script into statements, honouring quotes, comments and dollar quoting.
  function splitStatements(sql) {
    const out = [];
    let start = 0;
    let i = 0;
    const push = (end) => {
      const text = sql.slice(start, end);
      if (text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) out.push({ from: start, text });
      start = end + 1;
    };
    while (i < sql.length) {
      const ch = sql[i];
      const two = sql.substr(i, 2);
      if (two === '--') { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e + 1; }
      else if (two === '/*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; }
      else if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < sql.length) {
          if (sql[j] === ch) { if (sql[j + 1] === ch) j += 2; else break; } else j++;
        }
        i = j + 1;
      } else if (ch === '$') {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
        if (m) { const e = sql.indexOf(m[0], i + m[0].length); i = e < 0 ? sql.length : e + m[0].length; } else i++;
      } else if (ch === ';') { push(i); i++; }
      else i++;
    }
    push(sql.length);
    return out;
  }

  // PREPARE parses and analyses a statement (resolving tables, columns and functions)
  // without executing it, inside a read-only transaction that is always rolled back.
  router.post(
    '/db/:db/lint',
    wrap(async (req, res) => {
      const sql = String((req.body && req.body.sql) || '');
      if (sql.length > 200000) return res.json({ diagnostics: [] });
      const stmts = splitStatements(sql).slice(0, 40);
      const diagnostics = [];
      const client = await dbPool(req).connect();
      try {
        for (const s of stmts) {
          const body = s.text.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
          if (!/^(select|insert|update|delete|with|values|merge|table)\b/i.test(body)) continue;
          const lead = s.text.length - body.length;
          const prefix = 'PREPARE pgm_lint AS ';
          try {
            await client.query('BEGIN READ ONLY');
            await client.query("SET LOCAL statement_timeout = '3s'");
            await client.query(prefix + body);
            await client.query('DEALLOCATE pgm_lint');
          } catch (err) {
            const pos = err.position ? Number(err.position) - prefix.length - 1 : 0;
            let from = s.from + lead + Math.max(0, Math.min(pos, body.length - 1));
            const word = /^("[^"]*"|[\w$]+(\.[\w$]+)*)/.exec(sql.slice(from));
            const to = from + (word ? word[0].length : 1);
            diagnostics.push({ from, to, message: err.message, hint: err.hint || undefined });
          } finally {
            await client.query('ROLLBACK').catch(() => {});
          }
        }
      } finally {
        client.release();
      }
      res.json({ diagnostics });
    })
  );

  // ---------- designer ----------

  router.get(
    '/db/:db/designer',
    wrap(async (req, res) => {
      const pool = dbPool(req);
      const [tables, fks] = await Promise.all([
        pool.query(
          `SELECT n.nspname AS schema, c.relname AS name,
                  (SELECT json_agg(json_build_object('name', a.attname::text, 'type', format_type(a.atttypid, a.atttypmod),
                     'pk', COALESCE(a.attnum = ANY (SELECT unnest(i.indkey) FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary), false)) ORDER BY a.attnum)
                   FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND ${SYSTEM} ORDER BY 1, 2`
        ),
        pool.query(
          `SELECT k.conname AS name, fn.nspname AS from_schema, fc.relname AS from_table, tn.nspname AS to_schema, tc.relname AS to_table,
                  array(SELECT a.attname::text FROM unnest(k.conkey) u JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u) AS from_cols,
                  array(SELECT a.attname::text FROM unnest(k.confkey) u JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u) AS to_cols
           FROM pg_constraint k
           JOIN pg_class fc ON fc.oid = k.conrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
           JOIN pg_class tc ON tc.oid = k.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
           WHERE k.contype = 'f' AND fn.nspname NOT IN ('pg_catalog','information_schema')`
        ),
      ]);
      res.json({ tables: tables.rows, fks: fks.rows });
    })
  );

  // ---------- privileges ----------

  router.get(
    '/db/:db/privileges',
    wrap(async (req, res) => {
      const { rows } = await dbPool(req).query(
        `SELECT n.nspname AS schema, c.relname AS "table", COALESCE(r.rolname::text, 'PUBLIC') AS grantee,
                array_agg(a.privilege_type ORDER BY a.privilege_type) AS privileges
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
         WHERE c.relkind IN ('r','p','v','m','f') AND ${SYSTEM}
         GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`
      );
      res.json(rows);
    })
  );

  router.post(
    '/db/:db/privileges',
    wrap(async (req, res) => {
      const { role, privileges, schema, table, revoke } = req.body || {};
      if (!role || !schema) throw bad('Role and schema are required');
      const privs = (privileges || []).map((p) => String(p).toUpperCase());
      if (!privs.length || privs.some((p) => !TABLE_PRIVS.includes(p))) throw bad('Invalid privileges');
      const target = table ? `TABLE ${qualified(schema, table)}` : `ALL TABLES IN SCHEMA ${q(schema)}`;
      const who = role === 'PUBLIC' ? 'PUBLIC' : q(role);
      await dbPool(req).query(`${revoke ? 'REVOKE' : 'GRANT'} ${privs.join(', ')} ON ${target} ${revoke ? 'FROM' : 'TO'} ${who}`);
      res.json({ ok: true });
    })
  );

  router.put(
    '/server/roles/:name',
    wrap(async (req, res) => {
      const b = req.body || {};
      const opts = [];
      for (const [key, on, off] of [['login', 'LOGIN', 'NOLOGIN'], ['superuser', 'SUPERUSER', 'NOSUPERUSER'], ['createdb', 'CREATEDB', 'NOCREATEDB'], ['createrole', 'CREATEROLE', 'NOCREATEROLE'], ['replication', 'REPLICATION', 'NOREPLICATION']]) {
        if (b[key] !== undefined) opts.push(b[key] ? on : off);
      }
      if (b.connlimit !== undefined && b.connlimit !== '') {
        const n = parseInt(b.connlimit, 10);
        if (Number.isNaN(n)) throw bad('Invalid connection limit');
        opts.push(`CONNECTION LIMIT ${n}`);
      }
      if (b.password) opts.push(`PASSWORD ${lit(b.password)}`);
      if (b.validUntil !== undefined) opts.push(`VALID UNTIL ${b.validUntil ? lit(b.validUntil) : "'infinity'"}`);
      if (!opts.length) throw bad('Nothing to change');
      await adminPool(req).query(`ALTER ROLE ${q(req.params.name)} WITH ${opts.join(' ')}`);
      res.json({ ok: true });
    })
  );
};
