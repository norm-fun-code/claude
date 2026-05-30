// Weather connector: environmental context metrics. Useful later for
// correlations (e.g. mood / energy vs weather). Reuses the weather service.
const { fetchWeather } = require('../services/weather');

module.exports = {
  id: 'weather',
  domain: 'environment',
  displayName: 'Weather',

  async sync() {
    const w = await fetchWeather();
    const now = new Date();
    const m = (metric, value, unit) =>
      value == null
        ? null
        : { ts: now, domain: 'environment', metric, value, unit, source: this.id };

    const metrics = [
      m('temperature', w.temp, 'F'),
      m('feels_like', w.feelsLike, 'F'),
      m('humidity', w.humidity, 'percent'),
      m('uv_index', w.uvIndex, 'index'),
    ].filter(Boolean);

    return { metrics, documents: [] };
  },
};
