# pgMyAdmin

A phpMyAdmin-style web admin tool for **PostgreSQL**, written in Node.js with Express. It is an independent implementation (no phpMyAdmin code), with a dependency-free vanilla JS frontend.

## Run

```bash
npm install
npm start            # http://127.0.0.1:3000
```

By default you log in with your PostgreSQL host, port, user, password and database; credentials live only in server memory for the session (30 min idle timeout) and the browser holds an opaque HttpOnly cookie.

## Configuration (`.env`)

Copy [.env.example](.env.example) to `.env` (next to `server.js`). Variable names follow phpMyAdmin's Docker image (`PMA_HOST`, `PMA_USER`, `PMA_ARBITRARY`, …) with a `PGMA_` prefix. Real environment variables override the file; `PGMA_ENV_FILE=/path/x.env` uses another file (empty disables loading). Invalid values stop startup with a clear message.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PGMA_HOST` / `PGMA_HOSTS` | `localhost` | Server host(s), comma-separated (shown as a dropdown on the login page) |
| `PGMA_PORT` / `PGMA_PORTS` | `5432` | Port(s); one value applies to all hosts |
| `PGMA_VERBOSE` / `PGMA_VERBOSES` | | Display names for the servers |
| `PGMA_ARBITRARY` | `true` if no host set, else `false` | Allow typing any host on the login page |
| `PGMA_AUTH_TYPE` | `cookie`, or `config` if `PGMA_USER` is set | `cookie` = login form; `config` = always connect as `PGMA_USER` with no login screen |
| `PGMA_USER` / `PGMA_PASSWORD` | | Credentials for `config` auth (or the prefilled username for `cookie`) |
| `PGMA_DATABASE` | `postgres` | Default / initial database |
| `PGMA_SSL` | `false` | Default SSL setting |
| `PGMA_ALLOW_NO_PASSWORD` | `true` | Allow logins with an empty password |
| `PGMA_ONLY_DB` | | Only these databases are accessible (comma list, `*`/`%` wildcards); enforced by the API |
| `PGMA_HIDE_DB` | | Regex of databases to hide from the list (cosmetic) |
| `PGMA_LOGIN_COOKIE_VALIDITY` | `1800` | Idle session timeout (seconds) |
| `PGMA_MAX_ROWS` | `50` | Default rows per page in Browse |
| `PGMA_MAX_SQL_ROWS` | `1000` | Row cap for SQL console results |
| `PGMA_EXEC_TIME_LIMIT` | `0` | `statement_timeout` in seconds (0 = none) |
| `PGMA_UPLOAD_LIMIT` | `50M` | Max request/import size (`k`, `M`, `G` suffixes) |
| `PGMA_LISTEN_HOST` / `PGMA_LISTEN_PORT` | `127.0.0.1` / `3000` | Bind address (`HOST` / `PORT` still work) |
| `PGMA_TRUST_PROXY` | `false` | Express `trust proxy` (`true`, hop count, …) when behind a reverse proxy |
| `PGMA_COOKIE_SECURE` | `false` | Force the `Secure` flag on the session cookie |

> **`config` auth gives everyone who can reach the server full access as that role** (like phpMyAdmin's config auth). Only use it on a trusted network or behind your own authentication. `.env` is git-ignored; keep its permissions tight.

> Serve it behind HTTPS if you expose it beyond localhost; only bind to `0.0.0.0` deliberately.

## Features

- **Server**: databases (create / rename / drop), status and per-database stats, settings (`pg_settings`), running processes (cancel / terminate), roles (create / drop)
- **Database**: schemas, relation list with size/owner, create table, bulk drop / truncate, SQL console (multi-statement, history, load `.sql` file), export
- **Table**: browse with search, sorting and pagination; insert / edit / delete rows (by primary key, falling back to `ctid`); structure (columns, indexes, constraints, primary key; add / change / drop); rename, move schema, comment, copy, vacuum / analyze / reindex, truncate, drop
- **Export**: SQL (structure + data, optional `DROP IF EXISTS`), CSV, JSON; streamed through a server-side cursor
- Views and materialized views are browsable (read-only)
- **Import**: SQL scripts (database-level) and CSV (per table; header mapping, delimiter, empty = NULL; single transaction)
- **Search**: whole-database search (contains / exact / regex) with per-table match counts; per-table query-by-example with operators (`=`, `LIKE`, `~`, `IN`, `BETWEEN`, `IS NULL`, …)
- **Designer**: draggable ER diagram built from foreign keys, downloadable as SVG
- **Routines & more**: functions/procedures (view, edit, drop), triggers (enable/disable/drop), sequences (set value/drop), extensions (install/drop)
- **Privileges**: table grants per role, grant/revoke; role editing (flags, password, connection limit, expiry)
- **SQL editor**: CodeMirror 6 with PostgreSQL syntax highlighting, schema-aware autocomplete (schemas, tables, views, columns with types, aliases) and live error checking — unknown tables/columns/functions and syntax errors in SELECT/INSERT/UPDATE/DELETE statements are underlined, using `PREPARE` inside a rolled-back read-only transaction (nothing is executed)
- **SQL console extras**: EXPLAIN / EXPLAIN ANALYZE, CSV download of results, bookmarks (stored in the browser)
- **Browse extras**: foreign-key links, row copy, table statistics, bulk Analyze/Vacuum/Reindex, dark theme toggle

## Editor bundle

The editor lives in `client/editor.js` and is bundled into `public/editor.js` (committed). Rebuild after changing it with `npm install && npm run build:editor`.

## Tests

Integration tests need a PostgreSQL server (a throwaway database is created and dropped):

```bash
PGM_TEST_HOST=localhost PGM_TEST_PORT=5432 PGM_TEST_USER=postgres PGM_TEST_PASSWORD=... npm test
```

## Security notes

Identifiers are always quoted, row values are bound parameters, state-changing API calls require an `X-PGM-Request` header, and the cookie is `SameSite=Strict`. The SQL console and DDL endpoints intentionally execute whatever the logged-in PostgreSQL role is permitted to do.
