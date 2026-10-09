// Bundled example laps (public/examples/*). Served next to the app, so the relative
// path works both on the local bridge (/lab/) and on the hosted site.
export interface ExampleFile {
  id: string;
  label: string;
  file: string;
}

export const EXAMPLES: ExampleFile[] = [
  { id: 'intermediate', label: 'Intermediate: 1-29-2', file: '1-29-2.json' },
  { id: 'bike1000', label: '1000 Bike: serres_BMW_1-19-81', file: 'serres_BMW_1-19-81.json' },
  { id: 'bike600', label: '600 Bike: serres_R6_1-19-849', file: 'serres_R6_1-19-849.json' },
];

/** The example shown when the app starts with nothing loaded. */
export const DEFAULT_EXAMPLE_ID = 'bike1000';

export function exampleUrl(e: ExampleFile): string {
  return new URL(`examples/${e.file}`, document.baseURI).toString();
}

export async function fetchExampleFile(e: ExampleFile): Promise<File> {
  const r = await fetch(exampleUrl(e));
  if (!r.ok) throw new Error(`example ${e.file}: HTTP ${r.status}`);
  return new File([await r.blob()], e.file, { type: 'application/json' });
}
