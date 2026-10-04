import { useLab, type LabState } from '../../state/store';
import ChannelsPanel from './ChannelsPanel';
import MathPanel from './MathPanel';
import ReportsPanel from './ReportsPanel';
import ExternalPanel from './ExternalPanel';
import CursorPanel from './CursorPanel';
import './panels.css';

const TABS: Array<{ id: LabState['bottomTab']; label: string }> = [
  { id: 'channels', label: 'Channels' },
  { id: 'math', label: 'Math' },
  { id: 'reports', label: 'Reports' },
  { id: 'external', label: 'External' },
  { id: 'cursor', label: 'Cursor' },
];

export default function BottomPanels() {
  const tab = useLab((s) => s.bottomTab);
  const setBottomTab = useLab((s) => s.setBottomTab);
  const nSessions = useLab((s) => s.sessions.length);
  const nSelected = useLab((s) => s.selectedLaps.length);

  return (
    <div className="bottom-panels" data-testid="bottom-panels">
      <nav className="bp-tabs" role="tablist" aria-label="Bottom panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'on' : ''}
            data-testid={`bp-tab-${t.id}`}
            onClick={() => setBottomTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="bp-spacer" />
        <span className="bp-note num">
          {nSessions} session{nSessions === 1 ? '' : 's'} · {nSelected} lap{nSelected === 1 ? '' : 's'} selected
        </span>
      </nav>
      <div className="bp-body" role="tabpanel" data-testid={`bp-panel-${tab}`}>
        {tab === 'channels' && <ChannelsPanel />}
        {tab === 'math' && <MathPanel />}
        {tab === 'reports' && <ReportsPanel />}
        {tab === 'external' && <ExternalPanel />}
        {tab === 'cursor' && <CursorPanel />}
      </div>
    </div>
  );
}
