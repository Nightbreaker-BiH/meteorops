import { meteorShowers } from "../data/meteorShowers.js";
import { rankShowers } from "../lib/meteor.js";

self.addEventListener("message", (event) => {
  const { requestId, dateIso, site, weather, calibration } = event.data;

  try {
    const plans = rankShowers(meteorShowers, new Date(dateIso), site, weather, calibration);
    self.postMessage({
      requestId,
      ok: true,
      plans
    });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : "Planner worker failed."
    });
  }
});
