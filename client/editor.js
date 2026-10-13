// Source for public/editor.js (bundled by `npm run build:editor`).
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { linter, lintGutter, lintKeymap } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--hl-keyword)', fontWeight: '600' },
  { tag: [t.typeName, t.standard(t.typeName)], color: 'var(--hl-type)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--hl-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--hl-number)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.separator], color: 'var(--hl-punct)' },
  { tag: [t.name, t.variableName, t.propertyName], color: 'var(--hl-name)' },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: 'var(--hl-func)' },
  { tag: t.special(t.name), color: 'var(--hl-quoted)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--input)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '13px' },
  '&.cm-focused': { outline: '2px solid #a9c6e0', borderColor: 'var(--primary)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', minHeight: '150px', maxHeight: '60vh', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--th)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(128, 128, 128, 0.10)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(128, 128, 128, 0.18)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(80, 140, 200, 0.30) !important' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(80, 140, 200, 0.45) !important' },
  '.cm-content ::selection': { backgroundColor: 'rgba(80, 140, 200, 0.45)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--primary)', color: '#fff' },
  '.cm-completionDetail': { color: 'var(--muted)', marginLeft: '8px' },
  '.cm-tooltip-lint': { maxWidth: '520px', whiteSpace: 'pre-wrap' },
});

// Bare names resolve in the public schema; qualified names always resolve.
function buildSchema(meta) {
  const schema = {};
  for (const tbl of meta.tables) {
    const cols = tbl.columns.map((c) => ({ label: c.name, type: 'property', detail: c.type }));
    schema[`${tbl.schema}.${tbl.name}`] = cols;
    if (tbl.schema === 'public') schema[tbl.name] = cols;
  }
  for (const s of meta.schemas) if (!schema[s]) schema[s] = [];
  return schema;
}

const plainIdent = /^[a-z_][a-z0-9_$]*$/;
const quoteIfNeeded = (n) => (plainIdent.test(n) ? n : `"${n.replace(/"/g, '""')}"`);
const unquote = (s) => s.replace(/^"|"$/g, '').replace(/""/g, '"');
const REF = /\b(?:from|join|update|into|table|using)\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/gi;

// Columns of every table referenced in the statement under the cursor, offered without a prefix.
function columnSource(getMeta) {
  return (ctx) => {
    const word = ctx.matchBefore(/"?[\w$]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    if (ctx.state.sliceDoc(Math.max(0, word.from - 1), word.from) === '.') return null;
    const doc = ctx.state.doc.toString();
    const start = doc.lastIndexOf(';', ctx.pos - 1) + 1;
    const end = doc.indexOf(';', ctx.pos);
    const stmt = doc.slice(start, end < 0 ? doc.length : end).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
    const meta = getMeta();
    const seen = new Map();
    for (const m of stmt.matchAll(REF)) {
      const parts = m[1].split('.').map((x) => unquote(x.trim()));
      const [sch, name] = parts.length === 2 ? parts : [null, parts[0]];
      for (const t of meta.tables) {
        if (t.name === name && (sch ? t.schema === sch : t.schema === 'public' || !seen.size)) seen.set(`${t.schema}.${t.name}`, t);
      }
    }
    if (!seen.size) return null;
    const options = [];
    const dup = new Set();
    for (const t of seen.values()) {
      for (const c of t.columns) {
        const key = t.name + '.' + c.name;
        if (dup.has(key)) continue;
        dup.add(key);
        options.push({ label: c.name, apply: quoteIfNeeded(c.name), type: 'property', detail: `${c.type} · ${t.name}`, boost: 99 });
      }
    }
    return { from: word.from, options, validFor: /^"?[\w$]*$/ };
  };
}

function createSqlEditor({ parent, doc = '', meta = { schemas: [], tables: [] }, check, onRun, placeholderText }) {
  const lang = new Compartment();
  let current = meta;
  const langExt = (m) => {
    const support = sql({ dialect: PostgreSQL, schema: buildSchema(m), defaultSchema: 'public', upperCaseKeywords: true });
    return [support, support.language.data.of({ autocomplete: columnSource(() => current) })];
  };
  const extensions = [
    lineNumbers(), history(), drawSelection(), highlightActiveLine(), indentOnInput(), bracketMatching(), closeBrackets(),
    lang.of(langExt(meta)),
    autocompletion({ activateOnTyping: true }),
    syntaxHighlighting(highlight),
    theme,
    keymap.of([
      { key: 'Mod-Enter', run: () => { if (onRun) onRun(); return true; } },
      ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap, indentWithTab,
    ]),
  ];
  if (placeholderText) extensions.push(placeholder(placeholderText));
  if (check) {
    extensions.push(
      linter(async (view) => {
        const text = view.state.doc.toString();
        if (!text.trim()) return [];
        let list = [];
        try { list = await check(text); } catch { return []; }
        const len = view.state.doc.length;
        return list
          .filter((d) => d.from <= len)
          .map((d) => ({ from: d.from, to: Math.min(Math.max(d.to, d.from + 1), len), severity: 'error', message: d.message + (d.hint ? `\nHint: ${d.hint}` : '') }));
      }, { delay: 700 }),
      lintGutter()
    );
  }
  const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent });
  return {
    view,
    get value() { return view.state.doc.toString(); },
    set value(v) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }); },
    focus: () => view.focus(),
    setMeta: (m) => { current = m; view.dispatch({ effects: lang.reconfigure(langExt(m)) }); },
    destroy: () => view.destroy(),
  };
}

window.PGMEditor = { createSqlEditor };
