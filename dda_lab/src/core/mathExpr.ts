// Safe math-channel expression engine: hand-written tokenizer + recursive-descent
// parser + vectorized evaluator. No eval(), no Function().
//
// Identifiers are channel names. Functions:
//   abs, min, max, sqrt, pow                  (elementwise, scalars broadcast)
//   deriv(ch), integ(ch)                      (central difference / dtS, cumsum * dtS)
//   smooth(ch, n), shift(ch, s)               (moving average, shift by s seconds)
//   lap_min(ch), lap_max(ch)                  (per lap, using env.lapStarts)
//   where(c, a, b)
// Operators, loosest to tightest:
//   ||  <  &&  <  == !=  <  < <= > >=  <  + -  <  * /  <  ^ (right assoc)  <  unary - !

export interface EvalEnv {
  get(name: string): Float32Array;
  dtS: number;
  lapStarts?: number[];
}

export type Ast =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'unary'; op: '-' | '!'; arg: Ast }
  | { kind: 'binary'; op: BinOp; left: Ast; right: Ast }
  | { kind: 'call'; name: string; args: Ast[] };

export type BinOp =
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '^';

/** Arity of every supported function (`-1` = 1 or 2 args). */
const FUNCTIONS: Record<string, number> = {
  abs: 1,
  sqrt: 1,
  min: 2,
  max: 2,
  pow: 2,
  deriv: 1,
  integ: 1,
  smooth: 2,
  shift: 2,
  lap_min: 1,
  lap_max: 1,
  where: 3,
};

// ---------------------------------------------------------------- tokenizer

type TokType = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';
interface Tok {
  type: TokType;
  text: string;
  pos: number;
  value?: number;
}

const OPERATORS = [
  '||',
  '&&',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '^',
  '!',
];

function syntaxError(msg: string, pos: number): SyntaxError {
  return new SyntaxError(`${msg} at position ${pos}`);
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      out.push({ type: 'lparen', text: c, pos: i++ });
      continue;
    }
    if (c === ')') {
      out.push({ type: 'rparen', text: c, pos: i++ });
      continue;
    }
    if (c === ',') {
      out.push({ type: 'comma', text: c, pos: i++ });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      if (i < src.length && (src[i] === 'e' || src[i] === 'E')) {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (/[0-9]/.test(src[i] ?? '')) {
          while (i < src.length && /[0-9]/.test(src[i])) i++;
        } else {
          i = save;
        }
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw syntaxError(`Invalid number "${text}"`, start);
      out.push({ type: 'num', text, pos: start, value });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      out.push({ type: 'ident', text: src.slice(start, i), pos: start });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ type: 'op', text: op, pos: i });
      i += op.length;
      continue;
    }
    throw syntaxError(`Unexpected character "${c}"`, i);
  }
  out.push({ type: 'eof', text: '', pos: src.length });
  return out;
}

// ------------------------------------------------------------------- parser

/** Binary operator precedence levels, loosest first. */
const LEVELS: BinOp[][] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/'],
];

export function parseExpr(src: string): Ast {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];

  function parseBinary(level: number): Ast {
    if (level >= LEVELS.length) return parsePower();
    let left = parseBinary(level + 1);
    for (;;) {
      const t = peek();
      if (t.type === 'op' && (LEVELS[level] as string[]).includes(t.text)) {
        p++;
        const right = parseBinary(level + 1);
        left = { kind: 'binary', op: t.text as BinOp, left, right };
      } else {
        return left;
      }
    }
  }

  // ^ binds tighter than * / and is right associative; unary binds tighter still.
  function parsePower(): Ast {
    const base = parseUnary();
    const t = peek();
    if (t.type === 'op' && t.text === '^') {
      p++;
      const right = parsePower();
      return { kind: 'binary', op: '^', left: base, right };
    }
    return base;
  }

  function parseUnary(): Ast {
    const t = peek();
    if (t.type === 'op' && (t.text === '-' || t.text === '!')) {
      p++;
      return { kind: 'unary', op: t.text as '-' | '!', arg: parseUnary() };
    }
    if (t.type === 'op' && t.text === '+') {
      p++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): Ast {
    const t = peek();
    if (t.type === 'num') {
      p++;
      return { kind: 'num', value: t.value! };
    }
    if (t.type === 'ident') {
      p++;
      if (peek().type === 'lparen') {
        p++;
        const args: Ast[] = [];
        if (peek().type !== 'rparen') {
          for (;;) {
            args.push(parseBinary(0));
            if (peek().type === 'comma') {
              p++;
              continue;
            }
            break;
          }
        }
        const close = peek();
        if (close.type !== 'rparen') throw syntaxError('Expected ")"', close.pos);
        p++;
        return { kind: 'call', name: t.text, args };
      }
      return { kind: 'ident', name: t.text };
    }
    if (t.type === 'lparen') {
      p++;
      const inner = parseBinary(0);
      const close = peek();
      if (close.type !== 'rparen') throw syntaxError('Expected ")"', close.pos);
      p++;
      return inner;
    }
    if (t.type === 'eof') throw syntaxError('Unexpected end of expression', t.pos);
    throw syntaxError(`Unexpected token "${t.text}"`, t.pos);
  }

  if (toks.length === 1) throw syntaxError('Empty expression', 0);
  const ast = parseBinary(0);
  const rest = peek();
  if (rest.type !== 'eof') throw syntaxError(`Unexpected token "${rest.text}"`, rest.pos);
  return ast;
}

// ------------------------------------------------------------- dependencies

export function dependencies(ast: Ast): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: Ast): void => {
    switch (n.kind) {
      case 'ident':
        if (!seen.has(n.name)) {
          seen.add(n.name);
          out.push(n.name);
        }
        return;
      case 'unary':
        walk(n.arg);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'call':
        n.args.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(ast);
  return out;
}

// ---------------------------------------------------------------- evaluator

type Val = number | Float32Array;

function isArr(v: Val): v is Float32Array {
  return typeof v !== 'number';
}

function broadcast(v: Val, n: number): Float32Array {
  if (isArr(v)) return v;
  const out = new Float32Array(n);
  out.fill(v);
  return out;
}

function map1(v: Val, n: number, f: (x: number) => number): Val {
  if (!isArr(v)) return f(v);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f(v[i]);
  return out;
}

function map2(a: Val, b: Val, n: number, f: (x: number, y: number) => number): Val {
  if (!isArr(a) && !isArr(b)) return f(a, b);
  const out = new Float32Array(n);
  const av = broadcast(a, n);
  const bv = broadcast(b, n);
  for (let i = 0; i < n; i++) out[i] = f(av[i], bv[i]);
  return out;
}

const bool = (b: boolean): number => (b ? 1 : 0);

function lapSegments(n: number, lapStarts?: number[]): [number, number][] {
  const starts = (lapStarts ?? [])
    .filter((s) => Number.isFinite(s) && s >= 0 && s < n)
    .map((s) => Math.floor(s))
    .sort((a, b) => a - b);
  if (starts.length === 0) return [[0, n]];
  if (starts[0] !== 0) starts.unshift(0);
  const segs: [number, number][] = [];
  for (let i = 0; i < starts.length; i++) {
    segs.push([starts[i], i + 1 < starts.length ? starts[i + 1] : n]);
  }
  return segs;
}

function scalarOf(v: Val, what: string): number {
  if (isArr(v)) {
    if (v.length === 0) throw new Error(`${what} must be a scalar`);
    return v[0];
  }
  return v;
}

function callFn(name: string, args: Val[], n: number, env: EvalEnv): Val {
  const arity = FUNCTIONS[name];
  if (arity === undefined) throw new Error(`Unknown function: ${name}`);
  if (args.length !== arity) {
    throw new Error(`${name}() expects ${arity} argument(s), got ${args.length}`);
  }
  switch (name) {
    case 'abs':
      return map1(args[0], n, Math.abs);
    case 'sqrt':
      return map1(args[0], n, Math.sqrt);
    case 'min':
      return map2(args[0], args[1], n, Math.min);
    case 'max':
      return map2(args[0], args[1], n, Math.max);
    case 'pow':
      return map2(args[0], args[1], n, Math.pow);
    case 'deriv': {
      const v = broadcast(args[0], n);
      const out = new Float32Array(n);
      const dt = env.dtS;
      for (let i = 0; i < n; i++) {
        if (n < 2) {
          out[i] = NaN;
        } else if (i === 0) {
          out[i] = (v[1] - v[0]) / dt;
        } else if (i === n - 1) {
          out[i] = (v[n - 1] - v[n - 2]) / dt;
        } else {
          out[i] = (v[i + 1] - v[i - 1]) / (2 * dt);
        }
      }
      return out;
    }
    case 'integ': {
      const v = broadcast(args[0], n);
      const out = new Float32Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(v[i])) acc += v[i] * env.dtS;
        out[i] = acc;
      }
      return out;
    }
    case 'smooth': {
      const v = broadcast(args[0], n);
      const win = Math.max(1, Math.round(scalarOf(args[1], 'smooth(ch, n): n')));
      const half = Math.floor(win / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let cnt = 0;
        for (let j = i - half; j <= i + half; j++) {
          if (j < 0 || j >= n) continue;
          if (!Number.isFinite(v[j])) continue;
          sum += v[j];
          cnt++;
        }
        out[i] = cnt > 0 ? sum / cnt : NaN;
      }
      return out;
    }
    case 'shift': {
      const v = broadcast(args[0], n);
      const k = Math.round(scalarOf(args[1], 'shift(ch, s): s') / env.dtS);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const j = i - k;
        out[i] = j >= 0 && j < n ? v[j] : NaN;
      }
      return out;
    }
    case 'lap_min':
    case 'lap_max': {
      const v = broadcast(args[0], n);
      const out = new Float32Array(n);
      const wantMin = name === 'lap_min';
      for (const [a, b] of lapSegments(n, env.lapStarts)) {
        let acc = NaN;
        for (let i = a; i < b; i++) {
          const x = v[i];
          if (!Number.isFinite(x)) continue;
          if (Number.isNaN(acc)) acc = x;
          else acc = wantMin ? Math.min(acc, x) : Math.max(acc, x);
        }
        for (let i = a; i < b; i++) out[i] = acc;
      }
      return out;
    }
    case 'where': {
      const c = broadcast(args[0], n);
      const a = broadcast(args[1], n);
      const b = broadcast(args[2], n);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = c[i] !== 0 && !Number.isNaN(c[i]) ? a[i] : b[i];
      return out;
    }
    default:
      throw new Error(`Unknown function: ${name}`);
  }
}

export function evaluate(ast: Ast, env: EvalEnv): Float32Array {
  const deps = dependencies(ast);
  if (deps.length === 0) {
    throw new Error('Expression references no channel, so its length is unknown');
  }
  const first = env.get(deps[0]);
  const n = first.length;
  const cache = new Map<string, Float32Array>([[deps[0], first]]);
  const channel = (name: string): Float32Array => {
    let v = cache.get(name);
    if (!v) {
      v = env.get(name);
      cache.set(name, v);
    }
    if (v.length !== n) {
      const fit = new Float32Array(n);
      for (let i = 0; i < n; i++) fit[i] = i < v.length ? v[i] : NaN;
      return fit;
    }
    return v;
  };

  const ev = (node: Ast): Val => {
    switch (node.kind) {
      case 'num':
        return node.value;
      case 'ident':
        return channel(node.name);
      case 'unary':
        return node.op === '-'
          ? map1(ev(node.arg), n, (x) => -x)
          : map1(ev(node.arg), n, (x) => bool(!(x !== 0 && !Number.isNaN(x))));
      case 'binary': {
        const a = ev(node.left);
        const b = ev(node.right);
        switch (node.op) {
          case '+':
            return map2(a, b, n, (x, y) => x + y);
          case '-':
            return map2(a, b, n, (x, y) => x - y);
          case '*':
            return map2(a, b, n, (x, y) => x * y);
          case '/':
            return map2(a, b, n, (x, y) => x / y);
          case '^':
            return map2(a, b, n, (x, y) => Math.pow(x, y));
          case '<':
            return map2(a, b, n, (x, y) => bool(x < y));
          case '<=':
            return map2(a, b, n, (x, y) => bool(x <= y));
          case '>':
            return map2(a, b, n, (x, y) => bool(x > y));
          case '>=':
            return map2(a, b, n, (x, y) => bool(x >= y));
          case '==':
            return map2(a, b, n, (x, y) => bool(x === y));
          case '!=':
            return map2(a, b, n, (x, y) => bool(x !== y));
          case '&&':
            return map2(a, b, n, (x, y) => bool(truthy(x) && truthy(y)));
          case '||':
            return map2(a, b, n, (x, y) => bool(truthy(x) || truthy(y)));
          default:
            throw new Error(`Unknown operator: ${String((node as { op: string }).op)}`);
        }
      }
      case 'call':
        return callFn(
          node.name,
          node.args.map((a) => ev(a)),
          n,
          env,
        );
      default:
        throw new Error('Invalid AST node');
    }
  };

  return broadcast(ev(ast), n);
}

function truthy(x: number): boolean {
  return x !== 0 && !Number.isNaN(x);
}

// ------------------------------------------------------- dependency ordering

/**
 * Topologically sort math-channel definitions so that a channel referencing
 * another appears after it. Throws `cycle: a -> b -> a` on a dependency cycle.
 */
export function orderByDependencies<T extends { name: string; expr: string }>(defs: T[]): T[] {
  const byName = new Map<string, T>();
  for (const d of defs) byName.set(d.name, d);

  const depsOf = new Map<string, string[]>();
  for (const d of defs) {
    let refs: string[] = [];
    try {
      refs = dependencies(parseExpr(d.expr));
    } catch {
      refs = [];
    }
    depsOf.set(
      d.name,
      refs.filter((r) => byName.has(r)),
    );
  }

  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (name: string): void => {
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'visiting') {
      const from = path.indexOf(name);
      throw new Error(`cycle: ${[...path.slice(from), name].join(' -> ')}`);
    }
    state.set(name, 'visiting');
    path.push(name);
    for (const dep of depsOf.get(name) ?? []) visit(dep);
    path.pop();
    state.set(name, 'done');
    const def = byName.get(name);
    if (def) out.push(def);
  };

  for (const d of defs) visit(d.name);
  return out;
}
