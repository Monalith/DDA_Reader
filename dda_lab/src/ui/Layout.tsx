import { useCallback, useEffect, useRef } from 'react';
import { useLab } from '../state/store';
import TopBar from './TopBar';
import LapTable from './LapTable';
import ChartStack from './ChartStack';
import MapView from './MapView';
import BottomPanels from './panels/BottomPanels';

export default function Layout() {
  const splitPct = useLab((s) => s.workspace.splitPct);
  const mapMax = useLab((s) => s.mapMaximized);
  const setWorkspace = useLab((s) => s.setWorkspace);
  const dragging = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current || !rootRef.current) return;
      const rect = rootRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setWorkspace({ splitPct: Math.min(80, Math.max(30, pct)) });
    },
    [setWorkspace],
  );

  useEffect(() => {
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', up);
    };
  }, [onMove]);

  return (
    <div className="app-root">
      <TopBar />
      <div
        className={`workspace ${mapMax ? 'map-max' : ''}`}
        ref={rootRef}
        style={{ gridTemplateColumns: mapMax ? '0 0 1fr' : `${splitPct}% 6px 1fr` }}
      >
        <section className="left-pane" aria-label="Analysis">
          <LapTable />
          <ChartStack />
          <BottomPanels />
        </section>
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={() => {
            dragging.current = true;
            document.body.style.cursor = 'col-resize';
          }}
        />
        <section className="right-pane" aria-label="Map">
          <MapView />
        </section>
      </div>
    </div>
  );
}
