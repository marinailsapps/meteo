# Changelog

## 1.0.1 — 2026-11-13

- Corrected rights notice: "Copyright (c) 2026 les auteurs de Météo — publié par Maryna SYOMKO, entrepreneur individuel" (LICENSE, README, `app.js`). Release archive renamed `meteo-1.0.1.zip`. No change to the planner itself.

## 1.0.0 — 2026-11-12

First public release.

- Static web app: `index.html`, `app.js`, `app.css`, `i18n.js`. No build step, no dependencies, no external scripts or fonts.
- 16-day forecast table: one row per day, one column per place, weekends highlighted.
- Each day shows the weather icon, rain probability and amount (mm), maximum wind (km/h) and minimum/maximum temperature (°C).
- Cues for frost (min ≤ 0 °C), heat (max ≥ 28 °C), heavy rain (≥ 10 mm) and dry days (0 mm).
- Place search by name (Open-Meteo geocoding, results in the interface language). Unlimited places, removed with ✕, list kept in the browser (`localStorage`).
- All places are fetched in one request; the forecast is cached in the browser and refreshed automatically after one hour, or with the Refresh button. Last update time shown in local format.
- Optional Open-Meteo API key for commercial use: show/hide, test, save (or keep for the current tab only), clear. With a key the app switches to the `customer-*` Open-Meteo hosts.
- Clear messages for rate limits (HTTP 429), refused keys and network errors; the last forecast stays on screen.
- French and English interface, chosen from the browser language, with a toggle; localised day names, dates and numbers.
- Light and dark themes following the system; usable at phone width (the table scrolls sideways, the day column stays visible).
- Content Security Policy that only allows connections to Open-Meteo.
- Open-Meteo and GeoNames attribution (CC BY 4.0) next to the table.
