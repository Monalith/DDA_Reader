// Size and colour of every text drawn on the map: turn names (K1…, also the track model's
// corners), the km/h labels at the apex / brake / throttle points, the rider's corner-event
// letters (B T A P E) and the per-turn Δ labels vs the best lap. Shared by the chart bar's
// "labels" popover and the map's "Aa" popover; the values live in workspace.turnLabels.
import { DEFAULT_TURN_LABELS, type TurnLabelStyle } from '../core/types';

interface Props {
  turnLabels: TurnLabelStyle;
  setTurnLabels: (patch: Partial<TurnLabelStyle>) => void;
  /** also the Δ-label rows (the chart bar popover has them above already) */
  deltas?: boolean;
}

const D = DEFAULT_TURN_LABELS;

export default function MapTextControls({ turnLabels: t, setTurnLabels, deltas = false }: Props) {
  const row = (label: string, size: number, min: number, max: number, sizeId: string, onSize: (v: number) => void, color: string | undefined, colorId: string, onColor: (v: string) => void, extra?: React.ReactNode) => (
    <div className="ps-row">
      <span className="ps-label" style={{ width: 86 }}>{label}</span>
      <input type="range" min={min} max={max} step={1} value={size} data-testid={sizeId} onChange={(e) => onSize(Number(e.target.value))} />
      <span className="num ps-val">{size}px</span>
      <input type="color" value={color ?? '#ffffff'} data-testid={colorId} title="Text colour" onChange={(e) => onColor(e.target.value)} />
      {extra}
    </div>
  );
  return (
    <>
      {row('Turn names', t.turnSize ?? D.turnSize!, 8, 32, 'map-text-turn-size', (v) => setTurnLabels({ turnSize: v }), t.turnColor ?? D.turnColor, 'map-text-turn-color', (v) => setTurnLabels({ turnColor: v }))}
      {row('km/h points', t.pointSize ?? D.pointSize!, 8, 28, 'map-text-point-size', (v) => setTurnLabels({ pointSize: v }), t.pointColor, 'map-text-point-color', (v) => setTurnLabels({ pointColor: v }),
        t.pointColor ? (
          <button className="btn-mini" data-testid="map-text-point-color-reset" title="Back to one colour per kind (apex white, turn-in yellow, brake red, throttle green)" onClick={() => setTurnLabels({ pointColor: undefined })}>
            per kind
          </button>
        ) : undefined)}
      {row('Rider B/T/A/P/E', t.eventSize ?? 11, 8, 28, 'map-text-event-size', (v) => setTurnLabels({ eventSize: v }), t.eventColor ?? '#ffffff', 'map-text-event-color', (v) => setTurnLabels({ eventColor: v }))}
      {deltas && (
        <>
          <div className="ps-row">
            <span className="ps-label" style={{ width: 86 }}>Δ vs best</span>
            <input type="range" min={10} max={24} step={1} value={t.size} data-testid="turn-labels-size" onChange={(e) => setTurnLabels({ size: Number(e.target.value) })} />
            <span className="num ps-val">{t.size}px</span>
          </div>
          <div className="ps-row" style={{ gap: 6 }}>
            <span className="ps-label" style={{ width: 86 }}>Δ colours</span>
            {(['gain', 'loss', 'best'] as const).map((key) => (
              <label key={key} className="ps-check" title={key === 'gain' ? 'gained (−)' : key === 'loss' ? 'lost (+)' : 'best'}>
                <input type="color" value={t[key]} data-testid={`turn-labels-${key}`} onChange={(e) => setTurnLabels({ [key]: e.target.value })} />
                <span style={{ color: t[key] }}>{key === 'gain' ? '−' : key === 'loss' ? '+' : 'best'}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="ps-row">
        <button className="btn-mini" data-testid="map-text-reset" onClick={() => setTurnLabels({ turnSize: D.turnSize, turnColor: D.turnColor, pointSize: D.pointSize, pointColor: undefined, eventSize: undefined, eventColor: undefined })}>
          Reset map text
        </button>
      </div>
    </>
  );
}
