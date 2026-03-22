import {
  clamp,
  DEG,
  interpolate,
  normalizeDegrees,
  normalizeRadians,
  RAD
} from "./utils.js";

const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = 23.4397 * DEG;

function toJulian(date) {
  return date.valueOf() / 86400000 - 0.5 + J1970;
}

function toDays(date) {
  return toJulian(date) - J2000;
}

function rightAscension(longitude, latitude) {
  return Math.atan2(
    Math.sin(longitude) * Math.cos(OBLIQUITY) - Math.tan(latitude) * Math.sin(OBLIQUITY),
    Math.cos(longitude)
  );
}

function declination(longitude, latitude) {
  return Math.asin(
    Math.sin(latitude) * Math.cos(OBLIQUITY) +
      Math.cos(latitude) * Math.sin(OBLIQUITY) * Math.sin(longitude)
  );
}

function siderealTime(days, longitudeDeg) {
  const theta = 280.16 + 360.9856235 * days + longitudeDeg;
  return normalizeRadians(theta * DEG);
}

function hourAngle(days, longitudeDeg, ra) {
  return siderealTime(days, longitudeDeg) - ra;
}

export function raDecToAltAz(raRad, decRad, date, latDeg, lonDeg) {
  const phi = latDeg * DEG;
  const h = hourAngle(toDays(date), lonDeg, raRad);
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(decRad) + Math.cos(phi) * Math.cos(decRad) * Math.cos(h)
  );
  const azimuth = Math.atan2(
    Math.sin(h),
    Math.cos(h) * Math.sin(phi) - Math.tan(decRad) * Math.cos(phi)
  );

  return {
    altitudeDeg: altitude * RAD,
    azimuthDeg: normalizeDegrees(azimuth * RAD + 180)
  };
}

export function sunCoordinates(date) {
  const days = toDays(date);
  const meanAnomaly = DEG * (357.5291 + 0.98560028 * days);
  const center =
    DEG *
    (1.9148 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly) +
      0.0003 * Math.sin(3 * meanAnomaly));
  const perihelion = 102.9372 * DEG;
  const eclipticLongitude = meanAnomaly + center + perihelion + Math.PI;

  return {
    ra: rightAscension(eclipticLongitude, 0),
    dec: declination(eclipticLongitude, 0),
    eclipticLongitude,
    distanceAu: 1.00014 - 0.01671 * Math.cos(meanAnomaly) - 0.00014 * Math.cos(2 * meanAnomaly)
  };
}

export function sunPosition(date, latDeg, lonDeg) {
  const coords = sunCoordinates(date);
  return raDecToAltAz(coords.ra, coords.dec, date, latDeg, lonDeg);
}

export function moonCoordinates(date) {
  const days = toDays(date);
  const meanLongitude = DEG * (218.316 + 13.176396 * days);
  const meanAnomaly = DEG * (134.963 + 13.064993 * days);
  const meanDistance = DEG * (93.272 + 13.22935 * days);

  const longitude = meanLongitude + DEG * 6.289 * Math.sin(meanAnomaly);
  const latitude = DEG * 5.128 * Math.sin(meanDistance);
  const distanceKm = 385001 - 20905 * Math.cos(meanAnomaly);

  return {
    ra: rightAscension(longitude, latitude),
    dec: declination(longitude, latitude),
    longitude,
    latitude,
    distanceKm
  };
}

export function moonPosition(date, latDeg, lonDeg) {
  const coords = moonCoordinates(date);
  return {
    ...raDecToAltAz(coords.ra, coords.dec, date, latDeg, lonDeg),
    distanceKm: coords.distanceKm
  };
}

export function moonIllumination(date) {
  const sun = sunCoordinates(date);
  const moon = moonCoordinates(date);
  const phaseAngle = normalizeRadians(moon.longitude - sun.eclipticLongitude);
  const illumination = (1 - Math.cos(phaseAngle)) / 2;
  return {
    illumination: clamp(illumination, 0, 1),
    phaseAngleDeg: phaseAngle * RAD,
    waxing: phaseAngle <= Math.PI
  };
}

export function moonPhaseLabel(illumination, waxing) {
  if (illumination < 0.03) {
    return "Mladi Mjesec";
  }
  if (illumination < 0.22) {
    return waxing ? "Rastući srp" : "Opadajući srp";
  }
  if (illumination < 0.47) {
    return waxing ? "Prva četvrt" : "Zadnja četvrt";
  }
  if (illumination < 0.78) {
    return waxing ? "Rastući gibous" : "Opadajući gibous";
  }
  return "Pun Mjesec";
}

function interpolateTransitionTime(previous, current, threshold) {
  const delta = current.altitudeDeg - previous.altitudeDeg;
  if (Math.abs(delta) < 1e-6) {
    return current.time;
  }
  const fraction = clamp((threshold - previous.altitudeDeg) / delta, 0, 1);
  return new Date(
    interpolate(previous.time.getTime(), current.time.getTime(), fraction)
  );
}

function scanTransition(samples, threshold, comparator) {
  let start = null;
  let end = null;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const previousOk = comparator(previous.altitudeDeg, threshold);
    const currentOk = comparator(current.altitudeDeg, threshold);

    if (!previousOk && currentOk && !start) {
      start = interpolateTransitionTime(previous, current, threshold);
    }

    if (previousOk && !currentOk && !end && start) {
      end = interpolateTransitionTime(previous, current, threshold);
      break;
    }
  }

  return { start, end };
}

export function createNightSamples(date, latDeg, lonDeg, stepMinutes = 10) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600000);
  const samples = [];

  for (let time = start.getTime(); time <= end.getTime(); time += stepMinutes * 60000) {
    const sampleTime = new Date(time);
    samples.push({
      time: sampleTime,
      sun: sunPosition(sampleTime, latDeg, lonDeg),
      moon: moonPosition(sampleTime, latDeg, lonDeg)
    });
  }

  return samples.map((sample) => ({
    time: sample.time,
    sunAltitudeDeg: sample.sun.altitudeDeg,
    moonAltitudeDeg: sample.moon.altitudeDeg,
    moonAzimuthDeg: sample.moon.azimuthDeg
  }));
}

export function findAstronomicalNight(date, latDeg, lonDeg) {
  const samples = createNightSamples(date, latDeg, lonDeg, 5).map((item) => ({
    time: item.time,
    altitudeDeg: item.sunAltitudeDeg
  }));

  const { start, end } = scanTransition(samples, -18, (value, threshold) => value <= threshold);

  const darkest = samples.reduce((best, current) =>
    current.altitudeDeg < best.altitudeDeg ? current : best
  );

  return {
    dusk: start,
    dawn: end,
    darkest: darkest.time,
    hasDarkNight: Boolean(start && end)
  };
}

export function buildObservationTimeline(date, latDeg, lonDeg, stepMinutes = 20) {
  const night = findAstronomicalNight(date, latDeg, lonDeg);
  let start = night.dusk;
  let end = night.dawn;

  if (start && end) {
    start = new Date(start.getTime() - 60 * 60000);
    end = new Date(end.getTime() + 60 * 60000);
  } else {
    start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 19, 0, 0);
    end = new Date(start.getTime() + 10 * 3600000);
  }

  const sunMoon = [];
  for (let time = start.getTime(); time <= end.getTime(); time += stepMinutes * 60000) {
    const point = new Date(time);
    sunMoon.push({
      time: point,
      sunAltitudeDeg: sunPosition(point, latDeg, lonDeg).altitudeDeg,
      moon: moonPosition(point, latDeg, lonDeg)
    });
  }

  return {
    night,
    points: sunMoon
  };
}
