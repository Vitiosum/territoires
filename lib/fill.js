import { latLngToTile, tilesForTrack, ZOOM } from "./tiles.js";

// Calcul des cases z14 capturées par un athlète pour le mode territoire :
// cases PARCOURUES (rouler dessus) ∪ cases ENCERCLÉES (intérieur des boucles).
// L'encerclement est calculé sur une grille fine avec fermeture morphologique
// (mêmes réglages que le client), puis reprojeté en cases z14.
const CONQUEST_N = 32768; // 2^15
const CLOSE = 6;
const SHIFT = Math.log2(CONQUEST_N) - ZOOM; // fine -> z14

function toGridFine(lat, lng, n) {
  const r = (lat * Math.PI) / 180;
  return [
    ((lng + 180) / 360) * n,
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  ];
}

function rasterizeTrace(pts, n, mark) {
  const cross = (x, y) => { mark(x, y); mark(x + 1, y); mark(x - 1, y); mark(x, y + 1); mark(x, y - 1); };
  let prev = null;
  for (const [lat, lng] of pts) {
    const cur = toGridFine(lat, lng, n);
    if (prev) {
      const steps = Math.max(1, Math.ceil(2 * Math.max(Math.abs(cur[0] - prev[0]), Math.abs(cur[1] - prev[1]))));
      for (let s = 1; s <= steps; s++)
        cross(Math.floor(prev[0] + ((cur[0] - prev[0]) * s) / steps),
              Math.floor(prev[1] + ((cur[1] - prev[1]) * s) / steps));
    } else {
      cross(Math.floor(cur[0]), Math.floor(cur[1]));
    }
    prev = cur;
  }
}

function dilate(cells, r) {
  const out = new Set();
  for (const k of cells) {
    const [x, y] = k.split(":").map(Number);
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.add((x + dx) + ":" + (y + dy));
  }
  return out;
}
function erode(cells, r) {
  const out = new Set();
  for (const k of cells) {
    const [x, y] = k.split(":").map(Number);
    let keep = true;
    for (let dx = -r; dx <= r && keep; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (!cells.has((x + dx) + ":" + (y + dy))) { keep = false; break; }
    if (keep) out.add(k);
  }
  return out;
}

function interiorCells(cells) {
  if (cells.size < 8) return new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const k of cells) {
    const [x, y] = k.split(":").map(Number);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  minX--; minY--; maxX++; maxY++;
  const W = maxX - minX + 1, H = maxY - minY + 1;
  if (W * H > 4_000_000) return new Set();
  const grid = new Uint8Array(W * H);
  for (const k of cells) { const [x, y] = k.split(":").map(Number); grid[(y - minY) * W + (x - minX)] = 1; }
  const q = [];
  for (let x = 0; x < W; x++) {
    if (!grid[x]) { grid[x] = 2; q.push(x); }
    const b = (H - 1) * W + x;
    if (!grid[b]) { grid[b] = 2; q.push(b); }
  }
  for (let y = 0; y < H; y++) {
    const l = y * W;
    if (!grid[l]) { grid[l] = 2; q.push(l); }
    const rr = y * W + W - 1;
    if (!grid[rr]) { grid[rr] = 2; q.push(rr); }
  }
  while (q.length) {
    const i = q.pop(), x = i % W, y = (i - (i % W)) / W;
    if (x > 0 && !grid[i - 1]) { grid[i - 1] = 2; q.push(i - 1); }
    if (x < W - 1 && !grid[i + 1]) { grid[i + 1] = 2; q.push(i + 1); }
    if (y > 0 && !grid[i - W]) { grid[i - W] = 2; q.push(i - W); }
    if (y < H - 1 && !grid[i + W]) { grid[i + W] = 2; q.push(i + W); }
  }
  const interior = new Set();
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 0) {
      const x = (i % W) + minX, y = (i - (i % W)) / W + minY;
      interior.add(x + ":" + y);
    }
  }
  return interior;
}

// decodedTracks : tableau de traces [[lat,lng], ...]. Renvoie un Set "x:y" (z14).
export function capturedTiles(decodedTracks) {
  const captured = new Set();
  const fine = new Set();
  const addFine = (x, y) => fine.add(x + ":" + y);
  for (const pts of decodedTracks) {
    if (!pts?.length) continue;
    for (const key of tilesForTrack(pts)) captured.add(key); // parcourues (z14, interpolées)
    rasterizeTrace(pts, CONQUEST_N, addFine);
  }
  const interior = interiorCells(erode(dilate(fine, CLOSE), CLOSE));
  for (const k of interior) {
    const [x, y] = k.split(":").map(Number);
    captured.add((x >> SHIFT) + ":" + (y >> SHIFT)); // encerclées reprojetées en z14
  }
  return captured;
}
