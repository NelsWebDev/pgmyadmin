'use strict';

// ---------- helpers ----------

const $app = document.getElementById('app');
const state = { config: { authType: 'cookie', servers: [], arbitrary: true, defaults: {}, maxRows: 50 }, me: null, dbs: [], trees: {}, schema: {}, flash: null, browse: {}, history: JSON.parse(localStorage.getItem('pgm_history') || '[]') };
let navToken = 0;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

const enc = encodeURIComponent;
const fmtBytes = (n) => {
  if (n == null) return '';
  n = Number(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
};
const fmtNum = (n) => (n == null ? '' : Number(n).toLocaleString());
const KIND = { r: 'Table', p: 'Partitioned', v: 'View', m: 'Mat. view', f: 'Foreign' };

class AuthError extends Error {}

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-PGM-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (res.status === 401 && data && data.code === 'auth') {
    const wasLoggedIn = !!state.me;
    state.me = null;
    if (wasLoggedIn) renderLogin('Session expired. Please log in again.');
    throw new AuthError('Session expired');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.data = data;
    throw err;
  }
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b || {});
const PUT = (u, b) => api('PUT', u, b || {});
const DEL = (u, b) => api('DELETE', u, b);

const alertBox = (kind, text) => h('div', { class: 'alert ' + kind }, text);
function flash(kind, text) { state.flash = { kind, text }; }
function showError(container, err) {
  if (err instanceof AuthError) return;
  const parts = [err.message];
  if (err.data && err.data.detail) parts.push(err.data.detail);
  if (err.data && err.data.hint) parts.push('Hint: ' + err.data.hint);
  container.prepend(alertBox('error', parts.join('\n')));
  container.scrollIntoView({ block: 'start' });
}

// Run an action, showing errors in `container`.
async function attempt(container, fn) {
  try { return await fn(); } catch (err) { showError(container, err); }
}

function modal(title, ...content) {
  const bg = h('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.append(h('div', { class: 'modal' }, h('h3', {}, title), ...content));
  document.body.append(bg);
  return close;
}

const go = (hash) => { location.hash = hash; };
const dbLink = (db, tab = '') => `#/db/${enc(db)}${tab ? '/' + tab : ''}`;
const tableLink = (db, s, t, tab = 'browse') => `#/table/${enc(db)}/${enc(s)}/${enc(t)}/${tab}`;

function tabs(items, active) {
  return h('div', { class: 'tabs' }, items.map(([key, label, href]) => h('a', { href, class: key === active ? 'active' : '' }, label)));
}

function simpleTable(headers, rows, opts = {}) {
  return h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => (c instanceof Node && c.tagName === 'TD' ? c : h('td', opts.cellClass ? { class: opts.cellClass } : {}, c))))))));
}
const cellText = (v) => (v == null ? h('span', { class: 'null' }, 'NULL') : String(v));
const yesNo = (b) => h('span', { class: 'badge' + (b ? ' yes' : '') }, b ? 'yes' : 'no');

// ---------- login ----------

function renderLogin(error) {
  const cfg = state.config;
  const d = cfg.defaults || {};
  const f = {};
  const field = (key, label, attrs) => h('div', { class: 'f' }, h('label', {}, label), (f[key] = h('input', attrs)));
  const lbl = (t) => h('label', { style: 'font-weight:600;display:block;margin-bottom:3px' }, t);
  const errBox = h('div', {});
  if (error) errBox.append(alertBox('error', error));
  const servers = cfg.servers;
  const hostRow = h('div', { class: 'pair f' },
    h('div', {}, lbl('Host'), (f.host = h('input', { type: 'text', value: localStorage.pgm_host || (servers[0] && servers[0].host) || 'localhost' }))),
    h('div', {}, lbl('Port'), (f.port = h('input', { type: 'number', value: localStorage.pgm_port || (servers[0] && servers[0].port) || '5432' }))));
  let serverRow = '';
  if (servers.length > 1 || (servers.length === 1 && servers[0].label && cfg.arbitrary)) {
    f.server = h('select', {}, [...servers.map((s) => h('option', { value: s.id }, s.label)), ...(cfg.arbitrary ? [h('option', { value: 'custom' }, 'Other…')] : [])]);
    const sync = () => (hostRow.style.display = f.server.value === 'custom' ? '' : 'none');
    f.server.addEventListener('change', sync);
    sync();
    serverRow = h('div', { class: 'f' }, lbl('Server'), f.server);
  } else if (!cfg.arbitrary) hostRow.style.display = 'none';
  const form = h('form', { class: 'login' },
    h('h1', {}, 'pgMyAdmin'),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'PostgreSQL administration'),
    errBox,
    serverRow,
    hostRow,
    field('user', 'Username', { type: 'text', value: localStorage.pgm_user || d.user || 'postgres', autocomplete: 'username' }),
    field('password', 'Password', { type: 'password', autocomplete: 'current-password' }),
    field('database', 'Database', { type: 'text', value: localStorage.pgm_db || d.database || 'postgres' }),
    h('div', { class: 'f' }, h('label', { style: 'font-weight:400' }, (f.ssl = h('input', { type: 'checkbox', checked: !!d.ssl })), ' Use SSL')),
    h('button', { class: 'primary', style: 'width:100%' }, 'Log in'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { host: f.host.value, port: f.port.value, user: f.user.value, password: f.password.value, database: f.database.value, ssl: f.ssl.checked };
    if (f.server) body.server = f.server.value;
    try {
      state.me = await POST('/login', body);
      Object.assign(localStorage, { pgm_host: body.host, pgm_port: body.port, pgm_user: body.user, pgm_db: body.database });
      location.hash = '#/';
      render();
    } catch (err) {
      errBox.replaceChildren(alertBox('error', err.message));
    }
  });
  $app.replaceChildren(h('div', { class: 'login-wrap' }, form));
}

// ---------- layout / sidebar ----------

async function loadTree(db, force) {
  if (force || !state.trees[db]) state.trees[db] = await GET(`/db/${enc(db)}/tree`);
  return state.trees[db];
}

async function buildSidebar(route) {
  const side = h('div', { id: 'sidebar' });
  side.append(h('a', { class: 'side-item' + (route.page === 'home' ? ' active' : ''), href: '#/' }, 'Server'));
  side.append(h('div', { class: 'side-head' }, 'Databases'));
  try {
    state.dbs = await GET('/databases');
  } catch (err) { /* sidebar is best-effort */ }
  const current = route.db;
  for (const d of state.dbs) {
    side.append(h('a', { class: 'side-item' + (d.name === current && route.page === 'db' ? ' active' : ''), href: dbLink(d.name), title: d.name }, d.name));
    if (d.name !== current) continue;
    try {
      const tree = await loadTree(current);
      const multi = tree.schemas.length > 1 || (tree.schemas.length === 1 && tree.schemas[0] !== 'public');
      for (const s of tree.schemas) {
        if (multi) side.append(h('div', { class: 'side-item indent muted' }, s));
        for (const t of tree.tables.filter((x) => x.schema === s)) {
          const active = route.page === 'table' && route.schema === s && route.table === t.name;
          side.append(h('a', { class: 'side-item ' + (multi ? 'indent2' : 'indent') + (active ? ' active' : ''), href: tableLink(current, s, t.name), title: `${s}.${t.name}` },
            h('span', { class: 'kind' }, t.kind === 'v' || t.kind === 'm' ? 'V' : '▦'), t.name));
        }
      }
    } catch (err) {
      if (err instanceof AuthError) return side;
      side.append(h('div', { class: 'side-item indent2 muted' }, 'Cannot read database'));
    }
  }
  return side;
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'server') return { page: 'server', tab: parts[1] || 'status' };
  if (parts[0] === 'db' && parts[1]) return { page: 'db', db: parts[1], tab: parts[2] || 'structure' };
  if (parts[0] === 'table' && parts[3]) return { page: 'table', db: parts[1], schema: parts[2], table: parts[3], tab: parts[4] || 'browse' };
  return { page: 'home' };
}

async function render() {
  if (!state.me) {
    try { state.me = await GET('/session'); } catch (e) {
      if (state.config.authType === 'config') {
        return $app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' }, h('h1', {}, 'pgMyAdmin'),
          alertBox('error', e.message), h('button', { class: 'primary', onclick: () => render() }, 'Retry'))));
      }
      return renderLogin();
    }
  }
  const token = ++navToken;
  const route = parseRoute();
  const main = h('div', { id: 'main' });
  const topbar = h('div', { id: 'topbar' },
    h('span', { class: 'brand' }, 'pgMyAdmin'),
    h('span', {}, `${state.me.user}@${state.me.host}:${state.me.port}`),
    h('span', { class: 'spacer' }),
    h('a', { href: '#/server/status' }, 'Status'),
    h('a', { href: '#/server/users' }, 'Users'),
    h('button', { title: 'Toggle dark theme', onclick: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') }, '◐'),
    state.config.authType === 'config' ? '' : h('button', { onclick: async () => { await POST('/logout'); state.me = null; state.trees = {}; renderLogin(); } }, 'Log out'));
  const layout = h('div', { id: 'layout' }, topbar, h('div', { id: 'sidebar' }), main);
  $app.replaceChildren(layout);
  buildSidebar(route).then((side) => {
    if (token === navToken) layout.replaceChild(side, layout.querySelector('#sidebar'));
  });
  if (state.flash) { main.append(alertBox(state.flash.kind, state.flash.text)); state.flash = null; }
  const body = h('div', {});
  main.append(body);
  try {
    if (route.page === 'home') await viewHome(body);
    else if (route.page === 'server') await viewServer(body, route);
    else if (route.page === 'db') await viewDb(body, route);
    else await viewTable(body, route);
  } catch (err) {
    showError(body, err);
  }
}

async function refresh(db) {
  if (db) delete state.trees[db];
  await render();
}

// ---------- home / databases ----------

async function viewHome(main) {
  const dbs = await GET('/databases');
  state.dbs = dbs;
  main.append(h('h2', {}, 'Databases'));
  const name = h('input', { type: 'text', placeholder: 'New database name' });
  const owner = h('input', { type: 'text', placeholder: 'Owner (optional)' });
  const encoding = h('input', { type: 'text', placeholder: 'Encoding (e.g. UTF8)' });
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Create database'), h('div', { class: 'row' }, name, owner, encoding,
    h('button', { class: 'primary', onclick: () => attempt(main, async () => {
      await POST('/databases', { name: name.value, owner: owner.value, encoding: encoding.value });
      flash('ok', `Database "${name.value}" created.`);
      render();
    }) }, 'Create'))));
  main.append(simpleTable(['Database', 'Owner', 'Encoding', 'Collation', 'Size', ''], dbs.map((d) => [
    h('a', { href: dbLink(d.name) }, d.name), d.owner, d.encoding, d.collation, fmtBytes(d.size),
    h('td', {}, h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
      if (!confirm(`Drop database "${d.name}"? This cannot be undone.`)) return;
      await DEL(`/databases/${enc(d.name)}`);
      flash('ok', `Database "${d.name}" dropped.`);
      render();
    }) }, 'Drop')),
  ])));
  main.append(h('p', { class: 'muted' }, state.me.version));
}

// ---------- server ----------

async function viewServer(main, route) {
  main.append(h('h2', {}, 'Server'));
  main.append(tabs([['status', 'Status', '#/server/status'], ['variables', 'Variables', '#/server/variables'], ['processes', 'Processes', '#/server/processes'], ['users', 'Users', '#/server/users']], route.tab));
  if (route.tab === 'status') {
    const s = await GET('/server/status');
    main.append(h('div', { class: 'card' },
      h('div', {}, h('b', {}, 'Version: '), s.version),
      h('div', {}, h('b', {}, 'Started: '), new Date(s.started).toLocaleString()),
      h('div', {}, h('b', {}, 'Uptime: '), `${s.uptime.days ? s.uptime.days + 'd ' : ''}${s.uptime.hours || 0}h ${s.uptime.minutes || 0}m`),
      h('div', {}, h('b', {}, 'Connections: '), `${s.connections.total} total, ${s.connections.active} active`)));
    main.append(simpleTable(['Database', 'Backends', 'Commits', 'Rollbacks', 'Blocks read', 'Blocks hit', 'Returned', 'Inserted', 'Updated', 'Deleted', 'Deadlocks'],
      s.databases.map((d) => [d.name, d.numbackends, d.xact_commit, d.xact_rollback, d.blks_read, d.blks_hit, d.tup_returned, d.tup_inserted, d.tup_updated, d.tup_deleted, d.deadlocks].map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? fmtNum(x) : x)))));
  } else if (route.tab === 'variables') {
    const vars = await GET('/server/variables');
    const holder = h('div', {});
    const filter = h('input', { type: 'search', placeholder: 'Filter settings…', oninput: draw });
    function draw() {
      const f = filter.value.toLowerCase();
      const rows = vars.filter((v) => !f || v.name.toLowerCase().includes(f) || (v.description || '').toLowerCase().includes(f));
      holder.replaceChildren(simpleTable(['Name', 'Value', 'Unit', 'Category', 'Description'], rows.map((v) => [v.name, v.setting, v.unit, v.category, v.description])));
    }
    main.append(h('div', { class: 'row' }, filter), holder);
    draw();
  } else if (route.tab === 'processes') {
    const rows = await GET('/server/processes');
    main.append(simpleTable(['PID', 'DB', 'User', 'App', 'Client', 'State', 'Started', 'Query', ''], rows.map((p) => [
      p.pid, p.datname, p.usename, p.application_name, p.client, p.state, p.query_start && new Date(p.query_start).toLocaleTimeString(), h('code', {}, p.query),
      h('td', {}, h('button', { class: 'link', onclick: () => attempt(main, async () => { await DEL(`/server/processes/${p.pid}?cancel=1`); render(); }) }, 'Cancel'),
        h('button', { class: 'link danger', onclick: () => attempt(main, async () => { await DEL(`/server/processes/${p.pid}`); render(); }) }, 'Kill')),
    ])));
  } else {
    const roles = await GET('/server/roles');
    const name = h('input', { type: 'text', placeholder: 'Role name' });
    const pw = h('input', { type: 'password', placeholder: 'Password' });
    const cb = (label, checked) => { const i = h('input', { type: 'checkbox', checked }); return [i, h('label', {}, i, ' ' + label)]; };
    const [login, loginL] = cb('Can login', true), [sup, supL] = cb('Superuser'), [cdb, cdbL] = cb('Create DB'), [crole, croleL] = cb('Create role');
    main.append(h('div', { class: 'card' }, h('h3', {}, 'Create role'), h('div', { class: 'row' }, name, pw, loginL, supL, cdbL, croleL,
      h('button', { class: 'primary', onclick: () => attempt(main, async () => {
        await POST('/server/roles', { name: name.value, password: pw.value, login: login.checked, superuser: sup.checked, createdb: cdb.checked, createrole: crole.checked });
        flash('ok', `Role "${name.value}" created.`);
        render();
      }) }, 'Create'))));
    main.append(simpleTable(['Role', 'Login', 'Superuser', 'Create DB', 'Create role', 'Replication', 'Conn. limit', 'Member of', ''], roles.map((r) => [
      r.name, yesNo(r.login), yesNo(r.superuser), yesNo(r.createdb), yesNo(r.createrole), yesNo(r.replication), r.connlimit, (r.member_of || []).join(', '),
      h('td', {}, h('button', { class: 'link', onclick: () => editRole(r) }, 'Edit'), h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
        if (!confirm(`Drop role "${r.name}"?`)) return;
        await DEL(`/server/roles/${enc(r.name)}`);
        render();
      }) }, 'Drop')),
    ])));
  }
}

// ---------- database view ----------

function dbHeader(main, db, tab) {
  main.append(h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Server'), ' › ', db));
  main.append(tabs([['structure', 'Structure', dbLink(db)], ['sql', 'SQL', dbLink(db, 'sql')], ['search', 'Search', dbLink(db, 'search')], ['designer', 'Designer', dbLink(db, 'designer')], ['objects', 'Routines & more', dbLink(db, 'objects')], ['privileges', 'Privileges', dbLink(db, 'privileges')], ['import', 'Import', dbLink(db, 'import')], ['export', 'Export', dbLink(db, 'export')], ['operations', 'Operations', dbLink(db, 'operations')]], tab));
}

async function viewDb(main, route) {
  const db = route.db;
  dbHeader(main, db, route.tab);
  const tree = await loadTree(db, true);
  if (route.tab === 'sql') { const pre = state.prefill || ''; state.prefill = ''; return sqlView(main, db, pre); }
  if (route.tab === 'export') return exportView(main, db, tree.tables.map((t) => `${t.schema}.${t.name}`), true);
  if (route.tab === 'search') return dbSearchView(main, db, tree);
  if (route.tab === 'designer') return designerView(main, db);
  if (route.tab === 'objects') return objectsView(main, db);
  if (route.tab === 'privileges') return privilegesView(main, db);
  if (route.tab === 'import') return importView(main, db);
  if (route.tab === 'operations') return dbOperations(main, db, tree);

  if (!tree.schemas.length) tree.schemas.push('public');
  let schema = state.schema[db];
  if (!tree.schemas.includes(schema)) schema = tree.schemas.includes('public') ? 'public' : tree.schemas[0];
  state.schema[db] = schema;
  const picker = h('select', { onchange: () => { state.schema[db] = picker.value; render(); } }, tree.schemas.map((s) => h('option', { value: s, selected: s === schema }, s)));
  main.append(h('div', { class: 'row' }, h('b', {}, 'Schema:'), picker));
  const tables = await GET(`/db/${enc(db)}/tables?schema=${enc(schema)}`);
  if (!tables.length) main.append(h('p', { class: 'muted' }, 'No tables in this schema.'));
  else {
    const boxes = [];
    main.append(simpleTable(['', 'Name', 'Type', 'Rows (est.)', 'Size', 'Owner', 'Comment', ''], tables.map((t) => {
      const cb = h('input', { type: 'checkbox' });
      boxes.push([cb, t]);
      return [h('td', {}, cb), h('a', { href: tableLink(db, schema, t.name) }, t.name), KIND[t.kind], t.kind === 'r' || t.kind === 'p' ? fmtNum(Math.max(0, t.estimated_rows)) : '', fmtBytes(t.size), t.owner, t.comment,
        h('td', {}, h('a', { href: tableLink(db, schema, t.name, 'structure') }, 'Structure'), ' · ', h('a', { href: tableLink(db, schema, t.name, 'insert') }, 'Insert'))];
    })));
    const selected = () => boxes.filter(([c]) => c.checked).map(([, t]) => t);
    main.append(h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { onclick: () => boxes.forEach(([c]) => (c.checked = true)) }, 'Select all'),
      h('button', { class: 'danger', onclick: () => attempt(main, async () => {
        const sel = selected();
        if (!sel.length) return;
        if (!confirm(`Drop ${sel.length} object(s): ${sel.map((t) => t.name).join(', ')}?`)) return;
        for (const t of sel) await DEL(`/db/${enc(db)}/t/${enc(schema)}/${enc(t.name)}`);
        flash('ok', `Dropped ${sel.length} object(s).`);
        refresh(db);
      }) }, 'Drop selected'),
      ...[['analyze', 'Analyze'], ['vacuum', 'Vacuum'], ['reindex', 'Reindex']].map(([op, label]) => h('button', { onclick: () => attempt(main, async () => {
        const sel = selected().filter((t) => t.kind === 'r' || t.kind === 'p');
        if (!sel.length) return;
        for (const t of sel) await POST(`/db/${enc(db)}/t/${enc(schema)}/${enc(t.name)}/maintenance`, { op });
        main.prepend(alertBox('ok', `${label} completed on ${sel.length} table(s).`));
      }) }, label + ' selected')),
      h('button', { onclick: () => attempt(main, async () => {
        const sel = selected();
        if (!sel.length) return;
        if (!confirm(`Truncate ${sel.length} table(s)? All rows will be deleted.`)) return;
        for (const t of sel) await POST(`/db/${enc(db)}/t/${enc(schema)}/${enc(t.name)}/truncate`);
        flash('ok', `Truncated ${sel.length} table(s).`);
        refresh(db);
      }) }, 'Truncate selected')));
  }
  main.append(createTableForm(db, schema, main));
}

function createTableForm(db, schema, main) {
  const name = h('input', { type: 'text', placeholder: 'Table name' });
  const body = h('tbody', {});
  const addRow = (init = {}) => {
    const r = {
      name: h('input', { type: 'text', value: init.name || '', placeholder: 'column' }),
      type: h('input', { type: 'text', value: init.type || 'text', list: 'pg-types', size: 16 }),
      def: h('input', { type: 'text', value: init.def || '', placeholder: 'default expression' }),
      nn: h('input', { type: 'checkbox', checked: !!init.nn }),
      pk: h('input', { type: 'checkbox', checked: !!init.pk }),
    };
    const tr = h('tr', {}, h('td', {}, r.name), h('td', {}, r.type), h('td', {}, r.def), h('td', {}, r.nn), h('td', {}, r.pk),
      h('td', {}, h('button', { class: 'link danger', onclick: () => { tr.remove(); rows.splice(rows.indexOf(r), 1); } }, 'remove')));
    rows.push(r);
    body.append(tr);
  };
  const rows = [];
  addRow({ name: 'id', type: 'serial', pk: true, nn: true });
  return h('div', { class: 'card' }, h('h3', {}, `Create table in schema "${schema}"`),
    typeDatalist(),
    h('div', { class: 'row' }, name),
    h('div', { class: 'scroll' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Column', 'Type', 'Default', 'Not null', 'PK', ''].map((x) => h('th', {}, x)))), body)),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { onclick: () => addRow() }, 'Add column'),
      h('button', { class: 'primary', onclick: () => attempt(main, async () => {
        await POST(`/db/${enc(db)}/tables`, { schema, name: name.value, columns: rows.map((r) => ({ name: r.name.value, type: r.type.value, default: r.def.value, notnull: r.nn.checked, pk: r.pk.checked })) });
        flash('ok', `Table "${name.value}" created.`);
        refresh(db);
      }) }, 'Create table')));
}

function typeDatalist() {
  if (document.getElementById('pg-types')) return '';
  const types = ['integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric', 'real', 'double precision', 'boolean', 'text', 'varchar(255)', 'char(1)', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'bytea', 'inet', 'cidr', 'money', 'text[]', 'integer[]'];
  return h('datalist', { id: 'pg-types' }, types.map((t) => h('option', { value: t })));
}

async function dbOperations(main, db, tree) {
  const newSchema = h('input', { type: 'text', placeholder: 'Schema name' });
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Schemas'),
    simpleTable(['Schema', ''], tree.schemas.map((s) => [s, h('td', {}, h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
      if (!confirm(`Drop schema "${s}"?`)) return;
      const cascade = confirm('Also drop all objects in the schema (CASCADE)?');
      await DEL(`/db/${enc(db)}/schemas/${enc(s)}?cascade=${cascade ? 1 : 0}`);
      flash('ok', `Schema "${s}" dropped.`);
      refresh(db);
    }) }, 'Drop'))])),
    h('div', { class: 'row', style: 'margin-top:10px' }, newSchema, h('button', { class: 'primary', onclick: () => attempt(main, async () => {
      await POST(`/db/${enc(db)}/schemas`, { name: newSchema.value });
      flash('ok', `Schema "${newSchema.value}" created.`);
      refresh(db);
    }) }, 'Create schema'))));
  const rn = h('input', { type: 'text', value: db });
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Database'),
    h('div', { class: 'row' }, rn, h('button', { onclick: () => attempt(main, async () => {
      await POST(`/databases/${enc(db)}/rename`, { name: rn.value });
      flash('ok', 'Database renamed.');
      state.trees = {};
      go(dbLink(rn.value, 'operations'));
    }) }, 'Rename')),
    h('button', { class: 'danger', onclick: () => attempt(main, async () => {
      if (!confirm(`Drop database "${db}"? This cannot be undone.`)) return;
      await DEL(`/databases/${enc(db)}`);
      flash('ok', `Database "${db}" dropped.`);
      state.trees = {};
      go('#/');
    }) }, 'Drop database')));
}

// ---------- SQL console ----------

async function sqlEditor(db, doc, onRun) {
  const holder = h('div', { class: 'sql-editor' });
  const meta = await GET(`/db/${enc(db)}/completion`).catch(() => ({ schemas: [], tables: [] }));
  const ed = window.PGMEditor.createSqlEditor({
    parent: holder, doc, meta, onRun,
    placeholderText: 'Enter SQL. Ctrl/Cmd+Enter to run. Ctrl+Space for suggestions.',
    check: async (sql) => (await POST(`/db/${enc(db)}/lint`, { sql })).diagnostics,
  });
  return { holder, ed };
}

async function sqlView(main, db, initial) {
  let run;
  const { holder, ed: ta } = await sqlEditor(db, initial, () => run());
  const out = h('div', {});
  const histBox = h('div', { class: 'history card', style: 'padding:6px' });
  const drawHistory = () => histBox.replaceChildren(...(state.history.length ? state.history.map((q) => h('div', { title: q, onclick: () => { ta.value = q; ta.focus(); } }, q.replace(/\s+/g, ' '))) : [h('span', { class: 'muted' }, 'No history yet')]));
  let last = null;
  const bookmarks = () => JSON.parse(localStorage.getItem('pgm_bookmarks') || '{}');
  const bmBox = h('div', { class: 'card', style: 'padding:6px' });
  const drawBookmarks = () => {
    const bm = bookmarks();
    bmBox.replaceChildren(...(Object.keys(bm).length ? Object.entries(bm).map(([label, q]) => h('div', { class: 'row', style: 'margin:2px 0' },
      h('a', { href: 'javascript:void 0', title: q, onclick: () => { ta.value = q; ta.focus(); } }, label),
      h('button', { class: 'link danger', onclick: () => { const b = bookmarks(); delete b[label]; localStorage.setItem('pgm_bookmarks', JSON.stringify(b)); drawBookmarks(); } }, 'remove'))) : [h('span', { class: 'muted' }, 'No bookmarks yet')]));
  };
  run = async (prefix = '') => {
    const sql = prefix + ta.value;
    if (!ta.value.trim()) return;
    out.replaceChildren(h('p', { class: 'muted' }, 'Running…'));
    state.history = [ta.value, ...state.history.filter((x) => x !== ta.value)].slice(0, 30);
    localStorage.setItem('pgm_history', JSON.stringify(state.history));
    drawHistory();
    try {
      const res = await POST(`/db/${enc(db)}/sql`, { sql });
      out.replaceChildren(h('div', { class: 'alert ok' }, `Done in ${res.ms} ms.`));
      last = null;
      for (const r of res.results) {
        if (r.fields.length) {
          last = r;
          out.append(h('p', { class: 'muted' }, `${r.command}: ${fmtNum(r.rowCount)} row(s)${r.truncated ? ` (showing first ${fmtNum(r.rows.length)})` : ''}`),
            h('div', { class: 'scroll' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, r.fields.map((f) => h('th', {}, f)))),
              h('tbody', {}, r.rows.map((row) => h('tr', {}, row.map((v) => h('td', { class: 'cell', title: v == null ? '' : v }, cellText(v)))))))));
        } else out.append(h('p', {}, `${r.command}${r.rowCount != null ? ': ' + fmtNum(r.rowCount) + ' row(s) affected' : ''}`));
      }
      if (last) out.append(h('button', { onclick: () => downloadText('result.csv', toCsv([last.fields, ...last.rows]), 'text/csv') }, 'Download result as CSV'));
      if (/\b(create|drop|alter|rename)\b/i.test(sql)) { delete state.trees[db]; buildSidebar(parseRoute()).then((s) => { const old = document.querySelector('#sidebar'); if (old) old.replaceWith(s); }); }
    } catch (err) {
      out.replaceChildren();
      showError(out, err);
    }
  };
  const explain = () => run('EXPLAIN ');
  const explainAnalyze = () => { if (confirm('EXPLAIN ANALYZE actually executes the statement. Continue?')) run('EXPLAIN (ANALYZE, BUFFERS) '); };
  const file = h('input', { type: 'file', accept: '.sql,.txt', style: 'display:none', onchange: async () => { if (file.files[0]) ta.value = await file.files[0].text(); } });
  main.append(h('div', { class: 'sqlbox' }, holder,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: () => run() }, 'Run'), h('button', { onclick: explain }, 'Explain'), h('button', { onclick: explainAnalyze }, 'Explain analyze'), h('button', { onclick: () => (ta.value = '') }, 'Clear'),
      h('button', { onclick: () => { const label = prompt('Bookmark label:'); if (!label || !ta.value.trim()) return; const b = bookmarks(); b[label] = ta.value; localStorage.setItem('pgm_bookmarks', JSON.stringify(b)); drawBookmarks(); } }, 'Bookmark'),
      h('button', { onclick: () => file.click() }, 'Load .sql file…'), file),
    out, h('h3', {}, 'Bookmarks'), bmBox, h('h3', {}, 'History'), histBox));
  drawHistory();
  drawBookmarks();
}

// ---------- export ----------

function exportView(main, db, tableIds, multi) {
  const boxes = tableIds.map((id) => [id, h('input', { type: 'checkbox', checked: true })]);
  const fmt = h('select', {}, ['sql', 'csv', 'json'].map((f) => h('option', { value: f }, f.toUpperCase())));
  const structure = h('input', { type: 'checkbox', checked: true });
  const data = h('input', { type: 'checkbox', checked: true });
  const drop = h('input', { type: 'checkbox' });
  const sqlOpts = h('div', { class: 'row' }, h('label', {}, structure, ' Structure'), h('label', {}, data, ' Data'), h('label', {}, drop, ' Add DROP … IF EXISTS'));
  fmt.addEventListener('change', () => (sqlOpts.style.display = fmt.value === 'sql' ? '' : 'none'));
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Export'),
    multi ? h('div', { class: 'row' }, h('button', { onclick: () => boxes.forEach(([, c]) => (c.checked = true)) }, 'All'), h('button', { onclick: () => boxes.forEach(([, c]) => (c.checked = false)) }, 'None')) : '',
    multi ? h('div', { style: 'columns:2;margin-bottom:10px' }, boxes.map(([id, c]) => h('div', {}, h('label', {}, c, ' ' + id)))) : '',
    h('div', { class: 'row' }, h('b', {}, 'Format:'), fmt), sqlOpts,
    h('button', { class: 'primary', onclick: () => {
      const sel = boxes.filter(([, c]) => c.checked).map(([id]) => id);
      if (!sel.length) return alert('Select at least one table.');
      const q = `tables=${enc(sel.join(','))}&format=${fmt.value}&structure=${structure.checked ? 1 : 0}&data=${data.checked ? 1 : 0}&drop=${drop.checked ? 1 : 0}`;
      const a = h('a', { href: `/api/db/${enc(db)}/export?${q}`, download: '' });
      document.body.append(a);
      a.click();
      a.remove();
    } }, 'Download')));
}

// ---------- table view ----------

async function viewTable(main, route) {
  const { db, schema, table, tab } = route;
  const base = `/db/${enc(db)}/t/${enc(schema)}/${enc(table)}`;
  main.append(h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Server'), ' › ', h('a', { href: dbLink(db) }, db), ' › ', schema === 'public' ? '' : schema + '.', table));
  main.append(tabs([['browse', 'Browse', tableLink(db, schema, table)], ['structure', 'Structure', tableLink(db, schema, table, 'structure')], ['sql', 'SQL', tableLink(db, schema, table, 'sql')], ['search', 'Search', tableLink(db, schema, table, 'search')], ['insert', 'Insert', tableLink(db, schema, table, 'insert')], ['import', 'Import', tableLink(db, schema, table, 'import')], ['export', 'Export', tableLink(db, schema, table, 'export')], ['operations', 'Operations', tableLink(db, schema, table, 'operations')]], tab));
  const ctx = { db, schema, table, base, main, qname: `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"` };
  if (tab === 'browse') return browseView(ctx);
  if (tab === 'structure') return structureView(ctx);
  if (tab === 'sql') return sqlView(main, db, `SELECT * FROM ${ctx.qname} LIMIT 100;`);
  if (tab === 'export') return exportView(main, db, [`${schema}.${table}`], false);
  if (tab === 'search') return tableSearchView(ctx);
  if (tab === 'import') return csvImportView(ctx);
  if (tab === 'insert') {
    const d = await GET(`${base}/data?limit=1`);
    return rowForm(ctx, d.columns, null, d);
  }
  return operationsView(ctx);
}

async function browseView(ctx) {
  const { main, base, db, schema, table } = ctx;
  const key = `${db}.${schema}.${table}`;
  const st = (state.browse[key] ||= { page: 1, limit: state.config.maxRows, sort: '', dir: 'asc', q: '', filters: [] });
  const d = await GET(`${base}/data?page=${st.page}&limit=${st.limit}&sort=${enc(st.sort)}&dir=${st.dir}&q=${enc(st.q)}&filters=${enc(JSON.stringify(st.filters || []))}`);
  const pages = Math.max(1, Math.ceil(d.total / d.limit));
  if (st.page > pages) { st.page = pages; return browseView(ctx); }
  const search = h('input', { type: 'search', placeholder: 'Search rows…', value: st.q });
  const lim = h('select', { onchange: () => { st.limit = +lim.value; st.page = 1; render(); } }, [25, 50, 100, 250, 500].map((n) => h('option', { value: n, selected: n === st.limit }, `${n} rows`)));
  main.append(h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); st.q = search.value; st.page = 1; render(); } }, search, h('button', {}, 'Search'), lim,
    h('span', { class: 'muted' }, `${fmtNum(d.total)} row(s)`)));
  if (st.filters && st.filters.length) {
    main.append(h('div', { class: 'alert info' }, 'Filter: ' + st.filters.map((f) => `${f.col} ${f.op}${f.op.startsWith('IS') ? '' : ' ' + f.value}`).join(' AND '), ' ',
      h('button', { class: 'link', onclick: () => { st.filters = []; st.page = 1; render(); } }, 'Clear filter'),
      h('a', { href: tableLink(db, schema, table, 'search') }, 'Edit')));
  }
  const pager = h('div', { class: 'pager' },
    h('button', { disabled: st.page <= 1, onclick: () => { st.page--; render(); } }, '‹ Prev'),
    h('span', {}, `Page ${st.page} of ${pages}`),
    h('button', { disabled: st.page >= pages, onclick: () => { st.page++; render(); } }, 'Next ›'));
  const keyOf = (row) => (d.keyMode === 'pk' ? Object.fromEntries(d.columns.filter((c) => c.pk).map((c) => [c.name, row[c.name]])) : { __ctid: row.__ctid });
  const checks = [];
  const head = h('tr', {}, d.editable ? h('th', {}) : '', d.editable ? h('th', {}) : '',
    d.columns.map((c) => h('th', { class: 'sortable', title: c.type, onclick: () => { st.dir = st.sort === c.name && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = c.name; st.page = 1; render(); } },
      c.name, st.sort === c.name ? (st.dir === 'asc' ? ' ▲' : ' ▼') : '')));
  const body = h('tbody', {}, d.rows.map((row) => {
    const cb = h('input', { type: 'checkbox' });
    checks.push([cb, row]);
    return h('tr', {},
      d.editable ? h('td', {}, cb) : '',
      d.editable ? h('td', {}, h('button', { class: 'link', onclick: () => { main.replaceChildren(); editRow(ctx, d, row, keyOf(row)); } }, 'Edit'),
        h('button', { class: 'link', onclick: () => { main.replaceChildren(); rowForm(ctx, d.columns, row, d, null, true); } }, 'Copy'),
        h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
          if (!confirm('Delete this row?')) return;
          await DEL(`${base}/rows`, { keys: [keyOf(row)] });
          render();
        }) }, 'Delete')) : '',
      d.columns.map((c) => {
        const fk = d.fks && d.fks[c.name];
        const v = row[c.name];
        const content = fk && v != null
          ? h('a', { href: tableLink(db, fk.ref_schema, fk.ref_table), title: `Go to ${fk.ref_table}.${fk.ref_col}`, onclick: () => {
              state.browse[`${db}.${fk.ref_schema}.${fk.ref_table}`] = { page: 1, limit: state.config.maxRows, sort: '', dir: 'asc', q: '', filters: [{ col: fk.ref_col, op: '=', value: v }] };
            } }, v)
          : cellText(v);
        return h('td', { class: 'cell', title: v == null ? '' : v }, content);
      }));
  }));
  main.append(pager, h('div', { class: 'scroll' }, h('table', { class: 'data' }, h('thead', {}, head), body)));
  if (d.editable) {
    main.append(h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { onclick: () => checks.forEach(([c]) => (c.checked = true)) }, 'Select all'),
      h('button', { class: 'danger', onclick: () => attempt(main, async () => {
        const sel = checks.filter(([c]) => c.checked).map(([, r]) => keyOf(r));
        if (!sel.length) return;
        if (!confirm(`Delete ${sel.length} row(s)?`)) return;
        await DEL(`${base}/rows`, { keys: sel });
        flash('ok', `Deleted ${sel.length} row(s).`);
        render();
      }) }, 'Delete selected')));
  } else main.append(h('p', { class: 'muted' }, 'This relation is read-only.'));
}

function editRow(ctx, d, row, key) {
  ctx.main.append(h('div', { class: 'crumbs' }, 'Editing row'));
  rowForm(ctx, d.columns, row, d, key);
}

// Shared insert/edit form.
function rowForm(ctx, columns, row, d, key, copy = false) {
  const { main, base, db, schema, table } = ctx;
  if (!d.editable && !row) { main.append(alertBox('info', 'This relation is read-only.')); return; }
  const editing = !!row && !copy;
  const fields = [];
  const grid = h('div', { class: 'form-grid' });
  for (const c of columns) {
    if (c.generated) continue;
    const orig = row ? row[c.name] : null;
    const long = /text|json|xml|\[\]/.test(c.type) || (orig && String(orig).length > 80);
    const input = long ? h('textarea', { rows: 3 }) : h('input', { type: 'text' });
    input.value = orig == null ? '' : orig;
    const hasDefault = !!(c.default || c.identity);
    const nullBox = c.notnull ? null : h('input', { type: 'checkbox', checked: row ? orig == null : !hasDefault });
    const defBox = !editing && hasDefault ? h('input', { type: 'checkbox', checked: !row || (c.pk && !!c.default) }) : null;
    const sync = () => { input.disabled = !!((nullBox && nullBox.checked) || (defBox && defBox.checked)); };
    input.addEventListener('input', () => { if (nullBox) nullBox.checked = false; if (defBox) defBox.checked = false; sync(); });
    if (nullBox) nullBox.addEventListener('change', () => { if (nullBox.checked && defBox) defBox.checked = false; sync(); });
    if (defBox) defBox.addEventListener('change', () => { if (defBox.checked && nullBox) nullBox.checked = false; sync(); });
    sync();
    fields.push({ c, input, nullBox, defBox, orig });
    grid.append(h('label', { class: 'name' }, c.name, h('small', {}, c.type + (c.default ? ' = ' + c.default : ''))),
      h('div', { class: 'field' }, input, nullBox ? h('label', {}, nullBox, ' NULL') : '', defBox ? h('label', {}, defBox, ' DEFAULT') : ''));
  }
  const submit = async (again) => attempt(main, async () => {
    const values = {};
    for (const f of fields) {
      let spec;
      if (f.nullBox && f.nullBox.checked) spec = { mode: 'null' };
      else if (f.defBox && f.defBox.checked) spec = null;
      else spec = { mode: 'value', value: f.input.value };
      if (editing) {
        const unchanged = spec && (spec.mode === 'null' ? f.orig == null : f.orig != null && spec.value === f.orig);
        if (unchanged) continue;
      }
      if (spec) values[f.c.name] = spec;
    }
    if (editing) {
      if (!Object.keys(values).length) { flash('info', 'No changes.'); return go(tableLink(db, schema, table)); }
      await PUT(`${base}/rows`, { key, values });
      flash('ok', 'Row updated.');
      go(tableLink(db, schema, table));
      render();
    } else {
      await POST(`${base}/rows`, { values });
      flash('ok', 'Row inserted.');
      if (again) render(); else go(tableLink(db, schema, table));
    }
  });
  main.append(h('div', { class: 'card' }, grid, h('div', { class: 'row', style: 'margin-top:14px' },
    h('button', { class: 'primary', onclick: () => submit(false) }, editing ? 'Save' : 'Insert'),
    editing ? h('a', { class: 'btn', href: tableLink(db, schema, table) }, 'Cancel') : h('button', { onclick: () => submit(true) }, 'Insert and add another'))));
}

async function structureView(ctx) {
  const { main, base, db, schema, table } = ctx;
  const s = await GET(`${base}/structure`);
  const isTable = s.kind === 'r' || s.kind === 'p';
  const reload = () => { delete state.trees[db]; render(); };
  main.append(h('p', { class: 'muted' }, `${KIND[s.kind]} · owner ${s.owner} · ${fmtBytes(s.size)} total · ~${fmtNum(Math.max(0, s.estimated_rows))} rows` + (s.comment ? ` · ${s.comment}` : '')));
  if (s.definition) main.append(h('h3', {}, 'Definition'), h('pre', { class: 'sql' }, s.definition));
  if (s.stats) {
    const st = s.stats;
    const when = (v) => (v ? new Date(v).toLocaleString() : 'never');
    main.append(h('details', { class: 'card' }, h('summary', {}, 'Statistics'),
      h('div', {}, `Live rows ${fmtNum(st.n_live_tup)} · dead rows ${fmtNum(st.n_dead_tup)} · seq scans ${fmtNum(st.seq_scan)} · index scans ${fmtNum(st.idx_scan)}`),
      h('div', {}, `Inserted ${fmtNum(st.n_tup_ins)} · updated ${fmtNum(st.n_tup_upd)} · deleted ${fmtNum(st.n_tup_del)}`),
      h('div', {}, `Last vacuum ${when(st.last_vacuum || st.last_autovacuum)} · last analyze ${when(st.last_analyze || st.last_autoanalyze)}`)));
  }

  main.append(h('h3', {}, 'Columns'));
  main.append(simpleTable(['#', 'Name', 'Type', 'Null', 'Default', 'Extra', 'Comment', ''], s.columns.map((c, i) => [
    i + 1, h('td', {}, c.name, ' ', c.pk ? h('span', { class: 'badge pk' }, 'PK') : ''), c.type, c.notnull ? 'NO' : 'YES', c.default || h('span', { class: 'null' }, 'None'),
    [c.identity ? `identity (${c.identity === 'a' ? 'always' : 'by default'})` : '', c.generated ? 'generated' : ''].filter(Boolean).join(', '), c.comment,
    isTable ? h('td', {}, h('button', { class: 'link', onclick: () => editColumn(ctx, c, reload) }, 'Change'),
      h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
        if (!confirm(`Drop column "${c.name}"?`)) return;
        await DEL(`${base}/columns/${enc(c.name)}`);
        flash('ok', `Column "${c.name}" dropped.`);
        reload();
      }) }, 'Drop')) : '',
  ])));
  if (!isTable) return;

  const nm = h('input', { type: 'text', placeholder: 'name' });
  const ty = h('input', { type: 'text', placeholder: 'type', value: 'text', list: 'pg-types' });
  const df = h('input', { type: 'text', placeholder: 'default expression' });
  const nn = h('input', { type: 'checkbox' });
  main.append(typeDatalist(), h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Add column'),
    h('div', { class: 'row' }, nm, ty, df, h('label', {}, nn, ' Not null'), h('button', { class: 'primary', onclick: () => attempt(main, async () => {
      await POST(`${base}/columns`, { name: nm.value, type: ty.value, default: df.value, notnull: nn.checked });
      flash('ok', 'Column added.');
      reload();
    }) }, 'Add'))));

  main.append(h('h3', {}, 'Indexes'));
  main.append(s.indexes.length ? simpleTable(['Name', 'Method', 'Unique', 'Columns', 'Size', ''], s.indexes.map((i) => [
    h('td', {}, i.name, ' ', i.primary ? h('span', { class: 'badge pk' }, 'PRIMARY') : ''), i.method, yesNo(i.unique), i.columns.join(', '), fmtBytes(i.size),
    h('td', {}, i.has_constraint ? h('span', { class: 'muted' }, 'via constraint') : h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
      if (!confirm(`Drop index "${i.name}"?`)) return;
      await DEL(`${base}/indexes/${enc(i.name)}`);
      reload();
    }) }, 'Drop')),
  ])) : h('p', { class: 'muted' }, 'No indexes.'));

  const colSelect = (multiple = true) => h('select', { multiple, size: Math.min(6, s.columns.length) }, s.columns.map((c) => h('option', { value: c.name }, c.name)));
  const picked = (sel) => [...sel.selectedOptions].map((o) => o.value);
  const iName = h('input', { type: 'text', placeholder: 'Index name (optional)' });
  const iCols = colSelect();
  const iMethod = h('select', {}, ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist'].map((m) => h('option', {}, m)));
  const iUnique = h('input', { type: 'checkbox' });
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Create index'), h('div', { class: 'row' }, iName, iCols, iMethod, h('label', {}, iUnique, ' Unique'),
    h('button', { class: 'primary', onclick: () => attempt(main, async () => {
      await POST(`${base}/indexes`, { name: iName.value, columns: picked(iCols), unique: iUnique.checked, method: iMethod.value });
      flash('ok', 'Index created.');
      reload();
    }) }, 'Create'))));

  main.append(h('h3', {}, 'Constraints'));
  const TYPES = { p: 'PRIMARY KEY', u: 'UNIQUE', f: 'FOREIGN KEY', c: 'CHECK', x: 'EXCLUDE' };
  main.append(s.constraints.length ? simpleTable(['Name', 'Type', 'Definition', ''], s.constraints.map((k) => [k.name, TYPES[k.type] || k.type, h('code', {}, k.definition),
    h('td', {}, h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
      if (!confirm(`Drop constraint "${k.name}"?`)) return;
      await DEL(`${base}/constraints/${enc(k.name)}`);
      reload();
    }) }, 'Drop'))])) : h('p', { class: 'muted' }, 'No constraints.'));

  const cType = h('select', {}, [['unique', 'UNIQUE'], ['check', 'CHECK'], ['foreign', 'FOREIGN KEY']].map(([v, l]) => h('option', { value: v }, l)));
  const cName = h('input', { type: 'text', placeholder: 'Name (optional)' });
  const cCols = colSelect();
  const cCheck = h('input', { type: 'text', placeholder: 'CHECK expression, e.g. price > 0', size: 30 });
  const cRef = h('input', { type: 'text', placeholder: 'Referenced table (schema.table)' });
  const cRefCols = h('input', { type: 'text', placeholder: 'Referenced columns (comma-separated)' });
  const cDel = h('select', {}, ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'].map((a) => h('option', { value: a }, 'ON DELETE ' + a)));
  const extra = h('div', { class: 'row' });
  const drawExtra = () => extra.replaceChildren(...(cType.value === 'check' ? [cCheck] : cType.value === 'foreign' ? [cRef, cRefCols, cDel] : []));
  cType.addEventListener('change', drawExtra);
  drawExtra();
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Add constraint'), h('div', { class: 'row' }, cType, cName, cCols), extra,
    h('button', { class: 'primary', onclick: () => attempt(main, async () => {
      const body = { type: cType.value, name: cName.value, columns: picked(cCols), check: cCheck.value, onDelete: cDel.value };
      if (cType.value === 'foreign') {
        const parts = cRef.value.trim().split('.');
        body.refTable = parts.length > 1 ? { schema: parts[0], name: parts.slice(1).join('.') } : { name: parts[0] };
        body.refColumns = cRefCols.value.split(',').map((x) => x.trim()).filter(Boolean);
      }
      await POST(`${base}/constraints`, body);
      flash('ok', 'Constraint added.');
      reload();
    }) }, 'Add')));

  const pkCols = colSelect();
  [...pkCols.options].forEach((o) => (o.selected = s.columns.find((c) => c.name === o.value).pk));
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Primary key'), h('div', { class: 'row' }, pkCols,
    h('button', { onclick: () => attempt(main, async () => {
      if (!confirm('Replace the current primary key?')) return;
      await POST(`${base}/primary-key`, { columns: picked(pkCols) });
      flash('ok', 'Primary key updated.');
      reload();
    }) }, 'Set primary key'))));
}

function editColumn(ctx, c, done) {
  const name = h('input', { type: 'text', value: c.name });
  const type = h('input', { type: 'text', value: c.type, list: 'pg-types' });
  const def = h('input', { type: 'text', value: c.default || '' });
  const nn = h('input', { type: 'checkbox', checked: c.notnull });
  const comment = h('input', { type: 'text', value: c.comment || '' });
  const err = h('div', {});
  const row = (label, el) => h('div', { class: 'row' }, h('label', { style: 'width:90px' }, label), el);
  const close = modal(`Change column "${c.name}"`, err, row('Name', name), row('Type', type), row('Default', def), row('Not null', nn), row('Comment', comment),
    h('div', { class: 'row end' }, h('button', { onclick: () => close() }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
      const body = {};
      if (name.value !== c.name) body.name = name.value;
      if (type.value !== c.type) body.type = type.value;
      if (def.value !== (c.default || '')) body.default = def.value;
      if (nn.checked !== c.notnull) body.notnull = nn.checked;
      if (comment.value !== (c.comment || '')) body.comment = comment.value;
      if (!Object.keys(body).length) return close();
      try {
        await PUT(`${ctx.base}/columns/${enc(c.name)}`, body);
        close();
        flash('ok', 'Column updated.');
        done();
      } catch (e) { err.replaceChildren(alertBox('error', e.message)); }
    } }, 'Save')));
  document.body.append(typeDatalist());
}

async function operationsView(ctx) {
  const { main, base, db, schema, table } = ctx;
  const info = await GET(`${base}/structure`);
  const isTable = info.kind === 'r' || info.kind === 'p';
  const card = (title, ...kids) => main.append(h('div', { class: 'card' }, h('h3', {}, title), ...kids));
  const rn = h('input', { type: 'text', value: table });
  card('Rename', h('div', { class: 'row' }, rn, h('button', { class: 'primary', onclick: () => attempt(main, async () => {
    await POST(`${base}/rename`, { name: rn.value });
    flash('ok', 'Renamed.');
    delete state.trees[db];
    go(tableLink(db, schema, rn.value, 'operations'));
  }) }, 'Rename')));
  const tree = await loadTree(db);
  const mv = h('select', {}, tree.schemas.map((s) => h('option', { selected: s === schema }, s)));
  card('Move to schema', h('div', { class: 'row' }, mv, h('button', { onclick: () => attempt(main, async () => {
    await POST(`${base}/move`, { schema: mv.value });
    flash('ok', 'Moved.');
    delete state.trees[db];
    go(tableLink(db, mv.value, table, 'operations'));
  }) }, 'Move')));
  const cm = h('input', { type: 'text', value: info.comment || '', size: 50 });
  card('Comment', h('div', { class: 'row' }, cm, h('button', { onclick: () => attempt(main, async () => {
    await POST(`${base}/comment`, { comment: cm.value });
    flash('ok', 'Comment saved.');
    render();
  }) }, 'Save')));
  if (isTable) {
    const cn = h('input', { type: 'text', value: table + '_copy' });
    const cd = h('input', { type: 'checkbox', checked: true });
    card('Copy table', h('div', { class: 'row' }, cn, h('label', {}, cd, ' Include data'), h('button', { onclick: () => attempt(main, async () => {
      await POST(`${base}/copy`, { name: cn.value, data: cd.checked });
      flash('ok', `Copied to "${cn.value}".`);
      delete state.trees[db];
      go(tableLink(db, schema, cn.value));
    }) }, 'Copy')));
    const maint = (op, label) => h('button', { onclick: () => attempt(main, async () => { await POST(`${base}/maintenance`, { op }); main.prepend(alertBox('ok', `${label} completed.`)); }) }, label);
    card('Maintenance', h('div', { class: 'row' }, maint('analyze', 'Analyze'), maint('vacuum', 'Vacuum'), maint('vacuum_analyze', 'Vacuum + analyze'), maint('reindex', 'Reindex')));
    const restart = h('input', { type: 'checkbox' });
    const cascade = h('input', { type: 'checkbox' });
    card('Delete data', h('div', { class: 'row' }, h('label', {}, restart, ' Restart identity'), h('label', {}, cascade, ' Cascade'), h('button', { class: 'danger', onclick: () => attempt(main, async () => {
      if (!confirm(`Truncate "${table}"? All rows will be deleted.`)) return;
      await POST(`${base}/truncate`, { restart: restart.checked, cascade: cascade.checked });
      flash('ok', 'Table truncated.');
      go(tableLink(db, schema, table));
      render();
    }) }, 'Truncate table')));
  }
  card('Delete', h('button', { class: 'danger', onclick: () => attempt(main, async () => {
    if (!confirm(`Drop ${KIND[info.kind].toLowerCase()} "${table}"?`)) return;
    const cascade = confirm('Also drop dependent objects (CASCADE)?');
    await DEL(`${base}?cascade=${cascade ? 1 : 0}`);
    flash('ok', `"${table}" dropped.`);
    delete state.trees[db];
    go(dbLink(db));
  }) }, `Drop ${KIND[info.kind].toLowerCase()}`));
}

// ---------- shared helpers for the extra views ----------

function downloadText(name, text, mime) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
const toCsv = (rows) => rows.map((r) => r.map((v) => (v == null ? '' : /[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\r\n') + '\r\n';

function svgEl(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  kids.forEach((k) => el.append(k instanceof Node ? k : document.createTextNode(k)));
  return el;
}

function readFileInto(input, target) {
  input.addEventListener('change', async () => { if (input.files[0]) target.value = await input.files[0].text(); });
}

// ---------- table search (query by example) ----------

const OPS = [['=', '='], ['!=', '≠'], ['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥'], ['LIKE', 'LIKE'], ['NOT LIKE', 'NOT LIKE'], ['ILIKE', 'ILIKE'], ['NOT ILIKE', 'NOT ILIKE'], ['~', 'regex ~'], ['~*', 'regex ~*'], ['IN', 'IN (a,b,…)'], ['NOT IN', 'NOT IN'], ['BETWEEN', 'BETWEEN (a,b)'], ['IS NULL', 'IS NULL'], ['IS NOT NULL', 'IS NOT NULL']];

async function tableSearchView(ctx) {
  const { main, base, db, schema, table } = ctx;
  const d = await GET(`${base}/data?limit=1`);
  const key = `${db}.${schema}.${table}`;
  const st = (state.browse[key] ||= { page: 1, limit: state.config.maxRows, sort: '', dir: 'asc', q: '', filters: [] });
  const body = h('tbody', {});
  const rows = [];
  const addRow = (f = {}) => {
    const r = {
      col: h('select', {}, d.columns.map((c) => h('option', { value: c.name, selected: c.name === f.col }, `${c.name} (${c.type})`))),
      op: h('select', {}, OPS.map(([v, l]) => h('option', { value: v, selected: v === (f.op || '=') }, l))),
      value: h('input', { type: 'text', value: f.value || '', size: 30 }),
    };
    const sync = () => (r.value.disabled = r.op.value.startsWith('IS'));
    r.op.addEventListener('change', sync);
    sync();
    const tr = h('tr', {}, h('td', {}, r.col), h('td', {}, r.op), h('td', {}, r.value), h('td', {}, h('button', { class: 'link danger', onclick: () => { tr.remove(); rows.splice(rows.indexOf(r), 1); } }, 'remove')));
    rows.push(r);
    body.append(tr);
  };
  (st.filters && st.filters.length ? st.filters : [{}]).forEach(addRow);
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Search table'),
    h('p', { class: 'muted' }, 'All conditions must match. For LIKE use % as a wildcard.'),
    h('div', { class: 'scroll' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Column', 'Operator', 'Value', ''].map((x) => h('th', {}, x)))), body)),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { onclick: () => addRow() }, 'Add condition'),
      h('button', { class: 'primary', onclick: () => {
        st.filters = rows.map((r) => ({ col: r.col.value, op: r.op.value, value: r.value.value }));
        st.q = '';
        st.page = 1;
        go(tableLink(db, schema, table));
      } }, 'Go'),
      h('button', { onclick: () => { st.filters = []; go(tableLink(db, schema, table)); } }, 'Reset'))));
}

// ---------- import ----------

function importView(main, db) {
  const holder = h('div', { class: 'sql-editor' });
  const ta = window.PGMEditor.createSqlEditor({ parent: holder, placeholderText: 'Paste SQL here or choose a file…' });
  const file = h('input', { type: 'file', accept: '.sql,.txt' });
  readFileInto(file, ta);
  const out = h('div', {});
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Import SQL'),
    h('p', { class: 'muted' }, 'The script runs as a single request. If it fails and has no explicit transaction control, nothing is applied.'),
    h('div', { class: 'row' }, file), holder, out,
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: async () => {
      out.replaceChildren();
      if (!ta.value.trim()) return;
      try {
        const r = await POST(`/db/${enc(db)}/import`, { sql: ta.value });
        delete state.trees[db];
        out.append(alertBox('ok', `Import finished: ${r.statements} statement(s) in ${r.ms} ms.`));
      } catch (err) { showError(out, err); }
    } }, 'Run import'))));
}

function csvImportView(ctx) {
  const { main, base, db, schema, table } = ctx;
  const ta = h('textarea', { rows: 10, spellcheck: false, placeholder: 'Paste CSV here or choose a file…' });
  const file = h('input', { type: 'file', accept: '.csv,.txt,.tsv' });
  readFileInto(file, ta);
  const delim = h('select', {}, [[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']].map(([v, l]) => h('option', { value: v }, l)));
  const header = h('input', { type: 'checkbox', checked: true });
  const empty = h('input', { type: 'checkbox', checked: true });
  const out = h('div', {});
  main.append(h('div', { class: 'card' }, h('h3', {}, `Import CSV into ${table}`),
    h('p', { class: 'muted' }, 'With a header row, its names choose the target columns; otherwise values map to the table columns in order. Everything is imported in one transaction.'),
    h('div', { class: 'row' }, file, delim, h('label', {}, header, ' First row is header'), h('label', {}, empty, ' Empty value = NULL')), ta, out,
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: async () => {
      out.replaceChildren();
      try {
        const r = await POST(`${base}/import-csv`, { csv: ta.value, delimiter: delim.value, header: header.checked, emptyAsNull: empty.checked });
        out.append(alertBox('ok', `Imported ${fmtNum(r.rowCount)} row(s).`));
      } catch (err) { showError(out, err); }
    } }, 'Import'))));
}

// ---------- database search ----------

function dbSearchView(main, db, tree) {
  const term = h('input', { type: 'text', placeholder: 'Search for…', size: 30 });
  const mode = h('select', {}, [['contains', 'contains (case-insensitive)'], ['exact', 'exact match'], ['regex', 'regular expression']].map(([v, l]) => h('option', { value: v }, l)));
  const boxes = tree.tables.filter((t) => t.kind !== 'v' && t.kind !== 'f').map((t) => [`${t.schema}.${t.name}`, h('input', { type: 'checkbox', checked: true })]);
  const out = h('div', {});
  const run = async () => {
    out.replaceChildren();
    const sel = boxes.filter(([, c]) => c.checked).map(([id]) => id);
    if (!term.value || !sel.length) return;
    out.append(h('p', { class: 'muted' }, 'Searching…'));
    try {
      const res = await GET(`/db/${enc(db)}/search?q=${enc(term.value)}&mode=${mode.value}&tables=${enc(sel.join(','))}`);
      out.replaceChildren(simpleTable(['Table', 'Matching rows', ''], res.map((r) => [`${r.schema}.${r.name}`, fmtNum(r.matches),
        r.matches ? h('td', {}, h('a', { href: tableLink(db, r.schema, r.name), onclick: () => {
          state.browse[`${db}.${r.schema}.${r.name}`] = { page: 1, limit: state.config.maxRows, sort: '', dir: 'asc', q: mode.value === 'contains' ? term.value : '', filters: [] };
        } }, 'Browse')) : ''])));
    } catch (err) { out.replaceChildren(); showError(out, err); }
  };
  term.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Search in database'),
    h('div', { class: 'row' }, term, mode, h('button', { class: 'primary', onclick: run }, 'Search')),
    h('div', { class: 'row' }, h('button', { onclick: () => boxes.forEach(([, c]) => (c.checked = true)) }, 'All'), h('button', { onclick: () => boxes.forEach(([, c]) => (c.checked = false)) }, 'None')),
    h('div', { style: 'columns:2' }, boxes.map(([id, c]) => h('div', {}, h('label', {}, c, ' ' + id))))), out);
}

// ---------- routines, triggers, sequences, extensions ----------

async function objectsView(main, db) {
  const o = await GET(`/db/${enc(db)}/objects`);
  const reload = () => { delete state.trees[db]; render(); };
  const template = (sql) => { state.prefill = sql; go(dbLink(db, 'sql')); };
  const act = (fn) => attempt(main, async () => { await fn(); reload(); });

  main.append(h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, 'Routines'),
    h('button', { onclick: () => template("CREATE OR REPLACE FUNCTION my_function(arg integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN arg + 1;\nEND;\n$$;") }, 'New function…'),
    h('button', { onclick: () => template("CREATE OR REPLACE PROCEDURE my_procedure()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- statements\nEND;\n$$;") }, 'New procedure…')));
  main.append(o.routines.length ? simpleTable(['Schema', 'Name', 'Type', 'Arguments', 'Returns', 'Language', 'Owner', ''], o.routines.map((r) => [r.schema, r.name, r.kind, h('code', {}, r.args), r.returns || '', r.language, r.owner,
    h('td', {}, h('button', { class: 'link', onclick: () => modal(`${r.kind} ${r.name}`, h('pre', { class: 'sql' }, r.definition), h('div', { class: 'row end' }, h('button', { onclick: () => { document.querySelector('.modal-bg').remove(); template(r.definition); } }, 'Edit in SQL'))) }, 'Definition'),
      h('button', { class: 'link danger', onclick: () => act(async () => { if (!confirm(`Drop ${r.kind} "${r.name}(${r.args})"?`)) throw new AuthError(); await DEL(`/db/${enc(db)}/routines/${r.oid}`); }) }, 'Drop'))])) : h('p', { class: 'muted' }, 'No user-defined routines.'));

  main.append(h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, 'Triggers'),
    h('button', { onclick: () => template('CREATE TRIGGER my_trigger\nBEFORE INSERT ON my_table\nFOR EACH ROW\nEXECUTE FUNCTION my_trigger_function();') }, 'New trigger…')));
  main.append(o.triggers.length ? simpleTable(['Table', 'Name', 'Enabled', 'Definition', ''], o.triggers.map((t) => [`${t.schema}.${t.table}`, t.name, yesNo(t.enabled), h('code', {}, t.definition),
    h('td', {}, h('button', { class: 'link', onclick: () => act(() => POST(`/db/${enc(db)}/triggers/toggle`, { schema: t.schema, table: t.table, name: t.name, enabled: !t.enabled })) }, t.enabled ? 'Disable' : 'Enable'),
      h('button', { class: 'link danger', onclick: () => act(async () => { if (!confirm(`Drop trigger "${t.name}"?`)) throw new AuthError(); await POST(`/db/${enc(db)}/triggers/drop`, { schema: t.schema, table: t.table, name: t.name }); }) }, 'Drop'))])) : h('p', { class: 'muted' }, 'No triggers.'));

  main.append(h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, 'Sequences'),
    h('button', { onclick: () => template('CREATE SEQUENCE my_sequence START 1;') }, 'New sequence…')));
  main.append(o.sequences.length ? simpleTable(['Schema', 'Name', 'Type', 'Last value', 'Start', 'Min', 'Max', 'Increment', 'Cycle', ''], o.sequences.map((x) => [x.schema, x.name, x.type, x.last_value == null ? h('span', { class: 'null' }, 'unused') : x.last_value, x.start_value, x.min_value, x.max_value, x.increment_by, yesNo(x.cycle),
    h('td', {}, h('button', { class: 'link', onclick: () => act(async () => {
      const v = prompt(`Set current value of ${x.name}:`, x.last_value || x.start_value);
      if (v == null) throw new AuthError();
      await POST(`/db/${enc(db)}/sequences/setval`, { schema: x.schema, name: x.name, value: v });
    }) }, 'Set value'), h('button', { class: 'link danger', onclick: () => act(async () => { if (!confirm(`Drop sequence "${x.name}"?`)) throw new AuthError(); await POST(`/db/${enc(db)}/sequences/drop`, { schema: x.schema, name: x.name }); }) }, 'Drop'))])) : h('p', { class: 'muted' }, 'No sequences.'));

  main.append(h('h3', {}, 'Extensions'));
  main.append(simpleTable(['Name', 'Version', 'Schema', 'Description', ''], o.extensions.map((e) => [e.name, e.version, e.schema, e.description,
    e.name === 'plpgsql' ? '' : h('td', {}, h('button', { class: 'link danger', onclick: () => act(async () => { if (!confirm(`Drop extension "${e.name}"?`)) throw new AuthError(); await DEL(`/db/${enc(db)}/extensions/${enc(e.name)}`); }) }, 'Drop'))])));
  const pick = h('select', {}, o.availableExtensions.map((e) => h('option', { value: e.name, title: e.comment || '' }, `${e.name} ${e.default_version}`)));
  if (o.availableExtensions.length) main.append(h('div', { class: 'row', style: 'margin-top:10px' }, pick, h('button', { class: 'primary', onclick: () => act(() => POST(`/db/${enc(db)}/extensions`, { name: pick.value })) }, 'Install extension')));
}

// ---------- designer ----------

async function designerView(main, db) {
  const d = await GET(`/db/${enc(db)}/designer`);
  if (!d.tables.length) return main.append(h('p', { class: 'muted' }, 'No tables to show.'));
  const W = 210, HEAD = 26, ROW = 18;
  const id = (s, n) => `${s}.${n}`;
  const pos = (state.designer ||= {})[db] ||= {};
  const per = Math.max(1, Math.ceil(Math.sqrt(d.tables.length)));
  const rowH = [];
  d.tables.forEach((t, i) => { const r = Math.floor(i / per); rowH[r] = Math.max(rowH[r] || 0, HEAD + ROW * t.columns.length); });
  d.tables.forEach((t, i) => {
    const k = id(t.schema, t.name);
    if (pos[k]) return;
    const r = Math.floor(i / per);
    pos[k] = { x: 20 + (i % per) * (W + 110), y: 20 + rowH.slice(0, r).reduce((a, b) => a + b + 50, 0) };
  });
  const byId = Object.fromEntries(d.tables.map((t) => [id(t.schema, t.name), t]));
  const svg = svgEl('svg', { class: 'designer' });
  const colY = (t, col) => pos[id(t.schema, t.name)].y + HEAD + ROW * Math.max(0, t.columns.findIndex((c) => c.name === col)) + ROW / 2;

  const draw = () => {
    svg.replaceChildren();
    let maxX = 0, maxY = 0;
    for (const k of d.fks) {
      const a = byId[id(k.from_schema, k.from_table)], b = byId[id(k.to_schema, k.to_table)];
      if (!a || !b) continue;
      const pa = pos[id(a.schema, a.name)], pb = pos[id(b.schema, b.name)];
      const y1 = colY(a, k.from_cols[0]), y2 = colY(b, k.to_cols[0]);
      let x1, x2, c1, c2;
      if (pa.x + W + 20 <= pb.x) { x1 = pa.x + W; x2 = pb.x; c1 = x1 + 50; c2 = x2 - 50; }
      else if (pb.x + W + 20 <= pa.x) { x1 = pa.x; x2 = pb.x + W; c1 = x1 - 50; c2 = x2 + 50; }
      else { x1 = pa.x + W; x2 = pb.x + W; c1 = x1 + 60; c2 = x2 + 60; }
      svg.append(svgEl('path', { d: `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`, class: 'rel' }, svgEl('title', {}, `${k.name}: ${k.from_table}(${k.from_cols}) → ${k.to_table}(${k.to_cols})`)));
      svg.append(svgEl('circle', { cx: x2, cy: y2, r: 3.5, class: 'rel-end' }));
    }
    for (const t of d.tables) {
      const p = pos[id(t.schema, t.name)];
      const height = HEAD + ROW * t.columns.length;
      maxX = Math.max(maxX, p.x + W + 120);
      maxY = Math.max(maxY, p.y + height + 40);
      const g = svgEl('g', { transform: `translate(${p.x},${p.y})` });
      g.append(svgEl('rect', { width: W, height, rx: 4, class: 'tbl' }),
        svgEl('rect', { width: W, height: HEAD, rx: 4, class: 'tbl-head', onmousedown: (e) => { drag = { k: id(t.schema, t.name), dx: e.clientX - p.x, dy: e.clientY - p.y }; e.preventDefault(); }, ondblclick: () => go(tableLink(db, t.schema, t.name, 'structure')) }),
        svgEl('text', { x: 8, y: 17, class: 'tbl-title' }, (t.schema === 'public' ? '' : t.schema + '.') + t.name));
      t.columns.forEach((c, i) => {
        g.append(svgEl('text', { x: 8, y: HEAD + ROW * i + 13, class: c.pk ? 'col pk' : 'col' }, `${c.pk ? '🔑 ' : ''}${c.name}`),
          svgEl('text', { x: W - 8, y: HEAD + ROW * i + 13, class: 'col type', 'text-anchor': 'end' }, c.type.length > 16 ? c.type.slice(0, 15) + '…' : c.type));
      });
      svg.append(g);
    }
    svg.setAttribute('width', Math.max(maxX, 600));
    svg.setAttribute('height', Math.max(maxY, 300));
  };
  let drag = null;
  svg.addEventListener('mousemove', (e) => { if (drag) { pos[drag.k] = { x: Math.max(0, e.clientX - drag.dx), y: Math.max(0, e.clientY - drag.dy) }; draw(); } });
  const stop = () => { drag = null; };
  svg.addEventListener('mouseup', stop);
  svg.addEventListener('mouseleave', stop);
  main.append(h('p', { class: 'muted' }, `${d.tables.length} table(s), ${d.fks.length} relation(s). Drag a title bar to move a table; double-click it to open its structure.`),
    h('div', { class: 'row' }, h('button', { onclick: () => { delete state.designer[db]; render(); } }, 'Reset layout'),
      h('button', { onclick: () => downloadText(`${db}-diagram.svg`, new XMLSerializer().serializeToString(svg), 'image/svg+xml') }, 'Download SVG')),
    h('div', { class: 'scroll', style: 'max-height:75vh;background:var(--panel)' }, svg));
  draw();
}

// ---------- privileges / roles ----------

async function privilegesView(main, db) {
  const [privs, roles, tree] = await Promise.all([GET(`/db/${enc(db)}/privileges`), GET('/server/roles'), loadTree(db)]);
  const reload = () => render();
  main.append(h('h3', {}, 'Table privileges'));
  main.append(privs.length ? simpleTable(['Table', 'Role', 'Privileges', ''], privs.map((p) => [`${p.schema}.${p.table}`, p.grantee, p.privileges.map((x) => h('span', { class: 'badge', style: 'margin-right:3px' }, x)),
    h('td', {}, h('button', { class: 'link danger', onclick: () => attempt(main, async () => {
      if (!confirm(`Revoke ${p.privileges.join(', ')} on ${p.table} from ${p.grantee}?`)) return;
      await POST(`/db/${enc(db)}/privileges`, { role: p.grantee, privileges: p.privileges, schema: p.schema, table: p.table, revoke: true });
      reload();
    }) }, 'Revoke'))])) : h('p', { class: 'muted' }, 'No explicit grants (objects use default owner-only privileges).'));

  const role = h('select', {}, ['PUBLIC', ...roles.map((r) => r.name)].map((n) => h('option', {}, n)));
  const target = h('select', {}, [...tree.schemas.map((s) => h('option', { value: JSON.stringify({ schema: s }) }, `ALL tables in ${s}`)),
    ...tree.tables.map((t) => h('option', { value: JSON.stringify({ schema: t.schema, table: t.name }) }, `${t.schema}.${t.name}`))]);
  const boxes = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map((p) => [p, h('input', { type: 'checkbox' })]);
  const apply = (revoke) => attempt(main, async () => {
    const sel = boxes.filter(([, c]) => c.checked).map(([p]) => p);
    if (!sel.length) return;
    await POST(`/db/${enc(db)}/privileges`, { role: role.value, privileges: sel, revoke, ...JSON.parse(target.value) });
    reload();
  });
  main.append(h('div', { class: 'card' }, h('h3', {}, 'Grant or revoke'),
    h('div', { class: 'row' }, role, target), h('div', { class: 'row' }, boxes.map(([p, c]) => h('label', {}, c, ' ' + p))),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => apply(false) }, 'Grant'), h('button', { class: 'danger', onclick: () => apply(true) }, 'Revoke'))));
}

function editRole(r) {
  const flags = [['login', 'Can login'], ['superuser', 'Superuser'], ['createdb', 'Create databases'], ['createrole', 'Create roles'], ['replication', 'Replication']];
  const boxes = Object.fromEntries(flags.map(([k]) => [k, h('input', { type: 'checkbox', checked: r[k] })]));
  const pw = h('input', { type: 'password', placeholder: 'leave empty to keep', autocomplete: 'new-password' });
  const lim = h('input', { type: 'number', value: r.connlimit });
  const until = h('input', { type: 'text', value: r.valid_until || '', placeholder: 'e.g. 2030-01-01 (empty = never)' });
  const err = h('div', {});
  const row = (label, el) => h('div', { class: 'row' }, h('label', { style: 'width:130px' }, label), el);
  const close = modal(`Edit role "${r.name}"`, err, ...flags.map(([k, l]) => row(l, boxes[k])), row('New password', pw), row('Connection limit', lim), row('Valid until', until),
    h('div', { class: 'row end' }, h('button', { onclick: () => close() }, 'Cancel'), h('button', { class: 'primary', onclick: async () => {
      const body = { connlimit: lim.value, validUntil: until.value, password: pw.value };
      for (const [k] of flags) body[k] = boxes[k].checked;
      try { await PUT(`/server/roles/${enc(r.name)}`, body); close(); flash('ok', `Role "${r.name}" updated.`); render(); } catch (e) { err.replaceChildren(alertBox('error', e.message)); }
    } }, 'Save')));
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('pgm_theme', t);
}
applyTheme(localStorage.getItem('pgm_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

window.addEventListener('hashchange', render);
GET('/config').then((c) => { state.config = c; }).catch(() => {}).then(render);
