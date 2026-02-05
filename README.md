# Address District Lookup

A sample web component that geocodes an address and enriches it with election district data from [RegionFlex](https://regionflex.com). Intended as a developer reference, not a production-ready application.

## What it does

1. Takes an address as user input
2. Geocodes it to lat/lng via [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap)
3. Queries the [RegionFlex API](https://regionflex.com/docs/api/query-features-by-location) with those coordinates to find election districts that contain that point
4. Displays the results

## Prerequisites

- Node.js (for the Vite build tooling)
- A [RegionFlex](https://regionflex.com) API token with access to the regions you want to query

## Getting started

```sh
npm install
npm run dev
```

This starts a local dev server with hot reload. Open the URL Vite prints (usually `http://localhost:5173`).

## Project structure

```
src/
  address-lookup.html   ← widget markup (plain HTML fragment)
  address-lookup.css    ← widget styles (plain CSS)
  address-lookup.js     ← component logic, imports the above two
index.html              ← demo page that embeds the widget
vite.config.js          ← build config (library mode)
```

The CSS and HTML are separate files with full IDE support (syntax highlighting, emmet, formatting). Vite's `?inline` and `?raw` import suffixes pull them into the JS at build time.

## How the component works

The widget is a [web component](https://developer.mozilla.org/en-US/docs/Web/API/Web_components) (`<address-lookup>`). Key patterns:

- **Shadow DOM** keeps the widget's markup and styles isolated from the host page
- **`adoptedStyleSheets`** applies the CSS via a shared `CSSStyleSheet` instance (created once, reused across all instances)
- **`<template>` cloning** — the HTML is parsed into a `<template>` element once at module load, then `cloneNode(true)` is used per instance
- **Inherits host page styling** — the widget sets no font, color, or size of its own. It uses `font: inherit`, `color: inherit`, and `currentColor` so it picks up whatever the surrounding page sets

### Attributes

| Attribute | Required | Description |
|-----------|----------|-------------|
| `token`   | No       | RegionFlex bearer token. If set, the token input field is hidden. If omitted, a password field is shown for the user to paste their token at runtime. |

## Embedding in your page

Add the built script and drop the element wherever you want it:

```html
<address-lookup token="YOUR_TOKEN"></address-lookup>
<script type="module" src="address-lookup.js"></script>
```

Or without a pre-set token (shows an input field):

```html
<address-lookup></address-lookup>
<script type="module" src="address-lookup.js"></script>
```

The widget inherits font and color from its parent, so it will blend with your page's styling.

## Building for distribution

```sh
npm run build
```

Produces `dist/address-lookup.js` — a single self-contained ES module with the HTML and CSS bundled in. This is the only file consumers need.

## APIs used

### Nominatim (geocoding)

- **Endpoint:** `https://nominatim.openstreetmap.org/search`
- **Auth:** None (public, rate-limited)
- **Purpose:** Convert a street address to lat/lng coordinates
- **Note:** Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) limits use to low-volume and non-bulk scenarios. Fine for demos, not suitable for production.

### RegionFlex (district lookup)

- **Endpoint:** `https://app.regionflex.com/api/v1/query`
- **Auth:** Bearer token (`Authorization: Bearer <token>`)
- **Purpose:** Point-in-polygon query — finds which election district features contain the given lat/lng
- **Docs:** https://regionflex.com/docs/api/query-features-by-location
