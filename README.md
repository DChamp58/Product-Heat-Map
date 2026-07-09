# Product Heat Map

A Leaflet heat map of US customer revenue by product group. Upload one Excel
workbook per company (all in the standard `ProductMapFormat` layout), place
each company at its address, and see where revenue concentrates for each
product group.

## Features

- **Heat map by product group** — filter by I/O, Motion, IPC, TwinCAT, ZZ, or
  All (total). The heat intensity is each company's revenue for the selected
  product group, relative to the current maximum.
- **Year switching** — YTD 2026 is the default; 2023, 2024, and 2025 are one
  click away. Switching years updates every company on the map at once.
- **Excel intake** — click *Add company Excel files* and select one or more
  workbooks. Revenue per product group is read from the `BUItem1` sheet
  (`Revenue` columns for 2023 / 2024 / 2025 / YTD 2026).
- **Address prompt** — the workbooks contain no addresses, so the app asks for
  one per company. The company name is pre-filled from the file name (the part
  before the date) and is editable. Addresses are looked up with OpenStreetMap
  Nominatim; you can also type coordinates directly (`32.08, -81.09`) or click
  *Pick on map*.
- **Persistence** — companies are saved in the browser's localStorage, so the
  map survives reloads. *Export data* / *Import data* moves the dataset between
  browsers as a JSON file.
- **Updates** — re-uploading a file for an existing company (same name)
  replaces its sales data while keeping its saved address.

## Expected Excel format

One workbook per company. The file name should start with the company name,
optionally followed by a date, e.g. `Acme Robotics 2026-07-09.xlsx`.

The `BUItem1` sheet must contain year columns (`2023`, `2024`, `2025`,
`YTD 2026`) with a `Revenue` sub-header, and rows for the product groups
(`P1_I I/O`, `P1_M Motion`, `P1_P IPC`, `P1_T TwinCAT`, `P1_ZZ`, plus `Total`).

## Running locally

It is a static site — serve the folder over HTTP:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Deploying to Netlify

No build step is needed (`netlify.toml` publishes the repo root). Either:

- connect this repository in the Netlify UI (leave the build command empty), or
- `netlify deploy --prod --dir .`

All JavaScript/CSS libraries (Leaflet, leaflet.heat, SheetJS) are vendored
under `vendor/`, so the only external services used at runtime are the CARTO
basemap tiles and Nominatim address lookup.
