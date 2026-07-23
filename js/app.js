/* global L, HeatMapParser, HeatMapStore, HeatMapGeocode */
(function () {
  'use strict';

  const { PRODUCT_GROUPS, parseWorkbook, companyNameFromFileName } = HeatMapParser;
  const store = HeatMapStore;
  const geocoder = HeatMapGeocode;

  const ALL_GROUPS = ['All', ...PRODUCT_GROUPS];
  const DEFAULT_YEARS = ['YTD 2026', '2025', '2024', '2023'];

  // Green -> yellow -> red scale: low revenue is green, high revenue is red.
  // The dark ramp uses slightly brighter steps for the dark basemap.
  const HEAT_GRADIENT_LIGHT = {
    0.05: '#0ca30c', 0.25: '#7fb70a', 0.45: '#e3b400',
    0.65: '#f08c00', 0.85: '#e04b26', 1.0: '#c81e1e',
  };
  const HEAT_GRADIENT_DARK = {
    0.05: '#12b512', 0.25: '#8fc70e', 0.45: '#f2c200',
    0.65: '#ff9a1f', 0.85: '#f0552b', 1.0: '#e03131',
  };

  const TILES_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  const TILES_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const TILE_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

  const US_CENTER = [39.5, -96.35];
  const US_ZOOM = 4;

  // Categorical palette for pie slices (reference dataviz palette; fixed
  // order). "Other" is a reserved neutral, never a series color.
  const PIE_COLORS_LIGHT = [
    '#2a78d6', '#1baf7a', '#eda100', '#008300',
    '#4a3aa7', '#e34948', '#e87ba4', '#eb6834',
  ];
  const PIE_COLORS_DARK = [
    '#3987e5', '#199e70', '#c98500', '#008300',
    '#9085e9', '#e66767', '#d55181', '#d95926',
  ];
  const PIE_OTHER_COLOR = '#898781';
  const PIE_MAX_SLICES = 7; // beyond this, remaining companies fold into "Other"

  const fmtUSD = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  const darkMode = window.matchMedia('(prefers-color-scheme: dark)');

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let companies = store.load();
  const uiState = store.loadUiState();
  const state = {
    year: typeof uiState.year === 'string' ? uiState.year : DEFAULT_YEARS[0],
    group: ALL_GROUPS.includes(uiState.group) ? uiState.group : 'All',
  };

  // ------------------------------------------------------------------
  // DOM handles
  // ------------------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const dom = {
    fileInput: el('file-input'),
    btnUpload: el('btn-upload'),
    piePanel: el('pie-panel'),
    pieTitle: el('pie-title'),
    pieSvg: el('pie-svg'),
    pieLegend: el('pie-legend'),
    yearPills: el('year-pills'),
    groupPills: el('group-pills'),
    summary: el('summary'),
    companyList: el('company-list'),
    emptyHint: el('empty-hint'),
    btnExport: el('btn-export'),
    btnImport: el('btn-import'),
    importInput: el('import-input'),
    btnClear: el('btn-clear'),
    overlay: el('modal-overlay'),
    modalProgress: el('modal-progress'),
    modalFile: el('modal-file'),
    modalNote: el('modal-note'),
    modalName: el('modal-name'),
    modalAddress: el('modal-address'),
    modalSearch: el('modal-search'),
    modalResults: el('modal-results'),
    modalError: el('modal-error'),
    modalLocation: el('modal-location'),
    modalPick: el('modal-pick'),
    modalSkip: el('modal-skip'),
    modalSave: el('modal-save'),
    pickBanner: el('pick-banner'),
    pickName: el('pick-name'),
    pickCancel: el('pick-cancel'),
    toast: el('toast'),
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function showToast(msg, ms) {
    dom.toast.textContent = msg;
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (dom.toast.hidden = true), ms || 4000);
  }

  function persist() {
    if (!store.save(companies)) {
      showToast(
        'Warning: could not save to browser storage — this change may be lost on reload. ' +
          'Use Export data to back up.',
        7000
      );
    }
  }

  // ------------------------------------------------------------------
  // Map
  // ------------------------------------------------------------------
  const map = L.map('map', { zoomControl: true }).setView(US_CENTER, US_ZOOM);
  map.attributionControl.setPrefix(false);

  let tileLayer = null;
  // maxZoom here is the zoom at which intensities map 1:1 (leaflet.heat
  // divides intensity by 2^(maxZoom - zoom)); pin it to the default US-wide
  // zoom so heat colors encode relative revenue at the continental view.
  const heatLayer = L.heatLayer([], {
    radius: 55,
    blur: 34,
    maxZoom: US_ZOOM,
    max: 1.0,
    minOpacity: 0.25,
    gradient: darkMode.matches ? HEAT_GRADIENT_DARK : HEAT_GRADIENT_LIGHT,
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function () {
    const div = L.DomUtil.create('div', 'heat-legend');
    div.innerHTML =
      '<div class="heat-legend-title" id="legend-title"></div>' +
      '<div class="heat-legend-bar" id="legend-bar"></div>' +
      '<div class="heat-legend-scale"><span>$0</span><span id="legend-max"></span></div>';
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  legend.addTo(map);

  function gradientCss(gradient) {
    const stops = Object.keys(gradient)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => `${gradient[k]} ${Math.round(k * 100)}%`);
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  function applyTheme() {
    const dark = darkMode.matches;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(dark ? TILES_DARK : TILES_LIGHT, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);
    heatLayer.setOptions({
      gradient: dark ? HEAT_GRADIENT_DARK : HEAT_GRADIENT_LIGHT,
    });
    const bar = el('legend-bar');
    if (bar) {
      bar.style.background = gradientCss(dark ? HEAT_GRADIENT_DARK : HEAT_GRADIENT_LIGHT);
    }
  }

  if (darkMode.addEventListener) {
    darkMode.addEventListener('change', () => {
      applyTheme();
      refresh(); // marker colors follow the theme
    });
  }

  // ------------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------------
  function yearSortValue(year) {
    const m = String(year).match(/^(YTD\s+)?((?:19|20)\d{2})$/i);
    if (!m) return -Infinity;
    return Number(m[2]) + (m[1] ? 0.5 : 0);
  }

  function deriveYears() {
    const set = new Set();
    companies.forEach((c) => (c.years || []).forEach((y) => set.add(y)));
    const years = set.size > 0 ? [...set] : [...DEFAULT_YEARS];
    return years.sort((a, b) => yearSortValue(b) - yearSortValue(a));
  }

  function valueFor(company, group, year) {
    let v;
    if (group === 'All') {
      v = company.totals ? company.totals[year] : undefined;
      if (v === undefined && company.sales) {
        v = PRODUCT_GROUPS.reduce(
          (acc, g) => acc + (Number(company.sales[g] && company.sales[g][year]) || 0),
          0
        );
      }
    } else {
      v = company.sales && company.sales[group] ? company.sales[group][year] : 0;
    }
    v = Number(v);
    return Number.isFinite(v) ? v : 0;
  }

  function findByName(name, excludeId) {
    const norm = store.normalizeName(name);
    if (!norm) return null;
    return (
      companies.find(
        (c) => store.normalizeName(c.name) === norm && c.id !== excludeId
      ) || null
    );
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function renderPills(container, options, active, onSelect) {
    container.innerHTML = '';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill' + (opt === active ? ' active' : '');
      btn.setAttribute('aria-pressed', String(opt === active));
      btn.textContent = opt;
      btn.addEventListener('click', () => onSelect(opt));
      container.appendChild(btn);
    });
  }

  function popupHtml(company) {
    const rows = PRODUCT_GROUPS.map((g) => {
      const cls = state.group === g ? ' class="selected"' : '';
      return (
        `<tr${cls}><td>${escapeHtml(g)}</td>` +
        `<td>${fmtUSD.format(valueFor(company, g, state.year))}</td></tr>`
      );
    }).join('');
    const total =
      `<tr class="total"><td>Total</td>` +
      `<td>${fmtUSD.format(valueFor(company, 'All', state.year))}</td></tr>`;
    const rep = company.salesRep
      ? `<div class="popup-sub">Sales rep: ${escapeHtml(company.salesRep)}</div>`
      : '';
    return (
      `<div class="popup-title">${escapeHtml(company.name)}</div>` +
      `<div class="popup-sub">${escapeHtml(company.address || '')}</div>` +
      rep +
      `<div class="popup-sub">${escapeHtml(state.year)} revenue</div>` +
      `<table class="popup-table">${rows}${total}</table>`
    );
  }

  function refresh() {
    const years = deriveYears();
    if (!years.includes(state.year)) state.year = years[0];
    store.saveUiState({ year: state.year, group: state.group });

    renderPills(dom.yearPills, years, state.year, (y) => {
      state.year = y;
      refresh();
    });
    renderPills(dom.groupPills, ALL_GROUPS, state.group, (g) => {
      state.group = g;
      refresh();
    });

    const entries = companies.map((c) => ({
      company: c,
      value: valueFor(c, state.group, state.year),
    }));
    const positive = entries.filter((e) => e.value > 0);
    const max = positive.length ? Math.max(...positive.map((e) => e.value)) : 0;

    // Heat: intensity relative to the current max, floored so small-but-real
    // revenue is still visible.
    heatLayer.setLatLngs(
      positive.map((e) => [
        e.company.lat,
        e.company.lng,
        Math.max(e.value / max, 0.06),
      ])
    );

    // Markers (anchor points + exact values in popups).
    syncMarkers(entries);

    renderCompanyList(entries);
    renderPie();

    const total = entries.reduce((acc, e) => acc + e.value, 0);
    dom.summary.textContent = companies.length
      ? `${companies.length} · ${fmtUSD.format(total)}`
      : '';
    dom.emptyHint.hidden = companies.length > 0;

    const legendTitle = el('legend-title');
    const legendMax = el('legend-max');
    if (legendTitle) {
      legendTitle.textContent =
        (state.group === 'All' ? 'Total' : state.group) +
        ` revenue — ${state.year}`;
    }
    if (legendMax) legendMax.textContent = max > 0 ? fmtUSD.format(max) : '—';
    const bar = el('legend-bar');
    if (bar && !bar.style.background) {
      bar.style.background = gradientCss(
        darkMode.matches ? HEAT_GRADIENT_DARK : HEAT_GRADIENT_LIGHT
      );
    }
  }

  // Markers persist across refreshes (keyed by company id) so an open popup
  // stays open and just gets fresh content when the year or group changes.
  const markersById = new Map();

  function syncMarkers(entries) {
    const stroke = darkMode.matches ? '#c3c2b7' : '#52514e';
    const fill = darkMode.matches ? '#1a1a19' : '#ffffff';
    const seen = new Set();

    entries.forEach((e) => {
      const c = e.company;
      seen.add(c.id);
      let marker = markersById.get(c.id);
      if (!marker) {
        marker = L.circleMarker([c.lat, c.lng], {
          radius: 5,
          weight: 1.5,
          fillOpacity: 0.9,
        });
        marker.bindPopup('');
        marker.bindTooltip('', { direction: 'top', offset: [0, -6] });
        marker.addTo(markerLayer);
        markersById.set(c.id, marker);
      }
      marker.setLatLng([c.lat, c.lng]);
      marker.setStyle({ color: stroke, fillColor: fill });
      marker.setPopupContent(popupHtml(c));
      // Tooltip content is interpreted as HTML by Leaflet — escape it.
      marker.setTooltipContent(escapeHtml(c.name));
    });

    for (const [id, marker] of markersById) {
      if (!seen.has(id)) {
        markerLayer.removeLayer(marker);
        markersById.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------
  // Pie chart (share of revenue for the current selection)
  // ------------------------------------------------------------------
  const fmtCompact = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // With a specific product group selected, slices are companies (their share
  // of that group's revenue). With "All" selected, slices are the product
  // groups themselves, keeping each group's fixed palette slot.
  function pieSlices() {
    const palette = darkMode.matches ? PIE_COLORS_DARK : PIE_COLORS_LIGHT;
    if (state.group === 'All') {
      return PRODUCT_GROUPS.map((g, i) => ({
        name: g,
        value: companies.reduce(
          (acc, c) => acc + Math.max(valueFor(c, g, state.year), 0),
          0
        ),
        color: palette[i],
      }))
        .filter((s) => s.value > 0)
        .sort((a, b) => b.value - a.value);
    }
    const shares = companies
      .map((c) => ({
        name: c.name,
        value: Math.max(valueFor(c, state.group, state.year), 0),
      }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
    const top = shares
      .slice(0, PIE_MAX_SLICES)
      .map((s, i) => ({ ...s, color: palette[i] }));
    const rest = shares.slice(PIE_MAX_SLICES);
    if (rest.length > 0) {
      top.push({
        name: `Other (${rest.length})`,
        value: rest.reduce((acc, s) => acc + s.value, 0),
        color: PIE_OTHER_COLOR,
      });
    }
    return top;
  }

  // Annular sector path from angle a0 to a1 (radians).
  function arcPath(cx, cy, r0, r1, a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    return (
      `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} ` +
      `L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
    );
  }

  function renderPie() {
    const slices = pieSlices();
    const total = slices.reduce((acc, s) => acc + s.value, 0);
    if (slices.length === 0 || total <= 0) {
      dom.piePanel.hidden = true;
      return;
    }
    dom.piePanel.hidden = false;

    dom.pieTitle.textContent =
      state.group === 'All'
        ? `Revenue by product group — ${state.year}`
        : `${state.group} revenue by company — ${state.year}`;

    const CX = 70;
    const CY = 70;
    const R_OUT = 62;
    const R_IN = 36;
    const surface = getComputedStyle(document.body).backgroundColor;

    dom.pieSvg.innerHTML = '';
    let angle = -Math.PI / 2;
    slices.forEach((s) => {
      const frac = s.value / total;
      const pct = (frac * 100).toFixed(frac < 0.1 ? 1 : 0) + '%';
      let shape;
      if (frac > 0.9995) {
        // A single 100% slice: an arc path degenerates, draw a full ring.
        shape = document.createElementNS(SVG_NS, 'circle');
        shape.setAttribute('cx', CX);
        shape.setAttribute('cy', CY);
        shape.setAttribute('r', (R_OUT + R_IN) / 2);
        shape.setAttribute('fill', 'none');
        shape.setAttribute('stroke', s.color);
        shape.setAttribute('stroke-width', R_OUT - R_IN);
      } else {
        const next = angle + frac * 2 * Math.PI;
        shape = document.createElementNS(SVG_NS, 'path');
        shape.setAttribute('d', arcPath(CX, CY, R_IN, R_OUT, angle, next));
        shape.setAttribute('fill', s.color);
        // 2px surface gap between adjacent fills
        shape.setAttribute('stroke', surface);
        shape.setAttribute('stroke-width', '1');
        angle = next;
      }
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${s.name} — ${fmtUSD.format(s.value)} (${pct})`;
      shape.appendChild(title);
      dom.pieSvg.appendChild(shape);
      s.pct = pct;
    });

    const centerValue = document.createElementNS(SVG_NS, 'text');
    centerValue.setAttribute('x', CX);
    centerValue.setAttribute('y', CY + 1);
    centerValue.setAttribute('text-anchor', 'middle');
    centerValue.setAttribute('class', 'pie-center-value');
    centerValue.textContent = fmtCompact.format(total);
    dom.pieSvg.appendChild(centerValue);

    const centerLabel = document.createElementNS(SVG_NS, 'text');
    centerLabel.setAttribute('x', CX);
    centerLabel.setAttribute('y', CY + 13);
    centerLabel.setAttribute('text-anchor', 'middle');
    centerLabel.setAttribute('class', 'pie-center-label');
    centerLabel.textContent = 'total';
    dom.pieSvg.appendChild(centerLabel);

    dom.pieLegend.innerHTML = '';
    slices.forEach((s) => {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'pie-swatch';
      swatch.style.background = s.color;
      const name = document.createElement('span');
      name.className = 'pie-name';
      name.textContent = s.name;
      name.title = s.name;
      const value = document.createElement('span');
      value.className = 'pie-value';
      value.textContent = fmtCompact.format(s.value);
      const pct = document.createElement('span');
      pct.className = 'pie-pct';
      pct.textContent = s.pct;
      li.append(swatch, name, value, pct);
      dom.pieLegend.appendChild(li);
    });
  }

  function renderCompanyList(entries) {
    dom.companyList.innerHTML = '';
    [...entries]
      .sort((a, b) => b.value - a.value || a.company.name.localeCompare(b.company.name))
      .forEach((e) => {
        const li = document.createElement('li');
        li.className = 'company-item';

        const info = document.createElement('div');
        info.className = 'company-info';
        info.title = 'Show on map';
        info.innerHTML =
          `<div class="company-name">${escapeHtml(e.company.name)}</div>` +
          `<div class="company-address">${escapeHtml(e.company.address || '')}</div>`;
        info.addEventListener('click', () => focusCompany(e.company));

        const value = document.createElement('span');
        value.className = 'company-value';
        value.textContent = fmtUSD.format(e.value);

        const editBtn = document.createElement('button');
        editBtn.className = 'icon-btn';
        editBtn.title = 'Edit name / address';
        editBtn.setAttribute('aria-label', `Edit ${e.company.name}`);
        editBtn.textContent = '✎';
        editBtn.addEventListener('click', () => openEditModal(e.company));

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn danger';
        delBtn.title = 'Remove company';
        delBtn.setAttribute('aria-label', `Remove ${e.company.name}`);
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', () => {
          if (!window.confirm(`Remove "${e.company.name}" from the map?`)) return;
          companies = companies.filter((c) => c.id !== e.company.id);
          persist();
          refresh();
        });

        li.append(info, value, editBtn, delBtn);
        dom.companyList.appendChild(li);
      });
  }

  function focusCompany(company) {
    map.setView([company.lat, company.lng], Math.max(map.getZoom(), 8));
    const marker = markersById.get(company.id);
    if (marker) marker.openPopup();
  }

  function fitToCompanies() {
    if (companies.length === 0) return;
    const bounds = L.latLngBounds(companies.map((c) => [c.lat, c.lng]));
    map.fitBounds(bounds.pad(0.25), { maxZoom: 7 });
  }

  // ------------------------------------------------------------------
  // Modal (address prompt for imports; edit for existing companies)
  // ------------------------------------------------------------------
  const modal = {
    queue: [], // pending imports: {fileName, parsed, suggestedName}
    index: 0,
    mode: null, // 'import' | 'edit'
    editing: null, // company being edited
    location: null, // {lat, lng, label}
    locationSource: null, // 'user' (search/pick) | 'adopted' (from name match)
    adoptedFromId: null,
    adoptedAddress: '',
    addedCount: 0,
    updatedCount: 0,
    searchToken: 0, // invalidates in-flight geocode results on modal changes
  };

  // A double-click's second click lands on the next queued file's modal (it
  // opens synchronously under the cursor). Ignore Save/Skip in the first
  // instant after a modal opens — real interaction always takes longer.
  function modalActionAllowed() {
    return Date.now() - (modal.openedAt || 0) > 200;
  }

  function setModalLocation(loc, source) {
    modal.location = loc;
    modal.locationSource = loc ? source || 'user' : null;
    if (loc) {
      dom.modalLocation.textContent = loc.label || `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
      dom.modalLocation.classList.add('set');
    } else {
      dom.modalLocation.textContent = 'No location set yet';
      dom.modalLocation.classList.remove('set');
    }
    dom.modalSave.disabled = !loc;
  }

  function setModalError(msg) {
    dom.modalError.textContent = msg || '';
    dom.modalError.hidden = !msg;
  }

  function clearModalResults() {
    dom.modalResults.innerHTML = '';
    dom.modalResults.hidden = true;
  }

  function adoptLocationFrom(existing) {
    if (!dom.modalAddress.value || dom.modalAddress.value === modal.adoptedAddress) {
      dom.modalAddress.value = existing.address || '';
    }
    modal.adoptedFromId = existing.id;
    modal.adoptedAddress = existing.address || '';
    setModalLocation(
      {
        lat: existing.lat,
        lng: existing.lng,
        label: existing.address || `${existing.lat.toFixed(4)}, ${existing.lng.toFixed(4)}`,
      },
      'adopted'
    );
  }

  function updateExistingNote() {
    if (modal.mode !== 'import') {
      dom.modalNote.hidden = true;
      return;
    }
    const existing = findByName(dom.modalName.value);
    if (existing) {
      dom.modalNote.textContent =
        `A company named “${existing.name}” already exists — saving will update ` +
        'its sales data with this file.';
      dom.modalNote.hidden = false;
      // Adopt its saved location unless the user chose one themselves; if a
      // previously adopted location belongs to a different company, re-adopt.
      if (!modal.location) {
        adoptLocationFrom(existing);
      } else if (
        modal.locationSource === 'adopted' &&
        modal.adoptedFromId !== existing.id
      ) {
        adoptLocationFrom(existing);
      }
    } else {
      dom.modalNote.hidden = true;
      // The name no longer matches the company whose location we adopted —
      // editing the name must not silently keep the wrong coordinates.
      if (modal.locationSource === 'adopted') {
        if (dom.modalAddress.value === modal.adoptedAddress) dom.modalAddress.value = '';
        modal.adoptedFromId = null;
        modal.adoptedAddress = '';
        setModalLocation(null);
      }
    }
  }

  function openImportModal() {
    const item = modal.queue[modal.index];
    if (!item) return;
    modal.mode = 'import';
    modal.editing = null;
    modal.adoptedFromId = null;
    modal.adoptedAddress = '';
    modal.searchToken++;
    modal.openedAt = Date.now();

    dom.modalProgress.textContent =
      modal.queue.length > 1 ? `File ${modal.index + 1} of ${modal.queue.length}` : '';
    dom.modalFile.textContent = item.fileName;
    dom.modalName.value = item.suggestedName;
    dom.modalAddress.value = '';
    dom.modalSkip.textContent = 'Skip this file';
    setModalError('');
    clearModalResults();
    setModalLocation(null);
    updateExistingNote();

    dom.overlay.hidden = false;
    dom.modalName.focus();
    dom.modalName.select();
  }

  function openEditModal(company) {
    modal.mode = 'edit';
    modal.editing = company;
    modal.adoptedFromId = null;
    modal.adoptedAddress = '';
    modal.searchToken++;
    modal.openedAt = Date.now();

    dom.modalProgress.textContent = '';
    dom.modalFile.textContent = company.fileName ? `From ${company.fileName}` : '';
    dom.modalName.value = company.name;
    dom.modalAddress.value = company.address || '';
    dom.modalSkip.textContent = 'Cancel';
    dom.modalNote.hidden = true;
    setModalError('');
    clearModalResults();
    setModalLocation({
      lat: company.lat,
      lng: company.lng,
      label: company.address || `${company.lat.toFixed(4)}, ${company.lng.toFixed(4)}`,
    });

    dom.overlay.hidden = false;
    dom.modalName.focus();
  }

  function closeModal() {
    dom.overlay.hidden = true;
    modal.mode = null;
    modal.editing = null;
    modal.searchToken++;
  }

  function advanceImportQueue() {
    modal.index += 1;
    if (modal.index < modal.queue.length) {
      openImportModal();
    } else {
      const { addedCount, updatedCount } = modal;
      closeModal();
      if (addedCount + updatedCount > 0) {
        const parts = [];
        if (addedCount > 0) {
          parts.push(`Added ${addedCount} ${addedCount === 1 ? 'company' : 'companies'}`);
        }
        if (updatedCount > 0) parts.push(`updated ${updatedCount}`);
        showToast(`${parts.join(' · ')} on the map.`);
        fitToCompanies();
      }
      modal.queue = [];
      modal.index = 0;
      modal.addedCount = 0;
      modal.updatedCount = 0;
    }
  }

  async function runSearch() {
    const q = dom.modalAddress.value.trim();
    if (!q) {
      setModalError('Enter an address (or “lat, lng”) to search.');
      return;
    }
    setModalError('');
    clearModalResults();
    dom.modalSearch.disabled = true;
    dom.modalSearch.textContent = 'Searching…';
    const token = modal.searchToken;
    try {
      const results = await geocoder.geocode(q);
      // The modal may have moved on to another company (or closed) while the
      // lookup was in flight — never apply a stale result.
      if (token !== modal.searchToken || dom.overlay.hidden) return;
      if (results.length === 0) {
        setModalError(
          'No matches found. Try adding city and state, enter “lat, lng”, or use Pick on map.'
        );
      } else if (results.length === 1) {
        setModalLocation(results[0]);
      } else {
        results.forEach((r) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'geo-result';
          btn.textContent = r.label;
          btn.addEventListener('click', () => {
            setModalLocation(r);
            clearModalResults();
          });
          dom.modalResults.appendChild(btn);
        });
        dom.modalResults.hidden = false;
      }
    } catch (err) {
      console.error('Geocoding failed:', err);
      if (token === modal.searchToken && !dom.overlay.hidden) {
        setModalError(
          'Could not reach the address lookup service. Enter coordinates directly ' +
            '(“lat, lng”) or use Pick on map.'
        );
      }
    } finally {
      dom.modalSearch.disabled = false;
      dom.modalSearch.textContent = 'Search';
    }
  }

  function saveModal() {
    if (!modalActionAllowed()) return;
    const name = dom.modalName.value.trim();
    if (!name) {
      setModalError('Company name is required.');
      dom.modalName.focus();
      return;
    }
    if (!modal.location) {
      setModalError('Set a location first — search the address or use Pick on map.');
      return;
    }
    const address = dom.modalAddress.value.trim();
    const { lat, lng } = modal.location;

    if (modal.mode === 'edit') {
      const c = modal.editing;
      const dup = findByName(name, c.id);
      if (dup) {
        setModalError(`Another company is already named “${dup.name}”.`);
        return;
      }
      Object.assign(c, { name, address, lat, lng, updatedAt: new Date().toISOString() });
      persist();
      closeModal();
      refresh();
      return;
    }

    // Import mode: update the matching company or create a new one.
    const item = modal.queue[modal.index];
    const existing = findByName(name);
    const base = existing || {
      id: store.uuid(),
    };
    Object.assign(base, {
      name,
      address,
      lat,
      lng,
      salesRep: item.parsed.salesRep || (existing && existing.salesRep) || '',
      fileName: item.fileName,
      years: item.parsed.years,
      sales: item.parsed.sales,
      totals: item.parsed.totals,
      updatedAt: new Date().toISOString(),
    });
    if (!existing) companies.push(base);
    persist();
    if (existing) modal.updatedCount++;
    else modal.addedCount++;
    refresh();
    advanceImportQueue();
  }

  // Pick-on-map flow -------------------------------------------------
  let picking = false;

  function startPick() {
    picking = true;
    dom.overlay.hidden = true;
    dom.pickName.textContent = dom.modalName.value.trim() || 'this company';
    dom.pickBanner.hidden = false;
    document.getElementById('map').classList.add('picking');
    // The modal is parked, not closed — block the sidebar so uploads/edits
    // can't stomp the in-progress modal state.
    document.body.classList.add('picking-session');
  }

  function endPick(latlng) {
    picking = false;
    dom.pickBanner.hidden = true;
    document.getElementById('map').classList.remove('picking');
    document.body.classList.remove('picking-session');
    dom.overlay.hidden = false;
    if (latlng) {
      const ll = latlng.wrap ? latlng.wrap() : latlng; // normalize world copies
      setModalLocation({
        lat: ll.lat,
        lng: ll.lng,
        label: `Map point ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}`,
      });
      setModalError('');
    }
  }

  map.on('click', (ev) => {
    if (picking) endPick(ev.latlng);
  });

  // ------------------------------------------------------------------
  // File intake
  // ------------------------------------------------------------------
  async function handleFiles(fileList) {
    const files = [...fileList];
    if (files.length === 0) return;

    const queue = [];
    const failures = [];
    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseWorkbook(buffer);
        queue.push({
          fileName: file.name,
          parsed,
          suggestedName: companyNameFromFileName(file.name),
        });
      } catch (err) {
        console.error(`Failed to parse ${file.name}:`, err);
        failures.push(`${file.name}: ${err.message}`);
      }
    }

    if (failures.length > 0) {
      showToast(`Could not read ${failures.length} file(s) — ${failures[0]}`, 6000);
    }
    if (queue.length > 0) {
      modal.queue = queue;
      modal.index = 0;
      modal.savedCount = 0;
      openImportModal();
    }
  }

  // ------------------------------------------------------------------
  // Export / import / clear
  // ------------------------------------------------------------------
  function exportData() {
    if (companies.length === 0) {
      showToast('Nothing to export yet.');
      return;
    }
    const blob = new Blob(
      [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), companies }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'product-heat-map-data.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importData(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const list = Array.isArray(parsed) ? parsed : parsed.companies;
      if (!Array.isArray(list)) throw new Error('not a data export');
      const valid = list.filter(store.isValidCompany);
      if (valid.length === 0) throw new Error('no valid companies in file');
      if (
        companies.length > 0 &&
        !window.confirm(
          `Replace the current ${companies.length} companies with the ` +
            `${valid.length} from this file?`
        )
      ) {
        return;
      }
      companies = valid.map((c) => ({
        ...c,
        id: c.id || store.uuid(),
        lat: Number(c.lat),
        lng: Number(c.lng),
      }));
      persist();
      refresh();
      fitToCompanies();
      showToast(`Imported ${valid.length} companies.`);
    } catch (err) {
      console.error('Import failed:', err);
      showToast(`Import failed — ${err.message}.`, 6000);
    }
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    handleFiles(dom.fileInput.files);
    dom.fileInput.value = '';
  });

  dom.modalSearch.addEventListener('click', runSearch);
  dom.modalAddress.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      runSearch();
    }
  });
  dom.modalName.addEventListener('input', updateExistingNote);
  dom.modalPick.addEventListener('click', startPick);
  dom.pickCancel.addEventListener('click', () => endPick(null));
  dom.modalSave.addEventListener('click', saveModal);
  dom.modalSkip.addEventListener('click', () => {
    if (!modalActionAllowed()) return;
    if (modal.mode === 'import') {
      advanceImportQueue();
    } else {
      closeModal();
    }
  });

  dom.btnExport.addEventListener('click', exportData);
  dom.btnImport.addEventListener('click', () => dom.importInput.click());
  dom.importInput.addEventListener('change', () => {
    if (dom.importInput.files[0]) importData(dom.importInput.files[0]);
    dom.importInput.value = '';
  });
  dom.btnClear.addEventListener('click', () => {
    if (companies.length === 0) return;
    if (!window.confirm(`Remove all ${companies.length} companies from the map?`)) return;
    companies = [];
    persist();
    refresh();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (picking) endPick(null);
      else if (!dom.overlay.hidden && modal.mode === 'edit') closeModal();
      return;
    }
    // Keep Tab focus inside the modal while it is open.
    if (ev.key === 'Tab' && !dom.overlay.hidden) {
      const focusables = [...dom.overlay.querySelectorAll('button:not(:disabled), input')]
        .filter((node) => node.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!dom.overlay.contains(document.activeElement)) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  applyTheme();
  refresh();
  fitToCompanies();
})();
