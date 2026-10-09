import { useEffect, useMemo, useRef, useState } from 'react';
import guideSource from '../../guide/MATH_GUIDE.md?raw';
import { CONSTANTS, FUNCTION_DOCS, dependencies, parseExpr } from '../../core/mathExpr';
import {
  MATH_PRESETS,
  loadUserPresets,
  saveUserPresets,
  upsertUserPreset,
  type MathPreset,
  type UserMathPreset,
} from '../../core/presets';
import type { MathChannelDef } from '../../core/types';
import { SESSION_COLORS, lapKey, lapMetaOf, useLab } from '../../state/store';
import { selectedLapEntries } from '../../state/selectors';
import Markdown from './Markdown';

/** Expression for the integral builder. x = '' means time. */
export function integralExpr(y: string, x: string, perLap: boolean): string {
  if (!x) return perLap ? `lap_integ(${y})` : `integ(${y})`;
  return perLap ? `lap_integ_x(${y}, ${x})` : `integ_x(${y}, ${x})`;
}

const EXAMPLES = ['rpm / max(speed, 1)', 'accel_g(lowpass(speed, 1.5))', 'where(tps > 20, lean, 0)'];

type SubTab = 'editor' | 'presets' | 'guide';

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: 'editor', label: 'Editor' },
  { id: 'presets', label: 'Presets' },
  { id: 'guide', label: 'Guide' },
];

interface ParseState {
  ok: boolean;
  message: string;
  caret: string;
  deps: string[];
}

function analyse(src: string): ParseState {
  const text = src.trim();
  if (!text) return { ok: false, message: '', caret: '', deps: [] };
  try {
    const ast = parseExpr(text);
    return { ok: true, message: 'valid', caret: '', deps: dependencies(ast) };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const m = /at position (\d+)/.exec(msg);
    const pos = m ? Number(m[1]) : -1;
    const caret = pos >= 0 ? `${text}\n${' '.repeat(Math.min(pos, text.length))}^` : '';
    return { ok: false, message: msg, caret, deps: [] };
  }
}

/** First `name(` in a signature, used for click-to-insert. */
function firstFunction(sig: string): string | null {
  const m = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(sig);
  return m ? m[1] : null;
}

/** Scope value encoding: 'all' | 'session:<id>' | 'lap:<sessionId>:<lapN>' */
type Scope = { kind: 'all' } | { kind: 'session'; sessionId: string } | { kind: 'lap'; sessionId: string; lap: number };
const scopeToValue = (s: Scope): string => (s.kind === 'all' ? 'all' : s.kind === 'session' ? `session:${s.sessionId}` : `lap:${lapKey(s.sessionId, s.lap)}`);
function scopeFromValue(v: string): Scope {
  if (v.startsWith('session:')) return { kind: 'session', sessionId: v.slice(8) };
  if (v.startsWith('lap:')) {
    const k = v.slice(4);
    const i = k.lastIndexOf(':');
    return { kind: 'lap', sessionId: k.slice(0, i), lap: Number(k.slice(i + 1)) };
  }
  return { kind: 'all' };
}

/** One inline-editable formula field with validation and a save action. */
function ExprField({ value, onSave, testId, placeholder }: { value: string; onSave(v: string): void; testId: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const parsed = useMemo(() => analyse(draft), [draft]);
  const dirty = draft.trim() !== value.trim();
  return (
    <span className="expr-field">
      <input
        className="bp-input mono"
        data-testid={testId}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && parsed.ok && dirty) onSave(draft.trim());
          if (e.key === 'Escape') setDraft(value);
        }}
        title={parsed.ok || !draft.trim() ? 'Enter saves' : parsed.message}
        style={{ borderColor: draft.trim() && !parsed.ok ? 'var(--bad)' : undefined }}
      />
      {dirty && (
        <button className="bp-btn tiny primary" data-testid={`${testId}-save`} disabled={!parsed.ok} title={parsed.ok ? 'Save (Enter)' : parsed.message} onClick={() => onSave(draft.trim())}>
          Save
        </button>
      )}
    </span>
  );
}

export default function MathPanel() {
  const defs = useLab((s) => s.workspace.mathChannels);
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const lapMeta = useLab((s) => s.lapMeta);
  const { addMathChannel, removeMathChannel, setMathLapExpr, setMathSessionExpr } = useLab.getState();

  const [sub, setSub] = useState<SubTab>('editor');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [color, setColor] = useState(SESSION_COLORS[2]);
  const [expr, setExpr] = useState('');
  const [search, setSearch] = useState('');
  const [scopeV, setScopeV] = useState<string>('all');
  const [intY, setIntY] = useState('speed');
  const [intX, setIntX] = useState('lap_dist');
  const [intPerLap, setIntPerLap] = useState(true);
  const [userPresets, setUserPresets] = useState<UserMathPreset[]>(() => loadUserPresets());
  /** Draft edits of preset cards (expr/name/unit), keyed by preset id. */
  const [cardDraft, setCardDraft] = useState<Record<string, Partial<Pick<MathPreset, 'expr' | 'name' | 'unit' | 'label'>>>>({});
  const exprRef = useRef<HTMLTextAreaElement | null>(null);
  const parsed = useMemo(() => analyse(expr), [expr]);

  const persistUser = (list: UserMathPreset[]) => {
    setUserPresets(list);
    saveUserPresets(list);
  };

  const lapOptions = useMemo(
    () =>
      selectedLapEntries({ sessions, selectedLaps }).map(({ s, lap }) => ({
        sessionId: s.id,
        lap: lap.n,
        label: lapMetaOf({ sessions, lapMeta }, s.id, lap.n).name,
      })),
    [sessions, selectedLaps, lapMeta],
  );
  const scope = scopeFromValue(scopeV);
  const scopeValid =
    scope.kind === 'all' ||
    (scope.kind === 'session' && sessions.some((s) => s.id === scope.sessionId)) ||
    (scope.kind === 'lap' && lapOptions.some((o) => o.sessionId === scope.sessionId && o.lap === scope.lap));
  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name ?? id;
  const lapName = (k: string) => {
    const i = k.lastIndexOf(':');
    const o = lapOptions.find((x) => x.sessionId === k.slice(0, i) && x.lap === Number(k.slice(i + 1)));
    return o?.label ?? `${sessionName(k.slice(0, i))} L${k.slice(i + 1)}`;
  };

  const known = useMemo(() => {
    const s = new Set<string>();
    for (const ses of sessions) for (const k of ses.channels.keys()) s.add(k);
    return s;
  }, [sessions]);

  const firstSessionChannels = useMemo(
    () => (sessions[0] ? [...sessions[0].channels.keys()].sort((a, b) => a.localeCompare(b)) : []),
    [sessions],
  );

  const unknownDeps = parsed.deps.filter((d) => !known.has(d) && d !== name);
  const canSave = Boolean(name.trim()) && parsed.ok && scopeValid;

  function save() {
    if (!canSave) return;
    const n = name.trim();
    const e = expr.trim();
    if (scope.kind === 'all') {
      addMathChannel({ name: n, unit: unit.trim(), expr: e, color });
      return;
    }
    // scoped formula: create the channel first if it does not exist yet (same formula as default)
    if (!defs.some((d) => d.name === n)) addMathChannel({ name: n, unit: unit.trim(), expr: e, color });
    if (scope.kind === 'session') setMathSessionExpr(n, scope.sessionId, e);
    else setMathLapExpr(n, scope.sessionId, scope.lap, e);
  }

  function saveAsPreset(d?: MathChannelDef) {
    const n = (d?.name ?? name).trim();
    const e = (d?.expr ?? expr).trim();
    if (!n || !analyse(e).ok) return;
    const needs = dependencies(parseExpr(e)).filter((x) => !defs.some((m) => m.name === x));
    persistUser(upsertUserPreset(userPresets, { name: n, label: n, unit: (d?.unit ?? unit).trim(), color: d?.color ?? color, expr: e, doc: 'Saved from the editor' }, needs));
    useLab.getState().setStatus(`Preset "${n}" saved (Presets → My presets)`);
  }

  function buildIntegral() {
    const e = integralExpr(intY, intX, intPerLap);
    setExpr(e);
    if (!name.trim()) setName(`int_${intY}${intX ? `_${intX}` : ''}`.replace(/[^A-Za-z0-9_]/g, '_'));
  }

  /** Insert `text` at the caret of the expression textarea (or append). */
  function insert(text: string) {
    const el = exprRef.current;
    if (!el) {
      setExpr((prev) => prev + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
    setExpr(next);
    const caret = start + text.length;
    requestAnimationFrame(() => {
      el.focus();
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        /* ignore */
      }
    });
  }

  const loadIntoEditor = (d: { name: string; unit: string; color: string; expr: string }, sc = 'all') => {
    setName(d.name);
    setUnit(d.unit);
    setColor(d.color);
    setExpr(d.expr);
    setScopeV(sc);
    setSub('editor');
  };

  const allPresets: MathPreset[] = useMemo(() => [...userPresets, ...MATH_PRESETS], [userPresets]);
  const missingOf = (p: MathPreset) => p.needs.filter((n) => !known.has(n));

  const filteredPresets = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? allPresets.filter((p) => [p.label, p.expr, p.doc, p.name].some((s) => s.toLowerCase().includes(q))) : allPresets;
    const groups = new Map<string, MathPreset[]>();
    for (const p of list) {
      const arr = groups.get(p.group) ?? [];
      arr.push(p);
      groups.set(p.group, arr);
    }
    return [...groups.entries()];
  }, [search, allPresets]);

  const cardValue = (p: MathPreset) => ({ ...p, ...(cardDraft[p.id] ?? {}) });
  const setCard = (id: string, patch: Partial<Pick<MathPreset, 'expr' | 'name' | 'unit' | 'label'>>) =>
    setCardDraft((d) => ({ ...d, [id]: { ...(d[id] ?? {}), ...patch } }));
  const clearCard = (id: string) =>
    setCardDraft((d) => {
      const { [id]: _drop, ...rest } = d;
      void _drop;
      return rest;
    });

  return (
    <div data-testid="math-panel">
      <nav className="math-subtabs" role="tablist" aria-label="Math sub-tabs">
        {SUB_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={sub === t.id} className={`bp-btn${sub === t.id ? ' on' : ''}`} data-testid={`math-sub-${t.id}`} onClick={() => setSub(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {sub === 'editor' && (
        <div className="math-grid">
          <div>
            <div className="bp-row" style={{ marginBottom: 6 }}>
              <span className="bp-label">Name</span>
              <input className="bp-input" data-testid="math-name" value={name} placeholder="power_idx" onChange={(e) => setName(e.target.value)} />
              <span className="bp-label">Unit</span>
              <input className="bp-input" data-testid="math-unit" value={unit} style={{ width: 70 }} onChange={(e) => setUnit(e.target.value)} />
              <span className="bp-label">Colour</span>
              <input type="color" className="bp-input" data-testid="math-color" value={color} style={{ width: 36, padding: 0 }} onChange={(e) => setColor(e.target.value)} />
              <button className="bp-btn primary" data-testid="math-save" onClick={save} disabled={!canSave}>
                {scope.kind === 'session' && scopeValid
                  ? `Set for run ${sessionName(scope.sessionId)}`
                  : scope.kind === 'lap' && scopeValid
                    ? `Set for ${lapName(lapKey(scope.sessionId, scope.lap))}`
                    : defs.some((d) => d.name === name.trim())
                      ? 'Update'
                      : 'Add'}
              </button>
              <button className="bp-btn" data-testid="math-save-preset" disabled={!name.trim() || !parsed.ok} onClick={() => saveAsPreset()} title="Keep this formula as a reusable template (Presets → My presets)">
                ★ Save as preset
              </button>
            </div>

            <div className="bp-row math-scope" style={{ marginBottom: 6 }}>
              <span className="bp-label">Formula applies to</span>
              <select className="bp-select" data-testid="math-scope" value={scopeV} onChange={(e) => setScopeV(e.target.value)}>
                <option value="all">all runs and laps (default formula)</option>
                {sessions.map((s) => (
                  <option key={s.id} value={`session:${s.id}`}>
                    only run {s.name} (all its laps)
                  </option>
                ))}
                {lapOptions.map((o) => (
                  <option key={lapKey(o.sessionId, o.lap)} value={`lap:${lapKey(o.sessionId, o.lap)}`}>
                    only lap {o.label}
                  </option>
                ))}
              </select>
              {scope.kind !== 'all' && (
                <span className="bp-label">other runs keep the default formula (e.g. an offset for one bike: <code>speed + 3</code>)</span>
              )}
              {!scopeValid && <span className="bp-err">that run / lap is no longer loaded</span>}
            </div>

            <div className="integral-builder" data-testid="integral-builder">
              <span className="title">∫ Integral</span>
              <span className="bp-label">y =</span>
              <select className="bp-select" data-testid="integral-y" value={intY} onChange={(e) => setIntY(e.target.value)}>
                {firstSessionChannels.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <span className="bp-label">dx =</span>
              <select className="bp-select" data-testid="integral-x" value={intX} onChange={(e) => setIntX(e.target.value)}>
                <option value="">time (s)</option>
                {firstSessionChannels.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label className="bp-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={intPerLap} onChange={(e) => setIntPerLap(e.target.checked)} /> restart every lap
              </label>
              <button className="bp-btn" data-testid="integral-build" onClick={buildIntegral} disabled={!firstSessionChannels.length}>
                Build formula
              </button>
              <code className="bp-mono bp-label">{integralExpr(intY, intX, intPerLap)}</code>
            </div>

            <div className="bp-row" style={{ marginBottom: 4 }}>
              <span className="bp-label">Insert channel</span>
              <select
                className="bp-select"
                data-testid="math-insert-channel"
                value=""
                disabled={!firstSessionChannels.length}
                onChange={(e) => {
                  if (e.target.value) insert(e.target.value);
                  e.currentTarget.value = '';
                }}
              >
                <option value="">{firstSessionChannels.length ? 'channel…' : 'no session'}</option>
                {firstSessionChannels.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <span className="bp-label">Examples</span>
              {EXAMPLES.map((ex) => (
                <button key={ex} className="bp-btn mono-btn" onClick={() => setExpr(ex)}>
                  {ex}
                </button>
              ))}
            </div>

            <textarea className="bp-textarea" data-testid="math-expr" ref={exprRef} spellCheck={false} placeholder="rpm / max(speed, 1)" value={expr} onChange={(e) => setExpr(e.target.value)} />

            <div data-testid="math-validation" style={{ minHeight: 34, marginTop: 4 }}>
              {expr.trim() === '' && <span className="bp-label">Enter an expression using channel names.</span>}
              {expr.trim() !== '' && parsed.ok && (
                <span className="bp-ok">
                  ✓ valid · depends on {parsed.deps.length ? parsed.deps.join(', ') : '(constants only)'}
                  {unknownDeps.length ? <span className="bp-err"> · unknown: {unknownDeps.join(', ')}</span> : null}
                </span>
              )}
              {expr.trim() !== '' && !parsed.ok && (
                <div className="bp-err" data-testid="math-error">
                  {parsed.message}
                  {parsed.caret && <div className="bp-mono">{parsed.caret}</div>}
                </div>
              )}
            </div>

            <div className="ch-group-title">Math channels ({defs.length}) — edit in place, Enter saves</div>
            <div className="math-cards" data-testid="math-list">
              {defs.length === 0 && <span className="bp-label">none yet</span>}
              {defs.map((d) => (
                <div className="math-card" key={d.name} data-testid={`math-item-${d.name}`}>
                  <div className="row">
                    <input type="color" className="bp-input" value={/^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#ffffff'} style={{ width: 26, height: 22, padding: 0 }} title="Colour" onChange={(e) => addMathChannel({ ...d, color: e.target.value })} />
                    <strong>{d.name}</strong>
                    <input className="bp-input" value={d.unit} placeholder="unit" style={{ width: 60 }} title="Unit" onChange={(e) => addMathChannel({ ...d, unit: e.target.value })} />
                    <span className="bp-badge">all runs</span>
                    <ExprField value={d.expr} testId={`math-expr-${d.name}`} onSave={(v) => addMathChannel({ ...d, expr: v })} />
                    <span className="bp-spacer" style={{ flex: 1 }} />
                    <button className="bp-btn tiny" title="Load into the editor" data-testid={`math-edit-${d.name}`} onClick={() => loadIntoEditor(d)}>
                      Editor
                    </button>
                    <button className="bp-btn tiny" title="Add a formula for one run or lap only" onClick={() => loadIntoEditor(d, sessions[0] ? `session:${sessions[0].id}` : 'all')}>
                      + run/lap
                    </button>
                    <button className="bp-btn tiny" title="Save as preset" onClick={() => saveAsPreset(d)}>
                      ★
                    </button>
                    <button className="bp-btn tiny danger" data-testid={`math-del-${d.name}`} onClick={() => removeMathChannel(d.name)}>
                      Delete
                    </button>
                  </div>
                  {d.perSession && Object.keys(d.perSession).length > 0 && (
                    <div className="math-lap-overrides" data-testid={`math-persession-${d.name}`}>
                      {Object.entries(d.perSession).map(([sid, e]) => (
                        <div className="row" key={sid}>
                          <span className="bp-badge run">run</span>
                          <strong>{sessionName(sid)}</strong>
                          <ExprField value={e} testId={`math-persession-expr-${d.name}-${sid}`} onSave={(v) => setMathSessionExpr(d.name, sid, v)} />
                          <button className="bp-btn tiny danger" data-testid={`math-persession-del-${d.name}-${sid}`} title="Back to the default formula for this run" onClick={() => setMathSessionExpr(d.name, sid, null)}>
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {d.perLap && Object.keys(d.perLap).length > 0 && (
                    <div className="math-lap-overrides" data-testid={`math-perlap-${d.name}`}>
                      {Object.entries(d.perLap).map(([k, e]) => {
                        const i = k.lastIndexOf(':');
                        const sid = k.slice(0, i);
                        const lapStr = k.slice(i + 1);
                        return (
                          <div className="row" key={k}>
                            <span className="bp-badge">lap</span>
                            <strong>{lapName(k)}</strong>
                            <ExprField value={e} testId={`math-perlap-expr-${d.name}-${lapStr}`} onSave={(v) => setMathLapExpr(d.name, sid, Number(lapStr), v)} />
                            <button className="bp-btn tiny danger" data-testid={`math-perlap-del-${d.name}-${lapStr}`} title="Back to the default formula for this lap" onClick={() => setMathLapExpr(d.name, sid, Number(lapStr), null)}>
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <aside className="math-help" data-testid="math-help">
            <div className="ch-group-title">Function reference</div>
            <p className="bp-label">Click a signature to insert it at the caret.</p>
            {FUNCTION_DOCS.map((g) => (
              <div className="fn-group" key={g.group}>
                <div className="fn-group-title">{g.group}</div>
                {g.items.map((it) => {
                  const fn = firstFunction(it.sig);
                  return (
                    <div className="fn-item" key={it.sig} title={it.doc}>
                      {fn ? (
                        <code role="button" tabIndex={0} className="clickable" data-testid={`math-fn-${fn}`} onClick={() => insert(`${fn}(`)} onKeyDown={(e) => e.key === 'Enter' && insert(`${fn}(`)}>
                          {it.sig}
                        </code>
                      ) : (
                        <code>{it.sig}</code>
                      )}
                      <div className="fn-doc">{it.doc}</div>
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="fn-group">
              <div className="fn-group-title">Constants</div>
              <div className="fn-item">
                {Object.entries(CONSTANTS).map(([k, v]) => (
                  <code key={k} role="button" tabIndex={0} className="clickable" data-testid={`math-const-${k}`} onClick={() => insert(k)} onKeyDown={(e) => e.key === 'Enter' && insert(k)}>
                    {k} = {Number(v.toFixed(5))}
                  </code>
                ))}
              </div>
            </div>
            <p className="bp-label">Identifiers are channel names of the loaded sessions; results recompute per run.</p>
          </aside>
        </div>
      )}

      {sub === 'presets' && (
        <div data-testid="math-presets">
          <div className="bp-row" style={{ marginBottom: 8 }}>
            <span className="bp-label">Search</span>
            <input className="bp-input" data-testid="math-preset-search" value={search} placeholder="braking, lean, slip…" onChange={(e) => setSearch(e.target.value)} />
            <span className="bp-label num">
              {filteredPresets.reduce((n, [, list]) => n + list.length, 0)} of {allPresets.length}
            </span>
            {!sessions.length && <span className="bp-err">Open a session first</span>}
            <span className="bp-label">· cards are editable: change the formula, then Add (or Save for your own presets)</span>
          </div>

          {filteredPresets.map(([group, list]) => (
            <div key={group} style={{ marginBottom: 8 }}>
              <div className="ch-group-title">{group}</div>
              <div className="preset-cards">
                {list.map((p0) => {
                  const p = cardValue(p0);
                  const mine = p0.group === 'My presets';
                  const dirty = Boolean(cardDraft[p0.id]);
                  const parsedCard = analyse(p.expr);
                  const missing = missingOf(p0).filter((n) => parsedCard.deps.includes(n));
                  const disabled = !sessions.length || !parsedCard.ok || !p.name.trim();
                  const tip = !sessions.length ? 'Open a session first' : !parsedCard.ok ? parsedCard.message : missing.length ? `needs: ${missing.join(', ')}` : p.doc;
                  const exists = defs.some((d) => d.name === p.name);
                  return (
                    <div className={`preset-card${mine ? ' mine' : ''}`} key={p0.id} data-testid={`math-preset-${p0.id}`}>
                      <div className="pc-head">
                        <span className="bp-swatch" style={{ background: p.color }} />
                        {mine ? (
                          <input className="bp-input pc-label" value={p.label} onChange={(e) => setCard(p0.id, { label: e.target.value })} title="Title" />
                        ) : (
                          <strong>{p.label}</strong>
                        )}
                        {exists && (
                          <span className="bp-badge ok" data-testid={`math-preset-have-${p0.id}`} title="already added">
                            ✓
                          </span>
                        )}
                        {dirty && <span className="bp-badge" title="edited on the card">edited</span>}
                      </div>
                      <textarea
                        className="pc-expr-edit"
                        data-testid={`math-preset-expr-${p0.id}`}
                        value={p.expr}
                        spellCheck={false}
                        rows={2}
                        onChange={(e) => setCard(p0.id, { expr: e.target.value })}
                        style={{ borderColor: parsedCard.ok ? undefined : 'var(--bad)' }}
                        title={parsedCard.ok ? 'Formula (editable)' : parsedCard.message}
                      />
                      <div className="pc-doc">{p.doc}</div>
                      <div className="pc-foot">
                        <input className="bp-input pc-name" data-testid={`math-preset-name-${p0.id}`} value={p.name} title="Channel name" onChange={(e) => setCard(p0.id, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} />
                        <input className="bp-input pc-unit" value={p.unit} placeholder="unit" title="Unit" onChange={(e) => setCard(p0.id, { unit: e.target.value })} />
                        <span className="bp-spacer" style={{ flex: 1 }} />
                        {dirty && (
                          <button className="bp-btn tiny" title="Discard card edits" onClick={() => clearCard(p0.id)}>
                            ↺
                          </button>
                        )}
                        {mine ? (
                          <>
                            <button
                              className="bp-btn tiny"
                              data-testid={`math-preset-save-${p0.id}`}
                              disabled={!parsedCard.ok || !p.name.trim()}
                              title="Save the edits into this preset"
                              onClick={() => {
                                persistUser(upsertUserPreset(userPresets.filter((u) => u.id !== p0.id), { name: p.name, label: p.label, unit: p.unit, color: p.color, expr: p.expr, doc: p.doc }, parsedCard.deps.filter((x) => !defs.some((m) => m.name === x))));
                                clearCard(p0.id);
                              }}
                            >
                              Save
                            </button>
                            <button className="bp-btn tiny danger" data-testid={`math-preset-del-${p0.id}`} title="Delete this preset" onClick={() => persistUser(userPresets.filter((u) => u.id !== p0.id))}>
                              ✕
                            </button>
                          </>
                        ) : (
                          <button
                            className="bp-btn tiny"
                            title="Copy to My presets (with your edits)"
                            disabled={!parsedCard.ok}
                            onClick={() => persistUser(upsertUserPreset(userPresets, { name: p.name, label: p.label, unit: p.unit, color: p.color, expr: p.expr, doc: p.doc }, parsedCard.deps))}
                          >
                            ★
                          </button>
                        )}
                        <button className="bp-btn tiny" title="Open in the editor" onClick={() => loadIntoEditor({ name: p.name, unit: p.unit, color: p.color, expr: p.expr })}>
                          Editor
                        </button>
                        <button
                          className="bp-btn primary"
                          data-testid={`math-preset-add-${p0.id}`}
                          disabled={disabled}
                          title={tip}
                          onClick={() => useLab.getState().addMathChannel({ name: p.name, unit: p.unit, expr: p.expr.trim(), color: p.color })}
                        >
                          {exists ? 'Update' : 'Add'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!userPresets.length && (
            <p className="bp-label">
              No presets of your own yet — write a formula in the Editor and press <strong>★ Save as preset</strong>, or press ★ on any card.
            </p>
          )}
        </div>
      )}

      {sub === 'guide' && (
        <div className="math-guide" data-testid="math-guide">
          <Markdown source={guideSource} />
        </div>
      )}
    </div>
  );
}
