export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function interpolate(a, b, fraction) {
  return a + (b - a) * fraction;
}

export function formatSigned(value, digits = 2) {
  const rounded = round(value, digits).toFixed(digits);
  return value >= 0 ? `+${rounded}` : rounded;
}

export function formatClock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(date) {
  return `${formatDate(date)} ${formatClock(date)}`;
}

export function hourLabel(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toMonthDay({ month, day }) {
  return `${pad(day)}.${pad(month)}.`;
}

export function percent(value) {
  return `${Math.round(value)}%`;
}

export function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

export function normalizeRadians(value) {
  const full = Math.PI * 2;
  return ((value % full) + full) % full;
}

export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

export function cardinalFromAzimuth(azimuthDeg) {
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(normalizeDegrees(azimuthDeg) / 45) % 8;
  return labels[index];
}

export function angularSeparationDeg(alt1Deg, az1Deg, alt2Deg, az2Deg) {
  const alt1 = alt1Deg * DEG;
  const alt2 = alt2Deg * DEG;
  const deltaAz = Math.abs(normalizeDegrees(az1Deg - az2Deg)) * DEG;
  const cosine =
    Math.sin(alt1) * Math.sin(alt2) + Math.cos(alt1) * Math.cos(alt2) * Math.cos(deltaAz);
  return Math.acos(clamp(cosine, -1, 1)) * RAD;
}

export function gaussianProfile(distanceDays, sigmaDays) {
  if (!Number.isFinite(sigmaDays) || sigmaDays <= 0) {
    return 0;
  }
  return Math.exp(-0.5 * (distanceDays / sigmaDays) ** 2);
}

export function nearestValue(items, predicate) {
  return items.reduce((best, item) => {
    if (!best) {
      return item;
    }
    return predicate(item) < predicate(best) ? item : best;
  }, null);
}

export function uniqueId(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors; the app remains fully functional without persistence.
  }
}

export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

export function readCachedValue(key, ttlMs) {
  const cached = storageGet(key, null);
  if (!cached || typeof cached.savedAt !== "number") {
    return null;
  }
  if (Date.now() - cached.savedAt > ttlMs) {
    storageRemove(key);
    return null;
  }
  return cached.value ?? null;
}

export function writeCachedValue(key, value) {
  storageSet(key, {
    savedAt: Date.now(),
    value
  });
}
