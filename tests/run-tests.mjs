import assert from "node:assert/strict";

import { presetLocations } from "../src/data/locations.js";
import { buildObservationTimeline, moonIllumination, sunPosition } from "../src/lib/astro.js";
import { resolveTerrainHorizonMask } from "../src/lib/horizon.js";
import { computeMeteorPlan } from "../src/lib/meteor.js";
import { meteorShowers } from "../src/data/meteorShowers.js";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

run("moon illumination stays within physical limits", () => {
  const sample = moonIllumination(new Date("2026-08-12T00:00:00Z"));
  assert.ok(sample.illumination >= 0);
  assert.ok(sample.illumination <= 1);
});

run("sun altitude is lower at midnight than midday for Sarajevo summer sample", () => {
  const lat = 43.8563;
  const lon = 18.4131;
  const midday = sunPosition(new Date("2026-06-20T12:00:00Z"), lat, lon).altitudeDeg;
  const midnight = sunPosition(new Date("2026-06-20T00:00:00Z"), lat, lon).altitudeDeg;
  assert.ok(midday > midnight);
});

run("observation timeline produces night sample points", () => {
  const timeline = buildObservationTimeline(new Date("2026-08-12T20:00:00"), 43.715, 18.255, 20);
  assert.ok(timeline.points.length >= 10);
  assert.ok(timeline.points[0].time < timeline.points.at(-1).time);
});

run("meteor plan yields positive throughput near Perseid peak", () => {
  const perseids = meteorShowers.find((item) => item.id === "perseids");
  const plan = computeMeteorPlan(perseids, new Date("2026-08-12T20:00:00"), {
    lat: 43.715,
    lon: 18.255,
    bortle: 3
  });

  assert.ok(plan.bestRatePerHour > 10);
  assert.ok(plan.bestRadiantAltitudeDeg >= 0);
});

run("radiant path interpolation shifts radiant through the season", () => {
  const perseids = meteorShowers.find((item) => item.id === "perseids");
  const early = computeMeteorPlan(perseids, new Date("2026-07-20T20:00:00"), {
    lat: 43.715,
    lon: 18.255,
    bortle: 3
  });
  const late = computeMeteorPlan(perseids, new Date("2026-08-15T20:00:00"), {
    lat: 43.715,
    lon: 18.255,
    bortle: 3
  });

  assert.ok(late.bestRadiantRaHours > early.bestRadiantRaHours);
});

run("darkness factor suppresses twilight throughput", () => {
  const perseids = meteorShowers.find((item) => item.id === "perseids");
  const plan = computeMeteorPlan(perseids, new Date("2026-08-12T20:00:00"), {
    lat: 43.715,
    lon: 18.255,
    bortle: 3
  });
  const twilightEntry = plan.entries.find((entry) => entry.sunAltitudeDeg > -12);
  const darkEntry = plan.entries.find((entry) => entry.sunAltitudeDeg < -20);

  assert.ok(twilightEntry);
  assert.ok(darkEntry);
  assert.ok(darkEntry.ratePerHour > twilightEntry.ratePerHour);
});

run("horizon mask penalizes low-clearance radiant geometry", () => {
  const perseids = meteorShowers.find((item) => item.id === "perseids");
  const openPlan = computeMeteorPlan(perseids, new Date("2026-08-12T20:00:00"), {
    id: "open",
    lat: 43.715,
    lon: 18.255,
    bortle: 3,
    horizonMaskDeg: [3, 3, 3, 3, 3, 3, 3, 3]
  });
  const blockedPlan = computeMeteorPlan(perseids, new Date("2026-08-12T20:00:00"), {
    id: "blocked",
    lat: 43.715,
    lon: 18.255,
    bortle: 3,
    horizonMaskDeg: [25, 25, 25, 25, 25, 25, 25, 25]
  });

  assert.ok(openPlan.averageRatePerHour > blockedPlan.averageRatePerHour);
  assert.ok(blockedPlan.entries.some((entry) => entry.horizonClearanceDeg < 0 && entry.ratePerHour === 0));
});

run("calibration factor boosts planner rate when logs indicate underprediction", () => {
  const perseids = meteorShowers.find((item) => item.id === "perseids");
  const basePlan = computeMeteorPlan(perseids, new Date("2026-08-12T20:00:00"), {
    id: "site-a",
    lat: 43.715,
    lon: 18.255,
    bortle: 3
  });
  const calibratedPlan = computeMeteorPlan(
    perseids,
    new Date("2026-08-12T20:00:00"),
    {
      id: "site-a",
      lat: 43.715,
      lon: 18.255,
      bortle: 3
    },
    null,
    { "site-a::perseids": 1.3 }
  );

  assert.ok(calibratedPlan.bestRatePerHour > basePlan.bestRatePerHour);
});

run("terrain horizon solver resolves a multi-sector mask from terrain samples", () => {
  const bjelasnica = presetLocations.find((item) => item.id === "bjelasnica");
  const resolved = resolveTerrainHorizonMask(bjelasnica, 16);

  assert.equal(resolved.length, 16);
  assert.ok(Math.max(...resolved) > Math.min(...resolved));
  assert.ok(resolved.every((value) => value >= 0));
});

run("uncertainty band brackets the expected throughput", () => {
  const perseids = meteorShowers.find((item) => item.id === "perseids");
  const plan = computeMeteorPlan(perseids, new Date("2026-08-12T20:00:00"), {
    id: "site-b",
    lat: 43.715,
    lon: 18.255,
    altitudeM: 2067,
    bortle: 3,
    terrainProfile: presetLocations.find((item) => item.id === "bjelasnica").terrainProfile
  });

  assert.ok(plan.bestPessimisticRatePerHour <= plan.bestRatePerHour);
  assert.ok(plan.bestOptimisticRatePerHour >= plan.bestRatePerHour);
  assert.ok(plan.confidenceScore >= 0 && plan.confidenceScore <= 100);
});

if (!process.exitCode) {
  console.log("All MeteorOps tests passed.");
}
