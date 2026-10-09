// The only browser-dependent part of corridor extraction: fetch a tile and read
// its pixels. Esri World Imagery sends `Access-Control-Allow-Origin: *`, so the
// canvas is not tainted and getImageData() works.
import { TILE_SIZE, tileUrl, type TileLoader } from './tiles';

/**
 * Transient failures are retried: extractCorridor distrusts a mosaic with ANY
 * missing tile, so one flaky response out of ~54 would otherwise discard the
 * whole extraction.
 */
const ATTEMPTS = 3;

export const browserTileLoader: TileLoader = async (z, x, y) => {
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < ATTEMPTS && !blob; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 200 * attempt));
    try {
      const res = await fetch(tileUrl(z, x, y), { mode: 'cors', credentials: 'omit' });
      if (res.ok) blob = await res.blob();
      else if (res.status >= 400 && res.status < 500) return null; // not transient
    } catch {
      /* network blip: try again */
    }
  }
  if (!blob) return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, TILE_SIZE, TILE_SIZE);
    const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE); // RGBA
    const rgb = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return rgb;
  } finally {
    bmp.close();
  }
};
