import { useLab } from '../../state/store';

export default function SimPanel() {
  const corridor = useLab((s) => s.corridor);
  const busy = useLab((s) => s.corridorBusy);
  const extract = useLab((s) => s.extractCorridorNow);
  const setWorkspace = useLab((s) => s.setWorkspace);
  const workspace = useLab((s) => s.workspace);

  const resolved = corridor
    ? Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length)
    : 0;
  const widths = corridor
    ? Array.from(corridor.leftM, (l, i) => l + corridor.rightM[i]).filter((_w, i) => corridor.known[i])
        .sort((a, b) => a - b)
    : [];
  const medianWidth = widths.length ? widths[widths.length >> 1] : NaN;

  return (
    <div className="panel" data-testid="sim-panel">
      <div className="panel-row">
        <button data-testid="sim-extract" disabled={busy} onClick={() => void extract()}>
          {busy ? 'Extracting…' : 'Extract corridor'}
        </button>
        <label>
          <input
            type="checkbox"
            checked={workspace.mapLayers.corridor !== false}
            onChange={(e) => setWorkspace({ mapLayers: { ...workspace.mapLayers, corridor: e.target.checked } })}
          />
          Show on map
        </label>
      </div>
      {corridor && (
        <p className="panel-note num" data-testid="sim-corridor-stats">
          {resolved} % resolved · median width {medianWidth.toFixed(1)} m
        </p>
      )}
    </div>
  );
}
