const jwt = require('jsonwebtoken');
const fs = require('fs');
const axios = require('axios');

const WEATHERKIT_CONDITIONS = {
  Clear: 'Clear',
  Cloudy: 'Cloudy',
  Dust: 'Dusty',
  Fog: 'Foggy',
  Haze: 'Hazy',
  MostlyClear: 'Mostly Clear',
  MostlyCloudy: 'Mostly Cloudy',
  PartlyCloudy: 'Partly Cloudy',
  ScatteredThunderstorms: 'Scattered Storms',
  Smoke: 'Smoky',
  Breezy: 'Breezy',
  Windy: 'Windy',
  Drizzle: 'Drizzle',
  HeavyRain: 'Heavy Rain',
  Rain: 'Rain',
  Showers: 'Showers',
  Flurries: 'Flurries',
  HeavySnow: 'Heavy Snow',
  MixedRainAndSleet: 'Rain/Sleet',
  MixedRainAndSnow: 'Rain/Snow',
  Snow: 'Snow',
  Thunderstorms: 'Thunderstorms',
  Frigid: 'Frigid',
  Hot: 'Hot',
  Hurricane: 'Hurricane',
  TropicalStorm: 'Tropical Storm',
};

function celsiusToFahrenheit(c) {
  return Math.round((c * 9) / 5 + 32);
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function generateWeatherKitJWT() {
  const {
    WEATHERKIT_TEAM_ID,
    WEATHERKIT_SERVICE_ID,
    WEATHERKIT_KEY_ID,
    WEATHERKIT_PRIVATE_KEY_PATH,
  } = process.env;

  const privateKey = fs.readFileSync(WEATHERKIT_PRIVATE_KEY_PATH, 'utf8');

  const token = jwt.sign(
    {
      iss: WEATHERKIT_TEAM_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 60, // 30 min expiry
      sub: WEATHERKIT_SERVICE_ID,
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: {
        alg: 'ES256',
        kid: WEATHERKIT_KEY_ID,
        id: `${WEATHERKIT_TEAM_ID}.${WEATHERKIT_SERVICE_ID}`,
      },
    }
  );

  return token;
}

async function fetchWeatherKit(lat, lon) {
  const token = generateWeatherKitJWT();
  const url = `https://weatherkit.apple.com/api/v1/weather/en/${lat}/${lon}`;

  const res = await axios.get(url, {
    params: {
      dataSets: 'currentWeather,forecastHourly,forecastDaily',
      hourlyStart: new Date().toISOString(),
      hourlyEnd: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const current = res.data.currentWeather;
  const daily = res.data.forecastDaily?.days?.[0];
  const hourlyList = res.data.forecastHourly?.hours?.slice(0, 6) || [];

  const temp = celsiusToFahrenheit(current.temperature);
  const feelsLike = celsiusToFahrenheit(current.temperatureApparent);
  const high = daily ? celsiusToFahrenheit(daily.temperatureMax) : null;
  const low = daily ? celsiusToFahrenheit(daily.temperatureMin) : null;

  const hourly = hourlyList.map((h) => ({
    time: formatTime(h.forecastStart),
    ts: h.forecastStart, // ISO UTC, kept internally for UV backfill; stripped before return
    temp: celsiusToFahrenheit(h.temperature),
    condition: WEATHERKIT_CONDITIONS[h.conditionCode] || h.conditionCode,
    uvIndex: Number.isFinite(h.uvIndex) ? Math.round(h.uvIndex) : null,
  }));

  return {
    temp,
    feelsLike,
    condition: WEATHERKIT_CONDITIONS[current.conditionCode] || current.conditionCode,
    high,
    low,
    humidity: Math.round(current.humidity * 100),
    uvIndex: current.uvIndex,
    sunrise: daily ? formatTime(daily.sunrise) : null,
    sunset: daily ? formatTime(daily.sunset) : null,
    hourly,
    source: 'WeatherKit',
  };
}

const OPENWEATHER_CONDITION_MAP = {
  200: 'Thunderstorms', 201: 'Thunderstorms', 202: 'Thunderstorms',
  210: 'Thunderstorms', 211: 'Thunderstorms', 212: 'Thunderstorms',
  300: 'Drizzle', 301: 'Drizzle', 302: 'Drizzle',
  500: 'Rain', 501: 'Rain', 502: 'Heavy Rain', 503: 'Heavy Rain',
  600: 'Snow', 601: 'Snow', 602: 'Heavy Snow',
  700: 'Foggy', 701: 'Foggy', 711: 'Smoky', 721: 'Hazy', 741: 'Foggy',
  800: 'Clear', 801: 'Mostly Clear', 802: 'Partly Cloudy',
  803: 'Mostly Cloudy', 804: 'Cloudy',
};

async function fetchOpenWeatherMap(lat, lon) {
  const apiKey = process.env.OPENWEATHER_API_KEY;

  const [currentRes, forecastRes] = await Promise.all([
    axios.get('https://api.openweathermap.org/data/2.5/weather', {
      params: { lat, lon, appid: apiKey, units: 'imperial' },
    }),
    axios.get('https://api.openweathermap.org/data/2.5/forecast', {
      params: { lat, lon, appid: apiKey, units: 'imperial', cnt: 8 },
    }),
  ]);

  const current = currentRes.data;
  const forecastItems = forecastRes.data.list || [];

  const conditionCode = current.weather?.[0]?.id;
  const condition = OPENWEATHER_CONDITION_MAP[conditionCode] || current.weather?.[0]?.main || 'Unknown';

  // Today's high/low from forecast
  const todayDate = new Date().toISOString().split('T')[0];
  const todayForecasts = forecastItems.filter((f) =>
    new Date(f.dt * 1000).toISOString().startsWith(todayDate)
  );
  const temps = todayForecasts.map((f) => f.main.temp);
  const high = temps.length ? Math.round(Math.max(...temps)) : null;
  const low = temps.length ? Math.round(Math.min(...temps)) : null;

  const hourly = forecastItems.slice(0, 6).map((f) => ({
    time: formatTime(new Date(f.dt * 1000).toISOString()),
    ts: new Date(f.dt * 1000).toISOString(), // internal, for UV backfill
    temp: Math.round(f.main.temp),
    condition: OPENWEATHER_CONDITION_MAP[f.weather?.[0]?.id] || f.weather?.[0]?.main || 'Unknown',
    uvIndex: null, // basic OWM plan has no UV — backfilled from Open-Meteo below
  }));

  // Sunrise/sunset from current
  const sunrise = formatTime(new Date(current.sys.sunrise * 1000).toISOString());
  const sunset = formatTime(new Date(current.sys.sunset * 1000).toISOString());

  return {
    temp: Math.round(current.main.temp),
    feelsLike: Math.round(current.main.feels_like),
    condition,
    high,
    low,
    humidity: current.main.humidity,
    uvIndex: null, // Not available in basic OWM plan
    sunrise,
    sunset,
    hourly,
    source: 'OpenWeatherMap',
  };
}

/** Current + hourly UV index from Open-Meteo (free, no API key). Used as a
 *  fallback when the primary provider doesn't return UV (e.g. OpenWeatherMap's
 *  basic plan). Returns { current: int|null, hourly: Map<'YYYY-MM-DDTHH', int> }
 *  keyed by UTC hour so callers can backfill per-hour by matching timestamps. */
async function fetchOpenMeteoUv(lat, lon) {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      // GMT (UTC) so hourly.time aligns with the providers' UTC timestamps.
      params: { latitude: lat, longitude: lon, current: 'uv_index', hourly: 'uv_index', forecast_days: 2, timezone: 'GMT' },
      timeout: 5000,
    });
    const cur = res.data?.current?.uv_index;
    const times = res.data?.hourly?.time || [];
    const vals = res.data?.hourly?.uv_index || [];
    const hourly = new Map();
    for (let i = 0; i < times.length; i++) {
      if (Number.isFinite(vals[i])) hourly.set(String(times[i]).slice(0, 13), Math.round(vals[i]));
    }
    return { current: Number.isFinite(cur) ? Math.round(cur) : null, hourly };
  } catch (err) {
    console.warn('Open-Meteo UV lookup failed:', err.message);
    return { current: null, hourly: new Map() };
  }
}

function hasWeatherKitCredentials() {
  const { WEATHERKIT_TEAM_ID, WEATHERKIT_SERVICE_ID, WEATHERKIT_KEY_ID, WEATHERKIT_PRIVATE_KEY_PATH } =
    process.env;
  return !!(WEATHERKIT_TEAM_ID && WEATHERKIT_SERVICE_ID && WEATHERKIT_KEY_ID && WEATHERKIT_PRIVATE_KEY_PATH);
}

async function fetchWeather() {
  const lat = process.env.WEATHER_LAT;
  const lon = process.env.WEATHER_LON;

  if (!lat || !lon) {
    throw new Error('WEATHER_LAT and WEATHER_LON must be set in .env');
  }

  let weather = null;
  if (hasWeatherKitCredentials()) {
    try {
      weather = await fetchWeatherKit(lat, lon);
    } catch (err) {
      console.warn('WeatherKit failed, falling back to OpenWeatherMap:', err.message);
    }
  }

  if (!weather) {
    if (process.env.OPENWEATHER_API_KEY) {
      weather = await fetchOpenWeatherMap(lat, lon);
    } else {
      throw new Error('No weather credentials configured. Set WeatherKit or OpenWeatherMap credentials in .env');
    }
  }

  // Backfill UV from Open-Meteo (free, keyless) when the provider didn't supply
  // it — both the current reading and any missing per-hour values.
  const hourly = Array.isArray(weather.hourly) ? weather.hourly : [];
  const needHourlyUv = hourly.some((h) => h.uvIndex == null && h.ts);
  if (weather.uvIndex == null || needHourlyUv) {
    const uv = await fetchOpenMeteoUv(lat, lon);
    if (weather.uvIndex == null) weather.uvIndex = uv.current;
    if (needHourlyUv) {
      for (const h of hourly) {
        if (h.uvIndex == null && h.ts) {
          const key = h.ts.slice(0, 13); // YYYY-MM-DDTHH (UTC)
          if (uv.hourly.has(key)) h.uvIndex = uv.hourly.get(key);
        }
      }
    }
  }

  // Drop the internal timestamp; the client only needs the display fields.
  weather.hourly = hourly.map(({ ts, ...rest }) => rest);

  return weather;
}

module.exports = { fetchWeather };
