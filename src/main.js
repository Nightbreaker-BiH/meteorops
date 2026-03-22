import { presetLocations, sensorPresets } from "./data/locations.js";
import { meteorShowers } from "./data/meteorShowers.js";
import { averageResolvedHorizon, resolveTerrainHorizonMask, terrainSourceLabel } from "./lib/horizon.js";
import { moonPhaseLabel } from "./lib/astro.js";
import { fetchFireballs } from "./lib/fireballs.js";
import { buildGearAdvice, planSummary, rankShowers } from "./lib/meteor.js";
import { fetchWeather, summarizeWeather } from "./lib/weather.js";
import {
  cardinalFromAzimuth,
  clamp,
  formatClock,
  formatDate,
  formatSigned,
  normalizeDegrees,
  percent,
  round,
  storageGet,
  storageSet,
  toMonthDay,
  uniqueId
} from "./lib/utils.js";

const app = document.querySelector("#app");
const heroImageUrl = new URL("../aslovna.jpg", import.meta.url).href;
const savedSites = storageGet("meteorops.savedSites", []);
const preferences = storageGet("meteorops.preferences", {});
const sessionLogs = storageGet("meteorops.sessionLogs", []);
const observationEvents = storageGet("meteorops.observationEvents", []);
const fireballDrafts = storageGet("meteorops.fireballDrafts", []);
const stationNetwork = storageGet("meteorops.stationNetwork", []);
const defaultSite = presetLocations.find((item) => item.id === "bjelasnica") || presetLocations[0];
const defaultSensor = sensorPresets.find((item) => item.id === "full-frame");

const plannerWorker =
  typeof Worker !== "undefined"
    ? new Worker(new URL("./workers/planner.worker.js", import.meta.url), { type: "module" })
    : null;

const state = {
  lang: preferences.lang || "bs",
  theme: preferences.theme || "dark",
  date: preferences.date || formatDate(new Date()),
  siteId: preferences.siteId || defaultSite.id,
  latInput: String(preferences.lat ?? defaultSite.lat),
  lonInput: String(preferences.lon ?? defaultSite.lon),
  notes: preferences.notes || "",
  selectedShowerId: preferences.selectedShowerId || "",
  setup: {
    mode: preferences.setup?.mode || "timelapse",
    sensorId: preferences.setup?.sensorId || defaultSensor.id,
    focalMm: preferences.setup?.focalMm || 20,
    aperture: preferences.setup?.aperture || 2.8
  },
  savedSites,
  sessionLogs,
  observationEvents,
  stationNetwork,
  weather: null,
  weatherStatus: "idle",
  weatherError: "",
  weatherFetchedAt: null,
  fireballs: [],
  fireballStatus: "idle",
  fireballError: "",
  fireballDrafts,
  plans: [],
  planStatus: "idle",
  planError: "",
  observerCount: preferences.observerCount || 3,
  reportMode: preferences.reportMode || "imo",
  skyCamera: {
    mode: preferences.skyCamera?.mode || "device",
    deviceId: preferences.skyCamera?.deviceId || "",
    embedUrl: preferences.skyCamera?.embedUrl || "",
    embedType: preferences.skyCamera?.embedType || "iframe"
  },
  cameraDevices: [],
  cameraStatus: "idle",
  cameraError: "",
  audioLogger: {
    supported: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    listening: false,
    transcript: "",
    autoCommit: preferences.audioLogger?.autoCommit ?? true,
    language: preferences.audioLogger?.language || "bs-BA",
    error: ""
  },
  trigger: {
    enabled: false,
    sensitivity: preferences.trigger?.sensitivity ?? 0.12,
    minPixels: preferences.trigger?.minPixels ?? 140,
    cooldownSec: preferences.trigger?.cooldownSec ?? 8,
    autoLog: preferences.trigger?.autoLog ?? true,
    detectionCount: 0,
    lastDetectionIso: "",
    lastScore: 0,
    analysisFps: 0,
    lastFramePreview: "",
    status: "idle",
    error: ""
  },
  watchForm: {
    limitingMagnitude: preferences.watchForm?.limitingMagnitude ?? 5.8,
    cloudFraction: preferences.watchForm?.cloudFraction ?? 20,
    effectiveHours: preferences.watchForm?.effectiveHours ?? 1.0,
    breakMinutes: preferences.watchForm?.breakMinutes ?? 0,
    sqm: preferences.watchForm?.sqm ?? 21.2,
    centerAzDeg: preferences.watchForm?.centerAzDeg ?? 180,
    centerAltDeg: preferences.watchForm?.centerAltDeg ?? 55,
    skyQualityNote: preferences.watchForm?.skyQualityNote || ""
  },
  eventDraft: {
    utcIso: preferences.eventDraft?.utcIso || new Date().toISOString(),
    magnitude: preferences.eventDraft?.magnitude ?? -1,
    color: preferences.eventDraft?.color || "white",
    train: preferences.eventDraft?.train || "none",
    fragmentation: preferences.eventDraft?.fragmentation || "none",
    azimuthDeg: preferences.eventDraft?.azimuthDeg ?? 180,
    altitudeDeg: preferences.eventDraft?.altitudeDeg ?? 45,
    notes: preferences.eventDraft?.notes || ""
  },
  stationDraft: {
    name: preferences.stationDraft?.name || "",
    role: preferences.stationDraft?.role || "allsky",
    lens: preferences.stationDraft?.lens || "2.5 mm f/0.95",
    resolution: preferences.stationDraft?.resolution || "1920x1080 @ 25 fps",
    orientationAzDeg: preferences.stationDraft?.orientationAzDeg ?? 180,
    orientationAltDeg: preferences.stationDraft?.orientationAltDeg ?? 70,
    limitingMagnitude: preferences.stationDraft?.limitingMagnitude ?? 5.5,
    status: preferences.stationDraft?.status || "ready"
  },
  tonightBoard: [],
  tonightStatus: "idle",
  tonightError: "",
  reminderStatus: "idle"
};

const elements = {};
let weatherRequestId = 0;
let plannerRequestId = 0;
let weatherDebounceTimer = null;
let planDebounceTimer = null;
let weatherAbortController = null;
let reminderTimers = [];
let cameraStream = null;
let triggerAnimationFrame = null;
let triggerLastFrame = null;
let triggerLastProcessAt = 0;
let triggerLastDetectionAt = 0;
let voiceRecognition = null;

function allSites() {
  return [...presetLocations, ...state.savedSites, { id: "manual", name: "Rucni unos" }];
}

function parseCoordinates() {
  const lat = Number(state.latInput);
  const lon = Number(state.lonInput);
  return {
    lat,
    lon,
    valid: Number.isFinite(lat) && Number.isFinite(lon)
  };
}

function normalizeSite(site) {
  if (!site) {
    return null;
  }

  return {
    ...site,
    horizonMaskDeg: resolveTerrainHorizonMask(site, 16),
    horizonSource: terrainSourceLabel(site)
  };
}

function currentSiteMeta() {
  return normalizeSite(
    [...presetLocations, ...state.savedSites].find((site) => site.id === state.siteId) || {
      id: "manual",
      name: "Rucna lokacija",
      altitudeM: null,
      bortle: 4,
      horizon: "custom"
    }
  );
}

function selectedSiteSnapshot() {
  const coords = parseCoordinates();
  if (!coords.valid) {
    return null;
  }

  const meta = currentSiteMeta();
  return normalizeSite({
    ...meta,
    id: state.siteId,
    lat: coords.lat,
    lon: coords.lon,
    bortle: meta.bortle || 4,
    horizon: meta.horizon || "custom"
  });
}

function selectedDate() {
  return new Date(`${state.date}T20:00:00`);
}

function selectedSensor() {
  return sensorPresets.find((sensor) => sensor.id === state.setup.sensorId) || defaultSensor;
}

function persistPreferences() {
  const coords = parseCoordinates();
  storageSet("meteorops.preferences", {
    lang: state.lang,
    theme: state.theme,
    date: state.date,
    siteId: state.siteId,
    lat: coords.valid ? coords.lat : defaultSite.lat,
    lon: coords.valid ? coords.lon : defaultSite.lon,
    notes: state.notes,
    selectedShowerId: state.selectedShowerId,
    setup: state.setup,
    observerCount: state.observerCount,
    reportMode: state.reportMode,
    skyCamera: state.skyCamera,
    audioLogger: {
      autoCommit: state.audioLogger.autoCommit,
      language: state.audioLogger.language
    },
    trigger: {
      sensitivity: state.trigger.sensitivity,
      minPixels: state.trigger.minPixels,
      cooldownSec: state.trigger.cooldownSec,
      autoLog: state.trigger.autoLog
    },
    watchForm: state.watchForm,
    stationDraft: state.stationDraft,
    eventDraft: state.eventDraft
  });
  storageSet("meteorops.savedSites", state.savedSites);
  storageSet("meteorops.sessionLogs", state.sessionLogs);
  storageSet("meteorops.observationEvents", state.observationEvents);
  storageSet("meteorops.fireballDrafts", state.fireballDrafts);
  storageSet("meteorops.stationNetwork", state.stationNetwork);
}

function syncHash() {
  const params = new URLSearchParams();
  const coords = parseCoordinates();
  params.set("date", state.date);
  if (coords.valid) {
    params.set("lat", String(round(coords.lat, 4)));
    params.set("lon", String(round(coords.lon, 4)));
  }
  if (state.selectedShowerId) {
    params.set("shower", state.selectedShowerId);
  }
  window.history.replaceState(null, "", `#${params.toString()}`);
}

function persistState() {
  persistPreferences();
  syncHash();
}

function applyTheme() {
  document.body.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", state.theme === "light" ? "#f4efe5" : "#07111f");
  }
}

function isEnglish() {
  return state.lang === "en";
}

function t(bs, en) {
  return isEnglish() ? en : bs;
}

function applyLanguage() {
  document.documentElement.lang = state.lang === "en" ? "en" : "bs";
  document.title = t(
    "MeteorOps | Planiranje meteorskih rojeva i terenskih operacija",
    "MeteorOps | Meteor shower planning and field operations"
  );

  const meta = document.querySelector('meta[name="description"]');
  if (meta) {
    meta.setAttribute(
      "content",
      t(
        "MeteorOps je napredni planner za meteorske rojeve, vremensku prognozu, opremu i fireball monitoring.",
        "MeteorOps is an advanced planner for meteor showers, weather, gear and fireball monitoring."
      )
    );
  }
}

function openAboutWindow() {
  const win = window.open("", "_blank", "width=980,height=840");
  if (!win) {
    return;
  }
  win.opener = null;

  const title = t("O aplikaciji MeteorOps", "About MeteorOps");
  const subtitle = t(
    "Operativna astro aplikacija za planiranje meteorskih rojeva, procjenu uslova i terenski rad.",
    "An operational astronomy app for meteor shower planning, condition assessment and field work."
  );
  const intro = t(
    "MeteorOps objedinjuje astronomsku geometriju, vremensku prognozu, lokalni horizont, preporuke za opremu, event logging i kameru neba u jedan workflow. Aplikacija je zamišljena kao operativni alat za posmatrača ili mali tim koji mora brzo odlučiti da li noc vrijedi izlaska, gdje gledati, kako postaviti opremu i kako uredno dokumentovati rezultate.",
    "MeteorOps combines astronomical geometry, weather forecasting, local horizon data, gear guidance, event logging and sky-camera tooling into one workflow. The app is designed as an operational tool for an observer or a small team that needs to decide quickly whether a night is worth going out, where to look, how to configure gear and how to document results properly."
  );
  const bullets = [
    t(
      "Planner roja racuna aktivnost, tamu, visinu radianta, Moon penalty, masku horizonta i uticaj vremena kroz satni observing prozor.",
      "The shower planner evaluates activity, darkness, radiant altitude, Moon penalty, horizon masking and weather impact across an hourly observing window."
    ),
    t(
      "Weather sloj prikazuje satnu prognozu, cloud-break heuristiku, vidljivost, vjetar i padavine kako bi odluka o izlasku bila zasnovana na stvarnim uslovima.",
      "The weather layer shows an hourly forecast, cloud-break heuristics, visibility, wind and precipitation so the go/no-go decision is based on real conditions."
    ),
    t(
      "Setup i sky-map moduli daju preporuceni kadar, ekspoziciju, optimalni smjer pogleda i raspodjelu sektora za vise posmatraca ili kamera.",
      "The setup and sky-map modules provide recommended framing, exposure, optimal look direction and sector allocation for multiple observers or cameras."
    ),
    t(
      "Logger sesije, UTC event marker i fireball draft alati omogucavaju uredan zapis nauznih i operativnih podataka na terenu.",
      "The session logger, UTC event marker and fireball draft tools support clean scientific and operational record-keeping in the field."
    ),
    t(
      "Sky camera, trigger i QC sloj dodaju live monitoring, osnovnu detekciju i kontrolu stanja sistema tokom posmatranja.",
      "The sky camera, trigger and QC layer add live monitoring, basic detection and system-health visibility during observing."
    )
  ];
  const accuracy = t(
    "Napomena o tacnosti: MeteorOps je namijenjen session planningu, operativnom briefu i terenskom radu. Nije zamjena za formalnu redukciju podataka ili publikacijski nivo analize bez dodatne validacije.",
    "Accuracy note: MeteorOps is intended for session planning, operational briefs and field work. It is not a replacement for formal data reduction or publication-grade analysis without additional validation."
  );
  const author = t("Autor: Alan Catovic", "Author: Alan Catovic");

  win.document.write(`<!doctype html>
<html lang="${state.lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: ${state.theme};
        --bg: ${state.theme === "light" ? "#f7f2ea" : "#07101d"};
        --surface: ${state.theme === "light" ? "rgba(255,255,255,0.9)" : "rgba(10,21,39,0.9)"};
        --surface-2: ${state.theme === "light" ? "rgba(246,240,230,0.96)" : "rgba(13,28,50,0.92)"};
        --text: ${state.theme === "light" ? "#17263f" : "#eef4ff"};
        --muted: ${state.theme === "light" ? "#5d6f8b" : "#9db1cb"};
        --stroke: ${state.theme === "light" ? "rgba(53,76,119,0.18)" : "rgba(153,197,255,0.18)"};
        --accent: #39b8ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Aptos", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top right, rgba(57,184,255,0.14), transparent 22%),
          radial-gradient(circle at bottom left, rgba(255,159,75,0.12), transparent 18%),
          linear-gradient(180deg, var(--bg), color-mix(in srgb, var(--bg) 88%, black 12%));
      }
      .wrap {
        width: min(980px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .card {
        border: 1px solid var(--stroke);
        border-radius: 28px;
        overflow: hidden;
        background: var(--surface);
        box-shadow: 0 24px 80px rgba(7, 18, 36, 0.18);
      }
      .hero {
        aspect-ratio: 16 / 8.5;
        width: 100%;
        object-fit: cover;
        display: block;
      }
      .body {
        padding: 26px 28px 30px;
        background: linear-gradient(180deg, var(--surface), var(--surface-2));
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(2rem, 3vw, 3rem);
        line-height: 1;
        letter-spacing: -0.04em;
        font-family: "Bahnschrift SemiCondensed", "Aptos Display", sans-serif;
      }
      .subtitle {
        margin: 0 0 18px;
        color: var(--muted);
        line-height: 1.6;
      }
      .author {
        margin: 0 0 22px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 0.78rem;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 18px;
        margin-top: 20px;
      }
      .pane {
        border: 1px solid var(--stroke);
        border-radius: 22px;
        padding: 18px 18px 16px;
        background: color-mix(in srgb, var(--surface) 78%, transparent);
      }
      .pane h2 {
        margin: 0 0 10px;
        font-size: 1.08rem;
      }
      p {
        line-height: 1.7;
      }
      ul {
        margin: 0;
        padding-left: 20px;
        display: grid;
        gap: 10px;
        line-height: 1.6;
      }
      .note {
        margin-top: 18px;
        padding: 16px 18px;
        border-radius: 18px;
        background: color-mix(in srgb, var(--accent) 9%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--stroke));
      }
      @media (max-width: 760px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <article class="card">
        <img class="hero" src="${heroImageUrl}" alt="MeteorOps hero" />
        <div class="body">
          <h1>${title}</h1>
          <p class="subtitle">${subtitle}</p>
          <p class="author">${author}</p>
          <p>${intro}</p>
          <div class="grid">
            <section class="pane">
              <h2>${t("Sta aplikacija radi", "What the app does")}</h2>
              <ul>${bullets.map((item) => `<li>${item}</li>`).join("")}</ul>
            </section>
            <section class="pane">
              <h2>${t("Za koga je namijenjena", "Who it is for")}</h2>
              <p>${t(
                "Za solo posmatraca, meteor fotografa, all-sky stanicu ili mali tim koji treba kombinovati planiranje, pracenje uslova, dokumentovanje sesije i operativne odluke na jednoj lokaciji.",
                "For a solo observer, meteor photographer, all-sky station or a small team that needs to combine planning, condition tracking, session documentation and operational decisions in one place."
              )}</p>
              <p>${t(
                "Prakticna vrijednost je u tome sto MeteorOps spaja podatke koji se inace gledaju odvojeno: efemeride, forecast, lokalni horizont, opremu i evidenciju dogadaja.",
                "Its practical value comes from combining data that is usually checked separately: ephemerides, forecast, local horizon, gear setup and event logging."
              )}</p>
            </section>
          </div>
          <div class="note">${accuracy}</div>
        </div>
      </article>
    </div>
  </body>
</html>`);
  win.document.close();
}

function hydrateFromHash() {
  if (!window.location.hash.startsWith("#")) {
    return;
  }

  const params = new URLSearchParams(window.location.hash.slice(1));
  const date = params.get("date");
  const lat = params.get("lat");
  const lon = params.get("lon");
  const shower = params.get("shower");

  if (date) {
    state.date = date;
  }
  if (lat != null) {
    state.latInput = lat;
    state.siteId = "manual";
  }
  if (lon != null) {
    state.lonInput = lon;
    state.siteId = "manual";
  }
  if (shower) {
    state.selectedShowerId = shower;
  }
}

function ensureSelectedPlan() {
  if (!state.plans.length) {
    state.selectedShowerId = "";
    return null;
  }

  const selected = state.plans.find((plan) => plan.shower.id === state.selectedShowerId);
  if (selected) {
    return selected;
  }

  state.selectedShowerId = state.plans[0].shower.id;
  return state.plans[0];
}

function getSelectedPlan() {
  return ensureSelectedPlan();
}

function decisionScore(plan, weatherSummary) {
  const meteorScore = clamp(plan.bestRatePerHour / 1.4, 0, 65);
  const weatherScore = weatherSummary
    ? clamp(
        42 -
          weatherSummary.avgCloud * 0.18 -
          weatherSummary.avgLowCloud * 0.18 -
          weatherSummary.rainRisk * 0.16 -
          Math.max(0, 12 - weatherSummary.avgVisibilityKm) * 0.9,
        4,
        42
      )
    : 24;
  const moonScore = clamp(18 - plan.moonIllumination * 14, 4, 18);
  return round(clamp(meteorScore + weatherScore + moonScore, 0, 100), 0);
}

function decisionLabel(score) {
  if (score >= 78) {
    return t("Odlican izlazak", "Excellent go");
  }
  if (score >= 58) {
    return t("Vrijedi izaci", "Worth going out");
  }
  if (score >= 40) {
    return t("Granicno", "Marginal");
  }
  return t("Ne isplati se", "No-go");
}

function horizonLabel(site) {
  const map = {
    "urban-east": "Gradski horizont, vise LP-a",
    "open-mountain": "Otvoren planinski horizont",
    "lake-valley": "Siri juzni i istocni pogled",
    "flat-wide": "Sirok nizijski horizont",
    custom: "Rucni unos"
  };
  const base = map[site.horizon] || "Standardna lokacija";
  const source = site?.horizonSource === "terrain-profile" ? "terrain profil" : "rucna maska";
  return `${base} (${source})`;
}

function weatherBadge(summary) {
  if (!summary) {
    return { label: t("Bez prognoze", "No forecast"), tone: "muted" };
  }
  if (summary.avgCloud < 25 && summary.avgLowCloud < 20 && summary.rainRisk < 10) {
    return { label: t("Stabilno", "Stable"), tone: "good" };
  }
  if (summary.avgCloud < 50 && summary.avgLowCloud < 40 && summary.rainRisk < 20) {
    return { label: t("Upotrebljivo", "Usable"), tone: "fair" };
  }
  return { label: t("Rizicno", "Risky"), tone: "bad" };
}

function statusLabel(value) {
  const map = {
    idle: t("miruje", "idle"),
    loading: t("ucitava", "loading"),
    ready: t("spremno", "ready"),
    pending: t("na cekanju", "pending"),
    error: t("greska", "error"),
    live: t("uzivo", "live"),
    arming: t("naoruzavanje", "arming"),
    armed: t("aktivan", "armed"),
    triggered: t("okinut", "triggered"),
    recording: t("snima", "recording"),
    unsupported: t("nije podrzano", "unsupported"),
    listening: t("slusa", "listening"),
    offline: "offline",
    maintenance: t("odrzavanje", "maintenance")
  };

  return map[value] || value || "n/a";
}

function planTone(plan) {
  if (plan.bestRatePerHour >= 55) {
    return "good";
  }
  if (plan.bestRatePerHour >= 18) {
    return "fair";
  }
  return "muted";
}

function buildTimelineSvg(plan) {
  const width = 720;
  const height = 220;
  const chartBottom = 180;
  const chartHeight = 156;
  const maxRate = Math.max(10, ...plan.entries.map((entry) => entry.ratePerHour));
  const step = plan.entries.length > 1 ? width / (plan.entries.length - 1) : width;
  const startIndex = plan.entries.findIndex((entry) => entry.time >= plan.bestWindowStart);
  const reverseIndex = [...plan.entries]
    .reverse()
    .findIndex((entry) => entry.time <= plan.bestWindowEnd);
  const startX = Math.max(0, startIndex) * step - 10;
  const endX = width - Math.max(0, reverseIndex) * step + 10;

  const bars = plan.entries
    .map((entry, index) => {
      const x = index * step;
      const barHeight = (entry.ratePerHour / maxRate) * chartHeight;
      const y = chartBottom - barHeight;
      const opacity =
        entry.cloudCover == null ? 0.92 : 1 - clamp(entry.cloudCover / 160, 0.15, 0.6);
      return `<rect x="${round(x - 7, 1)}" y="${round(y, 1)}" width="14" height="${round(
        barHeight,
        1
      )}" rx="6" fill="rgba(124, 205, 255, ${round(opacity, 2)})"></rect>`;
    })
    .join("");

  const radiantPoints = plan.entries
    .map((entry, index) => {
      const x = index * step;
      const y = chartBottom - clamp(entry.radiantAltitudeDeg / 90, 0, 1) * chartHeight;
      return `${round(x, 1)},${round(y, 1)}`;
    })
    .join(" ");

  const labels = plan.entries
    .filter((_, index) => index % 3 === 0 || index === plan.entries.length - 1)
    .map((entry) => {
      const x = plan.entries.indexOf(entry) * step;
      return `<text x="${round(x, 1)}" y="208" text-anchor="middle">${formatClock(entry.time)}</text>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" class="timeline-chart" aria-label="Timeline meteorske aktivnosti">
      <rect x="${round(startX, 1)}" y="10" width="${round(Math.max(endX - startX, 36), 1)}" height="180" fill="rgba(253, 176, 72, 0.09)" stroke="rgba(253, 176, 72, 0.32)" rx="16"></rect>
      <line x1="0" y1="180" x2="${width}" y2="180" class="grid-line"></line>
      <line x1="0" y1="128" x2="${width}" y2="128" class="grid-line"></line>
      <line x1="0" y1="76" x2="${width}" y2="76" class="grid-line"></line>
      <line x1="0" y1="24" x2="${width}" y2="24" class="grid-line"></line>
      ${bars}
      <polyline points="${radiantPoints}" fill="none" stroke="#ffb561" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <text x="8" y="18">meteori/h</text>
      <text x="610" y="18">radiant alt</text>
      ${labels}
    </svg>
  `;
}

function renderPlanCard(plan, selected) {
  const peakDate = `${toMonthDay(plan.shower.peak)} | ZHR ${plan.shower.zhr}`;
  const tone = planTone(plan);
  return `
    <button class="shower-card ${selected ? "selected" : ""}" data-action="select-shower" data-id="${plan.shower.id}">
      <div class="card-topline">
        <span class="tone-pill ${tone}">${plan.bestRatePerHour}/h</span>
        <span class="card-code">${plan.shower.code}</span>
      </div>
      <h3>${plan.shower.nameBs || plan.shower.name}</h3>
      <p>${peakDate}</p>
      <p>Raspon ${plan.bestPessimisticRatePerHour}-${plan.bestOptimisticRatePerHour}/h | pouzdanost ${plan.confidenceScore}%</p>
      <dl class="mini-grid">
        <div><dt>Prozor</dt><dd>${formatClock(plan.bestWindowStart)}-${formatClock(plan.bestWindowEnd)}</dd></div>
        <div><dt>Radiant</dt><dd>${plan.bestRadiantAltitudeDeg} deg ${plan.bestDirection}</dd></div>
        <div><dt>Brzina</dt><dd>${plan.shower.velocityKmS} km/s</dd></div>
        <div><dt>Aktivnost</dt><dd>${Math.round(plan.activityFactor * 100)}%</dd></div>
      </dl>
    </button>
  `;
}

function renderWeatherStrip(weather, plan) {
  if (!weather) {
    return `<div class="weather-empty">Prognoza nije dostupna. Planner i dalje radi sa astronomskim slojem.</div>`;
  }

  const window = weather.hourly.filter(
    (hour) => hour.time >= plan.bestWindowStart && hour.time <= plan.bestWindowEnd
  );
  if (!window.length) {
    return `<div class="weather-empty">Nema forecast podataka za odabrani prozor posmatranja.</div>`;
  }

  return `
    <div class="weather-strip">
      ${window
        .map(
          (hour) => `
            <div class="weather-column">
              <span>${formatClock(hour.time)}</span>
              <div class="weather-bar">
                <span style="height:${clamp(hour.lowCloudCover, 3, 100)}%"></span>
              </div>
              <strong>${Math.round(hour.cloudCover)}%</strong>
              <small>${Math.round(hour.visibilityKm)} km</small>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function resolveForecastWindow(selectedPlan) {
  if (selectedPlan) {
    return {
      start: new Date(new Date(selectedPlan.bestWindowStart).getTime() - 60 * 60000),
      end: new Date(new Date(selectedPlan.bestWindowEnd).getTime() + 2 * 3600000)
    };
  }

  const anchor = selectedDate();
  return {
    start: new Date(anchor.getTime() - 2 * 3600000),
    end: new Date(anchor.getTime() + 10 * 3600000)
  };
}

function renderForecastBoard(weather, selectedPlan) {
  if (!weather) {
    return `<div class="weather-empty">${t('Prognoza jos nije dostupna. Klikni "Osvjezi prognozu" ili sacekaj automatski dohvat.', 'Forecast is not available yet. Click "Refresh forecast" or wait for the automatic fetch.')}</div>`;
  }

  const window = resolveForecastWindow(selectedPlan);
  const hours = weather.hourly
    .filter((entry) => entry.time >= window.start && entry.time <= window.end)
    .slice(0, 10);

  if (!hours.length) {
    return `<div class="weather-empty">${t("Nema satnih forecast podataka za odabrani vremenski prozor.", "No hourly forecast data is available for the selected time window.")}</div>`;
  }

  return `
    <div class="forecast-grid">
      ${hours
        .map(
          (hour) => `
            <article class="forecast-card">
              <strong>${formatClock(hour.time)}</strong>
              <p>${t("oblaci", "cloud")} ${Math.round(hour.cloudCover)}%</p>
              <p>${t("niski", "low cloud")} ${Math.round(hour.lowCloudCover)}%</p>
              <p>${t("vidljivost", "visibility")} ${round(hour.visibilityKm, 1)} km</p>
              <p>${t("vjetar", "wind")} ${round(hour.windKph, 1)} km/h</p>
              <p>${t("kisa", "rain")} ${Math.round(hour.precipitationProbability)}%</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderChecklist(plan, summary, advice) {
  const items = [
    `Stani 35-55 deg od radianta (${plan.bestDirection}) da tragovi budu duzi i manje foreshortened.`,
    `Glavni prozor je ${formatClock(plan.bestWindowStart)}-${formatClock(plan.bestWindowEnd)} uz procjenu ${plan.bestRatePerHour}/h.`,
    `Moon penalty je ${Math.round(plan.moonIllumination * 100)}%; radiant-Moon separacija u vrhu je ${plan.bestRadiantMoonSeparationDeg} deg.`,
    `Za tvoj setup: ${advice.recommendedExposureSec}s, ${advice.suggestedIso}, horizontalni FOV oko ${advice.horizontalFovDeg} deg.`
  ];

  if (summary) {
    items.push(
      `Meteoroloski prozor: oblaci ${Math.round(summary.avgCloud)}%, niski oblaci ${Math.round(
        summary.avgLowCloud
      )}%, vidljivost ${round(summary.avgVisibilityKm, 1)} km.`
    );
  }

  return items.map((item) => `<li>${item}</li>`).join("");
}

function renderFireballs(fireballs) {
  return fireballs
    .slice(0, 8)
    .map(
      (entry) => `
        <article class="fireball-item">
          <div>
            <strong>${entry.date}</strong>
            <p>${formatSigned(entry.lat, 1)} deg, ${formatSigned(entry.lon, 1)} deg</p>
          </div>
          <div>
            <strong>${round(entry.impactEnergyKt, 2)} kt</strong>
            <p>${round(entry.altitudeKm, 1)} km visina | ${round(entry.velocityKmS, 1)} km/s</p>
          </div>
        </article>
      `
    )
    .join("");
}

function renderShell() {
  app.innerHTML = `
    <div class="page-shell">
      <header class="hero">
        <div class="hero-copy">
          <div class="hero-topbar">
            <label class="theme-toggle">
              ${t("Jezik", "Language")}
              <select id="input-lang" name="lang">
                <option value="bs" ${state.lang === "bs" ? "selected" : ""}>Bosanski</option>
                <option value="en" ${state.lang === "en" ? "selected" : ""}>English</option>
              </select>
            </label>
            <label class="theme-toggle">
              ${t("Tema", "Theme")}
              <select id="input-theme" name="theme">
                <option value="dark">${t("Nocna", "Dark")}</option>
                <option value="light">${t("Dnevna", "Light")}</option>
              </select>
            </label>
            <button class="ghost-button hero-about-button" data-action="open-about">${t("O aplikaciji", "About app")}</button>
          </div>
          <span class="eyebrow">Night-Breaker Lab | MeteorOps v1.3</span>
          <p class="hero-author">${t("Autor: Alan Catovic", "Author: Alan Catovic")}</p>
          <div class="hero-banner">
            <img src="${heroImageUrl}" alt="${t("Naslovna slika aplikacije MeteorOps", "MeteorOps cover image")}" />
          </div>
          <div id="heroMetrics" class="hero-metrics"></div>
        </div>
        <div class="hero-panel">
          <div class="panel-header">
            <h2>${t("Operativni unos", "Operations input")}</h2>
            <p>${t("Fokusirano na Balkan, ali radi globalno sa rucnim koordinatama.", "Optimized for the Balkans, but works globally with manual coordinates.")}</p>
          </div>
          <div class="control-grid">
            <label>
              ${t("Datum noci", "Night date")}
              <input id="input-date" type="date" name="date" />
            </label>
            <label>
              ${t("Lokacija", "Location")}
              <select id="input-siteId" name="siteId"></select>
            </label>
            <label>
              ${t("Geografska sirina", "Latitude")}
              <input id="input-lat" type="number" name="lat" step="0.0001" />
            </label>
            <label>
              ${t("Geografska duzina", "Longitude")}
              <input id="input-lon" type="number" name="lon" step="0.0001" />
            </label>
            <label>
              ${t("Senzor", "Sensor")}
              <select id="input-sensorId" name="sensorId"></select>
            </label>
            <label>
              ${t("Fokalna duzina [mm]", "Focal length [mm]")}
              <input id="input-focalMm" type="number" min="4" max="200" step="1" name="focalMm" />
            </label>
            <label>
              ${t("Blend [f/]", "Aperture [f/]")}
              <input id="input-aperture" type="number" min="1.2" max="11" step="0.1" name="aperture" />
            </label>
            <label>
              ${t("Rezim", "Mode")}
              <select id="input-mode" name="mode">
                <option value="timelapse">Time-lapse</option>
                <option value="stills">${t("Stills / widefield", "Stills / widefield")}</option>
                <option value="visual">${t("Vizuelno", "Visual")}</option>
                <option value="video">${t("Video", "Video")}</option>
                <option value="allsky">All-sky</option>
              </select>
            </label>
          </div>
          <div class="control-actions">
            <button class="ghost-button" data-action="use-gps">${t("Koristi GPS", "Use GPS")}</button>
            <button class="ghost-button" data-action="save-site">${t("Sacuvaj lokaciju", "Save site")}</button>
            <button class="ghost-button" data-action="copy-summary">${t("Kopiraj sazetak", "Copy summary")}</button>
            <button class="ghost-button" data-action="use-look-direction">${t("Postavi optimalni pogled", "Set optimal look")}</button>
          </div>
          <div id="siteFootnote" class="site-footnote"></div>
        </div>
      </header>

      <main class="content-grid">
        <section class="panel span-5">
          <div class="section-heading">
            <div>
              <span class="section-kicker">${t("Rang lista", "Rank list")}</span>
              <h2>${t("Aktivni i relevantni rojevi", "Active and relevant showers")}</h2>
            </div>
            <p>${t("Sortirano po stvarnom nightly throughput-u, ne samo po katalog ZHR vrijednosti.", "Sorted by actual nightly throughput, not only by catalog ZHR.")}</p>
          </div>
          <div id="rankList" class="shower-list"></div>
        </section>

        <section class="panel span-7">
          <div id="detailContent"></div>
        </section>

        <section class="panel span-6">
          <div id="weatherContent"></div>
        </section>

        <section class="panel span-6">
          <div id="setupContent"></div>
        </section>

        <section class="panel span-12">
          <div class="section-heading">
            <div>
              <span class="section-kicker">${t("Teren", "Field")}</span>
              <h2>${t("Kontrolna lista i export", "Checklist and export")}</h2>
            </div>
            <p>${t("Brzi izlaz za teren ili dijeljenje session plana.", "Fast export for field use or sharing the session plan.")}</p>
          </div>
          <ul id="fieldChecklist" class="checklist"></ul>
          <label class="notes-box">
            ${t("Licne biljeske", "Personal notes")}
            <textarea id="input-notes" name="notes" rows="7" placeholder="${t("Npr. rezervna baterija, parking lokacija, cilj za time-lapse...", "Example: spare battery, parking spot, time-lapse target...")}"></textarea>
          </label>
          <div class="control-grid control-grid-single">
            <label>
              ${t("Nacin izvjestaja", "Report mode")}
              <select id="input-reportMode" name="reportMode">
                <option value="imo">${t("IMO vizuelni nacrt", "IMO visual draft")}</option>
                <option value="ops">${t("Operativni brief", "Operational brief")}</option>
                <option value="ams">${t("AMS fireball kontrolna lista", "AMS fireball checklist")}</option>
              </select>
            </label>
          </div>
          <div class="control-actions">
            <button class="ghost-button" data-action="download-ics">${t("Preuzmi ICS", "Download ICS")}</button>
            <button class="ghost-button" data-action="download-json">${t("Preuzmi JSON", "Download JSON")}</button>
            <button class="ghost-button" data-action="download-csv">${t("Preuzmi CSV", "Download CSV")}</button>
            <button class="ghost-button" data-action="download-report">${t("Preuzmi izvjestaj", "Download report")}</button>
            <button class="ghost-button" data-action="arm-peak-alert">${t("Alert vrha", "Peak alert")}</button>
            <button class="ghost-button" data-action="arm-clear-alert">${t("Alert vedrog prozora", "Clear-break alert")}</button>
          </div>
          <div id="reportPreview" class="weather-empty"></div>
        </section>

        <section class="panel span-6">
          <div id="summaryContent"></div>
          <div class="source-links">
            <a href="https://www.imo.net/" target="_blank" rel="noreferrer">IMO</a>
            <a href="https://www.amsmeteors.org/meteor-showers/" target="_blank" rel="noreferrer">AMS rojevi</a>
            <a href="https://api.open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>
            <a href="https://ssd-api.jpl.nasa.gov/doc/fireball.html" target="_blank" rel="noreferrer">NASA Fireball API</a>
          </div>
        </section>

        <section class="panel span-6">
          <div id="fireballContent"></div>
        </section>

        <section class="panel span-6">
          <div id="skyMapContent"></div>
        </section>

        <section class="panel span-6">
          <div class="section-heading">
            <div>
              <span class="section-kicker">${t("Sektori posmatranja", "Observer sectors")}</span>
              <h2>${t("Raspodjela posmatraca", "Observer allocation")}</h2>
            </div>
            <p>${t("Podjela neba za vise posmatraca ili kamera.", "Sky split for multiple observers or cameras.")}</p>
          </div>
          <div class="control-grid control-grid-single">
            <label>
              ${t("Broj posmatraca", "Observer count")}
              <input id="input-observerCount" type="number" name="observerCount" min="1" max="8" step="1" />
            </label>
          </div>
          <div id="observerSectors"></div>
        </section>

        <section class="panel span-6">
          <div id="cameraContent"></div>
        </section>

        <section class="panel span-6">
          <div id="opsConsoleContent"></div>
        </section>

        <section class="panel span-7">
          <div id="sessionLogContent"></div>
        </section>

        <section class="panel span-5">
          <div id="qcContent"></div>
        </section>

        <section class="panel span-5">
          <div id="multiStationContent"></div>
        </section>

        <section class="panel span-7">
          <div id="tonightContent"></div>
        </section>
      </main>
    </div>
  `;
}

function cacheElements() {
  elements.heroMetrics = app.querySelector("#heroMetrics");
  elements.langSelect = app.querySelector("#input-lang");
  elements.themeSelect = app.querySelector("#input-theme");
  elements.siteSelect = app.querySelector("#input-siteId");
  elements.dateInput = app.querySelector("#input-date");
  elements.latInput = app.querySelector("#input-lat");
  elements.lonInput = app.querySelector("#input-lon");
  elements.sensorSelect = app.querySelector("#input-sensorId");
  elements.focalInput = app.querySelector("#input-focalMm");
  elements.apertureInput = app.querySelector("#input-aperture");
  elements.modeSelect = app.querySelector("#input-mode");
  elements.notesInput = app.querySelector("#input-notes");
  elements.reportModeSelect = app.querySelector("#input-reportMode");
  elements.observerCountInput = app.querySelector("#input-observerCount");
  elements.siteFootnote = app.querySelector("#siteFootnote");
  elements.rankList = app.querySelector("#rankList");
  elements.detailContent = app.querySelector("#detailContent");
  elements.weatherContent = app.querySelector("#weatherContent");
  elements.setupContent = app.querySelector("#setupContent");
  elements.fieldChecklist = app.querySelector("#fieldChecklist");
  elements.reportPreview = app.querySelector("#reportPreview");
  elements.fireballContent = app.querySelector("#fireballContent");
  elements.summaryContent = app.querySelector("#summaryContent");
  elements.skyMapContent = app.querySelector("#skyMapContent");
  elements.cameraContent = app.querySelector("#cameraContent");
  elements.opsConsoleContent = app.querySelector("#opsConsoleContent");
  elements.observerSectors = app.querySelector("#observerSectors");
  elements.sessionLogContent = app.querySelector("#sessionLogContent");
  elements.multiStationContent = app.querySelector("#multiStationContent");
  elements.qcContent = app.querySelector("#qcContent");
  elements.tonightContent = app.querySelector("#tonightContent");
}

function syncSiteOptions() {
  elements.siteSelect.innerHTML = allSites()
    .map((location) => `<option value="${location.id}">${location.name}</option>`)
    .join("");
  elements.siteSelect.value = state.siteId;
}

function syncSensorOptions() {
  elements.sensorSelect.innerHTML = sensorPresets
    .map((sensor) => `<option value="${sensor.id}">${sensor.name}</option>`)
    .join("");
  elements.sensorSelect.value = state.setup.sensorId;
}

function syncControlValues() {
  elements.langSelect.value = state.lang;
  elements.themeSelect.value = state.theme;
  elements.dateInput.value = state.date;
  elements.siteSelect.value = state.siteId;
  elements.latInput.value = state.latInput;
  elements.lonInput.value = state.lonInput;
  elements.sensorSelect.value = state.setup.sensorId;
  elements.focalInput.value = String(state.setup.focalMm);
  elements.apertureInput.value = String(state.setup.aperture);
  elements.modeSelect.value = state.setup.mode;
  elements.notesInput.value = state.notes;
  elements.reportModeSelect.value = state.reportMode;
  elements.observerCountInput.value = String(state.observerCount);
}

function renderSiteFootnote() {
  const coords = parseCoordinates();
  const meta = currentSiteMeta();
  elements.siteFootnote.innerHTML = `
    <span>${meta.name}</span>
    <span>${coords.valid ? `${formatSigned(coords.lat, 4)} deg, ${formatSigned(coords.lon, 4)} deg` : "koordinate nisu validne"}</span>
    <span>${meta.altitudeM ? `${meta.altitudeM} m` : "bez altitude meta"}</span>
    <span>Bortle ${meta.bortle || 4}</span>
    <span>${horizonLabel(meta)}</span>
  `;
}

function getCalibrationMap() {
  const aggregates = {};

  for (const log of state.sessionLogs) {
    if (!log?.siteId || !log?.showerId || !Number.isFinite(log.predictedRate) || !Number.isFinite(log.actualCount)) {
      continue;
    }

    const duration = Number.isFinite(log.durationHours) && log.durationHours > 0 ? log.durationHours : 1;
    const observedRate = log.actualCount / duration;
    const ratio = clamp(observedRate / Math.max(log.predictedRate, 1), 0.3, 2.2);
    const key = `${log.siteId}::${log.showerId}`;

    if (!aggregates[key]) {
      aggregates[key] = { sum: 0, count: 0 };
    }
    aggregates[key].sum += ratio;
    aggregates[key].count += 1;
  }

  return Object.fromEntries(
    Object.entries(aggregates).map(([key, value]) => [key, round(value.sum / value.count, 2)])
  );
}

function confidenceLabel(score) {
  if (score >= 82) {
    return t("Visoka pouzdanost", "High confidence");
  }
  if (score >= 62) {
    return t("Srednja pouzdanost", "Medium confidence");
  }
  return t("Niska pouzdanost", "Low confidence");
}

function currentSessionEvents(plan = getSelectedPlan(), site = selectedSiteSnapshot()) {
  if (!plan || !site) {
    return [];
  }

  return state.observationEvents.filter(
    (event) =>
      event.sessionDate === state.date &&
      event.siteId === site.id &&
      event.showerId === plan.shower.id
  );
}

function sessionObservedRate(events, plan) {
  if (!plan || !events.length) {
    return 0;
  }
  const durationHours = Math.max(
    0.5,
    (new Date(plan.bestWindowEnd) - new Date(plan.bestWindowStart)) / 3600000
  );
  return round(events.length / durationHours, 1);
}

function bestPlanEntry(plan) {
  return plan?.entries.find((entry) => +new Date(entry.time) === +new Date(plan.bestTime)) || plan?.entries.at(-1) || null;
}

function angularDeltaDeg(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

function preferredLookDirection(plan, site) {
  const entry = bestPlanEntry(plan);
  if (!plan || !entry) {
    return null;
  }

  const candidates = [40, -40, 55, -55].map((offset) => {
    const azimuthDeg = normalizeDegrees(plan.bestRadiantAzimuthDeg + offset);
    const altitudeDeg = clamp(plan.bestRadiantAltitudeDeg + 10, 28, 72);
    const moonSeparation = angularDeltaDeg(azimuthDeg, entry.moonAzimuthDeg ?? 0);
    const horizonClearance = altitudeDeg - averageHorizonMask(site);
    return {
      azimuthDeg: round(azimuthDeg, 0),
      altitudeDeg: round(altitudeDeg, 0),
      moonSeparation,
      horizonClearance,
      score: moonSeparation * 0.8 + horizonClearance * 0.5
    };
  });

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  return {
    ...best,
    direction: cardinalFromAzimuth(best.azimuthDeg),
    note: `Look ${best.direction} oko ${best.altitudeDeg} deg, ~${round(
      angularDeltaDeg(best.azimuthDeg, plan.bestRadiantAzimuthDeg),
      0
    )} deg od radianta.`
  };
}

function scientificWatchSummary() {
  return {
    limitingMagnitude: Number(state.watchForm.limitingMagnitude) || 0,
    cloudFraction: Number(state.watchForm.cloudFraction) || 0,
    effectiveHours: Number(state.watchForm.effectiveHours) || 0,
    breakMinutes: Number(state.watchForm.breakMinutes) || 0,
    sqm: Number(state.watchForm.sqm) || 0,
    centerAzDeg: Number(state.watchForm.centerAzDeg) || 0,
    centerAltDeg: Number(state.watchForm.centerAltDeg) || 0,
    skyQualityNote: state.watchForm.skyQualityNote || ""
  };
}

function currentSessionFireballDrafts(plan = getSelectedPlan(), site = selectedSiteSnapshot()) {
  if (!plan || !site) {
    return [];
  }

  return state.fireballDrafts.filter(
    (draft) =>
      draft.sessionDate === state.date &&
      draft.siteId === site.id &&
      draft.showerId === plan.shower.id
  );
}

function shouldCreateFireballDraft(event) {
  return Number(event.magnitude) <= -3.5 || event.train === "persistent" || event.fragmentation === "strong";
}

function buildFireballDraft(event, source = "manual") {
  const plan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  if (!plan || !site) {
    return null;
  }

  const watch = scientificWatchSummary();
  return {
    id: uniqueId("draft"),
    sessionDate: state.date,
    createdAt: new Date().toISOString(),
    source,
    siteId: site.id,
    siteName: site.name,
    showerId: plan.shower.id,
    showerName: plan.shower.nameBs || plan.shower.name,
    timestampUtc: event.timestampUtc,
    magnitude: event.magnitude,
    color: event.color,
    train: event.train,
    fragmentation: event.fragmentation,
    azimuthDeg: event.azimuthDeg,
    altitudeDeg: event.altitudeDeg,
    limitingMagnitude: watch.limitingMagnitude,
    cloudFraction: watch.cloudFraction,
    sqm: watch.sqm,
    notes: event.notes || "",
    reportText: [
      "AMS Fireball nacrt",
      `UTC: ${event.timestampUtc}`,
      `Lokacija: ${site.name} (${formatSigned(site.lat, 3)} deg, ${formatSigned(site.lon, 3)} deg)`,
      `Kontekst roja: ${plan.shower.code} ${plan.shower.nameBs || plan.shower.name}`,
      `Sjaj: mag ${event.magnitude}`,
      `Smjer: az ${event.azimuthDeg} deg, alt ${event.altitudeDeg} deg`,
      `Izgled: ${event.color}, train ${event.train}, fragmentacija ${event.fragmentation}`,
      `Uslovi: LM ${watch.limitingMagnitude}, oblaci ${watch.cloudFraction}%, SQM ${watch.sqm}`,
      `Biljeske: ${event.notes || "n/a"}`
    ].join("\n")
  };
}

function appendFireballDraft(event, source = "manual") {
  if (!shouldCreateFireballDraft(event)) {
    return;
  }
  const draft = buildFireballDraft(event, source);
  if (!draft) {
    return;
  }
  state.fireballDrafts = [draft, ...state.fireballDrafts].slice(0, 18);
}

function nowcastSummary(plan = getSelectedPlan()) {
  if (!plan || !state.weather) {
    return null;
  }

  const now = new Date();
  const windowStart = new Date(Math.max(now.getTime(), new Date(plan.bestWindowStart).getTime() - 30 * 60000));
  const windowEnd = new Date(windowStart.getTime() + 4 * 3600000);
  const upcoming = state.weather.hourly.filter((entry) => entry.time >= windowStart && entry.time <= windowEnd);
  if (!upcoming.length) {
    return null;
  }

  const best = upcoming.reduce((winner, current) => {
    const score = (100 - current.cloudCover) * 0.45 + (100 - current.lowCloudCover) * 0.45 + current.visibilityKm * 1.2;
    if (!winner || score > winner.score) {
      return { entry: current, score };
    }
    return winner;
  }, null);

  const clearBreak = upcoming.find(
    (entry) => entry.cloudCover <= 28 && entry.lowCloudCover <= 18 && entry.precipitationProbability <= 20
  );
  const trend = upcoming[0].cloudCover - upcoming.at(-1).cloudCover;

  return {
    clearBreak,
    best: best?.entry || null,
    trendLabel: trend > 10 ? "oblaci se razilaze" : trend < -10 ? "oblaci se zatvaraju" : "trend je stabilan"
  };
}

function qcSnapshot() {
  const plan = getSelectedPlan();
  const triggerActive = state.trigger.enabled && state.trigger.status === "armed";
  return {
    plannerConfidence: plan?.confidenceScore ?? null,
    weatherAgeMin: state.weatherFetchedAt ? round((Date.now() - state.weatherFetchedAt) / 60000, 0) : null,
    camera: state.cameraStatus,
    trigger: triggerActive ? "armed" : state.trigger.status,
    voice: state.audioLogger.listening ? "slusa" : state.audioLogger.supported ? "spremno" : "nije podrzano",
    detectionCount: state.trigger.detectionCount,
    analysisFps: state.trigger.analysisFps
  };
}

function parseMagnitudeWord(text) {
  const map = {
    "minus pet": -5,
    "minus cetiri": -4,
    "minus četiri": -4,
    "minus tri": -3,
    "minus dva": -2,
    "minus jedan": -1,
    nula: 0,
    jedan: 1,
    dva: 2,
    tri: 3,
    cetiri: 4,
    četiri: 4
  };

  return Object.entries(map).find(([phrase]) => text.includes(phrase))?.[1] ?? null;
}

function parseSpeechMeteorCommand(transcript) {
  const text = transcript.toLowerCase();
  const numericMatch = text.match(/-?\d+(?:[.,]\d+)?/);
  const magnitude =
    numericMatch != null
      ? Number(numericMatch[0].replace(",", "."))
      : parseMagnitudeWord(text) ?? (text.includes("fireball") || text.includes("bolid") ? -4 : null);

  const colorMap = [
    ["green", "green"],
    ["zelen", "green"],
    ["blue", "blue"],
    ["plav", "blue"],
    ["yellow", "yellow"],
    ["zut", "yellow"],
    ["žut", "yellow"],
    ["orange", "orange"],
    ["narand", "orange"],
    ["red", "red"],
    ["crven", "red"],
    ["white", "white"],
    ["bijel", "white"]
  ];
  const color = colorMap.find(([token]) => text.includes(token))?.[1] || state.eventDraft.color;
  const train =
    text.includes("persistent") || text.includes("postojan") || text.includes("dug trag")
      ? "persistent"
      : text.includes("short") || text.includes("kratak")
        ? "short"
        : "none";
  const fragmentation =
    text.includes("fragment") || text.includes("raspad") || text.includes("explode")
      ? text.includes("jak") || text.includes("strong") ? "strong" : "minor"
      : "none";

  return {
    magnitude: magnitude ?? state.eventDraft.magnitude,
    color,
    train,
    fragmentation,
    notes: transcript
  };
}

function averageHorizonMask(site) {
  return averageResolvedHorizon(site, 16);
}

function buildSkyMapSvg(plan, site) {
  const size = 360;
  const center = size / 2;
  const maxRadius = 145;
  const horizonMask = resolveTerrainHorizonMask(site, 16);
  const sectorStep = 360 / Math.max(horizonMask.length, 1);
  const polarPoint = (azimuthDeg, altitudeDeg) => {
    const radius = ((90 - clamp(altitudeDeg, 0, 90)) / 90) * maxRadius;
    const angle = (azimuthDeg - 90) * (Math.PI / 180);
    return {
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius
    };
  };

  const radiant = polarPoint(plan.bestRadiantAzimuthDeg, plan.bestRadiantAltitudeDeg);
  const bestEntry = plan.entries.find((entry) => +new Date(entry.time) === +new Date(plan.bestTime)) || plan.entries.at(-1);
  const moon = bestEntry
    ? polarPoint(bestEntry.moonAzimuthDeg ?? 0, bestEntry.moonAltitudeDeg ?? 0)
    : polarPoint(0, 0);
  const lookDirection = preferredLookDirection(plan, site);
  const look = lookDirection
    ? polarPoint(lookDirection.azimuthDeg, lookDirection.altitudeDeg)
    : polarPoint(plan.bestRadiantAzimuthDeg, clamp(plan.bestRadiantAltitudeDeg + 10, 25, 70));

  const horizonPath = horizonMask
    .map((altitude, index) => {
      const point = polarPoint(index * sectorStep, altitude);
      return `${index === 0 ? "M" : "L"} ${round(point.x, 1)} ${round(point.y, 1)}`;
    })
    .join(" ");

  return `
    <svg viewBox="0 0 ${size} ${size}" class="sky-map" aria-label="Radiant sky map">
      <circle cx="${center}" cy="${center}" r="${maxRadius}" class="sky-ring"></circle>
      <circle cx="${center}" cy="${center}" r="${(60 / 90) * maxRadius}" class="sky-ring"></circle>
      <circle cx="${center}" cy="${center}" r="${(30 / 90) * maxRadius}" class="sky-ring"></circle>
      <path d="${horizonPath} Z" class="horizon-fill"></path>
      <circle cx="${radiant.x}" cy="${radiant.y}" r="8" class="radiant-dot"></circle>
      <circle cx="${moon.x}" cy="${moon.y}" r="8" class="moon-dot"></circle>
      <circle cx="${look.x}" cy="${look.y}" r="7" class="look-dot"></circle>
      <text x="${center}" y="22" text-anchor="middle">N</text>
      <text x="${size - 16}" y="${center + 4}" text-anchor="middle">E</text>
      <text x="${center}" y="${size - 10}" text-anchor="middle">S</text>
      <text x="16" y="${center + 4}" text-anchor="middle">W</text>
      <text x="${radiant.x + 12}" y="${radiant.y - 8}">Radiant</text>
      <text x="${moon.x + 12}" y="${moon.y - 8}">Mjesec</text>
      <text x="${look.x + 12}" y="${look.y - 8}">Pogled</text>
    </svg>
  `;
}

function buildObserverSectors(plan, observerCount) {
  const count = clamp(observerCount, 1, 8);
  const sectors = [];
  const startAzimuth = (plan.bestRadiantAzimuthDeg + 35) % 360;
  const span = 110 / count;

  for (let index = 0; index < count; index += 1) {
    const sectorStart = (startAzimuth + index * span) % 360;
    const sectorCenter = (sectorStart + span / 2) % 360;
    const sectorEnd = (sectorStart + span) % 360;
    sectors.push({
      index: index + 1,
      startDeg: round(sectorStart, 0),
      centerDeg: round(sectorCenter, 0),
      endDeg: round(sectorEnd, 0),
      targetAltDeg: round(clamp(plan.bestRadiantAltitudeDeg + 18, 20, 70), 0)
    });
  }

  return sectors;
}

function buildReportText(mode, plan, site, weatherSummary) {
  if (!plan || !site) {
    return "Planner jos nema kompletan report.";
  }

  const events = currentSessionEvents(plan, site);
  const watch = scientificWatchSummary();
  const drafts = currentSessionFireballDrafts(plan, site);
  const eventSummary = events.length
    ? `Uoceni eventi: ${events.length} | UTC markeri: ${events
        .slice(-5)
        .map((event) => event.timestampUtc.slice(11, 19))
        .join(", ")}`
    : "Uoceni eventi: 0";

  if (mode === "ams") {
    return [
      "AMS Fireball kontrolna lista",
      `Lokacija: ${site.name} (${formatSigned(site.lat, 3)} deg, ${formatSigned(site.lon, 3)} deg)`,
      `Kontekst roja: ${plan.shower.nameBs || plan.shower.name}`,
      `Raspon throughputa: ${plan.bestPessimisticRatePerHour}-${plan.bestRatePerHour}-${plan.bestOptimisticRatePerHour} /h`,
      `Watch forma: LM ${watch.limitingMagnitude}, oblaci ${watch.cloudFraction}%, SQM ${watch.sqm}`,
      "Provjeri UTC sinhronizaciju sata, cistocu optike, slobodan prostor i rezervu baterije.",
      "Ako se javi bolid, zabiljezi smjer, fragmentaciju, perzistentni train, kasnjenje zvuka i tacan UTC.",
      `Auto nacrti: ${drafts.length}`,
      eventSummary
    ].join("\n");
  }

  if (mode === "ops") {
    return [
      "Operativni brief",
      planSummary(plan),
      `Operativni score: ${plan.operationalScore} / Naucni score: ${plan.scientificScore}`,
      `Raspon: ${plan.bestPessimisticRatePerHour}-${plan.bestRatePerHour}-${plan.bestOptimisticRatePerHour} /h | ${confidenceLabel(plan.confidenceScore)} (${plan.confidenceScore}%)`,
      weatherSummary
        ? `Meteoroloski prozor: oblaci ${Math.round(weatherSummary.avgCloud)}%, niski oblaci ${Math.round(weatherSummary.avgLowCloud)}%, vidljivost ${round(weatherSummary.avgVisibilityKm, 1)} km`
        : "Meteoroloski prozor: nema live prognoze",
      `Cist horizont u vrhu: ${plan.bestHorizonClearanceDeg} deg`,
      `Watch forma: LM ${watch.limitingMagnitude}, oblaci ${watch.cloudFraction}%, efikasno ${watch.effectiveHours} h`,
      `Auto nacrti: ${drafts.length}`,
      eventSummary
    ].join("\n");
  }

  return [
    "IMO vizuelni nacrt",
    `Roj: ${plan.shower.code} ${plan.shower.nameBs || plan.shower.name}`,
    `Lokacija: ${site.name} (${formatSigned(site.lat, 3)} deg, ${formatSigned(site.lon, 3)} deg)`,
    `Glavni prozor: ${formatClock(plan.bestWindowStart)}-${formatClock(plan.bestWindowEnd)}`,
    `Ocekivani vrh: ${plan.bestRatePerHour}/h`,
    `Raspon: ${plan.bestPessimisticRatePerHour}-${plan.bestRatePerHour}-${plan.bestOptimisticRatePerHour} /h`,
    `Watch forma: LM ${watch.limitingMagnitude}, oblaci ${watch.cloudFraction}%, efikasno ${watch.effectiveHours} h`,
    eventSummary,
    "Zabiljezi efektivno vrijeme posmatranja, limiting magnitude, udio oblaka i prebrojane meteore po klasama sjaja."
  ].join("\n");
}

function buildReportCsv() {
  const header = [
    "recordType",
    "timestamp",
    "siteId",
    "siteName",
    "showerId",
    "showerName",
    "predictedOrExpectedRate",
    "actualCount",
    "durationHours",
    "mode",
    "limitingMagnitude",
    "cloudFraction",
    "breakMinutes",
    "sqm",
    "azimuthDeg",
    "altitudeDeg",
    "magnitude",
    "color",
    "train",
    "fragmentation",
    "notes"
  ];
  const sessionRows = state.sessionLogs.map((log) => [
    "session",
    log.timestamp,
    log.siteId,
    `"${log.siteName || ""}"`,
    log.showerId,
    `"${log.showerName || ""}"`,
    log.predictedRate,
    log.actualCount,
    log.durationHours,
    log.mode,
    log.limitingMagnitude ?? "",
    log.cloudFraction ?? "",
    log.breakMinutes ?? "",
    log.sqm ?? "",
    log.centerAzDeg ?? "",
    log.centerAltDeg ?? "",
    "",
    "",
    "",
    "",
    `"${(log.notes || "").replace(/"/g, '""')}"`
  ]);
  const eventRows = state.observationEvents.map((event) => [
    "event",
    event.timestampUtc,
    event.siteId,
    `"${event.siteName || ""}"`,
    event.showerId,
    `"${event.showerName || ""}"`,
    event.expectedRatePerHour,
    "",
    "",
    event.mode,
    "",
    "",
    "",
    "",
    event.azimuthDeg ?? "",
    event.altitudeDeg ?? "",
    event.magnitude,
    event.color,
    event.train,
    event.fragmentation,
    `"${(event.notes || "").replace(/"/g, '""')}"`
  ]);
  return [header, ...sessionRows, ...eventRows].map((row) => row.join(",")).join("\n");
}

function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function sanitizeCameraUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }

  try {
    const parsed = new URL(rawUrl, window.location.href);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return "";
  }

  return "";
}

async function refreshCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    state.cameraDevices = [];
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.cameraDevices = devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Camera ${index + 1}`
      }));

    if (!state.skyCamera.deviceId && state.cameraDevices.length) {
      state.skyCamera.deviceId = state.cameraDevices[0].id;
      persistState();
    }
  } catch {
    state.cameraDevices = [];
  }
}

function stopCameraStream({ silent = false } = {}) {
  stopMeteorTrigger({ silent: true });
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) {
      track.stop();
    }
    cameraStream = null;
  }

  state.cameraStatus = "idle";
  if (!silent) {
    renderSkyCameraContent();
    renderOpsConsoleContent();
    renderQcContent();
  }
}

function attachCameraStream() {
  const video = elements.cameraContent?.querySelector('[data-role="camera-preview"]');
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }
  if (!cameraStream) {
    video.srcObject = null;
    return;
  }

  if (video.srcObject !== cameraStream) {
    video.srcObject = cameraStream;
  }

  video
    .play()
    .catch(() => {
      // Ignore autoplay race conditions; user can still interact with the preview.
    });
}

async function startCameraStream() {
  if (!cameraSupported()) {
    state.cameraStatus = "error";
    state.cameraError = "Browser ne podrzava lokalni camera capture.";
    renderSkyCameraContent();
    return;
  }

  stopCameraStream({ silent: true });
  state.cameraStatus = "loading";
  state.cameraError = "";
  renderSkyCameraContent();

  try {
    const constraints = {
      video: state.skyCamera.deviceId
        ? {
            deviceId: { ideal: state.skyCamera.deviceId },
            facingMode: "environment"
          }
        : { facingMode: "environment" },
      audio: false
    };
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    state.cameraStatus = "live";
    state.cameraError = "";
    await refreshCameraDevices();
  } catch (error) {
    state.cameraStatus = "error";
    state.cameraError =
      error?.name === "NotAllowedError"
        ? "Pristup kameri nije odobren."
        : "Ne mogu pokrenuti live kameru.";
  }

  renderSkyCameraContent();
  renderOpsConsoleContent();
  renderQcContent();
}

function captureCameraFrame() {
  const video = elements.cameraContent?.querySelector('[data-role="camera-preview"]');
  if (!(video instanceof HTMLVideoElement) || !cameraStream || video.videoWidth <= 0) {
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadFile(`meteorops-skycam-${stamp}.png`, blob, "image/png");
  }, "image/png");
}

function stopMeteorTrigger({ silent = false } = {}) {
  if (triggerAnimationFrame) {
    cancelAnimationFrame(triggerAnimationFrame);
    triggerAnimationFrame = null;
  }
  triggerLastFrame = null;
  triggerLastProcessAt = 0;
  state.trigger.enabled = false;
  state.trigger.status = "idle";
  if (!silent) {
    renderOpsConsoleContent();
    renderQcContent();
  }
}

function triggerVideoElement() {
  return elements.cameraContent?.querySelector('[data-role="camera-preview"]') || null;
}

function meteorTriggerStep() {
  const video = triggerVideoElement();
  if (!(video instanceof HTMLVideoElement) || !cameraStream || !state.trigger.enabled) {
    stopMeteorTrigger({ silent: true });
    renderOpsConsoleContent();
    renderQcContent();
    return;
  }

  const now = performance.now();
  const minIntervalMs = 180;
  if (now - triggerLastProcessAt < minIntervalMs) {
    triggerAnimationFrame = requestAnimationFrame(meteorTriggerStep);
    return;
  }
  triggerLastProcessAt = now;

  const width = 160;
  const height = 90;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    triggerAnimationFrame = requestAnimationFrame(meteorTriggerStep);
    return;
  }

  ctx.drawImage(video, 0, 0, width, height);
  const current = ctx.getImageData(0, 0, width, height).data;

  if (triggerLastFrame) {
    let activePixels = 0;
    let diffEnergy = 0;
    const threshold = Math.max(18, 64 - state.trigger.sensitivity * 180);

    for (let index = 0; index < current.length; index += 16) {
      const currentLum = current[index] * 0.3 + current[index + 1] * 0.59 + current[index + 2] * 0.11;
      const previousLum =
        triggerLastFrame[index] * 0.3 + triggerLastFrame[index + 1] * 0.59 + triggerLastFrame[index + 2] * 0.11;
      const delta = Math.abs(currentLum - previousLum);
      if (delta > threshold) {
        activePixels += 1;
        diffEnergy += delta;
      }
    }

    const score = activePixels > 0 ? diffEnergy / Math.max(activePixels, 1) : 0;
    state.trigger.lastScore = round(score, 1);
    state.trigger.analysisFps = round(1000 / minIntervalMs, 1);
    state.trigger.status = "armed";

    const cooldownOk = Date.now() - triggerLastDetectionAt >= state.trigger.cooldownSec * 1000;
    if (cooldownOk && activePixels >= state.trigger.minPixels) {
      triggerLastDetectionAt = Date.now();
      state.trigger.detectionCount += 1;
      state.trigger.lastDetectionIso = new Date().toISOString();
      state.trigger.lastFramePreview = canvas.toDataURL("image/jpeg", 0.78);
      state.trigger.status = "triggered";

      if (state.trigger.autoLog) {
        const autoEvent = {
          timestampUtc: new Date().toISOString(),
          magnitude: Number(state.eventDraft.magnitude),
          color: state.eventDraft.color,
          train: score > 80 ? "persistent" : state.eventDraft.train,
          fragmentation: score > 95 ? "minor" : state.eventDraft.fragmentation,
          azimuthDeg: Number(state.watchForm.centerAzDeg) || Number(state.eventDraft.azimuthDeg),
          altitudeDeg: Number(state.watchForm.centerAltDeg) || Number(state.eventDraft.altitudeDeg),
          notes: `auto trigger | pixels ${activePixels} | score ${round(score, 1)}`
        };
        recordObservationEvent(autoEvent.timestampUtc, autoEvent);
      }

      renderOpsConsoleContent();
      renderQcContent();
    }
  }

  triggerLastFrame = new Uint8ClampedArray(current);
  triggerAnimationFrame = requestAnimationFrame(meteorTriggerStep);
}

function startMeteorTrigger() {
  if (!cameraStream || state.skyCamera.mode !== "device") {
    state.trigger.error = "Trigger radi samo nad lokalnim feedom uzivo.";
    state.trigger.status = "error";
    renderOpsConsoleContent();
    renderQcContent();
    return;
  }

  stopMeteorTrigger({ silent: true });
  state.trigger.error = "";
  state.trigger.enabled = true;
  state.trigger.status = "arming";
  triggerLastFrame = null;
  triggerAnimationFrame = requestAnimationFrame(meteorTriggerStep);
  renderOpsConsoleContent();
  renderQcContent();
}

function stopVoiceLogger() {
  if (voiceRecognition) {
    voiceRecognition.onresult = null;
    voiceRecognition.onend = null;
    voiceRecognition.onerror = null;
    voiceRecognition.stop();
    voiceRecognition = null;
  }
  state.audioLogger.listening = false;
  renderOpsConsoleContent();
  renderQcContent();
}

function startVoiceLogger() {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    state.audioLogger.error = "SpeechRecognition nije dostupan u ovom browseru.";
    renderOpsConsoleContent();
    return;
  }

  stopVoiceLogger();
  const recognition = new SpeechRecognitionCtor();
  voiceRecognition = recognition;
  recognition.lang = state.audioLogger.language;
  recognition.continuous = false;
  recognition.interimResults = true;
  state.audioLogger.listening = true;
  state.audioLogger.error = "";
  renderOpsConsoleContent();
  renderQcContent();

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();
    state.audioLogger.transcript = transcript;

    if (event.results[event.results.length - 1]?.isFinal) {
      const parsed = parseSpeechMeteorCommand(transcript);
      state.eventDraft.magnitude = parsed.magnitude;
      state.eventDraft.color = parsed.color;
      state.eventDraft.train = parsed.train;
      state.eventDraft.fragmentation = parsed.fragmentation;
      state.eventDraft.notes = parsed.notes;
      persistState();

      if (state.audioLogger.autoCommit) {
        recordObservationEvent(new Date().toISOString(), {
          timestampUtc: new Date().toISOString(),
          magnitude: parsed.magnitude,
          color: parsed.color,
          train: parsed.train,
          fragmentation: parsed.fragmentation,
          azimuthDeg: Number(state.watchForm.centerAzDeg) || Number(state.eventDraft.azimuthDeg),
          altitudeDeg: Number(state.watchForm.centerAltDeg) || Number(state.eventDraft.altitudeDeg),
          notes: `voice log | ${parsed.notes}`
        });
      }
    }

    renderOpsConsoleContent();
  };

  recognition.onerror = (event) => {
    state.audioLogger.error = `Greska glasovnog loggera: ${event.error}`;
    stopVoiceLogger();
  };

  recognition.onend = () => {
    state.audioLogger.listening = false;
    voiceRecognition = null;
    renderOpsConsoleContent();
    renderQcContent();
  };

  recognition.start();
}

function renderHeroMetrics() {
  const selectedPlan = getSelectedPlan();
  const weatherSummary =
    selectedPlan && state.weather
      ? summarizeWeather(state.weather, selectedPlan.bestWindowStart, selectedPlan.bestWindowEnd)
      : null;
  const weatherState = weatherBadge(weatherSummary);
  const score = selectedPlan ? decisionScore(selectedPlan, weatherSummary) : 0;
  const moonText =
    selectedPlan
      ? moonPhaseLabel(selectedPlan.moonIllumination, selectedPlan.moonPhaseText.waxing)
      : "N/A";

  elements.heroMetrics.innerHTML = `
    <div class="metric-card">
      <span>${t("Nocni score", "Night score")}</span>
      <strong>${selectedPlan ? `${score}/100` : "--"}</strong>
      <small>${
        selectedPlan
          ? `${decisionLabel(score)} | naucni ${selectedPlan.scientificScore}`
          : state.planStatus === "loading"
            ? t("Planner radi...", "Planner is running...")
            : t("Nema plana", "No plan")
      }</small>
    </div>
    <div class="metric-card">
      <span>${t("Top roj", "Top shower")}</span>
      <strong>${selectedPlan ? selectedPlan.shower.nameBs || selectedPlan.shower.name : "N/A"}</strong>
      <small>${selectedPlan ? `${selectedPlan.bestPessimisticRatePerHour}-${selectedPlan.bestRatePerHour}-${selectedPlan.bestOptimisticRatePerHour}/h` : t("Nema aktivnih rojeva", "No active showers")}</small>
    </div>
    <div class="metric-card">
      <span>${t("Mjesec", "Moon")}</span>
      <strong>${selectedPlan ? percent(selectedPlan.moonIllumination * 100) : "N/A"}</strong>
      <small>${moonText}</small>
    </div>
    <div class="metric-card">
      <span>${t("Vremenski prozor", "Weather window")}</span>
      <strong>${weatherState.label}</strong>
      <small>${state.weatherStatus === "loading" ? t("Ucitavanje...", "Loading...") : "Open-Meteo"}</small>
    </div>
  `;
}

function renderRankList() {
  if (state.planStatus === "loading" && state.plans.length === 0) {
    elements.rankList.innerHTML = `<div class="weather-empty">Planner racuna rang listu...</div>`;
    return;
  }

  if (state.planError) {
    elements.rankList.innerHTML = `<div class="weather-empty">${state.planError}</div>`;
    return;
  }

  const selectedPlan = getSelectedPlan();
  elements.rankList.innerHTML = state.plans.length
    ? state.plans
        .slice(0, 8)
        .map((plan) => renderPlanCard(plan, selectedPlan?.shower.id === plan.shower.id))
        .join("")
    : `<div class="weather-empty">Nema aktivnog roja za ovaj datum.</div>`;
}

function renderDetailContent() {
  const selectedPlan = getSelectedPlan();
  if (!selectedPlan) {
    elements.detailContent.innerHTML = `
      <div class="section-heading">
        <div>
          <span class="section-kicker">Detalj roja</span>
          <h2>Nema aktivnog roja</h2>
        </div>
        <p>${state.planStatus === "loading" ? "Planner racuna..." : "Promijeni datum ili lokaciju."}</p>
      </div>
    `;
    return;
  }

  const weatherSummary =
    state.weather &&
    summarizeWeather(state.weather, selectedPlan.bestWindowStart, selectedPlan.bestWindowEnd);
  const score = decisionScore(selectedPlan, weatherSummary);
  const weatherState = weatherBadge(weatherSummary);

  elements.detailContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Detalj roja", "Shower detail")}</span>
        <h2>${selectedPlan.shower.nameBs || selectedPlan.shower.name}</h2>
      </div>
      <div class="heading-badges">
        <span class="tone-pill ${planTone(selectedPlan)}">${selectedPlan.visibilityClass}</span>
        <span class="tone-pill warning">Peak ${toMonthDay(selectedPlan.shower.peak)}</span>
      </div>
    </div>
    <div class="detail-grid">
      <article class="detail-card">
        <span>${t("Najbolji prozor", "Best window")}</span>
        <strong>${formatClock(selectedPlan.bestWindowStart)}-${formatClock(selectedPlan.bestWindowEnd)}</strong>
        <small>${selectedPlan.bestRatePerHour} meteora/h u vrhu</small>
      </article>
      <article class="detail-card">
        <span>${t("Radiant", "Radiant")}</span>
        <strong>${selectedPlan.bestRadiantAltitudeDeg} deg ${selectedPlan.bestDirection}</strong>
        <small>RA ${selectedPlan.bestRadiantRaHours} h | Dec ${selectedPlan.bestRadiantDecDeg} deg</small>
      </article>
      <article class="detail-card">
        <span>${t("Orbitalni kontekst", "Orbital context")}</span>
        <strong>${selectedPlan.shower.parentBody}</strong>
        <small>r = ${selectedPlan.shower.populationIndex} | fireball ${Math.round(
          selectedPlan.shower.fireballRisk * 100
        )}%</small>
      </article>
      <article class="detail-card">
        <span>${t("Raspon throughputa", "Throughput band")}</span>
        <strong>${selectedPlan.bestPessimisticRatePerHour}-${selectedPlan.bestOptimisticRatePerHour}/h</strong>
        <small>Ocekivano ${selectedPlan.bestRatePerHour}/h | ${confidenceLabel(selectedPlan.confidenceScore)}</small>
      </article>
      <article class="detail-card">
        <span>${t("Zakljucak noci", "Night summary")}</span>
        <strong>${decisionLabel(score)}</strong>
        <small>${weatherState.label} | Mjesec ${percent(selectedPlan.moonIllumination * 100)}</small>
      </article>
    </div>
    <div class="timeline-wrap">
      ${buildTimelineSvg(selectedPlan)}
    </div>
    <p class="inline-note">${selectedPlan.shower.notes}</p>
  `;
}

function renderWeatherContent() {
  const selectedPlan = getSelectedPlan();
  const weatherSummary =
    selectedPlan && state.weather
      ? summarizeWeather(state.weather, selectedPlan.bestWindowStart, selectedPlan.bestWindowEnd)
      : null;
  const nowcast = nowcastSummary(selectedPlan);
  const fetchedLabel = state.weatherFetchedAt
    ? new Date(state.weatherFetchedAt).toLocaleTimeString("bs-BA", {
        hour: "2-digit",
        minute: "2-digit"
      })
    : "n/a";

  elements.weatherContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Vremenska prognoza", "Weather forecast")}</span>
        <h2>${t("Satna prognoza i nowcast", "Hourly forecast and nowcast")}</h2>
      </div>
      <p>${
        state.weatherStatus === "loading"
          ? t("Dohvatam Open-Meteo prognozu.", "Fetching the Open-Meteo forecast.")
          : state.weatherError || `Ažurirano ${fetchedLabel} | oblaci, niski oblaci, vidljivost i vjetar po satu.`
      }</p>
    </div>
    <div class="control-actions">
      <button class="ghost-button" data-action="refresh-weather">${t("Osvjezi prognozu", "Refresh forecast")}</button>
    </div>
    ${
      weatherSummary
        ? `
          <div class="detail-grid compact">
            <article class="detail-card">
              <span>${t("Ukupni oblaci", "Total cloud")}</span>
              <strong>${Math.round(weatherSummary.avgCloud)}%</strong>
              <small>${t("Niski oblaci", "Low cloud")} ${Math.round(weatherSummary.avgLowCloud)}%</small>
            </article>
            <article class="detail-card">
              <span>${t("Vidljivost", "Visibility")}</span>
              <strong>${round(weatherSummary.avgVisibilityKm, 1)} km</strong>
              <small>${t("Rizik kise", "Rain risk")} ${Math.round(weatherSummary.rainRisk)}%</small>
            </article>
            <article class="detail-card">
              <span>${t("Vjetar", "Wind")}</span>
              <strong>${round(weatherSummary.avgWindKph, 1)} km/h</strong>
              <small>${t("Temperatura", "Temperature")} ${round(weatherSummary.avgTemperatureC, 1)} C</small>
            </article>
            <article class="detail-card">
              <span>Cloud-break</span>
              <strong>${nowcast?.clearBreak ? formatClock(nowcast.clearBreak.time) : t("nema vedrog slota", "no clear slot")}</strong>
              <small>${nowcast ? nowcast.trendLabel : t("heuristika ceka forecast", "forecast heuristic is waiting")}</small>
            </article>
          </div>
        `
        : ""
    }
    <div class="section-heading compact-heading">
      <div>
        <span class="section-kicker">${t("Prognoza veceras", "Tonight forecast")}</span>
        <h2>${selectedPlan ? t("Forecast za najbolji prozor posmatranja", "Forecast for the best observing window") : t("Forecast za odabranu noc", "Forecast for the selected night")}</h2>
      </div>
      <p>${selectedPlan ? `${formatClock(selectedPlan.bestWindowStart)}-${formatClock(selectedPlan.bestWindowEnd)}` : t("bez aktivnog roja", "no active shower")}</p>
    </div>
    ${renderForecastBoard(state.weather, selectedPlan)}
    ${selectedPlan ? renderWeatherStrip(state.weather, selectedPlan) : `<div class="weather-empty">${t("Odaberi roj za detaljni weather strip.", "Pick a shower to show the detailed weather strip.")}</div>`}
  `;
}

function renderSetupContent() {
  const selectedPlan = getSelectedPlan();
  const advice =
    selectedPlan &&
    buildGearAdvice(selectedPlan, {
      mode: state.setup.mode,
      sensor: selectedSensor(),
      focalMm: Number(state.setup.focalMm),
      aperture: Number(state.setup.aperture)
    });

  elements.setupContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Preporuka setupa", "Setup guidance")}</span>
        <h2>${t("Foto i vizuelna taktika", "Photo and visual strategy")}</h2>
      </div>
      <p>${t("Brzina roja, sirina kadra i Moon penalty se ovdje spajaju u prakticne preporuke.", "Shower speed, framing width and Moon penalty are combined here into practical recommendations.")}</p>
    </div>
    ${
      advice
        ? `
          <div class="detail-grid compact">
            <article class="detail-card">
              <span>Preporucen kadar</span>
              <strong>${advice.focalBand}</strong>
              <small>Tvoj FOV oko ${advice.horizontalFovDeg} deg</small>
            </article>
            <article class="detail-card">
              <span>Ekspozicija</span>
              <strong>${advice.recommendedExposureSec}s</strong>
              <small>Star-trail limit ${advice.trailLimitSec}s</small>
            </article>
            <article class="detail-card">
              <span>ISO</span>
              <strong>${advice.suggestedIso}</strong>
              <small>f/${state.setup.aperture}</small>
            </article>
          </div>
          <ul class="checklist">
            <li>${advice.technique}</li>
            <li>${advice.fireballBias}</li>
          </ul>
        `
        : `
          <div class="detail-grid compact">
            <article class="detail-card">
              <span>${t("Rezim", "Mode")}</span>
              <strong>${state.setup.mode}</strong>
              <small>${t("Aktivni korisnicki mod snimanja ili posmatranja.", "Active user capture or observing mode.")}</small>
            </article>
            <article class="detail-card">
              <span>${t("Senzor", "Sensor")}</span>
              <strong>${selectedSensor().name}</strong>
              <small>${t("Trenutno odabrani senzor za procjenu kadra.", "Current sensor used for field-of-view estimation.")}</small>
            </article>
            <article class="detail-card">
              <span>${t("Optika", "Optics")}</span>
              <strong>${state.setup.focalMm} mm f/${state.setup.aperture}</strong>
              <small>${t("Planner ceka aktivan roj da izracuna preciznu preporuku.", "The planner is waiting for an active shower to compute a precise recommendation.")}</small>
            </article>
          </div>
          <div class="weather-empty">${t("Planner jos nema aktivan roj za setup preporuku.", "The planner does not yet have an active shower for setup guidance.")}</div>
        `
    }
  `;
}

function renderFieldChecklist() {
  const selectedPlan = getSelectedPlan();
  const advice =
    selectedPlan &&
    buildGearAdvice(selectedPlan, {
      mode: state.setup.mode,
      sensor: selectedSensor(),
      focalMm: Number(state.setup.focalMm),
      aperture: Number(state.setup.aperture)
    });
  const weatherSummary =
    selectedPlan && state.weather
      ? summarizeWeather(state.weather, selectedPlan.bestWindowStart, selectedPlan.bestWindowEnd)
      : null;

  elements.fieldChecklist.innerHTML =
    selectedPlan && advice
      ? renderChecklist(selectedPlan, weatherSummary, advice)
      : "<li>Odaberi roj.</li>";
}

function renderReportPreview() {
  const selectedPlan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  const weatherSummary =
    selectedPlan && state.weather
      ? summarizeWeather(state.weather, selectedPlan.bestWindowStart, selectedPlan.bestWindowEnd)
      : null;
  elements.reportPreview.textContent = [
    buildReportText(state.reportMode, selectedPlan, site, weatherSummary),
    state.reminderStatus && state.reminderStatus !== "idle" ? `\n\nPodsjetnik: ${state.reminderStatus}` : ""
  ].join("");
}

function renderFireballContent() {
  elements.fireballContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Pracenje bolida", "Fireball watch")}</span>
        <h2>${t("Nedavni fireball dogadaji", "Recent fireball events")}</h2>
      </div>
      <p>${
        state.fireballStatus === "loading"
          ? "Dohvatam NASA fireball feed."
          : state.fireballError || "Live feed sa deterministic fallback uzorkom."
      }</p>
    </div>
    <div class="fireball-list">
      ${state.fireballs.length ? renderFireballs(state.fireballs) : `<div class="weather-empty">Nema fireball podataka.</div>`}
    </div>
  `;
}

function renderSummaryContent() {
  const selectedPlan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  const watch = scientificWatchSummary();
  if (!selectedPlan || !site) {
    elements.summaryContent.innerHTML = `
      <div class="section-heading">
        <div>
          <span class="section-kicker">${t("Sazetak sesije", "Session summary")}</span>
          <h2>${t("Operativni sazetak noci", "Night operations summary")}</h2>
        </div>
        <p>Brzo citanje prije izlaska na teren.</p>
      </div>
      <div class="weather-empty">Planner jos nema kompletan sazetak.</div>
    `;
    return;
  }

  elements.summaryContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Sazetak sesije", "Session summary")}</span>
        <h2>${t("Operativni sazetak noci", "Night operations summary")}</h2>
      </div>
      <p>Brzo citanje prije izlaska na teren.</p>
    </div>
    <article class="summary-panel">
      <p>${planSummary(selectedPlan)}</p>
      <p>
        Lokacija <strong>${site.name}</strong> (${formatSigned(site.lat, 3)} deg, ${formatSigned(site.lon, 3)} deg),
        Bortle ${site.bortle || 4}, horizont: ${horizonLabel(site)}.
      </p>
      <p>
        Astro tama: ${
          selectedPlan.night.hasDarkNight && selectedPlan.night.dusk && selectedPlan.night.dawn
            ? `${formatClock(selectedPlan.night.dusk)}-${formatClock(selectedPlan.night.dawn)}`
            : "nema pune astro noci"
        }.
        Darkest point oko ${selectedPlan.night.darkest ? formatClock(selectedPlan.night.darkest) : "N/A"}.
      </p>
      <p>
        Planner sada koristi radiant path interpolaciju, Moon-radiant separaciju i low-cloud/visibility weighting.
        Dobar je za terensku odluku, ali nije zamjena za formalnu publikaciju opservacionih stopa.
      </p>
      <p>
        Watch forma: LM ${watch.limitingMagnitude}, oblaci ${watch.cloudFraction}%, efektivno ${watch.effectiveHours} h,
        pauze ${watch.breakMinutes} min, SQM ${watch.sqm}, centar ${watch.centerAzDeg}/${watch.centerAltDeg} deg.
      </p>
      <p>
        Raspon throughputa za vrh je ${selectedPlan.bestPessimisticRatePerHour}-${selectedPlan.bestRatePerHour}-${selectedPlan.bestOptimisticRatePerHour} /h,
        uz ${confidenceLabel(selectedPlan.confidenceScore).toLowerCase()} (${selectedPlan.confidenceScore}%).
      </p>
    </article>
  `;
}

function renderSkyMapContent() {
  const selectedPlan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  const lookDirection = selectedPlan && site ? preferredLookDirection(selectedPlan, site) : null;
  if (!selectedPlan || !site) {
    elements.skyMapContent.innerHTML = `
      <div class="section-heading">
        <div>
          <span class="section-kicker">${t("Geometrija neba", "Sky geometry")}</span>
          <h2>${t("Mapa radianta", "Radiant sky map")}</h2>
        </div>
        <p>All-sky pregled radianta, Mjeseca i lokalnog horizonta.</p>
      </div>
      <div class="weather-empty">Nema aktivnog plana za sky map.</div>
    `;
    return;
  }

  elements.skyMapContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Geometrija neba", "Sky geometry")}</span>
        <h2>${t("Mapa radianta", "Radiant sky map")}</h2>
      </div>
      <p>All-sky pregled radianta, Mjeseca i lokalnog horizonta.</p>
    </div>
    ${buildSkyMapSvg(selectedPlan, site)}
    <div class="detail-grid compact">
      <article class="detail-card">
        <span>Maska horizonta</span>
        <strong>${round(averageHorizonMask(site), 1)} deg avg</strong>
        <small>Peak clearance ${selectedPlan.bestHorizonClearanceDeg} deg | ${site.horizonSource}</small>
      </article>
      <article class="detail-card">
        <span>Separacija Mjeseca</span>
        <strong>${selectedPlan.bestRadiantMoonSeparationDeg} deg</strong>
        <small>Manje je gore, vece je cisce</small>
      </article>
      <article class="detail-card">
        <span>Optimalni pogled</span>
        <strong>${lookDirection ? `${lookDirection.direction} @ ${lookDirection.altitudeDeg} deg` : "n/a"}</strong>
        <small>${lookDirection ? lookDirection.note : "nema preporuke"}</small>
      </article>
    </div>
  `;
}

function renderSkyCameraContent() {
  const supported = cameraSupported();
  const embedUrl = sanitizeCameraUrl(state.skyCamera.embedUrl);
  const deviceOptions = state.cameraDevices.length
    ? state.cameraDevices
        .map(
          (device) => `
            <option value="${device.id}" ${state.skyCamera.deviceId === device.id ? "selected" : ""}>
              ${device.label}
            </option>
          `
        )
        .join("")
    : `<option value="">Podrazumijevana kamera</option>`;

  const embedPreview = (() => {
    if (!embedUrl) {
      return `<div class="camera-empty">Unesi javni stream URL ili embed link. Za YouTube koristi embed/iframe URL.</div>`;
    }

    if (state.skyCamera.embedType === "image") {
      return `<img class="camera-frame" src="${embedUrl}" alt="Sky camera feed" />`;
    }
    if (state.skyCamera.embedType === "video") {
      return `<video class="camera-frame" src="${embedUrl}" controls autoplay muted playsinline></video>`;
    }
    return `<iframe class="camera-frame" src="${embedUrl}" title="Sky camera embed" allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="no-referrer"></iframe>`;
  })();

  elements.cameraContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Kamera neba", "Sky camera")}</span>
        <h2>${t("Live prikaz neba", "Live sky feed")}</h2>
      </div>
      <p>${
        state.cameraStatus === "loading"
          ? "Pokrecem live kameru..."
          : state.cameraError || "Lokalna USB/IP kamera ili javni meteor/all-sky feed."
      }</p>
    </div>
    <div class="control-grid">
      <label>
        Izvor
        <select name="cameraMode">
          <option value="device" ${state.skyCamera.mode === "device" ? "selected" : ""}>Lokalna kamera</option>
          <option value="embed" ${state.skyCamera.mode === "embed" ? "selected" : ""}>Javni feed</option>
        </select>
      </label>
      <label>
        Kamera
        <select name="cameraDeviceId" ${state.skyCamera.mode !== "device" ? "disabled" : ""}>
          ${deviceOptions}
        </select>
      </label>
      <label>
        Tip embeda
        <select name="cameraEmbedType" ${state.skyCamera.mode !== "embed" ? "disabled" : ""}>
          <option value="iframe" ${state.skyCamera.embedType === "iframe" ? "selected" : ""}>iframe / YouTube</option>
          <option value="video" ${state.skyCamera.embedType === "video" ? "selected" : ""}>Direktni video</option>
          <option value="image" ${state.skyCamera.embedType === "image" ? "selected" : ""}>MJPEG / slika</option>
        </select>
      </label>
      <label>
        URL feeda
        <input name="cameraEmbedUrl" type="url" value="${state.skyCamera.embedUrl}" placeholder="https://..." ${state.skyCamera.mode !== "embed" ? "disabled" : ""} />
      </label>
    </div>
    <div class="control-actions">
      <button class="ghost-button" data-action="refresh-cameras" ${!supported ? "disabled" : ""}>Osvjezi kamere</button>
      <button class="ghost-button" data-action="start-camera" ${!supported || state.skyCamera.mode !== "device" ? "disabled" : ""}>Pokreni lokalni feed</button>
      <button class="ghost-button" data-action="stop-camera" ${state.skyCamera.mode !== "device" ? "disabled" : ""}>Zaustavi lokalni feed</button>
      <button class="ghost-button" data-action="capture-camera-frame" ${state.skyCamera.mode !== "device" || state.cameraStatus !== "live" ? "disabled" : ""}>Snimi kadar</button>
    </div>
    <div class="camera-shell">
      ${
        state.skyCamera.mode === "device"
          ? supported
            ? `<video class="camera-frame" data-role="camera-preview" autoplay muted playsinline></video>`
            : `<div class="camera-empty">Lokalna kamera radi samo u browseru koji podrzava getUserMedia na localhost/https.</div>`
          : embedPreview
      }
    </div>
    <p class="inline-note">
      Lokalni mod je najpouzdaniji za USB/all-sky kameru. Javni feed radi ako izvor dozvoljava embed ili direktni video/slika stream.
    </p>
  `;

  attachCameraStream();
}

function renderOpsConsoleContent() {
  const drafts = currentSessionFireballDrafts();
  elements.opsConsoleContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Operativna konzola", "Ops console")}</span>
        <h2>${t("Trigger, glas i fireball pomoc", "Trigger, voice and fireball assist")}</h2>
      </div>
      <p>${
        state.trigger.error || state.audioLogger.error || "Automatski trigger, hands-free logger i draft report workflow."
      }</p>
    </div>
    <div class="detail-grid compact">
      <article class="detail-card">
        <span>Trigger</span>
        <strong>${statusLabel(state.trigger.status)}</strong>
        <small>${state.trigger.detectionCount} detekcija | score ${state.trigger.lastScore}</small>
      </article>
      <article class="detail-card">
        <span>Glasovni logger</span>
        <strong>${state.audioLogger.listening ? "slusa" : state.audioLogger.supported ? "spremno" : "nije podrzano"}</strong>
        <small>${state.audioLogger.transcript || "nema transkripta"}</small>
      </article>
      <article class="detail-card">
        <span>Fireball nacrti</span>
        <strong>${drafts.length}</strong>
        <small>auto nacrt kada event izgleda dovoljno jak</small>
      </article>
      <article class="detail-card">
        <span>Zadnja detekcija</span>
        <strong>${state.trigger.lastDetectionIso ? state.trigger.lastDetectionIso.slice(11, 19) : "n/a"}</strong>
        <small>${state.trigger.lastFramePreview ? "preview sacuvan" : "preview jos nije spreman"}</small>
      </article>
    </div>
    <div class="control-grid">
      <label>
        Osjetljivost triggera
        <input name="triggerSensitivity" type="range" min="0.04" max="0.3" step="0.01" value="${state.trigger.sensitivity}" />
      </label>
      <label>
        Minimalni pikseli triggera
        <input name="triggerMinPixels" type="number" min="40" max="1200" step="10" value="${state.trigger.minPixels}" />
      </label>
      <label>
        Trigger pauza [s]
        <input name="triggerCooldownSec" type="number" min="2" max="60" step="1" value="${state.trigger.cooldownSec}" />
      </label>
      <label>
        Jezik glasa
        <select name="audioLanguage">
          <option value="bs-BA" ${state.audioLogger.language === "bs-BA" ? "selected" : ""}>bs-BA</option>
          <option value="hr-HR" ${state.audioLogger.language === "hr-HR" ? "selected" : ""}>hr-HR</option>
          <option value="sr-RS" ${state.audioLogger.language === "sr-RS" ? "selected" : ""}>sr-RS</option>
          <option value="en-US" ${state.audioLogger.language === "en-US" ? "selected" : ""}>en-US</option>
        </select>
      </label>
    </div>
    <div class="control-actions">
      <button class="ghost-button" data-action="start-trigger" ${state.cameraStatus !== "live" ? "disabled" : ""}>Aktiviraj trigger</button>
      <button class="ghost-button" data-action="stop-trigger">Zaustavi trigger</button>
      <button class="ghost-button" data-action="start-voice-logger" ${!state.audioLogger.supported || state.audioLogger.listening ? "disabled" : ""}>Pokreni glasovni logger</button>
      <button class="ghost-button" data-action="stop-voice-logger" ${!state.audioLogger.listening ? "disabled" : ""}>Zaustavi glasovni logger</button>
    </div>
    <label class="notes-box">
      <input name="triggerAutoLog" type="checkbox" ${state.trigger.autoLog ? "checked" : ""} />
      Auto-log trigger kao meteor event
    </label>
    ${
      state.trigger.lastFramePreview
        ? `<img class="trigger-preview" src="${state.trigger.lastFramePreview}" alt="Last trigger preview" />`
        : `<div class="camera-empty trigger-placeholder">Trigger preview ce se pojaviti nakon prve detekcije.</div>`
    }
    <div class="session-log-list">
      ${
        drafts.length
          ? drafts
              .slice(0, 3)
              .map(
                (draft) => `
                  <article class="session-item">
                    <strong>${draft.timestampUtc.slice(11, 19)} UTC | mag ${draft.magnitude}</strong>
                    <p>az ${draft.azimuthDeg} deg | alt ${draft.altitudeDeg} deg | ${draft.color}</p>
                    <p>${draft.train} | ${draft.fragmentation} | ${draft.source}</p>
                    <div class="control-actions">
                      <button class="ghost-button small" data-action="download-fireball-draft" data-id="${draft.id}">Preuzmi nacrt</button>
                    </div>
                  </article>
                `
              )
              .join("")
          : `<div class="weather-empty">Jos nema auto fireball draftova za ovu sesiju.</div>`
      }
    </div>
  `;
}

function renderQcContent() {
  const selectedPlan = getSelectedPlan();
  const nowcast = nowcastSummary(selectedPlan);
  const qc = qcSnapshot();
  const lookDirection = selectedPlan ? preferredLookDirection(selectedPlan, selectedSiteSnapshot()) : null;

  elements.qcContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("QC tabla", "QC dashboard")}</span>
        <h2>${t("Stanje instrumenta i nowcast", "Instrument health and nowcast")}</h2>
      </div>
      <p>Brz pregled svježine podataka, trigger stanja i cloud-break heuristike.</p>
    </div>
    <div class="detail-grid compact">
      <article class="detail-card">
        <span>Pouzdanost planera</span>
        <strong>${qc.plannerConfidence ?? "n/a"}%</strong>
        <small>${selectedPlan ? confidenceLabel(selectedPlan.confidenceScore) : "bez plana"}</small>
      </article>
      <article class="detail-card">
        <span>Svjezina prognoze</span>
        <strong>${qc.weatherAgeMin == null ? "n/a" : `${qc.weatherAgeMin} min`}</strong>
        <small>${statusLabel(state.weatherStatus)}</small>
      </article>
      <article class="detail-card">
        <span>Kamera / trigger</span>
        <strong>${statusLabel(qc.camera)} / ${statusLabel(qc.trigger)}</strong>
        <small>${qc.analysisFps} fps analiza | ${qc.detectionCount} detekcija</small>
      </article>
      <article class="detail-card">
        <span>Glasovni logger</span>
        <strong>${qc.voice}</strong>
        <small>${state.audioLogger.language}</small>
      </article>
    </div>
    <div class="detail-grid compact">
      <article class="detail-card">
        <span>Cloud-break nowcast</span>
        <strong>${nowcast?.clearBreak ? formatClock(nowcast.clearBreak.time) : "nema uskoro"}</strong>
        <small>${nowcast ? nowcast.trendLabel : "nema forecast heuristike"}</small>
      </article>
      <article class="detail-card">
        <span>Najbolji naredni slot</span>
        <strong>${nowcast?.best ? formatClock(nowcast.best.time) : "n/a"}</strong>
        <small>${nowcast?.best ? `oblaci ${Math.round(nowcast.best.cloudCover)}%, niski ${Math.round(nowcast.best.lowCloudCover)}%` : "bez podataka"}</small>
      </article>
      <article class="detail-card">
        <span>Optimalno polje</span>
        <strong>${lookDirection ? `${lookDirection.direction} @ ${lookDirection.altitudeDeg} deg` : "n/a"}</strong>
        <small>${lookDirection ? lookDirection.note : "nema preporuke"}</small>
      </article>
      <article class="detail-card">
        <span>Bazen uredjaja</span>
        <strong>${state.cameraDevices.length}</strong>
        <small>video inputs trenutno vidljivi browseru</small>
      </article>
    </div>
  `;
}

function renderObserverSectors() {
  const selectedPlan = getSelectedPlan();
  if (!selectedPlan) {
    elements.observerSectors.innerHTML = `<div class="weather-empty">Odaberi roj za raspodjelu sektora.</div>`;
    return;
  }

  const sectors = buildObserverSectors(selectedPlan, state.observerCount);
  elements.observerSectors.innerHTML = `
    <div class="sector-grid">
      ${sectors
        .map(
          (sector) => `
            <article class="sector-card">
              <strong>Posmatrac ${sector.index}</strong>
              <p>Az ${sector.startDeg}-${sector.endDeg} deg</p>
              <p>Centar ${sector.centerDeg} deg | ciljna visina ${sector.targetAltDeg} deg</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderSessionLogContent() {
  const selectedPlan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  const calibrationKey =
    selectedPlan && site ? `${site.id || "manual"}::${selectedPlan.shower.id}` : null;
  const calibrationMap = getCalibrationMap();
  const calibrationValue = calibrationKey ? calibrationMap[calibrationKey] ?? 1 : 1;
  const recentLogs = state.sessionLogs.slice(-4).reverse();
  const sessionEvents = currentSessionEvents(selectedPlan, site)
    .slice()
    .sort((a, b) => new Date(b.timestampUtc) - new Date(a.timestampUtc));
  const watch = scientificWatchSummary();
  const observedRate = sessionObservedRate(sessionEvents, selectedPlan);
  const averageMagnitude = sessionEvents.length
    ? round(
        sessionEvents.reduce((sum, event) => sum + Number(event.magnitude || 0), 0) /
          sessionEvents.length,
        1
      )
    : null;

  elements.sessionLogContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Logger sesije", "Session logger")}</span>
        <h2>${t("UTC event logger i kalibracija", "UTC event logger and calibration")}</h2>
      </div>
      <p>${t("Event-level meteor log sa UTC markerima i session-level samokalibracijom.", "Event-level meteor logging with UTC markers and session-level self-calibration.")}</p>
    </div>
    <div class="detail-grid compact">
      <article class="detail-card">
        <span>Faktor kalibracije</span>
        <strong>${round(calibrationValue, 2)}x</strong>
        <small>${selectedPlan ? `${selectedPlan.shower.code} @ ${site?.name || "site"}` : "bez odabira"}</small>
      </article>
      <article class="detail-card">
        <span>Zapisnici sesije</span>
        <strong>${state.sessionLogs.length}</strong>
        <small>Lokalna historija samokalibracije</small>
      </article>
      <article class="detail-card">
        <span>UTC events</span>
        <strong>${sessionEvents.length}</strong>
        <small>${selectedPlan ? `${selectedPlan.shower.code} @ ${state.date}` : "bez odabira"}</small>
      </article>
      <article class="detail-card">
        <span>Uocena stopa</span>
        <strong>${observedRate || 0}/h</strong>
        <small>${averageMagnitude == null ? "bez event statistike" : `prosjek mag ${averageMagnitude}`}</small>
      </article>
      <article class="detail-card">
        <span>Watch forma</span>
        <strong>LM ${watch.limitingMagnitude} | SQM ${watch.sqm}</strong>
        <small>oblaci ${watch.cloudFraction}% | efikasno ${watch.effectiveHours} h</small>
      </article>
    </div>
    <div class="control-grid">
      <label>
        UTC marker
        <input name="eventUtcIso" type="text" value="${state.eventDraft.utcIso}" placeholder="2026-08-12T21:14:08Z" />
      </label>
      <label>
        Magnituda
        <input name="eventMagnitude" type="number" min="-8" max="8" step="0.5" value="${state.eventDraft.magnitude}" />
      </label>
      <label>
        Boja
        <select name="eventColor">
          ${["white", "yellow", "orange", "green", "blue", "red"].map((color) => `<option value="${color}" ${state.eventDraft.color === color ? "selected" : ""}>${color}</option>`).join("")}
        </select>
      </label>
      <label>
        Trag
        <select name="eventTrain">
          ${[
            ["none", "nema"],
            ["short", "kratak"],
            ["persistent", "postojan"]
          ].map(([value, label]) => `<option value="${value}" ${state.eventDraft.train === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <label>
        Fragmentacija
        <select name="eventFragmentation">
          ${[
            ["none", "nema"],
            ["minor", "blaga"],
            ["strong", "jaka"]
          ].map(([value, label]) => `<option value="${value}" ${state.eventDraft.fragmentation === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <label>
        Azimut eventa [deg]
        <input name="eventAzimuthDeg" type="number" min="0" max="359" step="1" value="${state.eventDraft.azimuthDeg}" />
      </label>
      <label>
        Visina eventa [deg]
        <input name="eventAltitudeDeg" type="number" min="0" max="90" step="1" value="${state.eventDraft.altitudeDeg}" />
      </label>
      <label>
        Biljeske eventa
        <input name="eventNotes" type="text" value="${state.eventDraft.notes}" placeholder="promjena boje, flare, putanja..." />
      </label>
    </div>
    <div class="control-grid">
      <label>
        Limiting magnitude
        <input name="watchLimitingMagnitude" type="number" min="2" max="7.5" step="0.1" value="${state.watchForm.limitingMagnitude}" />
      </label>
      <label>
        Udio oblaka [%]
        <input name="watchCloudFraction" type="number" min="0" max="100" step="1" value="${state.watchForm.cloudFraction}" />
      </label>
      <label>
        Efektivno vrijeme [h]
        <input name="watchEffectiveHours" type="number" min="0.1" max="12" step="0.1" value="${state.watchForm.effectiveHours}" />
      </label>
      <label>
        Pauze [min]
        <input name="watchBreakMinutes" type="number" min="0" max="240" step="1" value="${state.watchForm.breakMinutes}" />
      </label>
      <label>
        SQM
        <input name="watchSqm" type="number" min="16" max="23" step="0.1" value="${state.watchForm.sqm}" />
      </label>
      <label>
        Azimut centra [deg]
        <input name="watchCenterAzDeg" type="number" min="0" max="359" step="1" value="${state.watchForm.centerAzDeg}" />
      </label>
      <label>
        Visina centra [deg]
        <input name="watchCenterAltDeg" type="number" min="0" max="90" step="1" value="${state.watchForm.centerAltDeg}" />
      </label>
      <label>
        Biljeska o nebu
        <input name="watchSkyQualityNote" type="text" value="${state.watchForm.skyQualityNote}" placeholder="izmaglica, LP kupola, transparencija..." />
      </label>
    </div>
    <div class="control-actions">
      <button class="ghost-button" data-action="log-event-now">Upisi meteor sada (UTC)</button>
      <button class="ghost-button" data-action="log-event-manual">Upisi uneseni UTC</button>
      <button class="ghost-button" data-action="clear-observation-events">Obrisi event log</button>
      <button class="ghost-button" data-action="log-session">Upisi rezultat sesije</button>
      <button class="ghost-button" data-action="clear-session-logs">Obrisi logove</button>
    </div>
    <div class="session-log-list">
      ${
        recentLogs.length
          ? recentLogs
              .map(
                (log) => `
                  <article class="session-item">
                    <strong>${log.showerName}</strong>
                    <p>${log.siteName} | uoceno ${log.actualCount} / predvidjeno ${round(log.predictedRate, 1)} po h</p>
                  </article>
                `
              )
              .join("")
          : `<div class="weather-empty">Jos nema logovanih sesija.</div>`
      }
    </div>
    <div class="session-log-list">
      ${
        sessionEvents.length
          ? sessionEvents
              .slice(0, 8)
              .map(
                (event) => `
                  <article class="session-item">
                    <strong>${event.timestampUtc.slice(11, 19)} UTC | mag ${event.magnitude}</strong>
                    <p>${event.color} | trag ${event.train} | frag ${event.fragmentation}</p>
                    <p>${event.notes || "bez dodatnih biljeski"} | ocekivano ${event.expectedRatePerHour}/h</p>
                  </article>
                `
              )
              .join("")
          : `<div class="weather-empty">Jos nema UTC event markera za ovu sesiju.</div>`
      }
    </div>
  `;
}

function renderMultiStationContent() {
  const selectedPlan = getSelectedPlan();
  const stations = state.stationNetwork;
  const date = selectedDate();

  const cards = stations
    .map((station) => {
      const plan = selectedPlan
        ? rankShowers(
            [selectedPlan.shower],
            date,
            { ...station, bortle: station.bortle || 4, horizonMaskDeg: station.horizonMaskDeg || currentSiteMeta().horizonMaskDeg },
            null,
            getCalibrationMap()
          )[0]
        : null;
      return `
        <article class="station-card">
          <strong>${station.name}</strong>
          <p>${station.role} | ${formatSigned(station.lat, 2)} deg, ${formatSigned(station.lon, 2)} deg</p>
          <p>${plan ? `${plan.bestRatePerHour}/h | ${formatClock(plan.bestWindowStart)}-${formatClock(plan.bestWindowEnd)}` : "bez plana"}</p>
          <p>${plan ? `raspon ${plan.bestPessimisticRatePerHour}-${plan.bestOptimisticRatePerHour}/h | pouzdanost ${plan.confidenceScore}%` : ""}</p>
          <p>${station.status || "spremna"} | ${station.lens || "objektiv n/a"} | ${station.resolution || "rez n/a"}</p>
          <p>orijentacija ${station.orientationAzDeg ?? "n/a"} deg / ${station.orientationAltDeg ?? "n/a"} deg | LM ${station.limitingMagnitude ?? "n/a"}</p>
          <button class="ghost-button small" data-action="remove-station" data-id="${station.id}">Ukloni</button>
        </article>
      `;
    })
    .join("");

  elements.multiStationContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">${t("Multi-station", "Multi-station")}</span>
        <h2>${t("GMN-ready mod stanica", "GMN-ready station mode")}</h2>
      </div>
      <p>${t("Lokalna zajednicka tabla za visual, DSLR, video i all-sky stanice sa profilima stanica.", "A local shared board for visual, DSLR, video and all-sky stations with station profiles.")}</p>
    </div>
    <div class="control-grid">
      <label>
        Naziv stanice
        <input name="stationName" type="text" value="${state.stationDraft.name}" placeholder="Bjelasnica GMN-01" />
      </label>
      <label>
        Uloga
        <select name="stationRole">
          ${["visual", "dslr", "video", "allsky"].map((value) => `<option value="${value}" ${state.stationDraft.role === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </label>
      <label>
        Objektiv
        <input name="stationLens" type="text" value="${state.stationDraft.lens}" />
      </label>
      <label>
        Rezolucija
        <input name="stationResolution" type="text" value="${state.stationDraft.resolution}" />
      </label>
      <label>
        Orijentacija az [deg]
        <input name="stationOrientationAzDeg" type="number" min="0" max="359" step="1" value="${state.stationDraft.orientationAzDeg}" />
      </label>
      <label>
        Orijentacija alt [deg]
        <input name="stationOrientationAltDeg" type="number" min="0" max="90" step="1" value="${state.stationDraft.orientationAltDeg}" />
      </label>
      <label>
        Limiting magnitude
        <input name="stationLimitingMagnitude" type="number" min="2" max="8" step="0.1" value="${state.stationDraft.limitingMagnitude}" />
      </label>
      <label>
        Status stanice
        <select name="stationStatus">
          ${[
            ["ready", "spremna"],
            ["recording", "snima"],
            ["offline", "offline"],
            ["maintenance", "odrzavanje"]
          ].map(([value, label]) => `<option value="${value}" ${state.stationDraft.status === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="control-actions">
      <button class="ghost-button" data-action="add-current-station">Dodaj GMN stanicu</button>
      <button class="ghost-button" data-action="export-stations">Izvezi tablu stanica</button>
    </div>
    <div class="station-grid">
      ${cards || `<div class="weather-empty">Jos nema dodatih stanica.</div>`}
    </div>
  `;
}

function renderTonightContent() {
  elements.tonightContent.innerHTML = `
    <div class="section-heading">
      <div>
        <span class="section-kicker">Tonight in BiH</span>
        <h2>${t("Javni pregled veceras", "Public tonight view")}</h2>
      </div>
      <p>${
        state.tonightStatus === "loading"
          ? "Racunam Tonight in BiH..."
          : state.tonightError || "Top lokacije i rojevi za vecerasnji pregled Balkana."
      }</p>
    </div>
    <div class="station-grid">
      ${
        state.tonightBoard.length
          ? state.tonightBoard
              .map(
                (entry) => `
                  <article class="station-card">
                    <strong>${entry.location.name}</strong>
                    <p>${entry.plan.shower.code} | ${entry.plan.bestRatePerHour}/h</p>
                    <p>${formatClock(entry.plan.bestWindowStart)}-${formatClock(entry.plan.bestWindowEnd)} | ${entry.label}</p>
                    <p>raspon ${entry.plan.bestPessimisticRatePerHour}-${entry.plan.bestOptimisticRatePerHour}/h | pouzdanost ${entry.plan.confidenceScore}%</p>
                  </article>
                `
              )
              .join("")
          : `<div class="weather-empty">Tonight tabla jos nije spremna.</div>`
      }
    </div>
  `;
}

function renderDynamicRegions() {
  renderHeroMetrics();
  renderSiteFootnote();
  renderRankList();
  renderDetailContent();
  renderWeatherContent();
  renderSetupContent();
  renderFieldChecklist();
  renderReportPreview();
  renderSummaryContent();
  renderSkyMapContent();
  renderSkyCameraContent();
  renderOpsConsoleContent();
  renderObserverSectors();
  renderSessionLogContent();
  renderMultiStationContent();
  renderQcContent();
  renderTonightContent();
  attachCameraStream();
}

function rerenderShellAndRegions() {
  renderShell();
  cacheElements();
  syncSiteOptions();
  syncSensorOptions();
  syncControlValues();
  renderSiteFootnote();
  renderDynamicRegions();
}

function downloadFile(name, content, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function getSummaryText() {
  const selected = getSelectedPlan();
  const site = selectedSiteSnapshot();
  if (!selected || !site) {
    return "";
  }

  return [
    `MeteorOps | ${selected.shower.nameBs || selected.shower.name}`,
    planSummary(selected),
    `Lokacija: ${site.name} (${formatSigned(site.lat, 3)} deg, ${formatSigned(site.lon, 3)} deg)`,
    state.notes ? `Biljeske: ${state.notes}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function copySummary() {
  const summary = getSummaryText();
  if (!summary) {
    return;
  }

  try {
    await navigator.clipboard.writeText(summary);
  } catch {
    window.alert(summary);
  }
}

function downloadICS() {
  const selected = getSelectedPlan();
  if (!selected) {
    return;
  }

  const start = new Date(selected.bestWindowStart);
  const end = new Date(selected.bestWindowEnd);
  const toIcsStamp = (date) =>
    `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(
      date.getUTCDate()
    ).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}${String(
      date.getUTCMinutes()
    ).padStart(2, "0")}00Z`;

  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Night-Breaker//MeteorOps//BS",
    "BEGIN:VEVENT",
    `UID:${uniqueId("meteorops")}@nightbreaker`,
    `DTSTAMP:${toIcsStamp(new Date())}`,
    `DTSTART:${toIcsStamp(start)}`,
    `DTEND:${toIcsStamp(end)}`,
    `SUMMARY:${selected.shower.nameBs || selected.shower.name} observing window`,
    `DESCRIPTION:${planSummary(selected).replace(/\|/g, "-")} `,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  downloadFile(`meteorops-${selected.shower.code.toLowerCase()}.ics`, body, "text/calendar");
}

function downloadJSON() {
  const selected = getSelectedPlan();
  const site = selectedSiteSnapshot();
  if (!selected || !site) {
    return;
  }

  downloadFile(
    `meteorops-${selected.shower.code.toLowerCase()}.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        site,
        date: state.date,
        selectedPlan: selected,
        notes: state.notes,
        setup: state.setup
      },
      null,
      2
    ),
    "application/json"
  );
}

function clearWeatherState() {
  state.weather = null;
  state.weatherStatus = "idle";
  state.weatherError = "";
  state.weatherFetchedAt = null;
}

function requestPlans() {
  const site = selectedSiteSnapshot();
  const requestId = ++plannerRequestId;
  const calibration = getCalibrationMap();

  if (!site) {
    state.planStatus = "error";
    state.planError = "Koordinate nisu validne.";
    state.plans = [];
    renderDynamicRegions();
    return;
  }

  state.planStatus = "loading";
  state.planError = "";
  renderDynamicRegions();

  if (!plannerWorker) {
    state.plans = rankShowers(meteorShowers, selectedDate(), site, state.weather, calibration);
    state.planStatus = "ready";
    ensureSelectedPlan();
    renderDynamicRegions();
    return;
  }

  plannerWorker.postMessage({
    requestId,
    dateIso: selectedDate().toISOString(),
    site,
    weather: state.weather,
    calibration
  });
}

function schedulePlanRefresh(delay = 100) {
  clearTimeout(planDebounceTimer);
  planDebounceTimer = setTimeout(() => {
    requestPlans();
  }, delay);
}

async function refreshWeatherImmediate() {
  const site = selectedSiteSnapshot();
  const requestId = ++weatherRequestId;

  if (!site) {
    state.weatherStatus = "error";
    state.weatherError = "Koordinate nisu validne.";
    renderDynamicRegions();
    return;
  }

  if (weatherAbortController) {
    weatherAbortController.abort();
  }

  weatherAbortController = new AbortController();
  state.weatherStatus = "loading";
  state.weatherError = "";
  renderDynamicRegions();

  try {
    const weather = await fetchWeather(site.lat, site.lon, {
      signal: weatherAbortController.signal
    });
    if (requestId !== weatherRequestId) {
      return;
    }
    state.weather = weather;
    state.weatherFetchedAt = Date.now();
    state.weatherStatus = "ready";
    state.weatherError = "";
    renderDynamicRegions();
    requestPlans();
  } catch (error) {
    if (requestId !== weatherRequestId) {
      return;
    }
    if (error?.name === "AbortError") {
      return;
    }
    state.weather = null;
    state.weatherFetchedAt = null;
    state.weatherStatus = "error";
    state.weatherError = "Prognoza nije dostupna trenutno.";
    renderDynamicRegions();
    requestPlans();
  }
}

function scheduleWeatherRefresh(delay = 450) {
  clearTimeout(weatherDebounceTimer);
  state.weatherStatus = "pending";
  renderDynamicRegions();
  weatherDebounceTimer = setTimeout(() => {
    refreshWeatherImmediate();
  }, delay);
}

async function loadFireballs() {
  state.fireballStatus = "loading";
  renderFireballContent();

  try {
    state.fireballs = await fetchFireballs(18);
    state.fireballStatus = "ready";
    state.fireballError = "";
  } catch {
    state.fireballStatus = "error";
    state.fireballError = "NASA feed nije dostupan.";
  }

  renderFireballContent();
}

async function loadTonightBoard() {
  state.tonightStatus = "loading";
  state.tonightError = "";
  renderTonightContent();

  const tonightDate = new Date(`${formatDate(new Date())}T20:00:00`);
  const calibration = getCalibrationMap();

  try {
    const board = await Promise.all(
      presetLocations.map(async (location) => {
        let weather = null;
        try {
          weather = await fetchWeather(location.lat, location.lon);
        } catch {
          weather = null;
        }
        const plan = rankShowers(
          meteorShowers,
          tonightDate,
          location,
          weather,
          calibration
        )[0];
        const summary =
          plan && weather
            ? summarizeWeather(weather, plan.bestWindowStart, plan.bestWindowEnd)
            : null;
        const score = plan ? decisionScore(plan, summary) : 0;
        return {
          location,
          plan,
          score,
          label: plan ? decisionLabel(score) : "Ne isplati se"
        };
      })
    );

    state.tonightBoard = board
      .filter((entry) => entry.plan)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    state.tonightStatus = "ready";
  } catch {
    state.tonightStatus = "error";
    state.tonightError = "Tonight in BiH tabla trenutno nije dostupna.";
  }

  renderTonightContent();
}

function clearReminderTimers() {
  for (const timer of reminderTimers) {
    clearTimeout(timer);
  }
  reminderTimers = [];
}

async function ensureNotificationPermission() {
  if (!("Notification" in window)) {
    return false;
  }
  if (Notification.permission === "granted") {
    return true;
  }
  if (Notification.permission === "denied") {
    return false;
  }
  const permission = await Notification.requestPermission();
  return permission === "granted";
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

async function armAlert(kind) {
  const selectedPlan = getSelectedPlan();
  if (!selectedPlan) {
    return;
  }

  const ok = await ensureNotificationPermission();
  if (!ok) {
    window.alert("Notification dozvola nije odobrena.");
    return;
  }

  clearReminderTimers();
  const now = Date.now();
  let targetTime = new Date(selectedPlan.bestWindowStart).getTime() - 15 * 60000;
  let label = "Alert vrha je aktivan";

  if (kind === "clear") {
    const clearSlot = selectedPlan.entries.find(
      (entry) => (entry.cloudCover ?? 100) < 25 && (entry.lowCloudCover ?? 100) < 20
    );
    if (clearSlot) {
      targetTime = new Date(clearSlot.time).getTime() - 10 * 60000;
      label = "Alert vedrog prozora je aktivan";
    }
  }

  const delay = Math.max(1000, targetTime - now);
  reminderTimers.push(
    setTimeout(() => {
      notify(
        kind === "clear" ? "MeteorOps clear break" : "MeteorOps peak window",
        planSummary(selectedPlan)
      );
    }, delay)
  );
  state.reminderStatus = label;
  renderReportPreview();
}

function scheduleEnvironmentRefresh(delay = 120) {
  clearWeatherState();
  schedulePlanRefresh(delay);
  scheduleWeatherRefresh(420);
  loadTonightBoard();
}

function saveCurrentSite() {
  const site = selectedSiteSnapshot();
  if (!site) {
    window.alert("Koordinate nisu validne.");
    return;
  }

  const name = window.prompt("Naziv lokacije:");
  if (!name) {
    return;
  }

  state.savedSites = [
    ...state.savedSites,
    {
      id: uniqueId("site"),
      name: name.trim(),
      lat: site.lat,
      lon: site.lon,
      altitudeM: null,
      bortle: 4,
      horizon: "custom"
    }
  ];
  state.siteId = state.savedSites.at(-1).id;
  syncSiteOptions();
  syncControlValues();
  persistState();
  renderSiteFootnote();
}

function parseUtcIso(rawValue) {
  if (!rawValue) {
    return null;
  }

  const trimmed = rawValue.trim();
  const candidate = /(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function recordObservationEvent(timestampUtc, overrides = null) {
  const selectedPlan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  const payload = overrides || {
    timestampUtc,
    magnitude: Number(state.eventDraft.magnitude),
    color: state.eventDraft.color,
    train: state.eventDraft.train,
    fragmentation: state.eventDraft.fragmentation,
    azimuthDeg: Number(state.eventDraft.azimuthDeg),
    altitudeDeg: Number(state.eventDraft.altitudeDeg),
    notes: state.eventDraft.notes
  };
  const magnitude = Number(payload.magnitude);

  if (!selectedPlan || !site) {
    return;
  }
  if (!Number.isFinite(magnitude)) {
    window.alert("Magnitude mora biti broj.");
    return;
  }

  state.observationEvents = [
    ...state.observationEvents,
    {
      id: uniqueId("event"),
      sessionDate: state.date,
      timestampUtc,
      siteId: site.id,
      siteName: site.name,
      showerId: selectedPlan.shower.id,
      showerName: selectedPlan.shower.nameBs || selectedPlan.shower.name,
      expectedRatePerHour: selectedPlan.bestRatePerHour,
      magnitude,
      color: payload.color,
      train: payload.train,
      fragmentation: payload.fragmentation,
      azimuthDeg: payload.azimuthDeg,
      altitudeDeg: payload.altitudeDeg,
      mode: state.setup.mode,
      notes: payload.notes
    }
  ];
  appendFireballDraft({
    timestampUtc,
    magnitude,
    color: payload.color,
    train: payload.train,
    fragmentation: payload.fragmentation,
    azimuthDeg: payload.azimuthDeg,
    altitudeDeg: payload.altitudeDeg,
    notes: payload.notes
  }, overrides ? "auto" : "manual");
  state.eventDraft.utcIso = new Date().toISOString();
  persistState();
  renderSessionLogContent();
  renderOpsConsoleContent();
  renderReportPreview();
}

function clearObservationEvents() {
  const selectedPlan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  if (!selectedPlan || !site) {
    state.observationEvents = [];
    state.fireballDrafts = [];
  } else {
    state.observationEvents = state.observationEvents.filter(
      (event) =>
        !(
          event.sessionDate === state.date &&
          event.siteId === site.id &&
          event.showerId === selectedPlan.shower.id
        )
    );
    state.fireballDrafts = state.fireballDrafts.filter(
      (draft) =>
        !(
          draft.sessionDate === state.date &&
          draft.siteId === site.id &&
          draft.showerId === selectedPlan.shower.id
        )
    );
  }
  persistState();
  renderSessionLogContent();
  renderOpsConsoleContent();
  renderReportPreview();
}

function addCurrentAsStation() {
  const site = selectedSiteSnapshot();
  if (!site) {
    return;
  }
  const name = state.stationDraft.name.trim() || `${site.name} ${state.stationNetwork.length + 1}`;
  state.stationNetwork = [
    ...state.stationNetwork,
    {
      id: uniqueId("station"),
      name,
      lat: site.lat,
      lon: site.lon,
      role: state.stationDraft.role,
      bortle: site.bortle,
      horizonMaskDeg: site.horizonMaskDeg,
      lens: state.stationDraft.lens,
      resolution: state.stationDraft.resolution,
      orientationAzDeg: Number(state.stationDraft.orientationAzDeg),
      orientationAltDeg: Number(state.stationDraft.orientationAltDeg),
      limitingMagnitude: Number(state.stationDraft.limitingMagnitude),
      status: state.stationDraft.status
    }
  ];
  state.stationDraft.name = "";
  persistState();
  renderMultiStationContent();
}

function removeStation(id) {
  state.stationNetwork = state.stationNetwork.filter((station) => station.id !== id);
  persistState();
  renderMultiStationContent();
}

function exportStations() {
  downloadFile(
    "meteorops-stations.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), stations: state.stationNetwork }, null, 2),
    "application/json"
  );
}

function logSessionResult() {
  const selectedPlan = getSelectedPlan();
  const site = selectedSiteSnapshot();
  if (!selectedPlan || !site) {
    return;
  }

  const watch = scientificWatchSummary();
  const defaultCount = Math.max(currentSessionEvents(selectedPlan, site).length, 0);
  const actualCount = Number(
    window.prompt("Koliko meteora si stvarno registrovao?", String(defaultCount || 25))
  );
  const durationHours = Number(
    window.prompt("Efektivno vrijeme [h]?", String(watch.effectiveHours || 1.0))
  );
  if (!Number.isFinite(actualCount) || !Number.isFinite(durationHours) || durationHours <= 0) {
    return;
  }

  state.sessionLogs = [
    ...state.sessionLogs,
    {
      id: uniqueId("log"),
      timestamp: new Date().toISOString(),
      siteId: site.id,
      siteName: site.name,
      showerId: selectedPlan.shower.id,
      showerName: selectedPlan.shower.nameBs || selectedPlan.shower.name,
      predictedRate: selectedPlan.bestRatePerHour,
      actualCount,
      durationHours,
      mode: state.setup.mode,
      notes: state.notes,
      limitingMagnitude: watch.limitingMagnitude,
      cloudFraction: watch.cloudFraction,
      breakMinutes: watch.breakMinutes,
      sqm: watch.sqm,
      centerAzDeg: watch.centerAzDeg,
      centerAltDeg: watch.centerAltDeg,
      skyQualityNote: watch.skyQualityNote
    }
  ];
  persistState();
  renderSessionLogContent();
  schedulePlanRefresh(0);
  loadTonightBoard();
}

function clearSessionLogs() {
  state.sessionLogs = [];
  persistState();
  renderSessionLogContent();
  schedulePlanRefresh(0);
}

function useGps() {
  if (!("geolocation" in navigator)) {
    window.alert("Browser ne podrzava geolokaciju.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.siteId = "manual";
      state.latInput = String(round(position.coords.latitude, 5));
      state.lonInput = String(round(position.coords.longitude, 5));
      syncControlValues();
      persistState();
      renderSiteFootnote();
      scheduleEnvironmentRefresh(0);
    },
    () => {
      window.alert("Geolokacija nije odobrena ili nije dostupna.");
    },
    { enableHighAccuracy: true, maximumAge: 300000, timeout: 10000 }
  );
}

function handlePlannerMessage(event) {
  const { requestId, ok, plans, error } = event.data;
  if (requestId !== plannerRequestId) {
    return;
  }

  if (!ok) {
    state.planStatus = "error";
    state.planError = error || "Planner worker nije uspio.";
    state.plans = [];
    renderDynamicRegions();
    return;
  }

  state.plans = plans;
  state.planStatus = "ready";
  state.planError = "";
  ensureSelectedPlan();
  renderDynamicRegions();
}

function handleStateInput(target) {
  const name = target.getAttribute("name");
  if (!name) {
    return;
  }

  switch (name) {
    case "lang":
      state.lang = target.value === "en" ? "en" : "bs";
      if (state.lang === "en" && state.audioLogger.language === "bs-BA") {
        state.audioLogger.language = "en-US";
      }
      if (state.lang === "bs" && state.audioLogger.language === "en-US") {
        state.audioLogger.language = "bs-BA";
      }
      applyLanguage();
      persistState();
      rerenderShellAndRegions();
      break;
    case "theme":
      state.theme = target.value;
      applyTheme();
      persistState();
      break;
    case "date":
      state.date = target.value;
      persistState();
      scheduleEnvironmentRefresh(120);
      break;
    case "siteId": {
      state.siteId = target.value;
      const site = [...presetLocations, ...state.savedSites].find((item) => item.id === target.value);
      if (site) {
        state.latInput = String(site.lat);
        state.lonInput = String(site.lon);
        syncControlValues();
      }
      persistState();
      renderSiteFootnote();
      scheduleEnvironmentRefresh(0);
      break;
    }
    case "lat":
      state.latInput = target.value;
      state.siteId = "manual";
      elements.siteSelect.value = "manual";
      persistState();
      renderSiteFootnote();
      scheduleEnvironmentRefresh(220);
      break;
    case "lon":
      state.lonInput = target.value;
      state.siteId = "manual";
      elements.siteSelect.value = "manual";
      persistState();
      renderSiteFootnote();
      scheduleEnvironmentRefresh(220);
      break;
    case "sensorId":
      state.setup.sensorId = target.value;
      persistState();
      renderSetupContent();
      renderFieldChecklist();
      break;
    case "focalMm": {
      const focalMm = Number(target.value);
      if (Number.isFinite(focalMm)) {
        state.setup.focalMm = focalMm;
      }
      persistState();
      renderSetupContent();
      renderFieldChecklist();
      break;
    }
    case "aperture": {
      const aperture = Number(target.value);
      if (Number.isFinite(aperture)) {
        state.setup.aperture = aperture;
      }
      persistState();
      renderSetupContent();
      renderFieldChecklist();
      break;
    }
    case "mode":
      state.setup.mode = target.value;
      persistState();
      renderSetupContent();
      renderFieldChecklist();
      break;
    case "reportMode":
      state.reportMode = target.value;
      persistState();
      renderReportPreview();
      break;
    case "observerCount": {
      const observerCount = Number(target.value);
      state.observerCount = clamp(observerCount || 1, 1, 8);
      persistState();
      renderObserverSectors();
      break;
    }
    case "triggerSensitivity":
      state.trigger.sensitivity = Number(target.value);
      persistState();
      renderOpsConsoleContent();
      renderQcContent();
      break;
    case "triggerMinPixels":
      state.trigger.minPixels = clamp(Number(target.value) || 0, 20, 5000);
      persistState();
      renderOpsConsoleContent();
      break;
    case "triggerCooldownSec":
      state.trigger.cooldownSec = clamp(Number(target.value) || 0, 1, 120);
      persistState();
      renderOpsConsoleContent();
      break;
    case "triggerAutoLog":
      state.trigger.autoLog = target.checked;
      persistState();
      renderOpsConsoleContent();
      break;
    case "audioLanguage":
      state.audioLogger.language = target.value;
      persistState();
      renderOpsConsoleContent();
      break;
    case "cameraMode":
      state.skyCamera.mode = target.value;
      if (target.value !== "device") {
        stopCameraStream({ silent: true });
        stopMeteorTrigger({ silent: true });
      }
      persistState();
      renderSkyCameraContent();
      renderOpsConsoleContent();
      break;
    case "cameraDeviceId":
      state.skyCamera.deviceId = target.value;
      persistState();
      if (state.cameraStatus === "live") {
        startCameraStream();
      }
      break;
    case "cameraEmbedType":
      state.skyCamera.embedType = target.value;
      persistState();
      renderSkyCameraContent();
      break;
    case "cameraEmbedUrl":
      state.skyCamera.embedUrl = target.value;
      persistState();
      renderSkyCameraContent();
      break;
    case "eventUtcIso":
      state.eventDraft.utcIso = target.value;
      persistState();
      break;
    case "eventMagnitude": {
      const magnitude = Number(target.value);
      state.eventDraft.magnitude = Number.isFinite(magnitude) ? magnitude : state.eventDraft.magnitude;
      persistState();
      break;
    }
    case "eventColor":
      state.eventDraft.color = target.value;
      persistState();
      break;
    case "eventTrain":
      state.eventDraft.train = target.value;
      persistState();
      break;
    case "eventFragmentation":
      state.eventDraft.fragmentation = target.value;
      persistState();
      break;
    case "eventAzimuthDeg":
      state.eventDraft.azimuthDeg = clamp(Number(target.value) || 0, 0, 359);
      persistState();
      break;
    case "eventAltitudeDeg":
      state.eventDraft.altitudeDeg = clamp(Number(target.value) || 0, 0, 90);
      persistState();
      break;
    case "watchLimitingMagnitude":
      state.watchForm.limitingMagnitude = Number(target.value);
      persistState();
      renderSessionLogContent();
      break;
    case "watchCloudFraction":
      state.watchForm.cloudFraction = clamp(Number(target.value) || 0, 0, 100);
      persistState();
      renderSessionLogContent();
      break;
    case "watchEffectiveHours":
      state.watchForm.effectiveHours = clamp(Number(target.value) || 0.1, 0.1, 16);
      persistState();
      renderSessionLogContent();
      break;
    case "watchBreakMinutes":
      state.watchForm.breakMinutes = clamp(Number(target.value) || 0, 0, 600);
      persistState();
      renderSessionLogContent();
      break;
    case "watchSqm":
      state.watchForm.sqm = clamp(Number(target.value) || 0, 10, 25);
      persistState();
      renderSessionLogContent();
      break;
    case "watchCenterAzDeg":
      state.watchForm.centerAzDeg = clamp(Number(target.value) || 0, 0, 359);
      persistState();
      renderSessionLogContent();
      renderSkyMapContent();
      renderQcContent();
      break;
    case "watchCenterAltDeg":
      state.watchForm.centerAltDeg = clamp(Number(target.value) || 0, 0, 90);
      persistState();
      renderSessionLogContent();
      renderSkyMapContent();
      renderQcContent();
      break;
    case "watchSkyQualityNote":
      state.watchForm.skyQualityNote = target.value;
      persistState();
      renderSessionLogContent();
      break;
    case "stationName":
      state.stationDraft.name = target.value;
      persistState();
      break;
    case "stationRole":
      state.stationDraft.role = target.value;
      persistState();
      break;
    case "stationLens":
      state.stationDraft.lens = target.value;
      persistState();
      break;
    case "stationResolution":
      state.stationDraft.resolution = target.value;
      persistState();
      break;
    case "stationOrientationAzDeg":
      state.stationDraft.orientationAzDeg = clamp(Number(target.value) || 0, 0, 359);
      persistState();
      break;
    case "stationOrientationAltDeg":
      state.stationDraft.orientationAltDeg = clamp(Number(target.value) || 0, 0, 90);
      persistState();
      break;
    case "stationLimitingMagnitude":
      state.stationDraft.limitingMagnitude = clamp(Number(target.value) || 0, 0, 8);
      persistState();
      break;
    case "stationStatus":
      state.stationDraft.status = target.value;
      persistState();
      break;
    case "eventNotes":
      state.eventDraft.notes = target.value;
      persistState();
      break;
    case "notes":
      state.notes = target.value;
      persistState();
      renderReportPreview();
      break;
    default:
      break;
  }
}

function bindEvents() {
  app.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      handleStateInput(target);
    }
  });

  app.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      handleStateInput(target);
    }
  });

  app.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }

    const action = target.getAttribute("data-action");
    if (action === "select-shower") {
      state.selectedShowerId = target.getAttribute("data-id") || "";
      persistState();
      renderDynamicRegions();
      return;
    }
    if (action === "use-gps") {
      useGps();
      return;
    }
    if (action === "save-site") {
      saveCurrentSite();
      return;
    }
    if (action === "copy-summary") {
      copySummary();
      return;
    }
    if (action === "open-about") {
      openAboutWindow();
      return;
    }
    if (action === "refresh-weather") {
      refreshWeatherImmediate();
      return;
    }
    if (action === "use-look-direction") {
      const selectedPlan = getSelectedPlan();
      const site = selectedSiteSnapshot();
      const look = selectedPlan && site ? preferredLookDirection(selectedPlan, site) : null;
      if (!look) {
        return;
      }
      state.watchForm.centerAzDeg = look.azimuthDeg;
      state.watchForm.centerAltDeg = look.altitudeDeg;
      state.eventDraft.azimuthDeg = look.azimuthDeg;
      state.eventDraft.altitudeDeg = look.altitudeDeg;
      persistState();
      renderSkyMapContent();
      renderSessionLogContent();
      renderQcContent();
      return;
    }
    if (action === "refresh-cameras") {
      await refreshCameraDevices();
      renderSkyCameraContent();
      return;
    }
    if (action === "start-camera") {
      startCameraStream();
      return;
    }
    if (action === "stop-camera") {
      stopCameraStream();
      return;
    }
    if (action === "capture-camera-frame") {
      captureCameraFrame();
      return;
    }
    if (action === "start-trigger") {
      startMeteorTrigger();
      return;
    }
    if (action === "stop-trigger") {
      stopMeteorTrigger();
      return;
    }
    if (action === "start-voice-logger") {
      startVoiceLogger();
      return;
    }
    if (action === "stop-voice-logger") {
      stopVoiceLogger();
      return;
    }
    if (action === "download-ics") {
      downloadICS();
      return;
    }
    if (action === "download-json") {
      downloadJSON();
      return;
    }
    if (action === "download-csv") {
      downloadFile("meteorops-session-logs.csv", buildReportCsv(), "text/csv");
      return;
    }
    if (action === "download-report") {
      downloadFile("meteorops-report.txt", elements.reportPreview.textContent || "", "text/plain");
      return;
    }
    if (action === "arm-peak-alert") {
      armAlert("peak");
      return;
    }
    if (action === "arm-clear-alert") {
      armAlert("clear");
      return;
    }
    if (action === "log-event-now") {
      recordObservationEvent(new Date().toISOString());
      return;
    }
    if (action === "log-event-manual") {
      const timestampUtc = parseUtcIso(state.eventDraft.utcIso);
      if (!timestampUtc) {
        window.alert("UTC marker nije validan. Koristi ISO format, npr. 2026-08-12T21:14:08Z");
        return;
      }
      recordObservationEvent(timestampUtc);
      return;
    }
    if (action === "clear-observation-events") {
      clearObservationEvents();
      return;
    }
    if (action === "log-session") {
      logSessionResult();
      return;
    }
    if (action === "clear-session-logs") {
      clearSessionLogs();
      return;
    }
    if (action === "add-current-station") {
      addCurrentAsStation();
      return;
    }
    if (action === "download-fireball-draft") {
      const draft = state.fireballDrafts.find((item) => item.id === target.getAttribute("data-id"));
      if (draft) {
        downloadFile(`meteorops-fireball-${draft.id}.txt`, draft.reportText, "text/plain");
      }
      return;
    }
    if (action === "remove-station") {
      removeStation(target.getAttribute("data-id"));
      return;
    }
    if (action === "export-stations") {
      exportStations();
    }
  });

  if (plannerWorker) {
    plannerWorker.addEventListener("message", handlePlannerMessage);
  }

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      refreshCameraDevices().then(() => {
        renderSkyCameraContent();
      });
    });
  }
}

function registerPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Ignore service worker registration errors in unsupported contexts.
    });
  }
}

hydrateFromHash();
applyLanguage();
applyTheme();
renderShell();
cacheElements();
syncSiteOptions();
syncSensorOptions();
syncControlValues();
renderSiteFootnote();
bindEvents();
persistState();
renderDynamicRegions();
refreshCameraDevices().then(() => {
  renderSkyCameraContent();
});
schedulePlanRefresh(0);
scheduleWeatherRefresh(0);
loadFireballs();
loadTonightBoard();
registerPwa();

window.addEventListener("beforeunload", () => {
  stopCameraStream({ silent: true });
  stopMeteorTrigger({ silent: true });
  stopVoiceLogger();
});
