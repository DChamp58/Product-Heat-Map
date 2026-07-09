/*
 * localStorage-backed store for companies and UI state.
 *
 * Company shape:
 *   { id, name, address, lat, lng, salesRep, fileName, updatedAt,
 *     years: ['2023', ...], sales: {'I/O': {'2023': 0, ...}, ...},
 *     totals: {'2023': 0, ...} }
 */
(function () {
  'use strict';

  const DATA_KEY = 'product-heat-map:data:v1';
  const UI_KEY = 'product-heat-map:ui:v1';

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function normalizeName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // Strict coordinate check: Number(null) and Number('') coerce to 0, which
  // would silently plot a company at (0, 0) off the coast of Africa.
  function isCoordinate(v) {
    return (
      (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) &&
      Number.isFinite(Number(v))
    );
  }

  function isValidCompany(c) {
    return (
      c &&
      typeof c === 'object' &&
      typeof c.name === 'string' &&
      isCoordinate(c.lat) &&
      isCoordinate(c.lng) &&
      c.sales &&
      typeof c.sales === 'object'
    );
  }

  function load() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.companies;
      if (!Array.isArray(list)) return [];
      return list.filter(isValidCompany).map((c) => ({
        ...c,
        id: c.id || uuid(),
        lat: Number(c.lat),
        lng: Number(c.lng),
      }));
    } catch (err) {
      console.error('Failed to load saved data:', err);
      return [];
    }
  }

  function save(companies) {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify({ version: 1, companies }));
      return true;
    } catch (err) {
      console.error('Failed to save data:', err);
      return false;
    }
  }

  function loadUiState() {
    try {
      return JSON.parse(localStorage.getItem(UI_KEY)) || {};
    } catch (_) {
      return {};
    }
  }

  function saveUiState(state) {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(state));
    } catch (_) {
      /* non-fatal */
    }
  }

  window.HeatMapStore = {
    uuid,
    normalizeName,
    isValidCompany,
    load,
    save,
    loadUiState,
    saveUiState,
  };
})();
