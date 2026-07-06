import { tilesForTrack, ZOOM } from "./tiles.js";

// Calcul des cases z14 capturées par un athlète pour le mode territoire :
// cases PARCOURUES (rouler dessus) ∪ cases ENCERCLÉES (intérieur des boucles).
// L'encerclement est calculé sur une grille fine avec fermeture morphologique
// (mêmes réglages que le client), puis reprojeté en cases z14.
//
// Le travail se fait PAR ZONE GÉOGRAPHIQUE (clusters de cellules) : avant,
// une seule sortie lointaine (voyage, VirtualRide/Zwift — coordonnées GPS
// fictives à l'autre bout du monde) rendait la bounding box globale
// gigantesque et le garde-fou mémoire désactivait TOUT le remplissage.
// Désormais chaque zone a sa propre petite bbox.
//
// Cellules fines indexées en numérique (x*N+y, décodage par bits) : zéro
// allocation de string dans les boucles chaudes (dilate/erode) — la sync
// tourne sur le thread unique du serveur. Les coordonnées sont clampées à
// la grille (marge > rayon de fermeture) pour que l'encodage ne puisse
// jamais produire de clé négative ou aliasée (antiméridien, latitudes
// extrêmes, polyline corrompue).
const CONQUEST_N = 32768; // 2^15
const NBITS = 15;
const NMASK = CONQUEST_N - 1;
// Rayon de fermeture = tolérance de brèche (~2*CLOSE cellules, 1 cellule
// ~ 0,8 km aux latitudes françaises). CONQUEST_CLOSE=6 -> brèches <= ~10 km
// scellées. Revers de la générosité : deux passages à moins de ~2*CLOSE
// l'un de l'autre se soudent aussi (bande entre deux routes parallèles,
// coin d'un éventail d'allers-retours). Réglable sans redéploiement :
// clever env set CONQUEST_CLOSE 3  (tolérance ~5 km, captures fantômes
// bien plus rares) puis resync.
const CLOSE_RAW = Number(process.env.CONQUEST_CLOSE || 6);
// entier 1..16 exigé : une valeur mal formée (NaN, 2.5…) produirait des clés
// fractionnaires et désactiverait silencieusement tout l'encerclement
const CLOSE = Number.isInteger(CLOSE_RAW) && CLOSE_RAW >= 1 && CLOSE_RAW <= 16 ? CLOSE_RAW : 6;
const SHIFT = Math.log2(CONQUEST_N) - ZOOM; // fine -> z14
const CELLS_PER_TILE = (1 << SHIFT) * (1 << SHIFT); // 4 : une case z14 = 2x2 cellules fines
const TILE_N = 1 << ZOOM; // 16384 cases z14 par axe
const MARGIN = CLOSE + 2; // dilate(±CLOSE) ne sort jamais de la grille

// Buckets grossiers pour regrouper les zones : taille >= 2*CLOSE+1 pour que
// deux cellules soudables par la fermeture (distance <= 2*CLOSE) tombent
// toujours dans le même bucket ou des buckets 8-adjacents — un anneau
// connexe ne peut donc jamais être coupé entre deux clusters.
const CLUSTER_SHIFT = Math.max(4, Math.ceil(Math.log2(2 * CLOSE + 1)));
const CLUSTER_N = CONQUEST_N >> CLUSTER_SHIFT;

function toGridFine(lat, lng, n) {
  const r = (lat * Math.PI) / 180;
  const x = ((lng + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [
    Math.min(n - 1 - MARGIN, Math.max(MARGIN, x)),
    Math.min(n - 1 - MARGIN, Math.max(MARGIN, y)),
  ];
}

function rasterizeTrace(pts, n, fine) {
  const mark = (x, y) => fine.add(x * n + y);
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
    const x = k >> NBITS, y = k & NMASK;
    for (let dx = -r; dx <= r; dx++) {
      const base = (x + dx) * CONQUEST_N + y;
      for (let dy = -r; dy <= r; dy++) out.add(base + dy);
    }
  }
  return out;
}
function erode(cells, r) {
  const out = new Set();
  for (const k of cells) {
    const x = k >> NBITS, y = k & NMASK;
    let keep = true;
    for (let dx = -r; dx <= r && keep; dx++) {
      const base = (x + dx) * CONQUEST_N + y;
      for (let dy = -r; dy <= r; dy++)
        if (!cells.has(base + dy)) { keep = false; break; }
    }
    if (keep) out.add(k);
  }
  return out;
}

// Cellules ENCERCLÉES d'un cluster : tout ce qui, après scellage des
// brèches, n'est pas relié à l'extérieur — y compris ce que la fermeture a
// comblé — tracé exclu. L'ancienne version ne capturait que les trous
// SURVIVANT à la fermeture : une boucle dont l'intérieur fait moins de
// ~2*CLOSE cellules (~10 km) de large était entièrement avalée par la
// fermeture et ne capturait rien (cas réel : tour de la presqu'île de
// Guérande, intérieur large de 3 à 8 km).
function enclosedCells(closed, trace) {
  if (closed.size < 8) return { enclosed: new Set(), inside: new Set() };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const k of closed) {
    const x = k >> NBITS, y = k & NMASK;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  minX--; minY--; maxX++; maxY++;
  const W = maxX - minX + 1, H = maxY - minY + 1;
  // garde-fou mémoire, désormais PAR CLUSTER : une zone d'activité normale
  // (même un grand tour régional) reste très en dessous
  if (W * H > 4_000_000) return { enclosed: new Set(), inside: new Set() };
  const grid = new Uint8Array(W * H); // 0 libre, 1 scellé, 2 relié à l'extérieur
  for (const k of closed) {
    const x = k >> NBITS, y = k & NMASK;
    grid[(y - minY) * W + (x - minX)] = 1;
  }
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
    const i = q.pop(), x = i % W, y = (i - x) / W;
    if (x > 0 && !grid[i - 1]) { grid[i - 1] = 2; q.push(i - 1); }
    if (x < W - 1 && !grid[i + 1]) { grid[i + 1] = 2; q.push(i + 1); }
    if (y > 0 && !grid[i - W]) { grid[i - W] = 2; q.push(i - W); }
    if (y < H - 1 && !grid[i + W]) { grid[i + W] = 2; q.push(i + W); }
  }
  const enclosed = new Set();
  const inside = new Set(); // TOUTES les cellules non reliées à l'extérieur (tracé et scellage inclus)
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 2) continue; // relié à l'extérieur
    const k = ((i % W) + minX) * CONQUEST_N + ((i - (i % W)) / W + minY);
    inside.add(k);
    if (!trace.has(k)) enclosed.add(k); // le tracé lui-même est déjà « parcouru »
  }
  return { enclosed, inside };
}

// Regroupe les cellules fines par zone géographique : composantes connexes
// de buckets grossiers (8-connexité). Renvoie un tableau de tableaux de clés.
function clusterCells(cells) {
  const buckets = new Map(); // clé bucket -> [clés cellules]
  for (const k of cells) {
    const bk = ((k >> NBITS) >> CLUSTER_SHIFT) * CLUSTER_N + ((k & NMASK) >> CLUSTER_SHIFT);
    const arr = buckets.get(bk);
    if (arr) arr.push(k);
    else buckets.set(bk, [k]);
  }
  const seen = new Set();
  const clusters = [];
  for (const start of buckets.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start];
    const cluster = [];
    while (queue.length) {
      const b = queue.pop();
      cluster.push(...buckets.get(b));
      const bx = Math.floor(b / CLUSTER_N), by = b % CLUSTER_N;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nbx = bx + dx, nby = by + dy;
          // bornes : sans elles, by=0 aliaserait vers (bx-1, CLUSTER_N-1)
          // (fausse adjacence haut/bas de grille aux latitudes clampées)
          if (nbx < 0 || nbx >= CLUSTER_N || nby < 0 || nby >= CLUSTER_N) continue;
          const nb = nbx * CLUSTER_N + nby;
          if (buckets.has(nb) && !seen.has(nb)) { seen.add(nb); queue.push(nb); }
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// decodedTracks : tableau de traces [[lat,lng], ...].
// Renvoie { captured, encircled } (Sets de clés "x:y" z14) :
// captured = parcourues ∪ encerclées ; encircled = seulement l'intérieur
// des boucles (sert aussi à compléter les cases perso, marquées enclave).
export function capturedTiles(decodedTracks) {
  const captured = new Set();
  const encircled = new Set();
  const fine = new Set();
  for (const pts of decodedTracks) {
    if (!pts?.length) continue;
    for (const key of tilesForTrack(pts)) captured.add(key); // parcourues (z14, interpolées)
    rasterizeTrace(pts, CONQUEST_N, fine);
  }
  for (const cluster of clusterCells(fine)) {
    if (cluster.length < 8) continue; // rien d'encerclable
    // Garde-fou AVANT dilate/erode : c'est la phase chère (CPU et mémoire),
    // elle ne doit jamais tourner sur un cluster à bbox démesurée (polyline
    // corrompue reliant des points épars sur le globe -> OOM sur une
    // instance XS, et le client redéclenche le refresh à chaque session).
    // bbox(fermeture(X)) ⊆ bbox(X) élargie de CLOSE : le pré-test est sûr.
    let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
    for (const k of cluster) {
      const x = k >> NBITS, y = k & NMASK;
      if (x < mnX) mnX = x; if (x > mxX) mxX = x;
      if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    }
    const W = mxX - mnX + 2 * CLOSE + 3, H = mxY - mnY + 2 * CLOSE + 3;
    if (W * H > 4_000_000) {
      console.warn(`[fill] cluster ignoré (encerclement seulement) : bbox ${W}x${H} > 4M cellules, ${cluster.length} cellules de trace`);
      continue;
    }
    const cs = new Set(cluster);
    const { enclosed, inside } = enclosedCells(erode(dilate(cs, CLOSE), CLOSE), cs);
    for (const k of enclosed) {
      const x = k >> NBITS, y = k & NMASK;
      const tile = (x >> SHIFT) + ":" + (y >> SHIFT); // reprojection z14
      encircled.add(tile);
      captured.add(tile);
    }
    // Trous de reprojection : une case z14 dont les 2x2 cellules fines sont
    // TOUTES intérieures (tracé compris) est conquise, même si la ligne GPS
    // ne l'a jamais traversée. Sinon, une case cernée de passages à moins
    // d'une cellule (~800 m) de chaque côté reste vide au milieu du
    // territoire : le débordement du corridor la couvre en fin (exclue de
    // l'encerclement) sans que tilesForTrack ne la marque (constaté en prod).
    const cnt = new Map(); // case z14 (clé numérique) -> nb de cellules fines intérieures
    for (const k of inside) {
      const tk = ((k >> NBITS) >> SHIFT) * TILE_N + ((k & NMASK) >> SHIFT);
      cnt.set(tk, (cnt.get(tk) || 0) + 1);
    }
    for (const [tk, c] of cnt) {
      if (c !== CELLS_PER_TILE) continue;
      const key = Math.floor(tk / TILE_N) + ":" + (tk % TILE_N);
      if (!captured.has(key)) {
        encircled.add(key);
        captured.add(key);
      }
    }
  }
  return { captured, encircled };
}
