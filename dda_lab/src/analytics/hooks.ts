// Wires usage tracking into the app: one `app_open`, store-derived events, and
// a flush whenever the tab is hidden or closed. Called once from main.tsx.
import { useLab } from '../state/store';
import { CHART_TEMPLATES } from '../core/chartTemplates';
import { flushTracking, track } from './track';
import { watchStore, type Subscribe } from './derive';

let started = false;

export function startTracking(): void {
  if (started) return;
  started = true;
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    track('app_open', {
      ua: nav.userAgentData?.platform || nav.platform || 'unknown',
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
    watchStore(useLab.subscribe as unknown as Subscribe<ReturnType<typeof useLab.getState>>, track, {
      templates: CHART_TEMPLATES,
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushTracking(true);
    });
    window.addEventListener('pagehide', () => flushTracking(true));
  } catch {
    /* never break startup */
  }
}
