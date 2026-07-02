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
