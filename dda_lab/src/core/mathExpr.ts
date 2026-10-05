import { butterworthLowpass, savitzkyGolay } from './filters';
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
  // elementwise
  abs: 1, sqrt: 1, sign: 1, floor: 1, ceil: 1, round: 1, exp: 1, log: 1, log10: 1,
  sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, atan2: 2, hypot: 2,
  min: 2, max: 2, pow: 2, mod: 2, clamp: 3, where: 3, isnan: 1, nanfill: 2,
  deg2rad: 1, rad2deg: 1, kmh2ms: 1, ms2kmh: 1,
  // calculus / time
  deriv: 1, integ: 1, diff: 1, cumsum: 1, shift: 2, lag: 2, accel_g: 1,
  // integrals with a chosen x channel / per-lap reset
  integ_x: 2, lap_integ: 1, lap_integ_x: 2, deriv_x: 2,
  // rolling windows (ch, nSamples)
  smooth: 2, rolling_mean: 2, rolling_min: 2, rolling_max: 2, rolling_std: 2, median: 2,
  // filters
  lowpass: 2, highpass: 2, sg: 2,
  // whole-channel statistics (broadcast scalars)
  mean: 1, std: 1, cmin: 1, cmax: 1,
  // per-lap statistics
  lap_min: 1, lap_max: 1, lap_mean: 1, lap_sum: 1, lap_first: 1, lap_last: 1, lap_time: 1, lap_progress: 1,
  // events
  rising: 1, falling: 1, hold: 2,
};

/** Named constants usable as identifiers. */
export const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, g: 9.80665 };

/** Human-readable function reference, grouped — rendered by the in-app guide. */
export const FUNCTION_DOCS: { group: string; items: { sig: string; doc: string }[] }[] = [
  { group: 'Elementwise', items: [
    { sig: 'abs(x) sqrt(x) sign(x) floor(x) ceil(x) round(x)', doc: 'Basic math on every sample.' },
    { sig: 'exp(x) log(x) log10(x)', doc: 'Exponential and logarithms.' },
    { sig: 'sin(x) cos(x) tan(x) asin(x) acos(x) atan(x) atan2(y, x)', doc: 'Trigonometry in radians; use deg2rad()/rad2deg().' },
    { sig: 'min(a, b) max(a, b) pow(a, b) mod(a, b) hypot(a, b) clamp(x, lo, hi)', doc: 'Two-argument helpers; scalars broadcast.' },
    { sig: 'where(cond, a, b)', doc: 'a where cond is true (non-zero), else b. Comparisons give 1/0.' },
    { sig: 'isnan(x) nanfill(x, v)', doc: 'Detect or replace missing samples (NaN).' },
    { sig: 'deg2rad(x) rad2deg(x) kmh2ms(x) ms2kmh(x)', doc: 'Unit conversions.' },
  ] },
  { group: 'Calculus & time', items: [
    { sig: 'deriv(ch)', doc: 'Time derivative per second (central difference). deriv(speed) is km/h per s.' },
    { sig: 'accel_g(speed_kmh)', doc: 'Longitudinal acceleration in g from a km/h speed channel.' },
    { sig: 'integ(ch) cumsum(ch)', doc: 'Running integral over time (unit·s) / running sum of samples.' },
    { sig: 'integ_x(y, x)', doc: 'Running integral ∫ y dx with your own x channel (trapezoid), e.g. integ_x(long_g, lap_dist).' },
    { sig: 'lap_integ(y) lap_integ_x(y, x)', doc: 'Same integrals, but restarting from 0 at every lap start.' },
    { sig: 'deriv_x(y, x)', doc: 'dy/dx with your own x channel, e.g. deriv_x(speed, lap_dist) = km/h per metre.' },
    { sig: 'diff(ch)', doc: 'Sample-to-sample difference.' },
    { sig: 'shift(ch, seconds) lag(ch, samples)', doc: 'Move a channel later in time (negative = earlier).' },
  ] },
  { group: 'Rolling windows (n = samples, 10 per second)', items: [
    { sig: 'smooth(ch, n) rolling_mean(ch, n)', doc: 'Centred moving average.' },
    { sig: 'rolling_min(ch, n) rolling_max(ch, n) rolling_std(ch, n) median(ch, n)', doc: 'Other centred window statistics.' },
  ] },
  { group: 'Filters', items: [
    { sig: 'lowpass(ch, hz)', doc: '2nd-order zero-phase Butterworth low-pass, cutoff in Hz (try 0.5–3).' },
    { sig: 'highpass(ch, hz)', doc: 'ch − lowpass(ch, hz): keeps the fast part (vibration, chatter).' },
    { sig: 'sg(ch, n)', doc: 'Savitzky-Golay smoothing, odd window of n samples.' },
  ] },
  { group: 'Statistics', items: [
    { sig: 'mean(ch) std(ch) cmin(ch) cmax(ch)', doc: 'Whole-channel value, broadcast to every sample.' },
    { sig: 'lap_min(ch) lap_max(ch) lap_mean(ch) lap_sum(ch) lap_first(ch) lap_last(ch)', doc: 'Per-lap statistics, constant inside each lap.' },
    { sig: 'lap_time(ch) lap_progress(ch)', doc: 'Seconds since lap start / 0–1 progress through the lap (argument only fixes the length).' },
  ] },
  { group: 'Events', items: [
    { sig: 'rising(cond) falling(cond)', doc: '1 on the sample where cond becomes true / false, else 0.' },
    { sig: 'hold(cond, seconds)', doc: '1 while cond was true within the last N seconds.' },
  ] },
  { group: 'Constants & operators', items: [
    { sig: 'pi e g', doc: '3.14159…, 2.71828…, 9.80665 m/s².' },
    { sig: '+ − * / ^   < <= > >= == !=   && || !', doc: 'Arithmetic, comparison (1/0) and logic. Parentheses group.' },
  ] },
];

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
        if (!(n.name in CONSTANTS) && !seen.has(n.name)) {
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
    case 'lap_integ': {
      const v = broadcast(args[0], n);
      const out = new Float32Array(n);
      for (const [a, b] of lapSegments(n, env.lapStarts)) {
        let acc = 0;
        for (let i = a; i < b; i++) {
          if (Number.isFinite(v[i])) acc += v[i] * env.dtS;
          out[i] = acc;
        }
      }
      return out;
    }
    case 'integ_x':
    case 'lap_integ_x': {
      const y = broadcast(args[0], n);
      const x = broadcast(args[1], n);
      const out = new Float32Array(n);
      const segs = name === 'lap_integ_x' ? lapSegments(n, env.lapStarts) : [[0, n] as [number, number]];
      for (const [a, b] of segs) {
        let acc = 0;
        let px = NaN;
        let py = NaN;
        for (let i = a; i < b; i++) {
          const xi = x[i];
          const yi = y[i];
          if (Number.isFinite(xi) && Number.isFinite(yi)) {
            if (Number.isFinite(px)) {
              const dx = xi - px;
              // a wrap of the x channel (e.g. lap_dist back to 0) is not integrated
              if (dx >= 0) acc += 0.5 * (yi + py) * dx;
            }
            px = xi;
            py = yi;
          }
          out[i] = acc;
        }
      }
      return out;
    }
    case 'deriv_x': {
      const y = broadcast(args[0], n);
      const x = broadcast(args[1], n);
      const out = new Float32Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        const i0 = i > 0 ? i - 1 : i;
        const i1 = i < n - 1 ? i + 1 : i;
        const dx = x[i1] - x[i0];
        out[i] = Number.isFinite(dx) && dx !== 0 ? (y[i1] - y[i0]) / dx : NaN;
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
    case 'sign': return map1(args[0], n, Math.sign);
    case 'floor': return map1(args[0], n, Math.floor);
    case 'ceil': return map1(args[0], n, Math.ceil);
    case 'round': return map1(args[0], n, Math.round);
    case 'exp': return map1(args[0], n, Math.exp);
    case 'log': return map1(args[0], n, Math.log);
    case 'log10': return map1(args[0], n, Math.log10);
    case 'sin': return map1(args[0], n, Math.sin);
    case 'cos': return map1(args[0], n, Math.cos);
    case 'tan': return map1(args[0], n, Math.tan);
    case 'asin': return map1(args[0], n, Math.asin);
    case 'acos': return map1(args[0], n, Math.acos);
    case 'atan': return map1(args[0], n, Math.atan);
    case 'atan2': return map2(args[0], args[1], n, Math.atan2);
    case 'hypot': return map2(args[0], args[1], n, Math.hypot);
    case 'mod': return map2(args[0], args[1], n, (a, b) => ((a % b) + b) % b);
    case 'deg2rad': return map1(args[0], n, (x) => (x * Math.PI) / 180);
    case 'rad2deg': return map1(args[0], n, (x) => (x * 180) / Math.PI);
    case 'kmh2ms': return map1(args[0], n, (x) => x / 3.6);
    case 'ms2kmh': return map1(args[0], n, (x) => x * 3.6);
    case 'isnan': return map1(args[0], n, (x) => bool(Number.isNaN(x)));
    case 'nanfill': return map2(args[0], args[1], n, (x, v) => (Number.isNaN(x) ? v : x));
    case 'clamp': {
      const x = broadcast(args[0], n);
      const lo = broadcast(args[1], n);
      const hi = broadcast(args[2], n);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.min(hi[i], Math.max(lo[i], x[i]));
      return out;
    }
    case 'accel_g': {
      const d = callFn('deriv', [args[0]], n, env) as Float32Array;
      return map1(d, n, (x) => x / 3.6 / 9.80665);
    }
    case 'diff': {
      const v = broadcast(args[0], n);
      const out = new Float32Array(n);
      out[0] = NaN;
      for (let i = 1; i < n; i++) out[i] = v[i] - v[i - 1];
      return out;
    }
    case 'cumsum': {
      const v = broadcast(args[0], n);
      const out = new Float32Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(v[i])) acc += v[i];
        out[i] = acc;
      }
      return out;
    }
    case 'lag': {
      const v = broadcast(args[0], n);
      const k = Math.round(scalarOf(args[1], 'lag(ch, samples): samples'));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const j = i - k;
        out[i] = j >= 0 && j < n ? v[j] : NaN;
      }
      return out;
    }
    case 'rolling_mean':
      return callFn('smooth', args, n, env);
    case 'rolling_min':
    case 'rolling_max':
    case 'rolling_std':
    case 'median': {
      const v = broadcast(args[0], n);
      const win = Math.max(1, Math.round(scalarOf(args[1], `${name}(ch, n): n`)));
      const half = Math.floor(win / 2);
      const out = new Float32Array(n);
      const buf: number[] = [];
      for (let i = 0; i < n; i++) {
        buf.length = 0;
        for (let j = i - half; j <= i + half; j++) if (j >= 0 && j < n && Number.isFinite(v[j])) buf.push(v[j]);
        if (!buf.length) {
          out[i] = NaN;
          continue;
        }
        if (name === 'rolling_min') out[i] = Math.min(...buf);
        else if (name === 'rolling_max') out[i] = Math.max(...buf);
        else if (name === 'median') {
          buf.sort((a, b) => a - b);
          const m = buf.length >> 1;
          out[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
        } else {
          const mu = buf.reduce((a, b) => a + b, 0) / buf.length;
          out[i] = Math.sqrt(buf.reduce((a, b) => a + (b - mu) * (b - mu), 0) / buf.length);
        }
      }
      return out;
    }
    case 'lowpass': {
      const v = broadcast(args[0], n);
      const hz = scalarOf(args[1], 'lowpass(ch, hz): hz');
      return butterworthLowpass(Float32Array.from(v), hz, 1 / env.dtS);
    }
    case 'highpass': {
      const v = broadcast(args[0], n);
      const lp = butterworthLowpass(Float32Array.from(v), scalarOf(args[1], 'highpass(ch, hz): hz'), 1 / env.dtS);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v[i] - lp[i];
      return out;
    }
    case 'sg': {
      const v = broadcast(args[0], n);
      let win = Math.max(3, Math.round(scalarOf(args[1], 'sg(ch, n): n')));
      if (win % 2 === 0) win += 1;
      return savitzkyGolay(Float32Array.from(v), win, 2);
    }
    case 'mean':
    case 'std':
    case 'cmin':
    case 'cmax': {
      const v = broadcast(args[0], n);
      let sum = 0, cnt = 0, mn = Infinity, mx = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = v[i];
        if (!Number.isFinite(x)) continue;
        sum += x; cnt++; if (x < mn) mn = x; if (x > mx) mx = x;
      }
      if (!cnt) return NaN;
      if (name === 'cmin') return mn;
      if (name === 'cmax') return mx;
      const mu = sum / cnt;
      if (name === 'mean') return mu;
      let ss = 0;
      for (let i = 0; i < n; i++) if (Number.isFinite(v[i])) ss += (v[i] - mu) * (v[i] - mu);
      return Math.sqrt(ss / cnt);
    }
    case 'lap_mean':
    case 'lap_sum':
    case 'lap_first':
    case 'lap_last':
    case 'lap_time':
    case 'lap_progress': {
      const v = broadcast(args[0], n);
      const out = new Float32Array(n);
      for (const [a, b] of lapSegments(n, env.lapStarts)) {
        if (name === 'lap_time' || name === 'lap_progress') {
          const len = Math.max(1, b - a - 1);
          for (let i = a; i < b; i++) out[i] = name === 'lap_time' ? (i - a) * env.dtS : (i - a) / len;
          continue;
        }
        let sum = 0, cnt = 0, first = NaN, last = NaN;
        for (let i = a; i < b; i++) {
          const x = v[i];
          if (!Number.isFinite(x)) continue;
          if (Number.isNaN(first)) first = x;
          last = x; sum += x; cnt++;
        }
        const val = name === 'lap_mean' ? (cnt ? sum / cnt : NaN) : name === 'lap_sum' ? sum : name === 'lap_first' ? first : last;
        for (let i = a; i < b; i++) out[i] = val;
      }
      return out;
    }
    case 'rising':
    case 'falling': {
      const c = broadcast(args[0], n);
      const out = new Float32Array(n);
      const truthy = (x: number) => x !== 0 && !Number.isNaN(x);
      for (let i = 1; i < n; i++) {
        const prev = truthy(c[i - 1]);
        const cur = truthy(c[i]);
        out[i] = bool(name === 'rising' ? !prev && cur : prev && !cur);
      }
      return out;
    }
    case 'hold': {
      const c = broadcast(args[0], n);
      const k = Math.max(0, Math.round(scalarOf(args[1], 'hold(cond, seconds): seconds') / env.dtS));
      const out = new Float32Array(n);
      let lastTrue = -Infinity;
      for (let i = 0; i < n; i++) {
        if (c[i] !== 0 && !Number.isNaN(c[i])) lastTrue = i;
        out[i] = bool(i - lastTrue <= k);
      }
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
        return node.name in CONSTANTS ? CONSTANTS[node.name] : channel(node.name);
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

  const res = broadcast(ev(ast), n);
  // `k = speed` must not alias the source channel: callers write into the result.
  for (const v of cache.values()) if (v === res) return res.slice();
  return res;
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
