import { readCachedValue, round, writeCachedValue } from "./utils.js";

const WEATHER_TTL_MS = 15 * 60 * 1000;

function weatherCacheKey(lat, lon) {
  return `meteorops.weather.v2.${round(lat, 3)}.${round(lon, 3)}`;
}

function serializeWeather(weather) {
  return {
    timezone: weather.timezone,
    hourly: weather.hourly.map((entry) => ({
      ...entry,
      time: entry.time.toISOString()
    }))
  };
}

function deserializeWeather(payload) {
  return {
    timezone: payload.timezone,
    hourly: payload.hourly.map((entry) => ({
      ...entry,
      time: new Date(entry.time)
    }))
  };
}

export async function fetchWeather(lat, lon, { signal } = {}) {
  const cacheKey = weatherCacheKey(lat, lon);
  const cached = readCachedValue(cacheKey, WEATHER_TTL_MS);
  if (cached) {
    return deserializeWeather(cached);
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "hourly",
    [
      "temperature_2m",
      "cloud_cover",
      "cloud_cover_low",
      "precipitation_probability",
      "visibility",
      "wind_speed_10m"
    ].join(",")
  );
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.status}`);
  }

  const payload = await response.json();
  const weather = {
    timezone: payload.timezone,
    hourly: payload.hourly.time.map((time, index) => ({
      time: new Date(time),
      temperatureC: payload.hourly.temperature_2m[index],
      cloudCover: payload.hourly.cloud_cover[index],
      lowCloudCover: payload.hourly.cloud_cover_low[index],
      precipitationProbability: payload.hourly.precipitation_probability[index],
      visibilityKm: payload.hourly.visibility[index] / 1000,
      windKph: payload.hourly.wind_speed_10m[index]
    }))
  };

  writeCachedValue(cacheKey, serializeWeather(weather));
  return weather;
}

export function summarizeWeather(weather, start, end) {
  if (!weather) {
    return null;
  }

  const window = weather.hourly.filter((entry) => entry.time >= start && entry.time <= end);
  if (!window.length) {
    return null;
  }

  const average = (field) =>
    window.reduce((sum, item) => sum + item[field], 0) / Math.max(window.length, 1);

  return {
    avgCloud: average("cloudCover"),
    avgLowCloud: average("lowCloudCover"),
    avgVisibilityKm: average("visibilityKm"),
    avgWindKph: average("windKph"),
    avgTemperatureC: average("temperatureC"),
    rainRisk: average("precipitationProbability")
  };
}
