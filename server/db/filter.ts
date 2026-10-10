// PocketBase filter and sort strings, translated into Prisma `where` and
// `orderBy` objects with PocketBase's own semantics — which were SQLite's.
//
// Phase 1 of the move to Postgres (docs/postgres-prisma-plan.md) keeps every
// query the server makes exactly as it was written for PocketBase, so this file
// has to answer each one the way PocketBase did. The rules below were checked
// against a PocketBase 0.40.5 copy of production on 10.10.2026, not guessed:
//
//   - "empty" is '' or null. `field = ''` on text is `field = ''`; on a number
//     or bool it is never true (SQLite: 0 is not ''); on a relation it is "not
//     set" (null here). `!=` is the exact opposite, nulls included.
//   - A number compared with a numeric-looking string compares as a number
//     (`season = "2026"`); with any other string the number is smaller
//     (SQLite orders numbers before text).
//   - `~` is a case-insensitive "contains" with `%` and `_` taken literally.
//   - Text compares byte-wise (the database is created with the builtin
//     C.UTF-8 locale for exactly this).
//   - `created`/`updated` were text in PocketBase. An empty one sorted and
//     compared as '' — before everything — so `created < X` includes them.
//   - With no sort, rows come back in insertion order; sort ties too
//     (SQLite's rowid). `seq` carries that order.
//   - `&&` binds tighter than `||`.
//
// Anything outside what the server uses throws a 400 like PocketBase's own
// "Something went wrong while processing your request." — loudly, so a new
// query shape is noticed in the log instead of quietly answering differently.

import type { CollectionMeta, FieldMeta } from './collections.ts';

export class FilterError extends Error {}

type Literal =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

type Comparison = { kind: 'cmp'; field: string; op: string; value: Literal };
type Group = { kind: 'and' | 'or'; items: Node[] };
type Node = Comparison | Group;

type Token =
  | { t: 'text'; v: string }
  | { t: 'number'; v: number }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'join'; v: '&&' | '||' }
  | { t: 'paren'; v: '(' | ')' };

const OPS = ['!=', '>=', '<=', '!~', '=', '>', '<', '~'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      // A comment runs to the end of the line, as in PocketBase.
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // PocketBase's scanner: the text runs to the next quote of the same kind
      // that does not follow a backslash, and only `\<quote>` is unescaped —
      // a doubled backslash stays doubled.
      let j = i + 1;
      let prev = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === ch && prev !== '\\') { closed = true; break; }
        prev = c;
        j++;
      }
      if (!closed) throw new FilterError(`unterminated text in filter`);
      out.push({ t: 'text', v: src.slice(i + 1, j).split(`\\${ch}`).join(ch) });
      i = j + 1;
      continue;
    }
    if (ch === '&' && src[i + 1] === '&') { out.push({ t: 'join', v: '&&' }); i += 2; continue; }
    if (ch === '|' && src[i + 1] === '|') { out.push({ t: 'join', v: '||' }); i += 2; continue; }
    if (ch === '(' || ch === ')') { out.push({ t: 'paren', v: ch }); i++; continue; }
    if (ch === '?') throw new FilterError('any-of operators are not supported');
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op }); i += op.length; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (ch !== '-' || /\d/.test(src[i + 1] ?? ''))) {
      out.push({ t: 'number', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_@#][\w.:@#]*/.exec(src.slice(i));
    if (ident) { out.push({ t: 'ident', v: ident[0] }); i += ident[0].length; continue; }
    throw new FilterError(`unexpected character in filter`);
  }
  return out;
}

function parse(src: string): Node | null {
  const tokens = tokenize(src);
  if (tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];

  const literal = (tok: Token | undefined): Literal => {
    if (!tok) throw new FilterError('filter ends after an operator');
    if (tok.t === 'text') return { kind: 'text', value: tok.v };
    if (tok.t === 'number') return { kind: 'number', value: tok.v };
    if (tok.t === 'ident') {
      if (tok.v === 'true' || tok.v === 'false') return { kind: 'bool', value: tok.v === 'true' };
      if (tok.v === 'null') return { kind: 'null' };
    }
    throw new FilterError('only a field compared with a value is supported');
  };

  const primary = (): Node => {
    const tok = tokens[pos++];
    if (!tok) throw new FilterError('filter ends early');
    if (tok.t === 'paren' && tok.v === '(') {
      const inner = orExpr();
      const close = tokens[pos++];
      if (!close || close.t !== 'paren' || close.v !== ')') throw new FilterError('unbalanced parentheses');
      return inner;
    }
    if (tok.t !== 'ident' || ['true', 'false', 'null'].includes(tok.v)) {
      throw new FilterError('a comparison has to start with a field name');
    }
    const op = tokens[pos++];
    if (!op || op.t !== 'op') throw new FilterError('expected an operator after a field');
    return { kind: 'cmp', field: tok.v, op: op.v, value: literal(tokens[pos++]) };
  };

  const andExpr = (): Node => {
    const items = [primary()];
    while (peek()?.t === 'join' && peek()!.v === '&&') { pos++; items.push(primary()); }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  };

  const orExpr = (): Node => {
    const items = [andExpr()];
    while (peek()?.t === 'join' && peek()!.v === '||') { pos++; items.push(andExpr()); }
    return items.length === 1 ? items[0] : { kind: 'or', items };
  };

  const node = orExpr();
  if (pos !== tokens.length) throw new FilterError('unexpected text after the filter');
  return node;
}

// Prisma has no literal true/false in a where; these two are what it renders
// as an always-true and an always-false condition.
export const TRUE: Record<string, unknown> = {};
export const FALSE: Record<string, unknown> = { id: { in: [] } };

const isEmpty = (l: Literal) => l.kind === 'null' || (l.kind === 'text' && l.value === '');

/** SQLite's NUMERIC affinity: text that reads as a number becomes one. */
function numericText(s: string): number | null {
  return /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/.test(s) ? Number(s) : null;
}

const PRISMA_OP: Record<string, string> = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };

function ordered(op: string, a: number, b: number): boolean {
  switch (op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    default: return false;
  }
}

const PB_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function textCmp(field: string, op: string, v: string): Record<string, unknown> {
  switch (op) {
    case '=': return { [field]: v };
    case '!=': return { [field]: { not: v } };
    case '~': return { [field]: { contains: v, mode: 'insensitive' } };
    case '!~': return { NOT: { [field]: { contains: v, mode: 'insensitive' } } };
    default: return { [field]: { [PRISMA_OP[op]]: v } };
  }
}

function comparison(c: Comparison, f: FieldMeta): Record<string, unknown> {
  const { op, value } = c;
  const name = f.name;
  if ((op === '~' || op === '!~') && (f.type !== 'text' && f.type !== 'file')) {
    throw new FilterError(`~ is only supported on text fields (${name})`);
  }
  if ((op === '~' || op === '!~') && value.kind === 'text' && value.value.includes('%')) {
    // PocketBase takes a value with % as a raw LIKE pattern. Nothing here does.
    throw new FilterError('a ~ value with % is not supported');
  }

  switch (f.type) {
    case 'text':
    case 'file': {
      if (value.kind === 'null') {
        if (op === '=') return { [name]: '' };
        if (op === '!=') return { [name]: { not: '' } };
        return FALSE; // ordered or LIKE against NULL: never true
      }
      const v = value.kind === 'text' ? value.value
        : value.kind === 'number' ? String(value.value)
        : value.value ? '1' : '0';
      return textCmp(name, op, v);
    }

    case 'relation': {
      if (op !== '=' && op !== '!=') throw new FilterError(`only = and != on relation ${name}`);
      if (isEmpty(value)) return op === '=' ? { [name]: null } : { [name]: { not: null } };
      if (value.kind !== 'text') throw new FilterError(`relation ${name} compared with a non-text value`);
      return op === '='
        ? { [name]: value.value }
        : { OR: [{ [name]: null }, { [name]: { not: value.value } }] };
    }

    case 'number':
    case 'bool': {
      if (op === '~' || op === '!~') throw new FilterError(`~ on ${name}`);
      let n: number | null = null;
      if (value.kind === 'number') n = value.value;
      else if (value.kind === 'bool') n = value.value ? 1 : 0;
      else if (value.kind === 'text') n = numericText(value.value);
      if (n === null) {
        // '' / null / non-numeric text: a stored number is never equal to it,
        // and orders before any text (null: every ordered comparison fails).
        if (op === '=') return FALSE;
        if (op === '!=') return TRUE;
        if (value.kind === 'null') return FALSE;
        return op === '<' || op === '<=' ? TRUE : FALSE;
      }
      if (f.type === 'number') {
        return op === '=' ? { [name]: n }
          : op === '!=' ? { [name]: { not: n } }
          : { [name]: { [PRISMA_OP[op]]: n } };
      }
      // A bool is 0 or 1 in SQLite; decide which of the two satisfy the test.
      const t = ordered(op, 1, n);
      const fl = ordered(op, 0, n);
      if (t && fl) return TRUE;
      if (!t && !fl) return FALSE;
      return { [name]: t };
    }

    case 'autodate': {
      if (op === '~' || op === '!~') throw new FilterError(`~ on ${name}`);
      if (isEmpty(value)) {
        if (op === '=') return { [name]: null };
        if (op === '!=') return { [name]: { not: null } };
        // '' compared by order: '' >= '' and '' <= '' hold, everything else is greater.
        if (value.kind === 'null') return FALSE;
        if (op === '>=' ) return TRUE;
        if (op === '<=') return { [name]: null };
        if (op === '>') return { [name]: { not: null } };
        return FALSE;
      }
      if (value.kind !== 'text') throw new FilterError(`${name} compared with a non-text value`);
      let at: Date;
      let o = op;
      if (PB_STAMP.test(value.value)) {
        at = new Date(value.value.replace(' ', 'T'));
      } else if (DATE_ONLY.test(value.value)) {
        // A stored stamp is longer than a bare date, so as text it is greater
        // than the date even at midnight: `>` means "on or after", `<=` "before".
        at = new Date(`${value.value}T00:00:00.000Z`);
        if (o === '>') o = '>=';
        else if (o === '<=') o = '<';
        else if (o === '=') return FALSE;
        else if (o === '!=') return TRUE;
      } else {
        throw new FilterError(`${name} compared with a value that is not a PocketBase date`);
      }
      if (Number.isNaN(at.getTime())) throw new FilterError(`${name}: invalid date`);
      // An empty stamp ('') was smaller than every date.
      if (o === '=') return { [name]: at };
      if (o === '!=') return { OR: [{ [name]: null }, { [name]: { not: at } }] };
      if (o === '<' || o === '<=') return { OR: [{ [name]: null }, { [name]: { [PRISMA_OP[o]]: at } }] };
      return { [name]: { [PRISMA_OP[o]]: at } };
    }

    case 'json':
      throw new FilterError(`filtering on JSON field ${name} is not supported`);
  }
}

function translate(node: Node, meta: CollectionMeta): Record<string, unknown> {
  // Cast, not narrowed: the project compiles without `strict`, where a union
  // does not narrow on its tag.
  if (node.kind === 'and' || node.kind === 'or') {
    const parts = (node as Group).items.map((n) => translate(n, meta));
    return node.kind === 'and' ? { AND: parts } : { OR: parts };
  }
  const cmp = node as Comparison;
  const f = meta.fields.find((x) => x.name === cmp.field);
  if (!f) throw new FilterError(`unknown field in filter: ${cmp.field}`);
  return comparison(cmp, f);
}

/** A PocketBase filter string as a Prisma `where` for one collection. */
export function filterToWhere(filter: string | undefined | null, meta: CollectionMeta): Record<string, unknown> {
  const node = parse(String(filter ?? ''));
  return node ? translate(node, meta) : TRUE;
}

/** A PocketBase sort string (`-match_date,created`) as a Prisma `orderBy`. */
export function sortToOrderBy(sort: string | undefined | null, meta: CollectionMeta): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of String(sort ?? '').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const desc = part.startsWith('-');
    const name = part.replace(/^[-+]/, '');
    if (name === '@rowid') { out.push({ seq: desc ? 'desc' : 'asc' }); continue; }
    const f = meta.fields.find((x) => x.name === name);
    if (!f) throw new FilterError(`unknown sort field: ${name}`);
    if (f.type === 'json') throw new FilterError(`sorting by JSON field ${name} is not supported`);
    const dir = desc ? 'desc' : 'asc';
    // Nullable columns: PocketBase's empty value ('') sorted before everything.
    if (f.type === 'relation' || f.type === 'autodate') {
      out.push({ [name]: { sort: dir, nulls: desc ? 'last' : 'first' } });
    } else {
      out.push({ [name]: dir });
    }
  }
  // Ties — and no sort at all — in insertion order, as SQLite's rowid did.
  out.push({ seq: 'asc' });
  return out;
}
