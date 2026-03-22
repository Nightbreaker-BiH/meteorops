const DEG = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;

function curvatureDropM(distanceKm) {
  const distanceM = distanceKm * 1000;
  return (distanceM * distanceM) / (2 * EARTH_RADIUS_M);
}

function elevationFromAngle(siteAltitudeM, angleDeg, distanceKm) {
  const distanceM = distanceKm * 1000;
  return Math.round(
    siteAltitudeM + Math.tan(angleDeg * DEG) * distanceM + curvatureDropM(distanceKm)
  );
}

function buildTerrainSector(siteAltitudeM, azimuthDeg, horizonAngleDeg) {
  const nearAngle = Math.max(0.2, horizonAngleDeg - 0.9);
  const midAngle = Math.max(0.2, horizonAngleDeg - 0.35);
  const farAngle = Math.max(0.1, horizonAngleDeg - 1.2);
  return {
    azimuthDeg,
    samples: [
      { distanceKm: 1.8, elevationM: elevationFromAngle(siteAltitudeM, nearAngle, 1.8) },
      { distanceKm: 4.5, elevationM: elevationFromAngle(siteAltitudeM, midAngle, 4.5) },
      { distanceKm: 9, elevationM: elevationFromAngle(siteAltitudeM, horizonAngleDeg, 9) },
      { distanceKm: 16, elevationM: elevationFromAngle(siteAltitudeM, farAngle, 16) }
    ]
  };
}

function buildTerrainProfile(siteAltitudeM, horizonAnglesDeg) {
  const sectorStep = 360 / horizonAnglesDeg.length;
  return {
    source: "terrain-profile",
    sectors: horizonAnglesDeg.map((angleDeg, index) =>
      buildTerrainSector(siteAltitudeM, index * sectorStep, angleDeg)
    )
  };
}

const sarajevoMask = [10, 12, 16, 22, 25, 21, 17, 13, 10, 9, 9, 10, 11, 13, 14, 12];
const openMountainMask = [6, 5, 4, 3, 3, 4, 5, 6, 7, 8, 8, 7, 6, 5, 4, 5];
const jahorinaMask = [7, 6, 5, 4, 4, 5, 6, 7, 8, 9, 9, 8, 7, 6, 5, 6];
const vlasicMask = [6, 5, 5, 4, 4, 5, 6, 6, 7, 7, 7, 6, 6, 5, 5, 5];
const lakeValleyMask = [12, 10, 8, 6, 5, 6, 8, 10, 12, 13, 14, 13, 11, 10, 9, 10];
const flatWideMask = [4, 4, 3, 3, 3, 4, 4, 5, 5, 5, 4, 4, 4, 3, 3, 3];

export const presetLocations = [
  {
    id: "sarajevo",
    name: "Sarajevo",
    lat: 43.8563,
    lon: 18.4131,
    altitudeM: 518,
    bortle: 7,
    horizon: "urban-east",
    horizonMaskDeg: sarajevoMask,
    terrainProfile: buildTerrainProfile(518, sarajevoMask)
  },
  {
    id: "bjelasnica",
    name: "Bjelasnica",
    lat: 43.715,
    lon: 18.255,
    altitudeM: 2067,
    bortle: 3,
    horizon: "open-mountain",
    horizonMaskDeg: openMountainMask,
    terrainProfile: buildTerrainProfile(2067, openMountainMask)
  },
  {
    id: "jahorina",
    name: "Jahorina",
    lat: 43.7389,
    lon: 18.5653,
    altitudeM: 1884,
    bortle: 4,
    horizon: "open-mountain",
    horizonMaskDeg: jahorinaMask,
    terrainProfile: buildTerrainProfile(1884, jahorinaMask)
  },
  {
    id: "vlasic",
    name: "Vlasic",
    lat: 44.3183,
    lon: 17.5758,
    altitudeM: 1943,
    bortle: 3,
    horizon: "open-mountain",
    horizonMaskDeg: vlasicMask,
    terrainProfile: buildTerrainProfile(1943, vlasicMask)
  },
  {
    id: "boracko",
    name: "Boracko jezero",
    lat: 43.5994,
    lon: 18.0184,
    altitudeM: 405,
    bortle: 4,
    horizon: "lake-valley",
    horizonMaskDeg: lakeValleyMask,
    terrainProfile: buildTerrainProfile(405, lakeValleyMask)
  },
  {
    id: "livno",
    name: "Livanjsko polje",
    lat: 43.8269,
    lon: 17.0075,
    altitudeM: 720,
    bortle: 3,
    horizon: "flat-wide",
    horizonMaskDeg: flatWideMask,
    terrainProfile: buildTerrainProfile(720, flatWideMask)
  }
];

export const sensorPresets = [
  { id: "full-frame", name: "Full frame", crop: 1, widthMm: 36, heightMm: 24 },
  { id: "aps-c", name: "APS-C", crop: 1.5, widthMm: 23.5, heightMm: 15.6 },
  { id: "mft", name: "Micro 4/3", crop: 2, widthMm: 17.3, heightMm: 13 },
  { id: "1-inch", name: "1-inch", crop: 2.7, widthMm: 13.2, heightMm: 8.8 },
  { id: "phone", name: "Phone", crop: 6, widthMm: 6.4, heightMm: 4.8 }
];
