import { pool } from "./db.js";
import { ZOOM } from "./tiles.js";

// Une "enclave" est un petit groupe de cases entièrement encerclé par les
// cases conquises d'un athlète (lac, zone militaire…) : on le compte comme
// conquis. Le plafond de taille empêche l'abus de la grande boucle qui
// capturerait tout son intérieur sans l'avoir exploré.
const ENCLAVE_MAX_TILES = Number(process.env.ENCLAVE_MAX_TILES || 20);
const GRID_MAX_CELLS = 30_000_000; // garde-fou mémoire (~30 Mo)

export async function fillEnclaves(athleteId) {
  const { rows } = await pool.query(
    "SELECT x, y FROM tiles WHERE athlete_id=$1 AND z=$2",
    [athleteId, ZOOM]
  );
  if (rows.length < 8) return 0; // impossible d'encercler quoi que ce soit

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of rows) {
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.y > maxY) maxY = t.y;
  }
  // marge de 1 : le bord du cadre est garanti hors territoire
  minX--; minY--; maxX++; maxY++;
  const W = maxX - minX + 1;
  const H = maxY - minY + 1;
  if (W * H > GRID_MAX_CELLS) return 0;

  // 0 = libre, 1 = conquise, 2 = reliée à l'extérieur, 3 = enclave vue
  const grid = new Uint8Array(W * H);
  for (const t of rows) grid[(t.y - minY) * W + (t.x - minX)] = 1;

  // BFS depuis tout le bord du cadre : tout ce qui est atteint est "dehors"
  const queue = [];
  for (let x = 0; x < W; x++) {
    if (!grid[x]) { grid[x] = 2; queue.push(x); }
    const b = (H - 1) * W + x;
    if (!grid[b]) { grid[b] = 2; queue.push(b); }
  }
  for (let y = 0; y < H; y++) {
    const l = y * W;
    if (!grid[l]) { grid[l] = 2; queue.push(l); }
    const r = y * W + W - 1;
    if (!grid[r]) { grid[r] = 2; queue.push(r); }
  }
  while (queue.length) {
    const i = queue.pop();
    const x = i % W, y = (i - x) / W;
    if (x > 0 && !grid[i - 1]) { grid[i - 1] = 2; queue.push(i - 1); }
    if (x < W - 1 && !grid[i + 1]) { grid[i + 1] = 2; queue.push(i + 1); }
    if (y > 0 && !grid[i - W]) { grid[i - W] = 2; queue.push(i - W); }
    if (y < H - 1 && !grid[i + W]) { grid[i + W] = 2; queue.push(i + W); }
  }

  // Ce qui reste à 0 est encerclé : on remplit les composantes assez petites
  let filled = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== 0) continue;
    const comp = [i];
    grid[i] = 3;
    for (let k = 0; k < comp.length; k++) {
      const c = comp[k];
      const x = c % W, y = (c - x) / W;
      if (x > 0 && grid[c - 1] === 0) { grid[c - 1] = 3; comp.push(c - 1); }
      if (x < W - 1 && grid[c + 1] === 0) { grid[c + 1] = 3; comp.push(c + 1); }
      if (y > 0 && grid[c - W] === 0) { grid[c - W] = 3; comp.push(c - W); }
      if (y < H - 1 && grid[c + W] === 0) { grid[c + W] = 3; comp.push(c + W); }
    }
    if (comp.length > ENCLAVE_MAX_TILES) continue;
    for (const c of comp) {
      const x = (c % W) + minX;
      const y = (c - (c % W)) / W + minY;
      await pool.query(
        `INSERT INTO tiles (athlete_id, z, x, y, enclave)
         VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (athlete_id, z, x, y) DO NOTHING`,
        [athleteId, ZOOM, x, y]
      );
      filled++;
    }
  }
  return filled;
}
