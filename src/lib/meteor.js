import { buildObservationTimeline, moonIllumination, raDecToAltAz } from "./astro.js";
import { resolveHorizonAltitude } from "./horizon.js";
import {
  angularSeparationDeg,
  cardinalFromAzimuth,
  clamp,
  formatClock,
  gaussianProfile,
  interpolate,
  round
} from "./utils.js";

function yearlyDate(year, month, day) {
  return new Date(year, month - 1, day, 0, 0, 0);
}

function chooseNearestPeakDate(targetDate, shower) {
  const years = [
    targetDate.getFullYear() - 1,
    targetDate.getFullYear(),
    targetDate.getFullYear() + 1
  ];
  return years
    .map((year) => yearlyDate(year, shower.peak.month, shower.peak.day))
    .reduce((best, current) =>
      Math.abs(current - targetDate) < Math.abs(best - targetDate) ? current : best
    );
}

function inActiveWindow(date, shower) {
  const year = date.getFullYear();
  const candidates = [year - 1, year, year + 1].map((baseYear) => {
    const startYear =
      shower.activeStart.month > shower.activeEnd.month ? baseYear - 1 : baseYear;
    const endYear = baseYear;

    return {
      start: yearlyDate(startYear, shower.activeStart.month, shower.activeStart.day),
      end: yearlyDate(endYear, shower.activeEnd.month, shower.activeEnd.day)
    };
  });

  return candidates.some(({ start, end }) => date >= start && date <= end);
}

function activityFactor(date, shower) {
  if (!inActiveWindow(date, shower)) {
    return 0;
  }

  const peakDate = chooseNearestPeakDate(date, shower);
  const distanceDays = (date - peakDate) / 86400000;
  const sigma = Math.max(1.2, shower.zhr > 90 ? 1.6 : 2.8);
  const broad = gaussianProfile(distanceDays, sigma);
  return clamp(broad, 0.03, 1);
}

function resolvePathYear(targetDate, month, wrapsYear, activeStartMonth, activeEndMonth) {
  const targetMonth = targetDate.getMonth() + 1;
  let year = targetDate.getFullYear();

  if (!wrapsYear) {
    return year;
  }

  if (targetMonth <= activeEndMonth && month >= activeStartMonth) {
    year -= 1;
  } else if (targetMonth >= activeStartMonth && month <= activeEndMonth) {
    year += 1;
  }

  return year;
}

function resolveRadiantForDate(shower, targetDate) {
  if (!Array.isArray(shower.radiantPath) || shower.radiantPath.length === 0) {
    return {
      raHours: shower.radiantRaHours,
      decDeg: shower.radiantDecDeg
    };
  }

  const wrapsYear = shower.activeStart.month > shower.activeEnd.month;
  const points = shower.radiantPath
    .map((point) => ({
      ...point,
      date: yearlyDate(
        resolvePathYear(
          targetDate,
          point.month,
          wrapsYear,
          shower.activeStart.month,
          shower.activeEnd.month
        ),
        point.month,
        point.day
      )
    }))
    .sort((a, b) => a.date - b.date);

  if (points.length === 1) {
    return {
      raHours: points[0].raHours,
      decDeg: points[0].decDeg
    };
  }

  if (targetDate <= points[0].date) {
    return {
      raHours: points[0].raHours,
      decDeg: points[0].decDeg
    };
  }

  if (targetDate >= points.at(-1).date) {
    return {
      raHours: points.at(-1).raHours,
      decDeg: points.at(-1).decDeg
    };
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (targetDate >= previous.date && targetDate <= current.date) {
      const span = current.date - previous.date;
      const fraction = span <= 0 ? 0 : (targetDate - previous.date) / span;
      return {
        raHours: interpolate(previous.raHours, current.raHours, fraction),
        decDeg: interpolate(previous.decDeg, current.decDeg, fraction)
      };
    }
  }

  return {
    raHours: shower.radiantRaHours,
    decDeg: shower.radiantDecDeg
  };
}

function radiantPoint(shower, time, lat, lon) {
  const radiant = resolveRadiantForDate(shower, time);
  const horizontal = raDecToAltAz(
    radiant.raHours * 15 * (Math.PI / 180),
    radiant.decDeg * (Math.PI / 180),
    time,
    lat,
    lon
  );

  return {
    ...horizontal,
    raHours: radiant.raHours,
    decDeg: radiant.decDeg
  };
}

function darknessFactor(sunAltitudeDeg) {
  if (sunAltitudeDeg <= -18) {
    return 1;
  }
  if (sunAltitudeDeg >= -6) {
    return 0;
  }
  return clamp(((-6) - sunAltitudeDeg) / 12, 0, 1);
}

function moonPenalty(illumination, moonAltitudeDeg, separationDeg, visibilityKm = null) {
  if (moonAltitudeDeg <= -2 || illumination < 0.04) {
    return 1;
  }

  const altitudeFactor = clamp((moonAltitudeDeg + 2) / 68, 0, 1);
  const proximityFactor = clamp(1 - separationDeg / 120, 0.05, 1);
  const hazeAmplifier =
    visibilityKm == null ? 1 : 1 + clamp((16 - visibilityKm) / 16, 0, 0.6) * illumination;
  const penalty = illumination * altitudeFactor * (0.38 + proximityFactor * 0.62) * hazeAmplifier;
  return clamp(1 - penalty, 0.12, 1);
}

function skyFactorFromBortle(bortle) {
  return clamp(1.18 - (bortle - 1) * 0.07, 0.55, 1.12);
}

function horizonAltitudeDeg(site, azimuthDeg) {
  return resolveHorizonAltitude(site, azimuthDeg);
}

function horizonFactor(site, azimuthDeg, altitudeDeg) {
  const maskAltitude = horizonAltitudeDeg(site, azimuthDeg);
  const clearance = altitudeDeg - maskAltitude;
  return {
    maskAltitudeDeg: maskAltitude,
    clearanceDeg: clearance,
    factor: clamp(clearance / 12, 0, 1)
  };
}

function weatherVisibilityFactor(visibilityKm) {
  if (!Number.isFinite(visibilityKm)) {
    return 1;
  }
  return clamp((visibilityKm - 3) / 19, 0.35, 1);
}

function visibilityDescriptor(rate) {
  if (rate >= 70) {
    return "intense";
  }
  if (rate >= 30) {
    return "strong";
  }
  if (rate >= 12) {
    return "useful";
  }
  if (rate >= 4) {
    return "modest";
  }
  return "weak";
}

function resolveCalibrationFactor(calibration, site, shower) {
  if (!calibration) {
    return 1;
  }

  const key = `${site.id || "manual"}::${shower.id}`;
  return clamp(calibration[key] ?? 1, 0.45, 1.75);
}

function scientificScore(best, averageRate, weatherFactor) {
  return round(
    clamp(
      averageRate * 0.35 +
        best.radiantAltitudeDeg * 0.18 +
        best.radiantMoonSeparationDeg * 0.08 +
        best.horizonClearanceDeg * 0.55 +
        weatherFactor * 22,
      0,
      100
    ),
    1
  );
}

function uncertaintySpread(entry, baseActivity, site) {
  const cloudTerm = entry.cloudCover == null ? 0.08 : (entry.cloudCover / 100) * 0.12;
  const lowCloudTerm =
    entry.lowCloudCover == null ? 0.08 : (entry.lowCloudCover / 100) * 0.16;
  const visibilityTerm =
    entry.visibilityKm == null ? 0.07 : clamp((12 - entry.visibilityKm) / 18, 0, 0.18);
  const clearanceTerm = clamp((12 - entry.horizonClearanceDeg) / 40, 0, 0.18);
  const activityTerm = clamp((1 - baseActivity) * 0.16, 0.02, 0.16);
  const terrainTerm = site?.terrainProfile?.source ? 0.03 : 0.08;

  return clamp(
    cloudTerm + lowCloudTerm + visibilityTerm + clearanceTerm + activityTerm + terrainTerm,
    0.1,
    0.48
  );
}

export function computeMeteorPlan(shower, date, site, weather = null, calibration = null) {
  const timeline = buildObservationTimeline(date, site.lat, site.lon, 20);
  const illuminationState = moonIllumination(date);
  const baseActivity = activityFactor(date, shower);
  const calibrationFactor = resolveCalibrationFactor(calibration, site, shower);

  const entries = timeline.points.map((point) => {
    const radiant = radiantPoint(shower, point.time, site.lat, site.lon);
    const weatherPoint = weather?.hourly.find(
      (hour) => Math.abs(hour.time - point.time) <= 35 * 60000
    );
    const visibilityKm = weatherPoint?.visibilityKm ?? null;
    const radiantMoonSeparationDeg = angularSeparationDeg(
      radiant.altitudeDeg,
      radiant.azimuthDeg,
      point.moon.altitudeDeg,
      point.moon.azimuthDeg
    );
    const horizon = horizonFactor(site, radiant.azimuthDeg, radiant.altitudeDeg);

    const altitudeFactor = clamp(
      Math.sin(Math.max(0, radiant.altitudeDeg) * (Math.PI / 180)),
      0,
      1
    );
    const darkFactor = darknessFactor(point.sunAltitudeDeg);
    const cloudFactor = weatherPoint
      ? clamp(1 - weatherPoint.cloudCover / 100, 0.08, 1)
      : 1;
    const lowCloudFactor = weatherPoint
      ? clamp(1 - weatherPoint.lowCloudCover / 100, 0.06, 1)
      : 1;
    const visibilityFactor = weatherVisibilityFactor(visibilityKm);
    const rainFactor = weatherPoint
      ? clamp(1 - weatherPoint.precipitationProbability / 100, 0.2, 1)
      : 1;
    const moonFactor = moonPenalty(
      illuminationState.illumination,
      point.moon.altitudeDeg,
      radiantMoonSeparationDeg,
      visibilityKm
    );

    const rawRate =
      shower.zhr *
      baseActivity *
      altitudeFactor ** 1.12 *
      darkFactor *
      moonFactor *
      horizon.factor *
      cloudFactor *
      lowCloudFactor *
      visibilityFactor *
      rainFactor *
      skyFactorFromBortle(site.bortle || 4) *
      calibrationFactor;
    const spreadFactor = uncertaintySpread(
      {
        cloudCover: weatherPoint?.cloudCover ?? null,
        lowCloudCover: weatherPoint?.lowCloudCover ?? null,
        visibilityKm,
        horizonClearanceDeg: horizon.clearanceDeg
      },
      baseActivity,
      site
    );
    const expectedRate = clamp(rawRate, 0, 200);

    return {
      time: point.time,
      radiantAltitudeDeg: radiant.altitudeDeg,
      radiantAzimuthDeg: radiant.azimuthDeg,
      radiantRaHours: radiant.raHours,
      radiantDecDeg: radiant.decDeg,
      radiantMoonSeparationDeg,
      moonAltitudeDeg: point.moon.altitudeDeg,
      moonAzimuthDeg: point.moon.azimuthDeg,
      sunAltitudeDeg: point.sunAltitudeDeg,
      cloudCover: weatherPoint?.cloudCover ?? null,
      lowCloudCover: weatherPoint?.lowCloudCover ?? null,
      visibilityKm,
      horizonMaskAltitudeDeg: horizon.maskAltitudeDeg,
      horizonClearanceDeg: horizon.clearanceDeg,
      spreadFactor,
      ratePerHour: expectedRate,
      pessimisticRatePerHour: clamp(expectedRate * (1 - spreadFactor), 0, 200),
      optimisticRatePerHour: clamp(expectedRate * (1 + spreadFactor * 0.82), 0, 200)
    };
  });

  const best = entries.reduce((winner, current) =>
    current.ratePerHour > winner.ratePerHour ? current : winner
  );
  const topWindow = entries
    .filter((entry) => entry.ratePerHour >= best.ratePerHour * 0.82)
    .map((entry) => entry.time);

  const averageRate =
    entries.reduce((sum, entry) => sum + entry.ratePerHour, 0) / Math.max(entries.length, 1);
  const averagePessimisticRate =
    entries.reduce((sum, entry) => sum + entry.pessimisticRatePerHour, 0) / Math.max(entries.length, 1);
  const averageOptimisticRate =
    entries.reduce((sum, entry) => sum + entry.optimisticRatePerHour, 0) / Math.max(entries.length, 1);
  const windowStart = topWindow[0] || timeline.night.dusk || new Date(date);
  const windowEnd = topWindow[topWindow.length - 1] || timeline.night.dawn || new Date(date);
  const score =
    best.ratePerHour * 0.55 +
    averageRate * 0.25 +
    baseActivity * 25 +
    clamp(best.radiantAltitudeDeg, 0, 90) * 0.15;
  const averageWeatherFactor =
    entries.reduce((sum, entry) => {
      const visibilityFactor = weatherVisibilityFactor(entry.visibilityKm);
      const cloudFactor =
        entry.cloudCover == null ? 1 : clamp(1 - entry.cloudCover / 100, 0.08, 1);
      const lowCloudFactor =
        entry.lowCloudCover == null ? 1 : clamp(1 - entry.lowCloudCover / 100, 0.06, 1);
      return sum + visibilityFactor * cloudFactor * lowCloudFactor;
    }, 0) / Math.max(entries.length, 1);
  const confidenceScore = round(
    clamp(
      100 -
        best.spreadFactor * 120 -
        (1 - averageWeatherFactor) * 42 -
        Math.max(0, 8 - best.horizonClearanceDeg) * 1.6,
      24,
      95
    ),
    0
  );

  return {
    shower,
    active: baseActivity > 0,
    activityFactor: baseActivity,
    score: round(score, 1),
    bestRatePerHour: round(best.ratePerHour, 1),
    averageRatePerHour: round(averageRate, 1),
    bestTime: best.time,
    bestWindowStart: windowStart,
    bestWindowEnd: windowEnd,
    bestRadiantAltitudeDeg: round(best.radiantAltitudeDeg, 1),
    bestRadiantAzimuthDeg: round(best.radiantAzimuthDeg, 1),
    bestRadiantRaHours: round(best.radiantRaHours, 2),
    bestRadiantDecDeg: round(best.radiantDecDeg, 1),
    bestRadiantMoonSeparationDeg: round(best.radiantMoonSeparationDeg, 1),
    bestHorizonMaskAltitudeDeg: round(best.horizonMaskAltitudeDeg, 1),
    bestHorizonClearanceDeg: round(best.horizonClearanceDeg, 1),
    bestDirection: cardinalFromAzimuth(best.radiantAzimuthDeg),
    visibilityClass: visibilityDescriptor(best.ratePerHour),
    bestPessimisticRatePerHour: round(best.pessimisticRatePerHour, 1),
    bestOptimisticRatePerHour: round(best.optimisticRatePerHour, 1),
    averagePessimisticRatePerHour: round(averagePessimisticRate, 1),
    averageOptimisticRatePerHour: round(averageOptimisticRate, 1),
    uncertaintySpread: round(best.spreadFactor, 2),
    confidenceScore,
    operationalScore: round(score, 1),
    scientificScore: scientificScore(best, averageRate, averageWeatherFactor),
    calibrationFactor: round(calibrationFactor, 2),
    entries,
    night: timeline.night,
    moonIllumination: illuminationState.illumination,
    moonPhaseText: illuminationState
  };
}

export function rankShowers(showers, date, site, weather, calibration = null) {
  return showers
    .map((shower) => computeMeteorPlan(shower, date, site, weather, calibration))
    .filter((plan) => plan.active || plan.bestRatePerHour > 1)
    .sort((a, b) => b.score - a.score);
}

export function planSummary(plan) {
  return [
    `${plan.shower.nameBs || plan.shower.name}`,
    `Najbolji termin: ${formatClock(plan.bestWindowStart)}-${formatClock(plan.bestWindowEnd)}`,
    `Procjena u vrhu: ${plan.bestRatePerHour}/h`,
    `Radiant: ${plan.bestRadiantAltitudeDeg} deg ${plan.bestDirection}`,
    `Aktivnost: ${Math.round(plan.activityFactor * 100)}% od maksimuma`
  ].join(" | ");
}

export function buildGearAdvice(plan, setup) {
  const speed = plan.shower.velocityKmS;
  const crop = setup.sensor.crop;
  const focal = setup.focalMm;
  const trailLimitSec = clamp(500 / (focal * crop), 2, 25);
  const targetExposure = speed >= 55 ? 8 : speed >= 35 ? 12 : 16;
  const moonAdjusted =
    plan.moonIllumination > 0.65
      ? targetExposure * 0.72
      : plan.moonIllumination > 0.35
        ? targetExposure * 0.85
        : targetExposure;
  const recommendedExposure = clamp(Math.min(trailLimitSec, moonAdjusted), 2, 25);
  const focalBand =
    speed >= 55 ? "14-20 mm" : speed >= 35 ? "20-28 mm" : "24-35 mm";
  const suggestedIso =
    plan.moonIllumination > 0.65
      ? "ISO 800-1600"
      : plan.moonIllumination > 0.35
        ? "ISO 1600-2500"
        : "ISO 2500-4000";
  const horizontalFov =
    2 * Math.atan(setup.sensor.widthMm / (2 * focal)) * (180 / Math.PI);
  const storagePerHourGb =
    setup.mode === "video"
      ? round(22 + speed * 0.18, 1)
      : setup.mode === "allsky"
        ? round(8 + speed * 0.08, 1)
        : null;
  const fps =
    setup.mode === "video"
      ? speed >= 55
        ? "50-100 fps"
        : speed >= 35
          ? "30-60 fps"
          : "25-50 fps"
      : setup.mode === "allsky"
        ? "25-30 fps"
        : null;

  return {
    focalBand,
    suggestedIso,
    trailLimitSec: round(trailLimitSec, 1),
    recommendedExposureSec: round(recommendedExposure, 1),
    horizontalFovDeg: round(horizontalFov, 1),
    technique:
      setup.mode === "visual"
        ? "Lezaljka i pogled 35-55 deg od radianta daju najbolji realni throughput."
        : setup.mode === "video"
          ? "Video mod trazi veci fps i stalni pointing 40-60 deg od radianta, sa prioritetom na limiting magnitude."
          : setup.mode === "allsky"
            ? "All-sky mod trazi cijeli zenitni kupolasti kadar, kontinualni snimak i precizan UTC time overlay."
        : "Siroki kadar 35-55 deg od radianta smanjuje foreshortening i hvata duze tragove.",
    fireballBias:
      plan.shower.fireballRisk >= 0.8
        ? "Ovaj roj ima povisen fireball potencijal; vrijedi ostaviti duzu kontinuiranu sekvencu."
        : "Akcenat je na broju meteora i dobroj kadenci, ne na rijetkim bolidima.",
    fps,
    storagePerHourGb
  };
}
