import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENWEATHER_API_KEY;


//HELPER FUNCTION --------
// Kelvin -> Celsius
const K2C = k => +(k - 273.15).toFixed(1);

// group 3-hour slots by YYYY-MM-DD and summarize
function summarizeThreeDays(list) {
  const byDay = {};
  for (const item of list) {
    const dateKey = new Date(item.dt * 1000).toISOString().slice(0, 10);
    byDay[dateKey] ||= { temps: [], wind: [], rain: 0 };
    byDay[dateKey].temps.push(item.main?.temp);
    byDay[dateKey].wind.push(item.wind?.speed ?? 0);
    byDay[dateKey].rain += item.rain?.["3h"] ?? 0;
  }

  const sortedDays = Object.keys(byDay).sort();
  const next3 = sortedDays.slice(0, 3);

  return next3.map(d => {
    const box = byDay[d];
    const avgK = box.temps.reduce((a,b)=>a+b,0) / box.temps.length;
    return {
      day: d,
      temp_avg_c: K2C(avgK),
      wind_max_ms: +Math.max(...box.wind).toFixed(1),
      rain_mm: +box.rain.toFixed(1)
    };
  });
}
// provide packing advice based on summaries
function packingAdvice(summaries) {
  const umbrella = summaries.some(d => (d.rain_mm || 0) > 0);
  const mean = summaries.reduce((s,d)=>s + d.temp_avg_c, 0) / summaries.length;
  const packing = mean < 8 ? "Cold" : mean <= 24 ? "Mild" : "Hot";
  return { umbrella, packing, mean_temp_c: +mean.toFixed(1) };
}

const GOOD_THRESHOLDS = {
  pm2_5: 12,
  pm10: 54,
  no2: 53,
  so2: 35,
  o3: 70,
  co: 4400
};

// analyze pollution components and build alerts
function buildPollutionAlerts(components) {
  if (!components) return [];
  const risks = {
    pm2_5: "Fine particles can penetrate deep into lungs; sensitive groups at risk.",
    pm10:  "Coarse particles may irritate airways; sensitive people may feel effects.",
    no2:   "Can irritate airways; people with asthma are at greater risk.",
    so2:   "May cause respiratory symptoms; consider limiting prolonged exertion.",
    o3:    "Can cause throat irritation and coughing; reduce outdoor exertion.",
    co:    "High levels reduce oxygen delivery; headache and fatigue possible."
  };

  const alerts = [];
  for (const key of Object.keys(GOOD_THRESHOLDS)) {
    const val = components[key];
    if (typeof val === "number" && val > GOOD_THRESHOLDS[key]) {
      const over = +(val - GOOD_THRESHOLDS[key]).toFixed(1);
      const pct = +((val / GOOD_THRESHOLDS[key]) * 100).toFixed(0);
      alerts.push({
        pollutant: key.toUpperCase().replace("_",""),
        value: +val.toFixed(1),
        good_max: GOOD_THRESHOLDS[key],
        elevation: `${over} µg/m³ (~${pct}% of 'Good' max)`,
        risk: risks[key]
      });
    }
  }
  return alerts;
}

function nextNDatesUTC(n) {
  const out = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// One Call 3.0: day_summary for a single date (metric => °C, m/s from API)
async function fetchDaySummaryOnce(lat, lon, dateStr) {
  const url = "https://api.openweathermap.org/data/3.0/onecall/day_summary";
  const params = { lat, lon, date: dateStr, units: "metric", appid: API_KEY };
  return await httpGet(url, params); // uses your existing httpGet(…)
}

// Normalize a day_summary payload to your app's shape
function normalizeDaySummary(dateStr, raw) {
  const tempAvg =
    raw?.temperature?.day ??
    raw?.temperature?.average ??
    ((raw?.temperature?.min + raw?.temperature?.max) / 2) ??
    null;

  const windMax =
    raw?.wind?.max?.speed ??
    raw?.wind?.max_speed ??
    raw?.wind_speed_max ??
    raw?.wind_speed ??
    0;

  const rainTotal =
    raw?.precipitation?.total ??
    raw?.rain?.total ??
    raw?.rain ??
    0;

  return {
    day: dateStr,
    temp_avg_c: tempAvg != null ? +Number(tempAvg).toFixed(1) : null,
    wind_max_ms: +Number(windMax || 0).toFixed(1),
    rain_mm: +Number(rainTotal || 0).toFixed(1),
  };
}

// EXPOSED ENDPOINTS --------------------------------------------------------------------
// --------------------------------------------------------------------------------------
// simple health
app.get("/", (req, res) => {
  res.send("OK: server running. Try /owm/geocode?city=Dublin");
});

/**
 * Return RAW geocoding data from OpenWeather.
 * Example: GET /owm/geocode?city=Dublin
 */
app.get("/owm/geocode", async (req, res) => {
  const city = (req.query.city || "").toString().trim();
  if (!city) return res.status(400).json({ error: "Missing ?city" });
  if (!API_KEY) return res.status(500).json({ error: "Missing OPENWEATHER_API_KEY" });

  try {
    const url = "https://api.openweathermap.org/geo/1.0/direct";
    const params = { q: city, limit: 1, appid: API_KEY };

    const resp = await axios.get(url, { params });
    // Log to server console so you can see what comes back
    console.log("[geocode] status:", resp.status, "data:", resp.data);
    // Return RAW data directly
    res.json(resp.data);
  } catch (e) {
    if (e.response) {
      console.error("[geocode] error:", e.response.status, e.response.data);
      return res.status(e.response.status).json(e.response.data);
    }
    console.error("[geocode] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Return RAW forecast data (by city).
 * We first geocode the city to lat/lon, then call forecast and return RAW result.
 * Example: GET /owm/forecast?city=Dublin
 */
app.get("/owm/forecast", async (req, res) => {
  const city = (req.query.city || "").toString().trim();
  if (!city) return res.status(400).json({ error: "Missing ?city" });
  if (!API_KEY) return res.status(500).json({ error: "Missing OPENWEATHER_API_KEY" });

  try {
    // 1) geocode
    const geoURL = "https://api.openweathermap.org/geo/1.0/direct";
    const geoResp = await axios.get(geoURL, { params: { q: city, limit: 1, appid: API_KEY } });
    if (!geoResp.data?.length) return res.status(404).json({ error: "City not found" });
    const { lat, lon } = geoResp.data[0];

    // 2) forecast
    const fcURL = "https://api.openweathermap.org/data/2.5/forecast";
    const fcResp = await axios.get(fcURL, { params: { lat, lon, appid: API_KEY } });

    console.log("[forecast] status:", fcResp.status, "cnt:", fcResp.data?.cnt);
    res.json(fcResp.data); // RAW forecast (list of 3-hour slots)
  } catch (e) {
    if (e.response) {
      console.error("[forecast] error:", e.response.status, e.response.data);
      return res.status(e.response.status).json(e.response.data);
    }
    console.error("[forecast] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/*
    * Return RAW forecast data (by city).
    * We first geocode the city to lat/lon, then call forecast and return RAW result.
    * Example: GET /owm/forecast?city=Dublin
*/

app.get("/owm/forecast", async (req, res) => {
  const city = (req.query.city || "").toString().trim();
  if (!city) return res.status(400).json({ error: "Missing ?city" });

  try {
    // 1) geocode
    const geo = await axios.get("https://api.openweathermap.org/geo/1.0/direct", {
      params: { q: city, limit: 1, appid: process.env.OPENWEATHER_API_KEY }
    });
    if (!geo.data?.length) return res.status(404).json({ error: "City not found" });
    const { lat, lon } = geo.data[0];

    // 2) forecast
    const fc = await axios.get("https://api.openweathermap.org/data/2.5/forecast", {
      params: { lat, lon, appid: process.env.OPENWEATHER_API_KEY }
    });

    console.log("[forecast] cnt:", fc.data?.cnt, "first:", fc.data?.list?.[0]?.dt_txt);
    res.json(fc.data); // raw
  } catch (e) {
    const resp = e.response;
    res.status(resp?.status || 500).json(resp?.data || { error: e.message });
  }
});
 
/*
    * Return summarized forecast data (by city).
    * We first geocode the city to lat/lon, then call forecast and return summarized result.
    * Example: GET /api/weather?city=Dublin
*/
app.get("/api/weather", async (req, res) => {
  const city = (req.query.city || "").toString().trim();
  if (!city) return res.status(400).json({ error: "Missing ?city" });

  try {
    // geocode
    const geo = await axios.get("https://api.openweathermap.org/geo/1.0/direct", {
      params: { q: city, limit: 1, appid: process.env.OPENWEATHER_API_KEY }
    });
    if (!geo.data?.length) return res.status(404).json({ error: "City not found" });
    const { lat, lon, name, country } = geo.data[0];

    // forecast
    const fc = await axios.get("https://api.openweathermap.org/data/2.5/forecast", {
      params: { lat, lon, appid: process.env.OPENWEATHER_API_KEY }
    });

    const forecast = summarizeThreeDays(fc.data?.list || []);
    const advice = packingAdvice(forecast);

    res.json({
      city: name,
      country,
      advice,
      forecast
    });
  } catch (e) {
    const resp = e.response;
    res.status(resp?.status || 500).json(resp?.data || { error: e.message });
  }
});

app.get("/owm/air", async (req, res) => {
  try {
    const city = (req.query.city || "").toString().trim();
    if (!city) return res.status(400).json({ error: "Missing ?city=" });

    // geocode
    const geo = await axios.get("https://api.openweathermap.org/geo/1.0/direct", {
      params: { q: city, limit: 1, appid: process.env.OPENWEATHER_API_KEY }
    });
    if (!geo.data?.length) return res.status(404).json({ error: "City not found" });
    const { lat, lon, name, country } = geo.data[0];

    // air pollution (current)
    const air = await axios.get("http://api.openweathermap.org/data/2.5/air_pollution", {
      params: { lat, lon, appid: process.env.OPENWEATHER_API_KEY }
    });

    const comp = air.data?.list?.[0]?.components || null;
    console.log("[air] lat/lon:", lat, lon, "components:", comp);

    return res.json({
      city: name, country, coord: { lat, lon },
      raw: air.data,
      alerts: buildPollutionAlerts(comp)
    });
  } catch (e) {
    const r = e.response;
    console.error("[/owm/air] error:", r?.status, r?.data || e.message);
    res.status(r?.status || 500).json(r?.data || { error: e.message });
  }
});

app.get("/api/day_summary_city", async (req, res) => {
  try {
    const city = (req.query.city || "").toString().trim();
    const date = (req.query.date || "").toString().trim(); // YYYY-MM-DD

    if (!city) return res.status(400).json({ error: "Missing ?city" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Missing or invalid ?date=YYYY-MM-DD" });
    }
    if (!API_KEY) return res.status(500).json({ error: "Missing OPENWEATHER_API_KEY" });

    // 1) Geocode the city -> lat/lon
    const geoResp = await axios.get("https://api.openweathermap.org/geo/1.0/direct", {
      params: { q: city, limit: 1, appid: API_KEY }
    });
    if (!Array.isArray(geoResp.data) || geoResp.data.length === 0) {
      return res.status(404).json({ error: "City not found" });
    }
    const { lat, lon, name, country } = geoResp.data[0];

    // 2) One Call 3.0 day_summary (metric -> °C, m/s)
    const dsResp = await axios.get("https://api.openweathermap.org/data/3.0/onecall/day_summary", {
      params: { lat, lon, date, units: "metric", appid: API_KEY }
    });

    // 3) Normalize the payload to your app shape
    const raw = dsResp.data;

    const tempAvg =
      raw?.temperature?.day ??
      raw?.temperature?.average ??
      ((raw?.temperature?.min + raw?.temperature?.max) / 2) ??
      null;

    const windMax =
      raw?.wind?.max?.speed ??
      raw?.wind?.max_speed ??
      raw?.wind_speed_max ??
      raw?.wind_speed ??
      0;

    const rainTotal =
      raw?.precipitation?.total ??
      raw?.rain?.total ??
      raw?.rain ??
      0;

    const normalized = {
      source: "onecall_day_summary",
      city: name,
      country,
      day: date,
      temp_avg_c: tempAvg != null ? +Number(tempAvg).toFixed(1) : null,
      wind_max_ms: +Number(windMax || 0).toFixed(1),
      rain_mm: +Number(rainTotal || 0).toFixed(1)
    };

    // 4) Optional: quick umbrella/packing on this single day
    const umbrella = normalized.rain_mm > 0;
    const packing = normalized.temp_avg_c == null
      ? "Unknown"
      : (normalized.temp_avg_c < 8 ? "Cold" : (normalized.temp_avg_c <= 24 ? "Mild" : "Hot"));

    return res.json({ ...normalized, umbrella, packing });
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    if (status === 401 || status === 403) {
      return res.status(status).json({
        error: "One Call 3.0 day_summary not available for this API key.",
        details: data || null,
        hint: "Use /api/weather (free /2.5/forecast summariser) or upgrade key."
      });
    }
    return res.status(status || 500).json(data || { error: e.message });
  }
});




app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  console.log("Try: /owm/geocode?city=Dublin and /owm/forecast?city=Dublin");
});
