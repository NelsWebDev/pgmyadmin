// Configuration from environment variables, optionally loaded from a .env file.
// Variables are named after phpMyAdmin's Docker image (PMA_HOST, PMA_USER, ...) with a PGMA_ prefix.
// Real environment variables always win over values in the file.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Minimal dotenv syntax: KEY=value, optional `export`, # comments, single/double quotes, \n in double quotes.
function parseEnv(text) {
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (v[0] === '"' && v.lastIndexOf('"') > 0) {
      v = v.slice(1, v.lastIndexOf('"')).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\(["\\])/g, '$1');
    } else if (v[0] === "'" && v.lastIndexOf("'") > 0) {
      v = v.slice(1, v.lastIndexOf("'"));
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

// Returns env merged with the .env file (PGMA_ENV_FILE selects another file; empty disables loading).
function loadEnv(env = process.env) {
  let file;
  if (env.PGMA_ENV_FILE !== undefined) {
    if (env.PGMA_ENV_FILE === '') return { env: { ...env }, file: null };
    file = path.resolve(env.PGMA_ENV_FILE);
    if (!fs.existsSync(file)) throw new Error(`PGMA_ENV_FILE not found: ${file}`);
  } else {
    file = [path.join(ROOT, '.env'), path.join(process.cwd(), '.env')].find((f) => fs.existsSync(f));
  }
  if (!file) return { env: { ...env }, file: null };
  return { env: { ...parseEnv(fs.readFileSync(file, 'utf8')), ...env }, file };
}

const bool = (v, def) => {
  if (v === undefined || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`Invalid boolean "${v}"`);
};

function int(env, name, def, { min = 0, max = Infinity } = {}) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max === Infinity ? '∞' : max}`);
  return n;
}

// "64M", "512k", "1G" or plain bytes.
function size(env, name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const m = /^(\d+)\s*([kmg]?)b?$/i.exec(String(v).trim());
  if (!m) throw new Error(`${name} must look like 64M, 512K, 1G or a byte count`);
  return Number(m[1]) * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
}

const list = (v) => (v === undefined || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const globToRegExp = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*') + '$');

function build(env) {
  const errors = [];
  const guard = (fn) => { try { return fn(); } catch (e) { errors.push(e.message); } };

  const hosts = list(env.PGMA_HOSTS || env.PGMA_HOST);
  const ports = list(env.PGMA_PORTS || env.PGMA_PORT);
  const labels = list(env.PGMA_VERBOSES || env.PGMA_VERBOSE);
  const servers = (hosts.length ? hosts : ['localhost']).map((host, i) => {
    const port = parseInt(ports.length === 1 ? ports[0] : ports[i] || '5432', 10);
    if (!(port >= 1 && port <= 65535)) errors.push(`Invalid port for server "${host}"`);
    return { id: String(i), host, port, label: labels[i] || (hosts.length ? `${host}:${port}` : '') };
  });

  const user = env.PGMA_USER || '';
  const password = env.PGMA_PASSWORD || '';
  const authType = (env.PGMA_AUTH_TYPE || (user ? 'config' : 'cookie')).toLowerCase();
  if (!['cookie', 'config'].includes(authType)) errors.push('PGMA_AUTH_TYPE must be "cookie" or "config"');
  if (authType === 'config' && !user) errors.push('PGMA_AUTH_TYPE=config requires PGMA_USER');
  if (authType === 'config' && servers.length > 1) errors.push('Config auth supports a single server; use cookie auth for PGMA_HOSTS');

  const onlyDb = list(env.PGMA_ONLY_DB);
  const onlyRes = onlyDb.map(globToRegExp);
  const hideDb = guard(() => (env.PGMA_HIDE_DB ? new RegExp(env.PGMA_HIDE_DB) : null)) ;

  const config = {
    authType,
    servers,
    arbitrary: guard(() => bool(env.PGMA_ARBITRARY, !hosts.length)),
    user,
    password,
    database: env.PGMA_DATABASE || 'postgres',
    ssl: guard(() => bool(env.PGMA_SSL, false)),
    allowNoPassword: guard(() => bool(env.PGMA_ALLOW_NO_PASSWORD, true)),
    onlyDb,
    hideDb,
    loginValiditySec: guard(() => int(env, 'PGMA_LOGIN_COOKIE_VALIDITY', 1800, { min: 60 })),
    maxRows: guard(() => int(env, 'PGMA_MAX_ROWS', 50, { min: 1, max: 500 })),
    maxSqlRows: guard(() => int(env, 'PGMA_MAX_SQL_ROWS', 1000, { min: 1, max: 100000 })),
    execTimeLimitSec: guard(() => int(env, 'PGMA_EXEC_TIME_LIMIT', 0, { min: 0 })),
    uploadLimit: guard(() => size(env, 'PGMA_UPLOAD_LIMIT', 50 * 1024 * 1024)),
    listenHost: env.PGMA_LISTEN_HOST || env.HOST || '127.0.0.1',
    listenPort: guard(() => int(env, env.PGMA_LISTEN_PORT !== undefined ? 'PGMA_LISTEN_PORT' : 'PORT', 3000, { min: 0, max: 65535 })),
    trustProxy: env.PGMA_TRUST_PROXY === undefined || env.PGMA_TRUST_PROXY === '' ? false : /^\d+$/.test(env.PGMA_TRUST_PROXY) ? Number(env.PGMA_TRUST_PROXY) : bool(env.PGMA_TRUST_PROXY, false),
    cookieSecure: guard(() => bool(env.PGMA_COOKIE_SECURE, false)),
  };
  config.dbAllowed = (name) => !onlyRes.length || onlyRes.some((re) => re.test(name));
  config.dbVisible = (name) => config.dbAllowed(name) && !(hideDb && hideDb.test(name));
  if (errors.length) throw new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
  return config;
}

let loaded, config;
try {
  loaded = loadEnv();
  config = build(loaded.env);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
config.envFile = loaded.file;

module.exports = config;
module.exports.build = build;
module.exports.parseEnv = parseEnv;
module.exports.loadEnv = loadEnv;
