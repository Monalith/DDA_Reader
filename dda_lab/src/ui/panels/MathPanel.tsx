import { useMemo, useRef, useState } from 'react';
import guideSource from '../../guide/MATH_GUIDE.md?raw';
import { CONSTANTS, FUNCTION_DOCS, dependencies, parseExpr } from '../../core/mathExpr';
import { MATH_PRESETS, type MathPreset } from '../../core/presets';
import { SESSION_COLORS, useLab } from '../../state/store';
import Markdown from './Markdown';

const EXAMPLES = [
  'rpm / max(speed, 1)',
  'accel_g(lowpass(speed, 1.5))',
  'where(tps > 20, lean, 0)',
];

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

export default function MathPanel() {
  const defs = useLab((s) => s.workspace.mathChannels);
  const sessions = useLab((s) => s.sessions);
  const { addMathChannel, removeMathChannel } = useLab.getState();

  const [sub, setSub] = useState<SubTab>('editor');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [color, setColor] = useState(SESSION_COLORS[2]);
  const [expr, setExpr] = useState('');
  const [search, setSearch] = useState('');
  const exprRef = useRef<HTMLTextAreaElement | null>(null);
  const parsed = useMemo(() => analyse(expr), [expr]);

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
  const canSave = Boolean(name.trim()) && parsed.ok;

  function save() {
    if (!canSave) return;
    addMathChannel({ name: name.trim(), unit: unit.trim(), expr: expr.trim(), color });
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

  const missingOf = (p: MathPreset) => p.needs.filter((n) => !known.has(n));

  const filteredPresets = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? MATH_PRESETS.filter((p) =>
          [p.label, p.expr, p.doc, p.name].some((s) => s.toLowerCase().includes(q)),
        )
      : MATH_PRESETS;
    const groups = new Map<string, MathPreset[]>();
    for (const p of list) {
      const arr = groups.get(p.group) ?? [];
      arr.push(p);
      groups.set(p.group, arr);
    }
    return [...groups.entries()];
  }, [search]);

  return (
    <div data-testid="math-panel">
      <nav className="math-subtabs" role="tablist" aria-label="Math sub-tabs">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={sub === t.id}
            className={`bp-btn${sub === t.id ? ' on' : ''}`}
            data-testid={`math-sub-${t.id}`}
            onClick={() => setSub(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {sub === 'editor' && (
        <div className="math-grid">
          <div>
            <div className="bp-row" style={{ marginBottom: 6 }}>
              <span className="bp-label">Name</span>
              <input
                className="bp-input"
                data-testid="math-name"
                value={name}
                placeholder="power_idx"
                onChange={(e) => setName(e.target.value)}
              />
              <span className="bp-label">Unit</span>
              <input
                className="bp-input"
                data-testid="math-unit"
                value={unit}
                style={{ width: 70 }}
                onChange={(e) => setUnit(e.target.value)}
              />
              <span className="bp-label">Colour</span>
              <input
                type="color"
                className="bp-input"
                data-testid="math-color"
                value={color}
                style={{ width: 36, padding: 0 }}
                onChange={(e) => setColor(e.target.value)}
              />
              <button className="bp-btn primary" data-testid="math-save" onClick={save} disabled={!canSave}>
                {defs.some((d) => d.name === name.trim()) ? 'Update' : 'Add'}
              </button>
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

            <textarea
              className="bp-textarea"
              data-testid="math-expr"
              ref={exprRef}
              spellCheck={false}
              placeholder="rpm / max(speed, 1)"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
            />

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

            <div className="ch-group-title">Math channels ({defs.length})</div>
            <div className="math-list" data-testid="math-list">
              {defs.length === 0 && <span className="bp-label">none yet</span>}
              {defs.map((d) => (
                <div className="row" key={d.name} data-testid={`math-item-${d.name}`}>
                  <span className="bp-swatch" style={{ background: d.color }} />
                  <strong>{d.name}</strong>
                  <span className="bp-label">{d.unit}</span>
                  <span className="expr">= {d.expr}</span>
                  <button
                    className="bp-btn"
                    data-testid={`math-edit-${d.name}`}
                    onClick={() => {
                      setName(d.name);
                      setUnit(d.unit);
                      setColor(d.color);
                      setExpr(d.expr);
                    }}
                  >
                    Edit
                  </button>
                  <button className="bp-btn danger" data-testid={`math-del-${d.name}`} onClick={() => removeMathChannel(d.name)}>
                    Delete
                  </button>
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
                        <code
                          role="button"
                          tabIndex={0}
                          className="clickable"
                          data-testid={`math-fn-${fn}`}
                          onClick={() => insert(`${fn}(`)}
                          onKeyDown={(e) => e.key === 'Enter' && insert(`${fn}(`)}
                        >
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
                  <code
                    key={k}
                    role="button"
                    tabIndex={0}
                    className="clickable"
                    data-testid={`math-const-${k}`}
                    onClick={() => insert(k)}
                    onKeyDown={(e) => e.key === 'Enter' && insert(k)}
                  >
                    {k} = {Number(v.toFixed(5))}
                  </code>
                ))}
              </div>
            </div>
            <p className="bp-label">
              Identifiers are channel names of the loaded sessions; results recompute per session.
            </p>
          </aside>
        </div>
      )}

      {sub === 'presets' && (
        <div data-testid="math-presets">
          <div className="bp-row" style={{ marginBottom: 8 }}>
            <span className="bp-label">Search</span>
            <input
              className="bp-input"
              data-testid="math-preset-search"
              value={search}
              placeholder="braking, lean, slip…"
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="bp-label num">
              {filteredPresets.reduce((n, [, list]) => n + list.length, 0)} of {MATH_PRESETS.length}
            </span>
            {!sessions.length && <span className="bp-err">Open a session first</span>}
          </div>

          {filteredPresets.map(([group, list]) => (
            <div key={group} style={{ marginBottom: 8 }}>
              <div className="ch-group-title">{group}</div>
              <div className="preset-cards">
                {list.map((p) => {
                  const missing = missingOf(p);
                  const disabled = !sessions.length || missing.length > 0;
                  const tip = !sessions.length
                    ? 'Open a session first'
                    : missing.length
                      ? `needs: ${missing.join(', ')}`
                      : p.doc;
                  const exists = defs.some((d) => d.name === p.name);
                  return (
                    <div className="preset-card" key={p.id} data-testid={`math-preset-${p.id}`}>
                      <div className="pc-head">
                        <span className="bp-swatch" style={{ background: p.color }} />
                        <strong>{p.label}</strong>
                        {exists && (
                          <span className="bp-badge ok" data-testid={`math-preset-have-${p.id}`} title="already added">
                            ✓
                          </span>
                        )}
                      </div>
                      <code className="pc-expr">{p.expr}</code>
                      <div className="pc-doc">{p.doc}</div>
                      <div className="pc-foot">
                        <span className="bp-label">
                          {p.name}
                          {p.unit ? ` · ${p.unit}` : ''}
                        </span>
                        <span className="bp-spacer" style={{ flex: 1 }} />
                        <button
                          className="bp-btn primary"
                          data-testid={`math-preset-add-${p.id}`}
                          disabled={disabled}
                          title={tip}
                          onClick={() =>
                            useLab
                              .getState()
                              .addMathChannel({ name: p.name, unit: p.unit, expr: p.expr, color: p.color })
                          }
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
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
