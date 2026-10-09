// Bundled example laps (public/examples/*). Served next to the app, so the relative
// path works both on the local bridge (/lab/) and on the hosted site.
export interface ExampleFile {
  id: string;
  label: string;
  file: string;
  /** run colour when opened as an example */
  color: string;
}

export const EXAMPLES: ExampleFile[] = [
  { id: 'intermediate', label: 'Intermediate: 1-29-2', file: '1-29-2.json', color: '#ffd166' },
  { id: 'bike1000', label: '1000 Bike: serres_BMW_1-19-81', file: 'serres_BMW_1-19-81.json', color: '#3dff5a' },
  { id: 'bike600', label: '600 Bike: serres_R6_1-19-849', file: 'serres_R6_1-19-849.json', color: '#3da5ff' },
];

/** Examples shown when the app starts with nothing loaded (first one becomes the reference lap). */
export const DEFAULT_EXAMPLE_IDS = ['bike1000', 'bike600'];

export function exampleUrl(e: ExampleFile): string {
  return new URL(`examples/${e.file}`, document.baseURI).toString();
}

export async function fetchExampleFile(e: ExampleFile): Promise<File> {
  const r = await fetch(exampleUrl(e));
  if (!r.ok) throw new Error(`example ${e.file}: HTTP ${r.status}`);
  return new File([await r.blob()], e.file, { type: 'application/json' });
}
