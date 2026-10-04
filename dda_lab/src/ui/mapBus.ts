// Tiny module-level event bus between SchemaImport and MapView.
//
// SchemaImport needs two things from the map that do not belong in the global
// store (they are transient UI state of one modal):
//   1. "arm" the map for a single click that resolves to a [lng,lat] pair
//      (schema alignment: click a point on the image, then on the map);
//   2. preview an unsaved schema overlay (image + transformed geometry).
import type { LngLat, SchemaLayer } from '../core/types';

type PickHandler = (p: LngLat) => void;
type Listener = () => void;

let pickHandler: PickHandler | null = null;
let preview: SchemaLayer | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export const mapBus = {
  /** Subscribe to armed/preview changes (MapView re-renders on these). */
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  /**
   * Ask the map for one point. Returns a cancel function. Re-arming replaces
   * any previous request.
   */
  requestPick(h: PickHandler): () => void {
    pickHandler = h;
    emit();
    return () => {
      if (pickHandler === h) {
        pickHandler = null;
        emit();
      }
    };
  },

  isArmed(): boolean {
    return pickHandler !== null;
  },

  /** Deliver a map click. Returns true when it was consumed by a pick request. */
  deliver(p: LngLat): boolean {
    const h = pickHandler;
    if (!h) return false;
    pickHandler = null;
    emit();
    h(p);
    return true;
  },

  /** Show (or clear, with null) an unsaved schema overlay on the map. */
  previewSchema(s: SchemaLayer | null): void {
    preview = s;
    emit();
  },

  getPreview(): SchemaLayer | null {
    return preview;
  },
};
