import { createRequire } from "node:module";
import { feature } from "topojson-client";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

const require = createRequire(import.meta.url);

// Contours Natural Earth 50m : assez précis pour attribuer des cases de
// 2,4 km, et contrairement au 110m il inclut les petits pays et découpe
// correctement les côtes. Drapeaux et noms français via world-countries.
let countries = null;
function load() {
  if (countries) return countries;
  const topo = require("world-atlas/countries-50m.json");
  const geo = feature(topo, topo.objects.countries);
  const wc = require("world-countries");
  const infoByName = new Map(
    wc.flatMap((c) => {
      const info = { flag: c.flag, nameFr: c.translations.fra?.common || c.name.common };
      const names = [c.name.common, c.name.official, ...Object.values(c.translations).map((t) => t.common)];
      return names.map((n) => [n, info]);
    })
  );
  countries = geo.features.map((f) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const scan = (ring) => {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    };
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) for (const ring of p) scan(ring);
    const info = infoByName.get(f.properties.name);
    return {
      name: info?.nameFr || f.properties.name,
      flag: info?.flag || "",
      areaKm2: area(f) / 1e6,
      bbox: [minX, minY, maxX, maxY],
      feature: f,
    };
  });
  return countries;
}

const cache = new Map(); // "lngArrondi:latArrondi" -> pays (les cases voisines partagent)

export function countryOf(lng, lat) {
  const key = `${Math.round(lng * 20)}:${Math.round(lat * 20)}`; // ~5 km
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const c of load()) {
    const [minX, minY, maxX, maxY] = c.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (booleanPointInPolygon([lng, lat], c.feature)) { found = c; break; }
  }
  if (cache.size < 200_000) cache.set(key, found);
  return found;
}
