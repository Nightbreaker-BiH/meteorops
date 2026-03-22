import { sampleFireballs } from "../data/sampleFireballs.js";
import { readCachedValue, writeCachedValue } from "./utils.js";

const FIREBALL_CACHE_KEY = "meteorops.fireballs.v2";
const FIREBALL_TTL_MS = 6 * 60 * 60 * 1000;

export async function fetchFireballs(limit = 18) {
  const cached = readCachedValue(FIREBALL_CACHE_KEY, FIREBALL_TTL_MS);
  if (cached) {
    return cached.slice(0, limit);
  }

  const url = new URL("https://ssd-api.jpl.nasa.gov/fireball.api");
  url.searchParams.set(
    "fields",
    "date,energy,impact-e,lat,lat-dir,lon,lon-dir,alt,vel"
  );
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "-date");

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Fireball API error: ${response.status}`);
    }

    const payload = await response.json();
    const fireballs = payload.data.map((row) => {
      const lat = Number(row[3]) * (row[4] === "S" ? -1 : 1);
      const lon = Number(row[5]) * (row[6] === "W" ? -1 : 1);
      return {
        date: row[0],
        totalEnergy10e10J: Number(row[1]),
        impactEnergyKt: Number(row[2]),
        lat,
        lon,
        altitudeKm: Number(row[7]),
        velocityKmS: Number(row[8])
      };
    });

    writeCachedValue(FIREBALL_CACHE_KEY, fireballs);
    return fireballs;
  } catch {
    return sampleFireballs.slice(0, limit);
  }
}
