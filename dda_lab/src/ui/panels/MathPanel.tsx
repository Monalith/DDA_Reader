import { useMemo, useState } from 'react';
import { dependencies, parseExpr } from '../../core/mathExpr';
import { SESSION_COLORS, useLab } from '../../state/store';

const EXAMPLES = [
  'rpm / max(speed, 1)',
  'deriv(speed) / 3.6 / 9.81',
  'where(tps > 20, lean, 0)',
];

const HELP_FUNCS = 'abs min max sqrt pow deriv integ smooth(ch,n) shift(ch,s) lap_min lap_max where(c,a,b)';
const HELP_OPS = '+  −  *  /  ^   <  <=  >  >=  ==  !=   &&  ||  !   unary −   ( )';

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

export default function MathPanel() {
  const defs = useLab((s) => s.workspace.mathChannels);
  const sessions = useLab((s) => s.sessions);
  const { addMathChannel, removeMathChannel } = useLab.getState();

  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [color, setColor] = useState(SESSION_COLORS[2]);
  const [expr, setExpr] = useState('');
  const parsed = useMemo(() => analyse(expr), [expr]);

  const known = useMemo(() => {
    const s = new Set<string>();
    for (const ses of sessions) for (const k of ses.channels.keys()) s.add(k);
    return s;
  }, [sessions]);

  const unknownDeps = parsed.deps.filter((d) => !known.has(d) && d !== name);
  const canSave = Boolean(name.trim()) && parsed.ok;

  function save() {
    if (!canSave) return;
    addMathChannel({ name: name.trim(), unit: unit.trim(), expr: expr.trim(), color });
  }

  return (
    <div className="math-grid" data-testid="math-panel">
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
          <input className="bp-input" data-testid="math-unit" value={unit} style={{ width: 70 }} onChange={(e) => setUnit(e.target.value)} />
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

        <textarea
          className="bp-textarea"
          data-testid="math-expr"
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
              {unknownDeps.length ? (
                <span className="bp-err"> · unknown: {unknownDeps.join(', ')}</span>
              ) : null}
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
        <div className="ch-group-title">Help</div>
        <p>
          <strong>Operators</strong>
          <br />
          <code>{HELP_OPS}</code>
        </p>
        <p>
          <strong>Functions</strong>
          <br />
          <code>{HELP_FUNCS}</code>
        </p>
        <p>
          <strong>Examples</strong>
          <br />
          {EXAMPLES.map((ex) => (
            <span key={ex}>
              <code
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
                onClick={() => setExpr(ex)}
                onKeyDown={(e) => e.key === 'Enter' && setExpr(ex)}
              >
                {ex}
              </code>
              <br />
            </span>
          ))}
        </p>
        <p className="bp-label">Identifiers are channel names of the loaded sessions; results recompute per session.</p>
      </aside>
    </div>
  );
}
