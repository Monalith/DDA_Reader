import { useEffect, useState } from 'react';
import { useLab, type LabState } from '../../state/store';
import { useAuth } from '../../auth/client';
import LapsPanel from './LapsPanel';
import TrackPanel from './TrackPanel';
import ChannelsPanel from './ChannelsPanel';
import MathPanel from './MathPanel';
import ReportsPanel from './ReportsPanel';
import ExternalPanel from './ExternalPanel';
import CursorPanel from './CursorPanel';
import MarkersPanel from './MarkersPanel';
import SimPanel from './SimPanel';
import StatsPanel from './StatsPanel';
import './panels.css';

const TABS: Array<{ id: LabState['bottomTab']; label: string }> = [
  { id: 'laps', label: 'Laps' },
  { id: 'track', label: 'Track' },
  { id: 'channels', label: 'Channels' },
  { id: 'math', label: 'Math' },
  { id: 'reports', label: 'Reports' },
  { id: 'external', label: 'External' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'markers', label: 'Markers' },
  { id: 'sim', label: 'Sim' },
];

export default function BottomPanels() {
  const tab = useLab((s) => s.bottomTab);
  const setBottomTab = useLab((s) => s.setBottomTab);
  const nSessions = useLab((s) => s.sessions.length);
  const nSelected = useLab((s) => s.selectedLaps.length);
  // The Stats tab is admin-only and kept local (the bottomTab union in the store has no 'stats').
  const isAdmin = useAuth().user?.role === 'admin';
  const [statsOpen, setStatsOpen] = useState(false);
  const showStats = isAdmin && statsOpen;
  // any tab switch (a click or the app itself, e.g. "open in Sim") leaves the Stats view
  useEffect(() => setStatsOpen(false), [tab]);

  return (
    <div className="bottom-panels" data-testid="bottom-panels">
      <nav className="bp-tabs" role="tablist" aria-label="Bottom panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={!showStats && tab === t.id}
            className={!showStats && tab === t.id ? 'on' : ''}
            data-testid={`bp-tab-${t.id}`}
            onClick={() => {
              setStatsOpen(false);
              setBottomTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
        {isAdmin && (
          <button
            role="tab"
            aria-selected={showStats}
            className={`stats-tab${showStats ? ' on' : ''}`}
            data-testid="bp-tab-stats"
            title="Usage statistics (admin)"
            onClick={() => setStatsOpen(true)}
          >
            Stats
          </button>
        )}
        <span className="bp-spacer" />
        <span className="bp-note num">
          {nSessions} session{nSessions === 1 ? '' : 's'} · {nSelected} lap{nSelected === 1 ? '' : 's'} selected
        </span>
      </nav>
      <div className="bp-body" role="tabpanel" data-testid={`bp-panel-${showStats ? 'stats' : tab}`}>
        {showStats && <StatsPanel />}
        {!showStats && tab === 'laps' && <LapsPanel />}
        {!showStats && tab === 'track' && <TrackPanel />}
        {!showStats && tab === 'channels' && <ChannelsPanel />}
        {!showStats && tab === 'math' && <MathPanel />}
        {!showStats && tab === 'reports' && <ReportsPanel />}
        {!showStats && tab === 'external' && <ExternalPanel />}
        {!showStats && tab === 'cursor' && <CursorPanel />}
        {!showStats && tab === 'markers' && <MarkersPanel />}
        {!showStats && tab === 'sim' && <SimPanel />}
      </div>
    </div>
  );
}
