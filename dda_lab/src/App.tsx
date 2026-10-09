import { useEffect } from 'react';
import Layout from './ui/Layout';
import { DEFAULT_EXAMPLE_IDS, EXAMPLES, fetchExampleFile } from './core/examples';
import { useLab } from './state/store';
import { openFiles } from './ui/openFiles';

/** On a fresh start the 1000 + 600 example laps are shown; they go away when real data is opened. */
function useDefaultExample(): void {
  useEffect(() => {
    if (useLab.getState().sessions.length) return;
    const q = new URLSearchParams(location.search);
    if (q.has('noexample')) return;
    const wanted = q.get('example'); // ?example=bike600 opens that one (also under automation)
    if (navigator.webdriver && !wanted) return;
    const ids = wanted ? [wanted] : DEFAULT_EXAMPLE_IDS;
    const exs = ids.map((id) => EXAMPLES.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!exs.length) return;
    let cancelled = false;
    Promise.all(exs.map(fetchExampleFile))
      .then((files) =>
        cancelled || useLab.getState().sessions.length
          ? undefined
          : openFiles(files, { example: true, colors: Object.fromEntries(exs.map((x) => [x.file, x.color])) }),
      )
      .catch(() => useLab.getState().setStatus('Example laps could not be loaded'));
    return () => {
      cancelled = true;
    };
  }, []);
}

export default function App() {
  useDefaultExample();
  return <Layout />;
}
