/* global XLSX */
/*
 * Excel parsing for the standard company sales workbook.
 *
 * Expected workbook layout (see ProductMapFormat.xlsx):
 *   Sheet "BUItem1":
 *     row 1: | (blank) | 2023 | 2024 | 2025 | YTD 2026 | YTD 2026 | YTD% | ...
 *     row 2: | BU Item | Revenue | Revenue | Revenue | Revenue | Qty | ...
 *     rows:  | Total | P0_C Central | P1_I I/O | P1_M Motion | P1_P IPC |
 *            | P1_T TwinCAT | P1_ZZ |
 *   Sheet "SalesRespCust": sales rep name in A2 (optional).
 */
(function () {
  'use strict';

  const PRODUCT_GROUPS = ['I/O', 'Motion', 'IPC', 'TwinCAT', 'ZZ'];

  // Map a BU Item row label (e.g. "P1_M Motion", "P1_ZZ") to a product group.
  function productGroupFor(label) {
    const s = String(label).trim();
    if (/twincat/i.test(s)) return 'TwinCAT';
    if (/\bipc\b/i.test(s)) return 'IPC';
    if (/\bmotion\b/i.test(s)) return 'Motion';
    if (/i\s*\/\s*o/i.test(s)) return 'I/O';
    if (/(^|[_\s])zz\b/i.test(s)) return 'ZZ';
    return null;
  }

  // Header cells look like "2023" or "YTD 2026" (numbers or strings).
  function yearKeyFor(headerCell) {
    const s = String(headerCell == null ? '' : headerCell).trim();
    const m = s.match(/^(ytd[\s.]*)?((?:19|20)\d{2})$/i);
    if (!m) return null;
    return m[1] ? 'YTD ' + m[2] : m[2];
  }

  // Revenue cells are usually numbers, but tolerate text like "$1,234.56"
  // or accounting-style "(500)".
  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      let s = v.replace(/[$,\s]/g, '');
      const paren = s.match(/^\((.*)\)$/);
      if (paren) s = '-' + paren[1];
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function findSheet(workbook, baseName) {
    const exact = workbook.SheetNames.find(
      (n) => n.trim().toLowerCase() === baseName.toLowerCase()
    );
    if (exact) return workbook.Sheets[exact];
    const prefix = workbook.SheetNames.find((n) =>
      n.trim().toLowerCase().startsWith(baseName.toLowerCase())
    );
    return prefix ? workbook.Sheets[prefix] : null;
  }

  /**
   * Parse one company workbook (ArrayBuffer) into:
   *   { years, sales: {group: {yearKey: number}}, totals: {yearKey: number},
   *     salesRep }
   * Throws an Error with a user-readable message when the format is wrong.
   */
  function parseWorkbook(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });

    const sheet = findSheet(wb, 'BUItem1') || findSheet(wb, 'BUItem');
    if (!sheet) {
      throw new Error(
        'No "BUItem1" sheet found — this file does not match the expected format.'
      );
    }

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
    });
    if (rows.length < 3) {
      throw new Error('The "BUItem1" sheet is empty or truncated.');
    }

    const yearHeader = rows[0] || [];
    const subHeader = rows[1] || [];

    // Year columns are those whose row-2 subheader is "Revenue" (the second
    // "YTD 2026" column is Qty and is skipped). First occurrence wins.
    const yearCols = {};
    const maxCols = Math.max(yearHeader.length, subHeader.length);
    for (let c = 1; c < maxCols; c++) {
      const key = yearKeyFor(yearHeader[c]);
      if (!key || yearCols[key] !== undefined) continue;
      const sub = String(subHeader[c] == null ? '' : subHeader[c]).trim();
      if (/^revenue$/i.test(sub)) yearCols[key] = c;
    }

    const years = Object.keys(yearCols);
    if (years.length === 0) {
      throw new Error(
        'No revenue year columns (2023 / 2024 / 2025 / YTD 2026) were found in "BUItem1".'
      );
    }

    const sales = {};
    PRODUCT_GROUPS.forEach((g) => {
      sales[g] = {};
      years.forEach((y) => (sales[g][y] = 0));
    });
    const totals = {};
    years.forEach((y) => (totals[y] = 0));
    let sawTotalRow = false;
    let sawGroupRow = false;

    for (let r = 2; r < rows.length; r++) {
      const row = rows[r] || [];
      const label = String(row[0] == null ? '' : row[0]).trim();
      if (!label) continue;

      const readYears = (target) => {
        years.forEach((y) => {
          target[y] += toNumber(row[yearCols[y]]);
        });
      };

      if (/^total$/i.test(label)) {
        sawTotalRow = true;
        readYears(totals);
        continue;
      }
      const group = productGroupFor(label);
      if (group) {
        sawGroupRow = true;
        readYears(sales[group]);
      }
    }

    if (!sawGroupRow && !sawTotalRow) {
      throw new Error(
        'No product group rows (I/O, Motion, IPC, TwinCAT, ZZ) were found in "BUItem1".'
      );
    }

    // If the workbook had no explicit Total row, derive totals from the groups.
    if (!sawTotalRow) {
      years.forEach((y) => {
        totals[y] = PRODUCT_GROUPS.reduce((acc, g) => acc + sales[g][y], 0);
      });
    }

    // Optional: sales rep name from the SalesRespCust sheet (cell A2).
    let salesRep = '';
    const repSheet = findSheet(wb, 'SalesRespCust');
    if (repSheet) {
      const repRows = XLSX.utils.sheet_to_json(repSheet, {
        header: 1,
        raw: true,
        defval: null,
      });
      if (repRows[1] && repRows[1][0] != null) {
        salesRep = String(repRows[1][0]).trim();
      }
    }

    return { years, sales, totals, salesRep };
  }

  /**
   * Derive the company name from a file name: everything before the first
   * date-like token ("Acme Corp 2026-07-09.xlsx" -> "Acme Corp").
   * Falls back to the whole base name when no date is present.
   */
  function companyNameFromFileName(fileName) {
    // Normalize separators first so date tokens are detectable even in names
    // like "Gulf_Coast_Controls_July 2026".
    const base = String(fileName || '')
      .replace(/\.[^.]+$/, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const datePatterns = [
      /\d{4}[-._/]\d{1,2}[-._/]\d{1,4}/, // 2026-07-09, 2026.7.9
      /\d{1,2}[-._/]\d{1,2}[-._/]\d{2,4}/, // 7-9-26, 07.09.2026
      /(?:^|\D)((?:19|20)\d{2}[01]\d[0-3]\d)(?:\D|$)/, // 20260709
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[-_ ]*\d{1,4}\b/i, // July 2026
      /\b(?:ytd[-_ ]*)?(?:19|20)\d{2}\b/i, // bare year / YTD 2026
    ];

    // Cut at the earliest date token that leaves a non-empty name (a match at
    // index 0 would erase the whole name — e.g. "Decatur 2026" matching the
    // month-name pattern — so it is skipped in favor of later matches).
    let cut = -1;
    for (const re of datePatterns) {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(base)) !== null) {
        const idx = m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
        if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
        if (m.index === g.lastIndex) g.lastIndex++;
      }
    }

    let name = cut > 0 ? base.slice(0, cut) : base;
    name = name
      .replace(/[\s\-–—.,([{]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return name || base;
  }

  window.HeatMapParser = {
    PRODUCT_GROUPS,
    parseWorkbook,
    companyNameFromFileName,
    productGroupFor,
    yearKeyFor,
  };
})();
