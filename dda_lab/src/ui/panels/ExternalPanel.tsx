import { useEffect, useMemo, useRef, useState } from 'react';
import { externalCsvToChannels, sniffCsv, type CsvMapping } from '../../core/csvImport';
import type { Channel } from '../../core/types';
import { useLab } from '../../state/store';

const PREVIEW_S = 60;

function sanitize(col: string): string {
  return (
    col
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'ext'
  );
}

interface ColMap {
  col: string;
  use: boolean;
  name: string;
  unit: string;
}

/** Normalize a slice of a channel to 0..1 for the overlay preview. */
function normalize(v: Float32Array, n: number): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n && i < v.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    if (v[i] < min) min = v[i];
    if (v[i] > max) max = v[i];
  }
  const span = max - min || 1;
  const out: number[] = [];
  for (let i = 0; i < n && i < v.length; i++) out.push(Number.isFinite(v[i]) ? (v[i] - min) / span : NaN);
  return out;
}

export default function ExternalPanel() {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const { addExternalChannels, setStatus } = useLab.getState();
  const fileRef = useRef<HTMLInputElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [preview, setPreview] = useState<string[][]>([]);
  const [isExport, setIsExport] = useState(false);
  const [timeCol, setTimeCol] = useState('');
  const [timeUnit, setTimeUnit] = useState<'s' | 'ms'>('s');
  const [decimal, setDecimal] = useState<'.' | ','>('.');
  const [method, setMethod] = useState<'linear' | 'step'>('linear');
  const [offsetS, setOffsetS] = useState(0);
  const [cols, setCols] = useState<ColMap[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState('');

  const sessionId = pick ?? selectedLaps[0]?.sessionId ?? sessions[0]?.id ?? null;
  const session = sessions.find((s) => s.id === sessionId) ?? sessions[0];

  async function onFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    try {
      const raw = await f.text();
      const sniff = sniffCsv(raw);
      setText(raw);
      setFileName(f.name);
      setColumns(sniff.columns);
      setPreview(sniff.preview);
      setIsExport(sniff.isDdaReaderExport);
      const tCol = sniff.columns.find((c) => /time|timestamp|^t$/i.test(c)) ?? sniff.columns[0] ?? '';
      setTimeCol(tCol);
      setDecimal(raw.includes(';') ? ',' : '.');
      const rest = sniff.columns.filter((c) => c !== tCol);
      setCols(rest.map((c, i) => ({ col: c, use: i === 0, name: sanitize(c), unit: '' })));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const mapping = useMemo<CsvMapping>(
    () => ({
      timeCol,
      timeUnit,
      decimal,
      channels: cols.filter((c) => c.use).map((c) => ({ col: c.col, name: c.name, unit: c.unit })),
      offsetS,
      method,
    }),
    [timeCol, timeUnit, decimal, cols, offsetS, method],
  );

  const result = useMemo<{ channels: Channel[] | null; error: string }>(() => {
    if (!text || !session || !mapping.channels.length || !mapping.timeCol) return { channels: null, error: '' };
    try {
      return { channels: externalCsvToChannels(text, mapping, session.t), error: '' };
    } catch (e) {
      return { channels: null, error: (e as Error).message };
    }
  }, [text, session, mapping]);
  const built = result.channels;
  const mapError = error || result.error;

  // live overlay preview: first mapped channel vs session speed, first 60 s
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, w, h);
    if (!session) return;
    const hz = session.t.length > 1 ? 1 / (session.t[1] - session.t[0]) : 10;
    const n = Math.min(session.t.length, Math.round(PREVIEW_S * hz));
    const line = (vals: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      vals.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          started = false;
          return;
        }
        const x = (i / Math.max(1, vals.length - 1)) * (w - 2) + 1;
        const y = h - 2 - v * (h - 4);
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      });
      ctx.stroke();
    };
    const speed = session.channels.get('speed')?.data;
    if (speed) line(normalize(speed, n), '#3da5ff');
    if (built?.[0]) line(normalize(built[0].data, n), '#ff6a00');
    ctx.fillStyle = '#8b95a5';
    ctx.font = '9px sans-serif';
    ctx.fillText(`0–${Math.round(n / hz)} s · blue = speed, orange = ${built?.[0]?.name ?? 'external'}`, 4, 10);
  }, [session, built]);

  function apply() {
    if (!session || !built) return;
    addExternalChannels(session.id, built);
    setStatus(`Imported ${built.length} channel(s) from ${fileName}`);
  }

  return (
    <div data-testid="external-panel">
      <div className="bp-row" style={{ marginBottom: 6 }}>
        <button className="bp-btn primary" data-testid="ext-open" onClick={() => fileRef.current?.click()}>
          📄 Choose CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt"
          hidden
          data-testid="ext-file"
          onChange={(e) => onFile(e.target.files)}
        />
        {fileName && (
          <span className="bp-label">
            {fileName} · {columns.length} columns · {preview.length} preview rows
            {isExport ? ' · DDA_Reader export' : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="bp-label">Target session</span>
        <select
          className="bp-select"
          data-testid="ext-session"
          value={session?.id ?? ''}
          onChange={(e) => setPick(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {!session && <div className="bp-empty">Load a session first — external channels are resampled onto its time base.</div>}

      {session && !columns.length && <div className="bp-empty">Pick a CSV/TXT file to map its columns onto this session.</div>}

      {session && columns.length > 0 && (
        <>
          <div className="bp-row" style={{ marginBottom: 6 }}>
            <span className="bp-label">Time column</span>
            <select className="bp-select" data-testid="ext-timecol" value={timeCol} onChange={(e) => setTimeCol(e.target.value)}>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="bp-label">Unit</span>
            <select
              className="bp-select"
              data-testid="ext-timeunit"
              value={timeUnit}
              onChange={(e) => setTimeUnit(e.target.value as 's' | 'ms')}
            >
              <option value="s">s</option>
              <option value="ms">ms</option>
            </select>
            <span className="bp-label">Decimal</span>
            <select
              className="bp-select"
              data-testid="ext-decimal"
              value={decimal}
              onChange={(e) => setDecimal(e.target.value as '.' | ',')}
            >
              <option value=".">.</option>
              <option value=",">,</option>
            </select>
            <span className="bp-label">Resample</span>
            <select
              className="bp-select"
              data-testid="ext-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as 'linear' | 'step')}
            >
              <option value="linear">linear</option>
              <option value="step">step</option>
            </select>
          </div>

          <div className="ext-cols" data-testid="ext-cols">
            {cols.map((c, i) => (
              <label className="ext-col" key={c.col}>
                <input
                  type="checkbox"
                  data-testid={`ext-use-${c.col}`}
                  checked={c.use}
                  onChange={(e) =>
                    setCols((prev) => prev.map((p, j) => (j === i ? { ...p, use: e.target.checked } : p)))
                  }
                />
                <span className="cname bp-label" title={c.col}>
                  {c.col}
                </span>
                <input
                  className="bp-input"
                  style={{ width: 100 }}
                  value={c.name}
                  data-testid={`ext-name-${c.col}`}
                  onChange={(e) => setCols((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))}
                />
                <input
                  className="bp-input"
                  style={{ width: 54 }}
                  placeholder="unit"
                  value={c.unit}
                  data-testid={`ext-unit-${c.col}`}
                  onChange={(e) => setCols((prev) => prev.map((p, j) => (j === i ? { ...p, unit: e.target.value } : p)))}
                />
              </label>
            ))}
          </div>

          <div className="bp-row" style={{ marginTop: 6 }}>
            <span className="bp-label">Offset</span>
            <input
              type="range"
              min={-10}
              max={10}
              step={0.1}
              value={offsetS}
              data-testid="ext-offset"
              onChange={(e) => setOffsetS(Number(e.target.value))}
            />
            <span className="num" style={{ width: 58 }}>
              {offsetS.toFixed(1)} s
            </span>
            <button className="bp-btn" onClick={() => setOffsetS(0)}>
              0
            </button>
            <button
              className="bp-btn primary"
              data-testid="ext-apply"
              onClick={apply}
              disabled={!built || !built.length}
            >
              Apply to {session.name}
            </button>
            {mapError && <span className="bp-err">{mapError}</span>}
          </div>

          <div className="ext-preview" style={{ marginTop: 6 }}>
            <canvas ref={cvRef} width={520} height={90} data-testid="ext-preview" />
          </div>
        </>
      )}
    </div>
  );
}
