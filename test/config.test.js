// Config tests. The spawned-server test needs the same PGM_TEST_* variables as api.test.js.
process.env.PGMA_ENV_FILE = '';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const config = require('../src/config');

test('parseEnv handles quotes, comments and export', () => {
  const env = config.parseEnv('# c\nA=1\nexport B="x y" # note\nC=\'q#z\'\nD="l1\\nl2"\nE=val # trailing\n');
  assert.deepStrictEqual(env, { A: '1', B: 'x y', C: 'q#z', D: 'l1\nl2', E: 'val' });
});

test('build defaults and server lists', () => {
  const d = config.build({});
  assert.strictEqual(d.authType, 'cookie');
  assert.strictEqual(d.arbitrary, true);
  assert.strictEqual(d.maxRows, 50);
  const c = config.build({ PGMA_HOSTS: 'a,b', PGMA_PORT: '6000', PGMA_VERBOSES: 'A,B' });
  assert.deepStrictEqual(c.servers.map((s) => [s.host, s.port, s.label]), [['a', 6000, 'A'], ['b', 6000, 'B']]);
  assert.strictEqual(c.arbitrary, false);
  assert.strictEqual(config.build({ PGMA_USER: 'u' }).authType, 'config');
  assert.strictEqual(config.build({ PGMA_UPLOAD_LIMIT: '2M' }).uploadLimit, 2 * 1024 * 1024);
});

test('only_db and hide_db rules', () => {
  const c = config.build({ PGMA_ONLY_DB: 'app_*,stats', PGMA_HIDE_DB: '_old$' });
  assert.ok(c.dbAllowed('app_x') && c.dbAllowed('stats') && !c.dbAllowed('other'));
  assert.ok(c.dbAllowed('app_old') && !c.dbVisible('app_old') && c.dbVisible('app_new'));
});

test('invalid configuration is rejected', () => {
  assert.throws(() => config.build({ PGMA_AUTH_TYPE: 'config' }), /requires PGMA_USER/);
  assert.throws(() => config.build({ PGMA_AUTH_TYPE: 'bogus' }), /cookie/);
  assert.throws(() => config.build({ PGMA_HOSTS: 'a,b', PGMA_USER: 'u' }), /single server/);
  assert.throws(() => config.build({ PGMA_MAX_ROWS: '0' }), /PGMA_MAX_ROWS/);
  assert.throws(() => config.build({ PGMA_HIDE_DB: '(' }), /Invalid/);
  assert.throws(() => config.build({ PGMA_SSL: 'maybe' }), /boolean/);
});

test('loadEnv reads a file, real env wins, missing file throws', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgma-')), 'x.env');
  fs.writeFileSync(f, 'PGMA_MAX_ROWS=75\nPGMA_DATABASE=fromfile\n');
  const r = config.loadEnv({ PGMA_ENV_FILE: f, PGMA_DATABASE: 'real' });
  assert.strictEqual(r.env.PGMA_MAX_ROWS, '75');
  assert.strictEqual(r.env.PGMA_DATABASE, 'real');
  assert.throws(() => config.loadEnv({ PGMA_ENV_FILE: f + '.nope' }), /not found/);
});

const skip = !process.env.PGM_TEST_PORT && 'set PGM_TEST_PORT to run integration tests';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(env) {
  const lp = String(await freePort());
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PGMA_ENV_FILE: '', PGMA_LISTEN_PORT: lp, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /listening on (http\S+)/.exec(out); if (m) resolve({ p, url: m[1] }); });
    p.on('exit', (code) => reject(new Error('exited ' + code + out)));
  });
}

test('config auth auto-logs-in; cookie auth enforces arbitrary/only_db', { skip }, async () => {
  const host = process.env.PGM_TEST_HOST || '127.0.0.1';
  const port = process.env.PGM_TEST_PORT;
  const user = process.env.PGM_TEST_USER || 'postgres';
  const password = process.env.PGM_TEST_PASSWORD || '';
  const H = { 'Content-Type': 'application/json', 'X-PGM-Request': '1' };

  let s = await startServer({ PGMA_HOST: host, PGMA_PORT: port, PGMA_USER: user, PGMA_PASSWORD: password, PGMA_HIDE_DB: '^template' });
  try {
    const cfg = await (await fetch(s.url + '/api/config')).json();
    assert.strictEqual(cfg.authType, 'config');
    assert.ok(!JSON.stringify(cfg).includes(password || '\u0000'));
    const sess = await fetch(s.url + '/api/session');
    assert.strictEqual(sess.status, 200);
    const dbs = await (await fetch(s.url + '/api/databases')).json();
    assert.ok(!JSON.stringify(dbs).includes('template0'));
    const login = await fetch(s.url + '/api/login', { method: 'POST', headers: H, body: '{}' });
    assert.strictEqual(login.status, 403);
  } finally { s.p.kill(); }

  s = await startServer({ PGMA_HOST: host, PGMA_PORT: port, PGMA_ONLY_DB: 'postgres' });
  try {
    const login = (body) => fetch(s.url + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ user, password, ...body }) });
    assert.strictEqual((await login({ host: 'evil.example', port: 1, database: 'postgres' })).status, 200, 'host ignored when not arbitrary');
    assert.strictEqual((await login({ database: 'other' })).status, 403);
    assert.strictEqual((await login({ server: '0', database: 'postgres' })).status, 200);
  } finally { s.p.kill(); }
});
