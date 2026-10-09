import { useEffect } from 'react';
import Layout from './ui/Layout';
import { DEFAULT_EXAMPLE_ID, EXAMPLES, fetchExampleFile } from './core/examples';
import { useLab } from './state/store';
import { openFiles } from './ui/openFiles';

/** On a fresh start the 1000 cc example lap is shown; it goes away when real data is opened. */
function useDefaultExample(): void {
  useEffect(() => {
    if (useLab.getState().sessions.length) return;
    const q = new URLSearchParams(location.search);
    if (q.has('noexample')) return;
    const wanted = q.get('example'); // ?example=bike600 opens that one (also under automation)
    if (navigator.webdriver && !wanted) return;
    const ex = EXAMPLES.find((x) => x.id === (wanted ?? DEFAULT_EXAMPLE_ID));
    if (!ex) return;
    let cancelled = false;
    fetchExampleFile(ex)
      .then((f) => (cancelled || useLab.getState().sessions.length ? undefined : openFiles([f], { example: true })))
      .catch(() => useLab.getState().setStatus('Example lap could not be loaded'));
    return () => {
      cancelled = true;
    };
  }, []);
}

export default function App() {
  useDefaultExample();
  return <Layout />;
}
