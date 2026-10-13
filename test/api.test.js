// Integration tests. Requires a reachable PostgreSQL server:
//   PGM_TEST_HOST, PGM_TEST_PORT, PGM_TEST_USER, PGM_TEST_PASSWORD (defaults: localhost/5432/postgres/"")
// Tests are skipped when PGM_TEST_PORT is not set.
const test = require('node:test');
const assert = require('node:assert');
// Keep a developer's .env from affecting the tests.
process.env.PGMA_ENV_FILE = '';
const app = require('../server');

const skip = !process.env.PGM_TEST_PORT && 'set PGM_TEST_PORT to run integration tests';
let server, base, cookie = '';

async function call(method, url, body) {
  const res = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-PGM-Request': '1', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

test.before(async () => {
  if (skip) return;
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) { server.closeAllConnections(); server.close(); } });

test('rejects unauthenticated and header-less requests', { skip }, async () => {
  assert.strictEqual((await call('GET', '/databases')).status, 401);
  const res = await fetch(base + '/api/logout', { method: 'POST' });
  assert.strictEqual(res.status, 403);
});

test('login, schema ops, CRUD, export', { skip }, async () => {
  const bad = await call('POST', '/login', { user: 'nobody', password: 'wrong', host: process.env.PGM_TEST_HOST || 'localhost', port: process.env.PGM_TEST_PORT });
  assert.strictEqual(bad.status, 401);

  const login = await call('POST', '/login', {
    host: process.env.PGM_TEST_HOST || 'localhost', port: process.env.PGM_TEST_PORT,
    user: process.env.PGM_TEST_USER || 'postgres', password: process.env.PGM_TEST_PASSWORD || '',
  });
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));

  const name = 'pgm_test_' + Date.now();
  assert.strictEqual((await call('POST', '/databases', { name })).status, 200);
  const db = `/db/${name}`;
  try {
    assert.ok((await call('GET', '/databases')).body.some((d) => d.name === name));

    const create = await call('POST', `${db}/tables`, {
      schema: 'public', name: 'people',
      columns: [{ name: 'id', type: 'serial', pk: true, notnull: true }, { name: 'name', type: 'text', notnull: true }, { name: 'meta', type: 'jsonb' }],
    });
    assert.strictEqual(create.status, 200, JSON.stringify(create.body));

    const t = `${db}/t/public/people`;
    assert.strictEqual((await call('POST', `${t}/rows`, { values: { name: { mode: 'value', value: "O'Brien" }, meta: { mode: 'value', value: '{"a":1}' } } })).status, 200);
    assert.strictEqual((await call('POST', `${t}/rows`, { values: { name: { mode: 'value', value: 'Ann' }, meta: { mode: 'null' } } })).status, 200);

    let data = (await call('GET', `${t}/data?sort=name&dir=asc`)).body;
    assert.strictEqual(data.total, 2);
    assert.strictEqual(data.rows[0].name, 'Ann');
    assert.strictEqual(data.rows[1].name, "O'Brien");
    assert.strictEqual(data.keyMode, 'pk');
    assert.strictEqual((await call('GET', `${t}/data?q=brien`)).body.total, 1);
    assert.strictEqual((await call('GET', `${t}/data?sort=${encodeURIComponent('x"; drop table people;--')}`)).status, 400);

    const ann = data.rows[0];
    assert.strictEqual((await call('PUT', `${t}/rows`, { key: { id: ann.id }, values: { name: { mode: 'value', value: 'Anna' } } })).body.rowCount, 1);

    const structure = (await call('GET', `${t}/structure`)).body;
    assert.deepStrictEqual(structure.columns.map((c) => c.name), ['id', 'name', 'meta']);
    assert.ok(structure.columns[0].pk);

    assert.strictEqual((await call('POST', `${t}/columns`, { name: 'age', type: 'integer', default: '0' })).status, 200);
    assert.strictEqual((await call('PUT', `${t}/columns/age`, { name: 'years', notnull: true })).status, 200);
    assert.strictEqual((await call('POST', `${t}/indexes`, { name: 'people_name_idx', columns: ['name'] })).status, 200);
    assert.strictEqual((await call('POST', `${t}/constraints`, { type: 'check', check: 'years >= 0', name: 'years_ok' })).status, 200);
    assert.strictEqual((await call('DELETE', `${t}/indexes/people_name_idx`)).status, 200);

    const sql = await call('POST', `${db}/sql`, { sql: 'SELECT 1 AS a, 2 AS a; SELECT count(*) FROM people' });
    assert.strictEqual(sql.status, 200);
    assert.strictEqual(sql.body.results.length, 2);
    assert.deepStrictEqual(sql.body.results[0].fields, ['a', 'a']);
    assert.strictEqual((await call('POST', `${db}/sql`, { sql: 'SELEC 1' })).status, 400);

    const exp = await call('GET', `${db}/export?tables=public.people&format=sql&drop=1`);
    assert.match(exp.body, /CREATE TABLE "public"."people"/);
    assert.match(exp.body, /'O''Brien'/);
    assert.match(exp.body, /NULL/);
    const csv = await call('GET', `${db}/export?tables=public.people&format=csv`);
    assert.match(csv.body, /^id,name,meta,years/);
    const json = await call('GET', `${db}/export?tables=public.people&format=json`);
    assert.strictEqual(json.body['public.people'].length, 2);

    assert.strictEqual((await call('DELETE', `${t}/rows`, { keys: [{ id: ann.id }] })).body.rowCount, 1);
    assert.strictEqual((await call('DELETE', `${t}/rows`, { keys: [] })).status, 400);
    assert.strictEqual((await call('POST', `${t}/truncate`)).status, 200);

    // ctid-addressed table without a primary key
    await call('POST', `${db}/sql`, { sql: 'CREATE TABLE nopk (v text); INSERT INTO nopk VALUES (\'a\'),(\'b\')' });
    const nopk = (await call('GET', `${db}/t/public/nopk/data`)).body;
    assert.strictEqual(nopk.keyMode, 'ctid', JSON.stringify(nopk.columns));
    await call('DELETE', `${db}/t/public/nopk/rows`, { keys: [{ __ctid: nopk.rows[0].__ctid }] });
    assert.strictEqual((await call('GET', `${db}/t/public/nopk/data`)).body.total, 1);

    assert.ok((await call('GET', `${db}/tree`)).body.tables.length >= 2);
    assert.strictEqual((await call('DELETE', `${t}`)).status, 200);
    assert.ok((await call('GET', '/server/status')).body.version);
    assert.ok((await call('GET', '/server/roles')).body.length);
  } finally {
    assert.strictEqual((await call('DELETE', `/databases/${name}`)).status, 200);
  }
  await call('POST', '/logout');
  assert.strictEqual((await call('GET', '/databases')).status, 401);
});

test('import, search, filters, objects, designer, privileges', { skip }, async () => {
  await call('POST', '/login', {
    host: process.env.PGM_TEST_HOST || 'localhost', port: process.env.PGM_TEST_PORT,
    user: process.env.PGM_TEST_USER || 'postgres', password: process.env.PGM_TEST_PASSWORD || '',
  });
  const name = 'pgm_test2_' + Date.now();
  await call('POST', '/databases', { name });
  const db = `/db/${name}`;
  try {
    const imp = await call('POST', `${db}/import`, { sql: `
      CREATE TABLE authors (id serial PRIMARY KEY, name text NOT NULL);
      CREATE TABLE books (id serial PRIMARY KEY, title text, author_id int REFERENCES authors(id), price numeric);
      INSERT INTO authors (name) VALUES ('Alice'), ('Bob');
      CREATE FUNCTION add_one(i int) RETURNS int LANGUAGE sql AS 'SELECT i + 1';
      CREATE SEQUENCE my_seq;
      CREATE FUNCTION trg() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
      CREATE TRIGGER books_trg BEFORE INSERT ON books FOR EACH ROW EXECUTE FUNCTION trg();` });
    assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
    assert.strictEqual(imp.body.statements, 7);
    assert.strictEqual((await call('POST', `${db}/import`, { sql: 'INSERT INTO authors(name) VALUES (\'x\'); SELECT bad syntax' })).status, 400);
    assert.strictEqual((await call('GET', `${db}/t/public/authors/data`)).body.total, 2, 'failed import rolled back');

    const csv = 'title,author_id,price\r\n"Hello, ""World""",1,9.5\r\nMultiline,2,\r\n"Line1\nLine2",,3\r\n';
    const bt = `${db}/t/public/books`;
    const ic = await call('POST', `${bt}/import-csv`, { csv });
    assert.strictEqual(ic.status, 200, JSON.stringify(ic.body));
    assert.strictEqual(ic.body.rowCount, 3);
    assert.strictEqual((await call('POST', `${bt}/import-csv`, { csv: 'nope\r\n1' })).status, 400);
    const rows = (await call('GET', `${bt}/data`)).body.rows;
    assert.strictEqual(rows[0].title, 'Hello, "World"');
    assert.strictEqual(rows[1].price, null);
    assert.strictEqual(rows[2].title, 'Line1\nLine2');

    const data = (await call('GET', `${bt}/data`)).body;
    assert.strictEqual(data.fks.author_id.ref_table, 'authors');
    const f = (filters) => call('GET', `${bt}/data?filters=${encodeURIComponent(JSON.stringify(filters))}`);
    assert.strictEqual((await f([{ col: 'price', op: '>', value: '5' }])).body.total, 1);
    assert.strictEqual((await f([{ col: 'price', op: 'IS NULL' }])).body.total, 1);
    assert.strictEqual((await f([{ col: 'title', op: 'LIKE', value: 'Multi', contains: true }])).body.total, 1);
    assert.strictEqual((await f([{ col: 'author_id', op: 'IN', value: '1,2' }])).body.total, 2);
    assert.strictEqual((await f([{ col: 'price', op: 'BETWEEN', value: '1,4' }])).body.total, 1);
    assert.strictEqual((await f([{ col: 'author_id', op: '=', value: '1' }, { col: 'price', op: '>', value: '5' }])).body.total, 1);
    assert.strictEqual((await f([{ col: 'nope', op: '=', value: '1' }])).status, 400);
    assert.strictEqual((await f([{ col: 'price', op: '; drop', value: '1' }])).status, 400);
    assert.strictEqual((await f([{ col: 'price', op: '=', value: 'abc' }])).status, 400);

    const s = (await call('GET', `${db}/search?q=alice`)).body;
    assert.strictEqual(s.find((t) => t.name === 'authors').matches, 1);
    assert.strictEqual(s.find((t) => t.name === 'books').matches, 0);
    assert.strictEqual((await call('GET', `${db}/search?q=^Bo&mode=regex`)).body.find((t) => t.name === 'authors').matches, 1);
    assert.strictEqual((await call('GET', `${db}/search?q=Alice&mode=exact`)).body.find((t) => t.name === 'authors').matches, 1);

    const objs = (await call('GET', `${db}/objects`)).body;
    assert.ok(objs.routines.some((r) => r.name === 'add_one' && /SELECT i \+ 1/.test(r.definition)));
    assert.strictEqual(objs.triggers[0].name, 'books_trg');
    assert.strictEqual(objs.sequences.some((x) => x.name === 'my_seq'), true);
    assert.strictEqual((await call('POST', `${db}/sequences/setval`, { schema: 'public', name: 'my_seq', value: 42 })).status, 200);
    assert.strictEqual((await call('POST', `${db}/triggers/toggle`, { schema: 'public', table: 'books', name: 'books_trg', enabled: false })).status, 200);
    assert.strictEqual((await call('GET', `${db}/objects`)).body.triggers[0].enabled, false);
    assert.strictEqual((await call('POST', `${db}/triggers/drop`, { schema: 'public', table: 'books', name: 'books_trg' })).status, 200);
    const fn = objs.routines.find((r) => r.name === 'add_one');
    assert.strictEqual((await call('DELETE', `${db}/routines/${fn.oid}`)).status, 200);
    assert.strictEqual((await call('POST', `${db}/sequences/drop`, { schema: 'public', name: 'my_seq' })).status, 200);

    const d = (await call('GET', `${db}/designer`)).body;
    assert.strictEqual(d.tables.length, 2);
    assert.deepStrictEqual([d.fks[0].from_table, d.fks[0].to_table, d.fks[0].from_cols], ['books', 'authors', ['author_id']]);

    const comp = (await call('GET', `${db}/completion`)).body;
    const authors = comp.tables.find((t) => t.name === 'authors');
    assert.ok(authors.columns.length > 0 && comp.schemas.includes('public'));
    const sqlText = "SELECT 1;\nSELECT * FROM authors WHERE nope = ';';\nSELECT x FROM missing_tbl";
    const lint = (await call('POST', `${db}/lint`, { sql: sqlText })).body.diagnostics;
    assert.strictEqual(lint.length, 2);
    assert.strictEqual(sqlText.slice(lint[0].from, lint[0].to), 'nope');
    assert.strictEqual(sqlText.slice(lint[1].from, lint[1].to), 'missing_tbl');

    const role = 'pgm_role_' + Date.now();
    assert.strictEqual((await call('POST', '/server/roles', { name: role, login: true })).status, 200);
    assert.strictEqual((await call('PUT', `/server/roles/${role}`, { createdb: true, connlimit: 5, validUntil: '2099-01-01' })).status, 200);
    assert.strictEqual((await call('POST', `${db}/privileges`, { role, privileges: ['select', 'insert'], schema: 'public', table: 'authors' })).status, 200);
    let privs = (await call('GET', `${db}/privileges`)).body.filter((p) => p.grantee === role);
    assert.deepStrictEqual(privs[0].privileges, ['INSERT', 'SELECT']);
    assert.strictEqual((await call('POST', `${db}/privileges`, { role, privileges: ['insert'], schema: 'public', table: 'authors', revoke: true })).status, 200);
    privs = (await call('GET', `${db}/privileges`)).body.filter((p) => p.grantee === role);
    assert.deepStrictEqual(privs[0].privileges, ['SELECT']);
    assert.strictEqual((await call('POST', `${db}/privileges`, { role, privileges: ['bogus'], schema: 'public' })).status, 400);
    await call('POST', `${db}/privileges`, { role, privileges: ['select'], schema: 'public', table: 'authors', revoke: true });
    assert.strictEqual((await call('DELETE', `/server/roles/${role}`)).status, 200);
  } finally {
    await call('DELETE', `/databases/${name}`);
  }
  await call('POST', '/logout');
});
