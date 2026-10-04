// Track-schema import: pick a coach drawing (PNG/JPG/PDF), optionally let the
// local Claude bridge trace it, then align it to the map with >= 3 point pairs
// (least-squares affine) and store it on the active track model.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import './map.css';
import {
  analyzeSchema,
  bridgeErrorText,
  health,
  type BridgeHealth,
  type SchemaResult,
} from '../bridge/client';
import { applyAffine, fitAffine, type Affine } from '../core/affine';
import type { LngLat, SchemaLayer, SchemaPoint } from '../core/types';
import { activeTrack, useLab } from '../state/store';
import { mapBus } from './mapBus';

type Pair = { img: [number, number]; ll: LngLat };
type Tune = { rotDeg: number; scalePct: number; dxM: number; dyM: number };

const NO_TUNE: Tune = { rotDeg: 0, scalePct: 0, dxM: 0, dyM: 0 };
const R_EARTH = 6371008.8;
const D2R = Math.PI / 180;

/**
 * Compose a small refinement (rotate / scale about the overlay centre, then
 * translate by metres) onto a fitted affine. The refinement is expressed in
 * metres at the track latitude and converted to degrees.
 */
export function composeTune(A: Affine, tune: Tune, latHint?: number): Affine {
  const centre = applyAffine(A, [0.5, 0.5]);
  const lat0 = latHint ?? centre[1];
  const mPerDegLat = R_EARTH * D2R;
  const mPerDegLng = mPerDegLat * Math.max(0.01, Math.cos(lat0 * D2R));
  const s = 1 + tune.scalePct / 100;
  const th = tune.rotDeg * D2R;
  const k = s * Math.cos(th);
  const m = s * Math.sin(th);

  // M in lng/lat space: clockwise rotation + scale about `centre`, then dx/dy.
  const Ma = k;
  const Mb = (m * mPerDegLat) / mPerDegLng;
  const Mc = centre[0] - Ma * centre[0] - Mb * centre[1] + tune.dxM / mPerDegLng;
  const Md = (-m * mPerDegLng) / mPerDegLat;
  const Me = k;
  const Mf = centre[1] - Md * centre[0] - Me * centre[1] + tune.dyM / mPerDegLat;

  return [
    Ma * A[0] + Mb * A[3],
    Ma * A[1] + Mb * A[4],
    Ma * A[2] + Mb * A[5] + Mc,
    Md * A[0] + Me * A[3],
    Md * A[1] + Me * A[4],
    Md * A[2] + Me * A[5] + Mf,
  ];
}

export default function SchemaImport({ onClose }: { onClose: () => void }) {
  const tracks = useLab((s) => s.tracks);
  const activeTrackId = useLab((s) => s.activeTrackId);
  const setTrack = useLab((s) => s.setTrack);
  const track = useMemo(() => activeTrack({ tracks, activeTrackId }), [tracks, activeTrackId]);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [isPdf, setIsPdf] = useState(false);
  const [hc, setHc] = useState<BridgeHealth | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SchemaResult | null>(null);
  const [manual, setManual] = useState(false);
  const [manualApexes, setManualApexes] = useState<Array<SchemaPoint & { turn?: number }>>([]);
  const [turnNo, setTurnNo] = useState('1');
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [pendingImg, setPendingImg] = useState<[number, number] | null>(null);
  const [affine, setAffine] = useState<Affine | null>(null);
  const [tune, setTune] = useState<Tune>(NO_TUNE);
  const cancelPickRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    void health().then((h) => {
      if (alive) setHc(h);
    });
    return () => {
      alive = false;
    };
  }, []);

  const effAffine = useMemo(
    () => (affine ? composeTune(affine, tune, track?.center[1]) : null),
    [affine, tune, track],
  );

  const schema = useMemo<SchemaLayer>(() => {
    const apexes: SchemaLayer['apexes'] = result
      ? result.apexes.map((a) => ({ x: a.x, y: a.y, turn: a.turn ?? undefined, label: a.label ?? undefined }))
      : manualApexes;
    return {
      imageDataUrl,
      affine: effAffine,
      apexes,
      racingLine: (result?.racing_line ?? []).map(([x, y]) => ({ x, y })),
      trackOutline: (result?.track_outline ?? []).map(([x, y]) => ({ x, y })),
      markers: (result?.markers ?? []).map((m) => ({ x: m.x, y: m.y, type: m.type, text: m.text ?? undefined })),
      startFinish: result?.start_finish ? { x: result.start_finish.x, y: result.start_finish.y } : undefined,
      turnLabels: result?.turn_labels ?? [],
    };
  }, [result, manualApexes, imageDataUrl, effAffine]);

  // Live preview on the map while aligning; cleared when the dialog closes.
  useEffect(() => {
    if (step === 3 && effAffine) mapBus.previewSchema(schema);
  }, [step, effAffine, schema]);

  useEffect(
    () => () => {
      cancelPickRef.current?.();
      mapBus.previewSchema(null);
    },
    [],
  );

  function pickFile(f: File | null) {
    setError(null);
    setResult(null);
    setFile(f);
    if (!f) return;
    const pdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    setIsPdf(pdf);
    setStep(2);
    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(f);
  }

  async function runAnalyze() {
    if (!file) return;
    setAnalyzing(true);
    setError(null);
    try {
      const r = await analyzeSchema(file);
      setResult(r);
      setManual(false);
    } catch (e) {
      setError(bridgeErrorText(e));
    } finally {
      setAnalyzing(false);
    }
  }

  function onImageClick(e: MouseEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (step === 2 && manual) {
      const n = Number.parseInt(turnNo, 10);
      setManualApexes((prev) => [...prev, { x, y, turn: Number.isFinite(n) ? n : undefined }]);
      setTurnNo(String((Number.isFinite(n) ? n : 0) + 1));
      return;
    }
    if (step !== 3) return;
    setPendingImg([x, y]);
    cancelPickRef.current?.();
    cancelPickRef.current = mapBus.requestPick((ll) => {
      cancelPickRef.current = null;
      setPairs((prev) => [...prev, { img: [x, y], ll }]);
      setPendingImg(null);
    });
  }

  function doFit() {
    if (pairs.length < 3) return;
    try {
      setAffine(fitAffine(pairs.map((p) => p.img), pairs.map((p) => [p.ll[0], p.ll[1]] as [number, number])));
      setTune(NO_TUNE);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function save() {
    if (!track || !effAffine) return;
    setTrack({ ...track, schema: { ...schema, affine: effAffine } });
    mapBus.previewSchema(null);
    onClose();
  }

  const counts = result
    ? `${result.apexes.length} apexes · ${result.racing_line.length} racing line points · ${result.markers.length} markers · ${result.turn_labels.length} turn labels`
    : manual && manualApexes.length
      ? `${manualApexes.length} apexes marked manually`
      : null;

  const dots: Array<{ x: number; y: number; pending?: boolean }> = [
    ...(result ? result.apexes.map((a) => ({ x: a.x, y: a.y })) : manualApexes.map((a) => ({ x: a.x, y: a.y }))),
    ...pairs.map((p) => ({ x: p.img[0], y: p.img[1] })),
    ...(pendingImg ? [{ x: pendingImg[0], y: pendingImg[1], pending: true }] : []),
  ];

  return (
    <div className="schema-backdrop" data-testid="schema-modal" role="dialog" aria-modal="true" aria-label="Import track schema">
      <div className="schema-dialog">
        <div className="schema-head">
          <h2>Import track schema</h2>
          <span className="map-spacer" />
          <button className="map-btn" data-testid="schema-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="schema-steps">
          <span className={step === 1 ? 'on' : ''}>1 · File</span>
          <span>›</span>
          <span className={step === 2 ? 'on' : ''}>2 · Interpret</span>
          <span>›</span>
          <span className={step === 3 ? 'on' : ''}>3 · Align</span>
        </div>

        {!track && (
          <div className="schema-error" data-testid="schema-no-track">
            No active track model yet — load a session and build the track first; the schema is stored on the track.
          </div>
        )}

        <div className="schema-body">
          <div className="schema-img-wrap">
            {!imageDataUrl && <div className="schema-placeholder">No image selected</div>}
            {imageDataUrl && isPdf && (
              <div className="schema-placeholder" data-testid="schema-pdf-placeholder">
                PDF selected ({file?.name})<br />
                page 1 is rasterized by the bridge; no local preview
              </div>
            )}
            {imageDataUrl && !isPdf && (
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <img
                  src={imageDataUrl}
                  alt="Track schema"
                  data-testid="schema-image"
                  onClick={onImageClick}
                  draggable={false}
                />
                {dots.map((d, i) => (
                  <span
                    key={i}
                    className={`schema-dot ${d.pending ? 'pending' : ''}`}
                    style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%` }}
                  />
                ))}
              </div>
            )}
          </div>

          <div>
            {step === 1 && (
              <>
                <p className="schema-hint">
                  Pick a PNG, JPG or PDF of the track schema. The image and the Claude output stay on this machine.
                </p>
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
                  data-testid="schema-file"
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
              </>
            )}

            {step === 2 && (
              <>
                <p className="schema-hint" data-testid="schema-bridge-state">
                  Bridge:{' '}
                  {hc === null
                    ? 'checking…'
                    : hc.ok && hc.claude
                      ? 'available (Claude CLI ready)'
                      : hc.ok
                        ? 'running, but the Claude CLI is unavailable'
                        : 'not reachable on 127.0.0.1:8777'}
                </p>
                <div className="schema-actions" style={{ border: 'none', marginTop: 0, paddingTop: 0 }}>
                  <button
                    className="map-btn"
                    data-testid="schema-analyze"
                    disabled={!file || analyzing || !(hc?.claude ?? false)}
                    onClick={() => void runAnalyze()}
                  >
                    Analyze with Claude
                  </button>
                  <button
                    className={`map-btn ${manual ? 'active' : ''}`}
                    data-testid="schema-manual"
                    onClick={() => setManual((v) => !v)}
                  >
                    Manual mode
                  </button>
                  {analyzing && <span className="schema-spinner" data-testid="schema-spinner" />}
                </div>
                {manual && (
                  <p className="schema-hint">
                    Click the apexes on the image. Turn number:{' '}
                    <input
                      style={{ width: 48 }}
                      data-testid="schema-turn-no"
                      value={turnNo}
                      onChange={(e) => setTurnNo(e.target.value)}
                    />
                  </p>
                )}
                {counts && (
                  <div className="schema-counts" data-testid="schema-counts">
                    {counts}
                  </div>
                )}
                {error && (
                  <div className="schema-error" data-testid="schema-error">
                    {error}
                  </div>
                )}
              </>
            )}

            {step === 3 && (
              <>
                <p className="schema-hint" data-testid="schema-align-hint">
                  Click a point on the image, then its location on the map. Repeat for at least 3 pairs.
                  {pendingImg && <strong> Waiting for the map click…</strong>}
                </p>
                <div className="schema-pairs" data-testid="schema-pairs">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>image x,y</th>
                        <th>lng,lat</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.map((p, i) => (
                        <tr key={i} data-testid="schema-pair-row">
                          <td>{i + 1}</td>
                          <td>
                            {p.img[0].toFixed(3)}, {p.img[1].toFixed(3)}
                          </td>
                          <td>
                            {p.ll[0].toFixed(5)}, {p.ll[1].toFixed(5)}
                          </td>
                          <td>
                            <button
                              className="map-btn"
                              data-testid={`schema-pair-del-${i}`}
                              onClick={() => setPairs((prev) => prev.filter((_, j) => j !== i))}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!pairs.length && (
                        <tr>
                          <td colSpan={4} style={{ color: 'var(--fg-dim)' }}>
                            no pairs yet
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <button className="map-btn" data-testid="schema-fit" disabled={pairs.length < 3} onClick={doFit}>
                  Fit ({pairs.length} pairs)
                </button>

                {affine && (
                  <div style={{ marginTop: 10 }} data-testid="schema-tune">
                    <Slider label="Rotate" min={-5} max={5} step={0.1} unit="°" value={tune.rotDeg} onChange={(v) => setTune({ ...tune, rotDeg: v })} />
                    <Slider label="Scale" min={-5} max={5} step={0.1} unit="%" value={tune.scalePct} onChange={(v) => setTune({ ...tune, scalePct: v })} />
                    <Slider label="dx" min={-20} max={20} step={0.5} unit="m" value={tune.dxM} onChange={(v) => setTune({ ...tune, dxM: v })} />
                    <Slider label="dy" min={-20} max={20} step={0.5} unit="m" value={tune.dyM} onChange={(v) => setTune({ ...tune, dyM: v })} />
                    <button className="map-btn" data-testid="schema-tune-reset" onClick={() => setTune(NO_TUNE)}>
                      Reset fine-tune
                    </button>
                  </div>
                )}
                {error && (
                  <div className="schema-error" data-testid="schema-error">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="schema-actions">
          {step > 1 && (
            <button className="map-btn" data-testid="schema-back" onClick={() => setStep(step === 3 ? 2 : 1)}>
              Back
            </button>
          )}
          {step === 2 && (
            <button className="map-btn" data-testid="schema-align" disabled={!imageDataUrl} onClick={() => setStep(3)}>
              Align on map →
            </button>
          )}
          {step === 3 && (
            <button
              className="map-btn"
              data-testid="schema-save"
              disabled={!track || !effAffine}
              title={!track ? 'No active track model' : !effAffine ? 'Fit at least 3 pairs first' : 'Save schema on the track'}
              onClick={save}
            >
              Save
            </button>
          )}
          <span className="map-spacer" />
          {counts && step === 3 && <span className="num">{counts}</span>}
        </div>
      </div>
    </div>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="schema-slider-row">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        data-testid={`schema-slider-${props.label.toLowerCase()}`}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="num">
        {props.value.toFixed(1)}
        {props.unit}
      </span>
    </div>
  );
}
