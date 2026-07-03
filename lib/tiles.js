// Tuiles "slippy map" (Web Mercator). Zoom 14 = le standard des jeux de
// territoires (Veloviewer, Squadrats) : ~2,4 km de côté à l'équateur.
export const ZOOM = 14;

export function latLngToTile(lat, lng, z = ZOOM) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Ensemble des tuiles traversées par une trace [[lat,lng], ...]
export function tilesForTrack(latlngs, z = ZOOM) {
  const set = new Set();
  for (const [lat, lng] of latlngs) {
    if (lat == null || lng == null) continue;
    const { x, y } = latLngToTile(lat, lng, z);
    set.add(`${x}:${y}`);
  }
  return set;
}

// Décodage des polylines encodées Strava (format Google) -> [[lat,lng], ...]
export function decodePolyline(str) {
  let i = 0, lat = 0, lng = 0;
  const coords = [];
  while (i < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    if (Number.isFinite(lat) && Number.isFinite(lng)) coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

// Centre d'une tuile -> [lng, lat]
export function tileCenter(x, y, z) {
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return [lng, lat];
}

// Surface réelle d'une tuile en km² (dépend de la latitude en Web Mercator)
export function tileAreaKm2(x, y, z) {
  const n = 2 ** z;
  const lat = (yy) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  const lat1 = lat(y);
  const lat2 = lat(y + 1);
  const heightKm = Math.abs(lat1 - lat2) * 111.32;
  const widthKm =
    (360 / n) * 111.32 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return heightKm * widthKm;
}

// Bords d'une tuile -> polygone GeoJSON [lng, lat]
export function tileToPolygon(x, y, z = ZOOM) {
  const n = 2 ** z;
  const lng1 = (x / n) * 360 - 180;
  const lng2 = ((x + 1) / n) * 360 - 180;
  const lat1 = tileYToLat(y, n);
  const lat2 = tileYToLat(y + 1, n);
  return [
    [
      [lng1, lat1],
      [lng2, lat1],
      [lng2, lat2],
      [lng1, lat2],
      [lng1, lat1],
    ],
  ];
}

function tileYToLat(y, n) {
  const rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return (rad * 180) / Math.PI;
}
