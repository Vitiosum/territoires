// Tuiles "slippy map" (Web Mercator). Zoom 14 = le standard des jeux de
// territoires (Veloviewer, Squadrats) : ~2,4 km de côté à l'équateur.
export const ZOOM = 14;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Coordonnées de tuile fractionnaires (avant arrondi) — brique commune des
// conversions Web Mercator lng/lat -> tuile.
function lngToTileX(lng, n) {
  return ((lng + 180) / 360) * n;
}
function latToTileY(lat, n) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
}

// Distance haversine en mètres entre deux points [lat, lng]
export function haversineM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Découpe une trace aux « sauts GPS » : quand la montre perd le fix, la
// polyline relie en ligne droite deux points très éloignés — et
// l'interpolation (ici et dans fill.js) peindrait des cases à travers tout
// le pays (cas réel : une diagonale Le Mans -> Paris sur la carte).
// Seuil ADAPTATIF par trace : max(GPS_JUMP_MIN_M, 8 × médiane des
// segments). Une longue ligne droite légitime d'une polyline simplifiée
// reste dans l'ordre de grandeur des autres segments ; un décrochage GPS
// (des dizaines de km d'un coup) crève toujours le plafond. Les points
// isolés entre deux sauts (spike GPS aller-retour) sont abandonnés.
const GPS_JUMP_MIN_M = Number(process.env.GPS_JUMP_MIN_M || 2000);
export function splitTrackOnJumps(latlngs) {
  const pts = [];
  for (const p of latlngs) if (p && p[0] != null && p[1] != null) pts.push(p);
  if (pts.length < 2) return pts.length ? [pts] : [];
  const lens = new Array(pts.length - 1);
  for (let i = 1; i < pts.length; i++) lens[i - 1] = haversineM(pts[i - 1], pts[i]);
  const median = [...lens].sort((x, y) => x - y)[Math.floor(lens.length / 2)];
  const cap = Math.max(GPS_JUMP_MIN_M, 8 * median);
  let jumped = false;
  const parts = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (lens[i - 1] > cap) {
      jumped = true;
      if (cur.length >= 2) parts.push(cur); // un point seul = spike, on jette
      cur = [];
    }
    cur.push(pts[i]);
  }
  if (!jumped) return [pts]; // chemin rapide : trace saine, zéro copie
  if (cur.length >= 2) parts.push(cur);
  return parts;
}

// Ensemble des tuiles traversées par une trace [[lat,lng], ...].
// On interpole chaque segment (pas d'une demi-tuile) : les summary_polyline
// Strava sont simplifiées (Douglas-Peucker), deux points consécutifs peuvent
// sauter plusieurs tuiles sur une ligne droite — sans interpolation, des
// trous apparaîtraient dans les cases capturées le long de la trace.
// La trace est d'abord découpée aux sauts GPS : on n'interpole JAMAIS
// à travers un décrochage de la montre.
export function tilesForTrack(latlngs, z = ZOOM) {
  const n = 2 ** z;
  const set = new Set();
  const add = (x, y) => set.add(`${clamp(x, 0, n - 1)}:${clamp(y, 0, n - 1)}`);
  for (const part of splitTrackOnJumps(latlngs)) {
    let prev = null;
    for (const [lat, lng] of part) {
      const cur = [lngToTileX(lng, n), latToTileY(lat, n)];
      if (prev) {
        const steps = Math.max(
          1,
          Math.ceil(2 * Math.max(Math.abs(cur[0] - prev[0]), Math.abs(cur[1] - prev[1])))
        );
        for (let s = 1; s <= steps; s++) {
          add(
            Math.floor(prev[0] + ((cur[0] - prev[0]) * s) / steps),
            Math.floor(prev[1] + ((cur[1] - prev[1]) * s) / steps)
          );
        }
      } else {
        add(Math.floor(cur[0]), Math.floor(cur[1]));
      }
      prev = cur;
    }
  }
  return set;
}

// Set/itérable de clés "x:y" -> colonnes parallèles pour les INSERT unnest
export function keysToColumns(keys) {
  const xs = [], ys = [];
  for (const k of keys) {
    const [x, y] = k.split(":").map(Number);
    xs.push(x);
    ys.push(y);
  }
  return [xs, ys];
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
  return [((x + 0.5) / n) * 360 - 180, tileYToLat(y + 0.5, n)];
}

// Surface d'une RANGÉE de tuiles : en Web Mercator elle ne dépend que de y.
// Sert aux agrégats SQL GROUP BY (z, y) — évite de rapatrier chaque case.
export function tileRowAreaKm2(y, z) {
  return tileAreaKm2(0, y, z);
}

// Surface réelle d'une tuile en km² (dépend de la latitude en Web Mercator)
export function tileAreaKm2(x, y, z) {
  const n = 2 ** z;
  const lat1 = tileYToLat(y, n);
  const lat2 = tileYToLat(y + 1, n);
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
