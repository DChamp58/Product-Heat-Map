/*
 * Address lookup via OpenStreetMap Nominatim (no API key required).
 * Also accepts direct "lat, lng" input, e.g. "32.08, -81.09".
 */
(function () {
  'use strict';

  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

  function parseLatLng(text) {
    const m = String(text || '').match(
      /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/
    );
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng, label: `Coordinates ${lat.toFixed(4)}, ${lng.toFixed(4)}` };
  }

  async function queryNominatim(q, usOnly) {
    const params = new URLSearchParams({
      format: 'jsonv2',
      limit: '5',
      addressdetails: '0',
      q,
    });
    if (usOnly) params.set('countrycodes', 'us');
    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Address service returned ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .map((r) => ({
        lat: Number(r.lat),
        lng: Number(r.lon),
        label: r.display_name || q,
      }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  }

  /**
   * Resolve an address string to candidate locations
   * [{lat, lng, label}, ...]. Direct "lat, lng" input short-circuits the
   * network. US-biased first, worldwide as a fallback.
   */
  async function geocode(text) {
    const direct = parseLatLng(text);
    if (direct) return [direct];

    const q = String(text || '').trim();
    if (!q) return [];

    const usResults = await queryNominatim(q, true);
    if (usResults.length > 0) return usResults;
    // Worldwide fallback — spaced out to respect Nominatim's 1 req/s policy.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return queryNominatim(q, false);
  }

  window.HeatMapGeocode = { geocode, parseLatLng };
})();
