// Right-hand map pane: MapLibre with satellite / OSM / plain basemaps, the
// selected-lap GPS traces coloured by a channel, the track model (centerline,
// turn numbers, apex / brake / throttle markers, sector gates), the imported
// coach schema overlay, and the tools (fit, maximize, measure, edit gates,
// import schema).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre derives its worker URL from its own `import.meta.url`, which breaks
// once Vite pre-bundles or chunks the library. Point it at a worker that Vite
// builds for us instead (works in dev and in the production build).
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './map.css';
import { applyAffine } from '../core/affine';
import { bearingDeg, haversineM } from '../core/geo';
import { turnMetrics } from '../core/track';
import type { Gate, LngLat, SchemaLayer, TrackModel, TurnMetrics } from '../core/types';
import { selectedLapEntries } from '../state/selectors';
import { activeTrack, useLab } from '../state/store';
import {
  IMAGE_CORNERS,
  centerlineGeoJson,
  gatesGeoJson,
  markersGeoJson,
  schemaGeoJson,
  traceGeoJson,
} from './MapLayers';
import { mapBus } from './mapBus';
import SchemaImport from './SchemaImport';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

type Basemap = 'satellite' | 'osm' | 'plain';

const LAYER_KEYS = [
  'satellite',
  'centerline',
  'turns',
  'apex',
  'brake',
  'throttle',
  'gates',
  'trace',
  'schema',
] as const;

const EMPTY = { type: 'FeatureCollection' as const, features: [] };
const CLICK_RADIUS_M = 25;
const TEXT_FONT = ['Open Sans Regular', 'Arial Unicode MS Regular'];

const BASE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0e1116' } },
    { id: 'esri', type: 'raster', source: 'esri', layout: { visibility: 'visible' } },
    { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
  ],
};

const BIKE_SVG = `
<svg class="bike-marker" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="11" fill="rgba(14,17,22,0.55)" stroke="#0e1116" stroke-width="1"/>
  <path d="M12 2.5 L16 13 L12 11 L8 13 Z" fill="#ffffff" stroke="#0e1116" stroke-width="0.8"/>
  <circle cx="12" cy="15.5" r="2.2" fill="#ff6a00" stroke="#0e1116" stroke-width="0.8"/>
</svg>`;

function fmtM(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(1)} m`;
}

/** Offset a gate's centre by metres (east, north). */
function offsetGate(g: Gate, lng: number, lat: number): Gate {
  return { ...g, at: [lng, lat] };
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const bikeRef = useRef<maplibregl.Marker | null>(null);
  const measureMarkerRef = useRef<maplibregl.Marker | null>(null);
  const gateMarkersRef = useRef<maplibregl.Marker[]>([]);
  const traceIdsRef = useRef<string[]>([]);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>('satellite');
  const [layersOpen, setLayersOpen] = useState(false);
  const [measure, setMeasure] = useState(false);
  const [measurePts, setMeasurePts] = useState<LngLat[]>([]);
  const [gateEdit, setGateEdit] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);

  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const tracks = useLab((s) => s.tracks);
  const activeTrackId = useLab((s) => s.activeTrackId);
  const mapLayers = useLab((s) => s.workspace.mapLayers);
  const colorBy = useLab((s) => s.mapColorBy);
  const setMapColorBy = useLab((s) => s.setMapColorBy);
  const maximized = useLab((s) => s.mapMaximized);
  const setMapMaximized = useLab((s) => s.setMapMaximized);
  const cursor = useLab((s) => s.cursor);
  const setCursor = useLab((s) => s.setCursor);
  const setWorkspace = useLab((s) => s.setWorkspace);
  const setTrack = useLab((s) => s.setTrack);

  const track = useMemo(() => activeTrack({ tracks, activeTrackId }), [tracks, activeTrackId]);
  const entries = useMemo(() => selectedLapEntries({ sessions, selectedLaps }), [sessions, selectedLaps]);

  // Unsaved schema preview pushed by SchemaImport.
  const preview = useSyncExternalStore(mapBus.subscribe, mapBus.getPreview, () => null);
  const armed = useSyncExternalStore(mapBus.subscribe, mapBus.isArmed, () => false);

  const metrics = useMemo<TurnMetrics[]>(() => {
    const first = entries[0];
    if (!track || !first) return [];
    try {
      return turnMetrics(first.s, first.lap, track);
    } catch {
      return [];
    }
  }, [entries, track]);

  // ---------- map creation ----------
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [0, 20],
      zoom: 1.4,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    const onLoad = () => {
      addDataLayers(map);
      setReady(true);
    };
    map.on('load', onLoad);

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      setReady(false);
      bikeRef.current?.remove();
      bikeRef.current = null;
      measureMarkerRef.current?.remove();
      measureMarkerRef.current = null;
      for (const m of gateMarkersRef.current) m.remove();
      gateMarkersRef.current = [];
      traceIdsRef.current = [];
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // ---------- basemap visibility ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const satOn = basemap === 'satellite' && mapLayers.satellite !== false;
    setVis(map, 'esri', satOn);
    setVis(map, 'osm', basemap === 'osm');
  }, [ready, basemap, mapLayers.satellite]);

  // ---------- traces ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const want = new Map<string, { sessionId: string; lap: number }>();
    for (const e of entries) want.set(`trace:${e.s.id}:${e.lap.n}`, { sessionId: e.s.id, lap: e.lap.n });

    // remove stale
    for (const id of traceIdsRef.current) {
      if (!want.has(id)) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
    }
    traceIdsRef.current = [...want.keys()];

    for (const e of entries) {
      const id = `trace:${e.s.id}:${e.lap.n}`;
      const data = traceGeoJson(e.s, e.lap, colorBy);
      const src = map.getSource<maplibregl.GeoJSONSource>(id);
      if (src) {
        void src.setData(data);
      } else {
        map.addSource(id, { type: 'geojson', data });
        map.addLayer(
          {
            id,
            type: 'line',
            source: id,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
          },
          map.getLayer('markers-apex') ? 'markers-apex' : undefined,
        );
      }
      setVis(map, id, mapLayers.trace !== false);
    }
  }, [ready, entries, colorBy, mapLayers.trace]);

  // ---------- track model + schema ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setData(map, 'centerline', track ? { type: 'FeatureCollection', features: [centerlineGeoJson(track)] } : EMPTY);
    setData(map, 'gates', track ? gatesGeoJson(track) : EMPTY);
    const first = entries[0];
    setData(
      map,
      'markers',
      track && first ? markersGeoJson(track, metrics, first.s, first.lap) : EMPTY,
    );
    const schema: SchemaLayer | undefined = preview ?? track?.schema;
    setData(map, 'schema', track && schema ? schemaGeoJson({ ...track, schema }) : EMPTY);
    syncSchemaImage(map, schema ?? null);
  }, [ready, track, entries, metrics, preview]);

  // ---------- layer toggles ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setVis(map, 'centerline-line', mapLayers.centerline !== false);
    setVis(map, 'markers-turn', mapLayers.turns !== false);
    setVis(map, 'markers-apex', mapLayers.apex !== false);
    setVis(map, 'markers-brake', mapLayers.brake !== false);
    setVis(map, 'markers-throttle', mapLayers.throttle !== false);
    setVis(map, 'gates-line', mapLayers.gates !== false);
    const schemaOn = mapLayers.schema !== false;
    for (const id of ['schema-outline', 'schema-racing', 'schema-apex', 'schema-marker', 'schema-label', 'schema-image']) {
      setVis(map, id, schemaOn);
    }
    for (const id of traceIdsRef.current) setVis(map, id, mapLayers.trace !== false);
  }, [ready, mapLayers, preview, track]);

  // ---------- cursor marker ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const pos = cursorPosition(sessions, cursor);
    if (!pos) {
      bikeRef.current?.remove();
      bikeRef.current = null;
      return;
    }
    if (!bikeRef.current) {
      const el = document.createElement('div');
      el.innerHTML = BIKE_SVG;
      el.setAttribute('data-testid', 'map-cursor-marker');
      bikeRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(pos.at).addTo(map);
    } else {
      bikeRef.current.setLngLat(pos.at);
    }
    bikeRef.current.setRotation(pos.bearing);
  }, [ready, cursor, sessions]);

  // ---------- measure line ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (measurePts.length === 2) {
      setData(map, 'measure', {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: [measurePts[0], measurePts[1]] },
          },
        ],
      });
      const d = haversineM(measurePts[0], measurePts[1]);
      const mid: LngLat = [
        (measurePts[0][0] + measurePts[1][0]) / 2,
        (measurePts[0][1] + measurePts[1][1]) / 2,
      ];
      const el = document.createElement('div');
      el.className = 'measure-label';
      el.setAttribute('data-testid', 'map-measure-label');
      el.textContent = fmtM(d);
      measureMarkerRef.current?.remove();
      measureMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat(mid).addTo(map);
    } else {
      setData(map, 'measure', EMPTY);
      measureMarkerRef.current?.remove();
      measureMarkerRef.current = null;
    }
  }, [ready, measurePts]);

  const clearMeasure = useCallback(() => {
    setMeasurePts([]);
    setMeasure(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      clearMeasure();
      setLayersOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearMeasure]);

  // ---------- map click ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (ev: maplibregl.MapMouseEvent) => {
      const p: LngLat = [ev.lngLat.lng, ev.lngLat.lat];
      if (mapBus.deliver(p)) return;
      if (measure) {
        setMeasurePts((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
        return;
      }
      if (gateEdit) return;
      const hit = nearestSample(entries, p);
      if (hit) setCursor({ sessionId: hit.sessionId, idx: hit.idx });
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [ready, measure, gateEdit, entries, setCursor]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = armed || measure ? 'crosshair' : '';
  }, [ready, armed, measure]);

  // ---------- gate editing ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of gateMarkersRef.current) m.remove();
    gateMarkersRef.current = [];
    if (!gateEdit || !track) return;

    const gates: Array<{ g: Gate; isSf: boolean }> = [
      { g: track.startFinish, isSf: true },
      ...track.sectors.map((g) => ({ g, isSf: false })),
    ];
    for (const { g, isSf } of gates) {
      const el = document.createElement('div');
      el.className = `gate-marker ${isSf ? 'sf' : ''}`;
      el.title = `${g.name} — drag to move, shift+wheel to rotate`;
      el.setAttribute('data-testid', `gate-marker-${g.id}`);
      const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(g.at).addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        commitGate(track, isSf, offsetGate(g, ll.lng, ll.lat), setTrack);
      });
      el.addEventListener(
        'wheel',
        (e: WheelEvent) => {
          if (!e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          const step = e.deltaY > 0 ? 5 : -5;
          commitGate(track, isSf, { ...g, bearingDeg: (g.bearingDeg + step + 360) % 360 }, setTrack);
        },
        { passive: false },
      );
      gateMarkersRef.current.push(marker);
    }
  }, [ready, gateEdit, track, setTrack]);

  // ---------- fit ----------
  const fit = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = new maplibregl.LngLatBounds();
    let any = false;
    if (track?.centerline.length) {
      for (const p of track.centerline) {
        bounds.extend(p);
        any = true;
      }
    } else {
      for (const e of entries) {
        const lng = e.s.channels.get('gps_lon')?.data;
        const lat = e.s.channels.get('gps_lat')?.data;
        if (!lng || !lat) continue;
        for (let i = e.lap.startIdx; i <= Math.min(e.lap.endIdx, lng.length - 1); i++) {
          if (!Number.isFinite(lng[i]) || !Number.isFinite(lat[i])) continue;
          bounds.extend([lng[i], lat[i]]);
          any = true;
        }
      }
    }
    if (any) map.fitBounds(bounds, { padding: 40, duration: 500 });
  }, [track, entries]);

  // Auto-fit the first time there is something to show.
  const didFit = useRef(false);
  useEffect(() => {
    if (!ready || didFit.current) return;
    if (!track && !entries.length) return;
    didFit.current = true;
    fit();
  }, [ready, track, entries, fit]);

  const toggleLayer = (key: string) => {
    setWorkspace({ mapLayers: { ...mapLayers, [key]: mapLayers[key] === false } });
  };

  return (
    <div className="map-wrap" data-testid="map-wrap">
      <div className="map-canvas" ref={containerRef} data-testid="map-canvas" />

      <div className="map-toolbar">
        <select
          className="map-select"
          data-testid="map-basemap"
          aria-label="Basemap"
          value={basemap}
          onChange={(e) => setBasemap(e.target.value as Basemap)}
        >
          <option value="satellite">Satellite</option>
          <option value="osm">OSM</option>
          <option value="plain">Plain</option>
        </select>

        <select
          className="map-select"
          data-testid="map-colorby"
          aria-label="Colour traces by"
          value={colorBy}
          onChange={(e) => setMapColorBy(e.target.value as typeof colorBy)}
        >
          <option value="speed">Speed</option>
          <option value="tps">Throttle</option>
          <option value="lean">Lean</option>
          <option value="brake">Braking</option>
          <option value="solid">Solid</option>
        </select>

        <button className="map-btn" data-testid="map-fit" onClick={fit} title="Fit to track">
          Fit
        </button>
        <button
          className={`map-btn ${measure ? 'active' : ''}`}
          data-testid="map-measure"
          onClick={() => {
            setMeasurePts([]);
            setMeasure((v) => !v);
          }}
          title="Measure a distance (two clicks, Esc clears)"
        >
          Measure
        </button>
        <button
          className={`map-btn ${gateEdit ? 'active' : ''}`}
          data-testid="map-edit-gates"
          disabled={!track}
          onClick={() => setGateEdit((v) => !v)}
          title="Drag gate markers to move, shift+wheel to rotate"
        >
          Gates
        </button>
        <button className="map-btn" data-testid="schema-import" onClick={() => setSchemaOpen(true)}>
          Import schema
        </button>

        <span className="map-spacer" />

        <button
          className={`map-btn ${layersOpen ? 'active' : ''}`}
          data-testid="map-layers"
          onClick={() => setLayersOpen((v) => !v)}
        >
          Layers
        </button>
        <button
          className={`map-btn ${maximized ? 'active' : ''}`}
          data-testid="map-maximize"
          onClick={() => setMapMaximized(!maximized)}
          title="Maximize map"
        >
          {maximized ? '⤡' : '⤢'}
        </button>
      </div>

      {layersOpen && (
        <div className="map-pop" data-testid="map-layers-pop">
          {LAYER_KEYS.map((k) => (
            <label key={k}>
              <input
                type="checkbox"
                data-testid={`map-layer-${k}`}
                checked={mapLayers[k] !== false}
                onChange={() => toggleLayer(k)}
              />
              {k}
            </label>
          ))}
        </div>
      )}

      {(measure || armed) && (
        <div className="map-status" data-testid="map-status">
          {armed
            ? 'Alignment: click the matching point on the map'
            : measurePts.length === 2
              ? `${fmtM(haversineM(measurePts[0], measurePts[1]))} — Esc clears`
              : 'Measure: click two points (Esc cancels)'}
        </div>
      )}

      {schemaOpen && <SchemaImport onClose={() => setSchemaOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function setVis(map: maplibregl.Map, id: string, on: boolean): void {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

function setData(map: maplibregl.Map, id: string, data: GeoJSON.FeatureCollection): void {
  const src = map.getSource<maplibregl.GeoJSONSource>(id);
  if (src) void src.setData(data as GeoJSON.GeoJSON);
}

function commitGate(track: TrackModel, isSf: boolean, g: Gate, setTrack: (t: TrackModel) => void): void {
  setTrack(
    isSf
      ? { ...track, startFinish: g }
      : { ...track, sectors: track.sectors.map((x) => (x.id === g.id ? g : x)) },
  );
}

function cursorPosition(
  sessions: ReturnType<typeof useLab.getState>['sessions'],
  cursor: ReturnType<typeof useLab.getState>['cursor'],
): { at: LngLat; bearing: number } | null {
  if (!cursor) return null;
  const s = sessions.find((x) => x.id === cursor.sessionId);
  if (!s) return null;
  const lng = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lng || !lat) return null;
  const i = Math.max(0, Math.min(cursor.idx, lng.length - 1));
  if (!Number.isFinite(lng[i]) || !Number.isFinite(lat[i])) return null;
  const at: LngLat = [lng[i], lat[i]];
  const brg = s.channels.get('bearing')?.data;
  let bearing = brg && Number.isFinite(brg[i]) ? brg[i] : NaN;
  if (!Number.isFinite(bearing)) {
    const j = i + 1 < lng.length && Number.isFinite(lng[i + 1]) ? i + 1 : i - 1;
    if (j >= 0 && j < lng.length && Number.isFinite(lng[j]) && Number.isFinite(lat[j])) {
      const b: LngLat = [lng[j], lat[j]];
      bearing = j > i ? bearingDeg(at, b) : bearingDeg(b, at);
    } else {
      bearing = 0;
    }
  }
  return { at, bearing };
}

function nearestSample(
  entries: ReturnType<typeof selectedLapEntries>,
  p: LngLat,
): { sessionId: string; idx: number; distM: number } | null {
  let best: { sessionId: string; idx: number; distM: number } | null = null;
  for (const e of entries) {
    const lng = e.s.channels.get('gps_lon')?.data;
    const lat = e.s.channels.get('gps_lat')?.data;
    if (!lng || !lat) continue;
    const last = Math.min(e.lap.endIdx, lng.length - 1, lat.length - 1);
    for (let i = e.lap.startIdx; i <= last; i++) {
      if (!Number.isFinite(lng[i]) || !Number.isFinite(lat[i])) continue;
      const d = haversineM([lng[i], lat[i]], p);
      if (d > CLICK_RADIUS_M) continue;
      if (!best || d < best.distM) best = { sessionId: e.s.id, idx: i, distM: d };
    }
  }
  return best;
}

/** Add/replace the semi-transparent schema image overlay below the vector layers. */
function syncSchemaImage(map: maplibregl.Map, schema: SchemaLayer | null): void {
  if (map.getLayer('schema-image')) map.removeLayer('schema-image');
  if (map.getSource('schema-image')) map.removeSource('schema-image');
  if (!schema?.affine || !schema.imageDataUrl) return;
  const corners = IMAGE_CORNERS.map((c) => applyAffine(schema.affine!, c)) as [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  map.addSource('schema-image', { type: 'image', url: schema.imageDataUrl, coordinates: corners });
  map.addLayer(
    {
      id: 'schema-image',
      type: 'raster',
      source: 'schema-image',
      paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0 },
    },
    map.getLayer('centerline-line') ? 'centerline-line' : undefined,
  );
}

/** One-time creation of the empty data sources and their layers. */
function addDataLayers(map: maplibregl.Map): void {
  for (const id of ['centerline', 'gates', 'markers', 'schema', 'measure']) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  map.addLayer({
    id: 'schema-outline',
    type: 'line',
    source: 'schema',
    filter: ['==', ['get', 'kind'], 'outline'],
    paint: { 'line-color': '#9aa7b8', 'line-width': 1.5, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'schema-racing',
    type: 'line',
    source: 'schema',
    filter: ['==', ['get', 'kind'], 'racingLine'],
    paint: { 'line-color': '#ff6a00', 'line-width': 2.5, 'line-opacity': 0.9 },
  });

  map.addLayer({
    id: 'centerline-line',
    type: 'line',
    source: 'centerline',
    paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'gates-line',
    type: 'line',
    source: 'gates',
    paint: {
      'line-color': ['case', ['==', ['get', 'type'], 'sf'], '#ffffff', '#3da5ff'],
      'line-width': 3,
    },
  });
  map.addLayer({
    id: 'measure-line',
    type: 'line',
    source: 'measure',
    paint: { 'line-color': '#ffd166', 'line-width': 2, 'line-dasharray': [2, 1] },
  });

  map.addLayer({
    id: 'schema-apex',
    type: 'circle',
    source: 'schema',
    filter: ['==', ['get', 'kind'], 'schemaApex'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#ff6a00',
      'circle-stroke-color': '#0e1116',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: 'schema-marker',
    type: 'circle',
    source: 'schema',
    filter: ['in', ['get', 'kind'], ['literal', ['schemaMarker', 'schemaSF']]],
    paint: {
      'circle-radius': 4,
      'circle-color': ['case', ['==', ['get', 'mtype'], 'brake'], '#ff4d4f', ['==', ['get', 'mtype'], 'throttle'], '#3ddc84', '#c77dff'],
      'circle-stroke-color': '#0e1116',
      'circle-stroke-width': 1,
    },
  });

  // apex / brake / throttle of the first selected lap
  map.addLayer({
    id: 'markers-apex',
    type: 'circle',
    source: 'markers',
    filter: ['==', ['get', 'kind'], 'apex'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#0e1116',
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'markers-brake',
    type: 'circle',
    source: 'markers',
    filter: ['==', ['get', 'kind'], 'brake'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#ff4d4f',
      'circle-stroke-color': '#0e1116',
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'markers-throttle',
    type: 'circle',
    source: 'markers',
    filter: ['==', ['get', 'kind'], 'throttle'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#3ddc84',
      'circle-stroke-color': '#0e1116',
      'circle-stroke-width': 1.5,
    },
  });

  map.addLayer({
    id: 'markers-turn',
    type: 'symbol',
    source: 'markers',
    filter: ['==', ['get', 'kind'], 'turn'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': TEXT_FONT,
      'text-size': 13,
      'text-offset': [0, -1],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ffd166', 'text-halo-color': '#0e1116', 'text-halo-width': 1.4 },
  });
  map.addLayer({
    id: 'schema-label',
    type: 'symbol',
    source: 'schema',
    filter: ['in', ['get', 'kind'], ['literal', ['schemaTurn', 'schemaSF']]],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': TEXT_FONT,
      'text-size': 12,
      'text-offset': [0, 1],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ff9a4d', 'text-halo-color': '#0e1116', 'text-halo-width': 1.2 },
  });
}
