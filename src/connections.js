const crypto = require('crypto');
const { Pool, Client } = require('pg');
const config = require('./config');

// Used for user-data queries so values are shown and round-tripped losslessly as text.
const rawTypes = { getTypeParser: () => (v) => v };

const IDLE_MS = config.loginValiditySec * 1000;
const connections = new Map(); // token -> { cfg, pools, lastUsed, version }

function makePool(cfg, database) {
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    database,
    max: 5,
    idleTimeoutMillis: 30000,
    ...(config.execTimeLimitSec ? { statement_timeout: config.execTimeLimitSec * 1000 } : {}),
  });
  pool.on('error', () => {});
  return pool;
}

async function login(cfg, { pinned = false } = {}) {
  const pool = makePool(cfg, cfg.database);
  try {
    const { rows } = await pool.query('SELECT version() AS version, current_database() AS db');
    const token = crypto.randomBytes(32).toString('hex');
    connections.set(token, {
      cfg: { ...cfg, database: rows[0].db },
      pools: new Map([[rows[0].db, pool]]),
      lastUsed: Date.now(),
      version: rows[0].version,
      pinned,
    });
    return { token, version: rows[0].version, database: rows[0].db };
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

// Config auth: one shared, never-expiring session for every browser.
let shared = null;
async function sharedSession(cfg) {
  if (!shared) shared = login(cfg, { pinned: true }).catch((err) => { shared = null; throw err; });
  const { token } = await shared;
  return connections.get(token);
}

function get(token) {
  const entry = token && connections.get(token);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry;
}

function poolFor(entry, database) {
  let pool = entry.pools.get(database);
  if (!pool) {
    pool = makePool(entry.cfg, database);
    entry.pools.set(database, pool);
  }
  return pool;
}

async function closePool(entry, database) {
  const pool = entry.pools.get(database);
  if (pool && database !== entry.cfg.database) {
    entry.pools.delete(database);
    await pool.end().catch(() => {});
  }
}

async function logout(token) {
  const entry = connections.get(token);
  connections.delete(token);
  if (entry) await Promise.all([...entry.pools.values()].map((p) => p.end().catch(() => {})));
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of connections) if (!entry.pinned && now - entry.lastUsed > IDLE_MS) logout(token);
}, 60 * 1000).unref();

const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const quoteLiteral = (s) => Client.prototype.escapeLiteral.call(null, String(s));
const qualified = (schema, name) => `${quoteIdent(schema)}.${quoteIdent(name)}`;

module.exports = { rawTypes, login, sharedSession, get, logout, poolFor, closePool, quoteIdent, quoteLiteral, qualified };
