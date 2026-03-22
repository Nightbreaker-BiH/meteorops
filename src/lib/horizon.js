import { RAD, clamp, interpolate, normalizeDegrees, round } from "./utils.js";

const EARTH_RADIUS_M = 6371000;

function curvatureDropM(distanceM) {
  return (distanceM * distanceM) / (2 * EARTH_RADIUS_M);
}

function sectorAngles(count) {
  const sectorCount = Math.max(1, count || 1);
  return Array.from({ length: sectorCount }, (_, index) => index * (360 / sectorCount));
}

function densifyMask(mask, sectorCount) {
  if (!Array.isArray(mask) || !mask.length) {
    return new Array(sectorCount).fill(0);
  }
  if (mask.length === sectorCount) {
    return [...mask];
  }

  const sourceStep = 360 / mask.length;
  return sectorAngles(sectorCount).map((azimuthDeg) => {
    const normalized = normalizeDegrees(azimuthDeg);
    const sourceIndex = normalized / sourceStep;
    const lowerIndex = Math.floor(sourceIndex) % mask.length;
    const upperIndex = (lowerIndex + 1) % mask.length;
    const fraction = sourceIndex - Math.floor(sourceIndex);
    return round(interpolate(mask[lowerIndex] ?? 0, mask[upperIndex] ?? 0, fraction), 2);
  });
}

function solveTerrainSector(siteAltitudeM, sector) {
  if (!sector?.samples?.length) {
    return 0;
  }

  return sector.samples.reduce((best, sample) => {
    const distanceM = Math.max(1, (sample.distanceKm || 0) * 1000);
    const relativeElevationM =
      (sample.elevationM || siteAltitudeM) - siteAltitudeM - curvatureDropM(distanceM);
    const angleDeg = Math.atan2(relativeElevationM, distanceM) * RAD;
    return Math.max(best, angleDeg);
  }, 0);
}

function terrainAngles(site) {
  const siteAltitudeM = site?.altitudeM || 0;
  const sectors = site?.terrainProfile?.sectors;
  if (!Array.isArray(sectors) || !sectors.length) {
    return [];
  }

  return sectors
    .map((sector) => ({
      azimuthDeg: normalizeDegrees(sector.azimuthDeg || 0),
      altitudeDeg: solveTerrainSector(siteAltitudeM, sector)
    }))
    .sort((a, b) => a.azimuthDeg - b.azimuthDeg);
}

function interpolateTerrainAngle(angles, azimuthDeg) {
  if (!angles.length) {
    return 0;
  }
  if (angles.length === 1) {
    return angles[0].altitudeDeg;
  }

  const normalized = normalizeDegrees(azimuthDeg);
  const first = angles[0];
  const last = angles.at(-1);

  if (normalized < first.azimuthDeg) {
    const span = first.azimuthDeg + 360 - last.azimuthDeg;
    const fraction = span <= 0 ? 0 : (normalized + 360 - last.azimuthDeg) / span;
    return interpolate(last.altitudeDeg, first.altitudeDeg, clamp(fraction, 0, 1));
  }

  for (let index = 1; index < angles.length; index += 1) {
    const previous = angles[index - 1];
    const current = angles[index];
    if (normalized >= previous.azimuthDeg && normalized <= current.azimuthDeg) {
      const span = current.azimuthDeg - previous.azimuthDeg;
      const fraction = span <= 0 ? 0 : (normalized - previous.azimuthDeg) / span;
      return interpolate(previous.altitudeDeg, current.altitudeDeg, clamp(fraction, 0, 1));
    }
  }

  const wrapSpan = first.azimuthDeg + 360 - last.azimuthDeg;
  const wrapFraction = wrapSpan <= 0 ? 0 : (normalized - last.azimuthDeg) / wrapSpan;
  return interpolate(last.altitudeDeg, first.altitudeDeg, clamp(wrapFraction, 0, 1));
}

export function resolveTerrainHorizonMask(site, sectorCount = 16) {
  const terrain = terrainAngles(site);
  if (terrain.length) {
    return sectorAngles(sectorCount).map((azimuthDeg) =>
      round(interpolateTerrainAngle(terrain, azimuthDeg), 1)
    );
  }
  return densifyMask(site?.horizonMaskDeg, sectorCount);
}

export function resolveHorizonAltitude(site, azimuthDeg) {
  const terrain = terrainAngles(site);
  if (terrain.length) {
    return round(interpolateTerrainAngle(terrain, azimuthDeg), 2);
  }

  const mask = resolveTerrainHorizonMask(site, Array.isArray(site?.horizonMaskDeg) ? site.horizonMaskDeg.length : 16);
  if (!mask.length) {
    return 0;
  }
  const sectorStep = 360 / mask.length;
  const normalized = normalizeDegrees(azimuthDeg);
  const sourceIndex = normalized / sectorStep;
  const lowerIndex = Math.floor(sourceIndex) % mask.length;
  const upperIndex = (lowerIndex + 1) % mask.length;
  const fraction = sourceIndex - Math.floor(sourceIndex);
  return round(interpolate(mask[lowerIndex] ?? 0, mask[upperIndex] ?? 0, fraction), 2);
}

export function averageResolvedHorizon(site, sectorCount = 16) {
  const mask = resolveTerrainHorizonMask(site, sectorCount);
  if (!mask.length) {
    return 0;
  }
  return round(mask.reduce((sum, value) => sum + value, 0) / mask.length, 1);
}

export function terrainSourceLabel(site) {
  if (site?.terrainProfile?.source) {
    return site.terrainProfile.source;
  }
  if (Array.isArray(site?.horizonMaskDeg) && site.horizonMaskDeg.length) {
    return "manual-mask";
  }
  return "flat-default";
}
