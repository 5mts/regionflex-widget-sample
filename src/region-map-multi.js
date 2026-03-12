// ---------------------------------------------------------------------------
// <region-map-multi> Web Component
//
// Displays multiple RegionFlex regions on a single map. All rendering uses
// PMTiles vector tiles — no GeoJSON fetches, no client-side geometry math.
//
// Default state: outlines only — no fill.
// Hover: each region's hovered feature gets a translucent fill in its color.
//        Where regions overlap on screen, the fills naturally stack, producing
//        a visibly denser/blended area.
//
// Usage:
//   <region-map-multi
//     token="YOUR_TOKEN"
//     regions="region-a-slug,region-b-slug">
//   </region-map-multi>
//   <script type="module" src="region-map-multi.js"></script>
//
// Attributes:
//   token   — RegionFlex bearer token. If omitted, a token input is shown.
//   regions — Comma-separated region identifiers (UUIDs, custom_ids, or slugs).
// ---------------------------------------------------------------------------

import { API_BASE } from "./config.js";
import maplibregl from "maplibre-gl";
import maplibreCSS from "maplibre-gl/dist/maplibre-gl.css?inline";
import { PMTiles, Protocol } from "pmtiles";
import styles from "./region-map-multi.css?inline";
import markup from "./region-map-multi.html?raw";

// --- Shared styles & template -----------------------------------------------

const mapSheet = new CSSStyleSheet();
mapSheet.replaceSync(maplibreCSS);

const componentSheet = new CSSStyleSheet();
componentSheet.replaceSync(styles);

const tmpl = document.createElement("template");
tmpl.innerHTML = markup;

// --- PMTiles protocol (registered once globally) ----------------------------

const pmtilesProtocol = new Protocol();
maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);

// --- Palette ----------------------------------------------------------------

const REGION_COLORS = [
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
];

// --- Base map style (OSM raster, no API key) --------------------------------

const BASE_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution:
        "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

// --- Component --------------------------------------------------------------

class RegionMapMulti extends HTMLElement {
  #map = null;
  #regionData = [];      // [{ key, config, header, sourceLayer, features, lookup, color }]
  #regionCount = 0;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.adoptedStyleSheets = [mapSheet, componentSheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(tmpl.content.cloneNode(true));

    const token = this.getAttribute("token") || "";
    if (token) {
      this.#el("token-input").value = token;
      this.#el("token-section").classList.add("hidden");
      this.#loadMap();
    } else {
      this.#el("load-btn").addEventListener("click", () => this.#loadMap());
      this.#el("token-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.#loadMap();
      });
    }
  }

  disconnectedCallback() {
    if (this.#map) { this.#map.remove(); this.#map = null; }
  }

  #el(id) { return this.shadowRoot.getElementById(id); }

  // -------------------------------------------------------------------------
  // Main load flow
  // -------------------------------------------------------------------------
  async #loadMap() {
    const token =
      this.getAttribute("token") || this.#el("token-input").value.trim();
    const regionsAttr = this.getAttribute("regions") || "";
    const regionIds = regionsAttr.split(",").map((s) => s.trim()).filter(Boolean);

    if (!token) return this.#showError("Please enter your RegionFlex API token.");
    if (regionIds.length < 2)
      return this.#showError('Provide at least two region identifiers in the "regions" attribute.');

    this.#setLoading(true);
    this.#hideError();

    try {
      // 1 — Batch-fetch geodisplay configs for all regions
      this.#showStatus("Fetching region configurations…");
      const configs = await this.#fetchConfigs(regionIds, token);

      // 2 — For each region: open PMTiles (header + metadata) and fetch
      //     feature metadata for popups.
      this.#showStatus("Loading region data…");
      this.#regionData = await Promise.all(
        regionIds.map(async (key, i) => {
          const config = configs[key];
          if (!config)
            throw new Error(`Region "${key}" was not returned by the API. Check the identifier and token access.`);

          const pm = new PMTiles(config.tiles_url);
          pmtilesProtocol.add(pm);

          const [header, metadata, featuresRes] = await Promise.all([
            pm.getHeader(),
            pm.getMetadata(),
            this.#fetchJSON(config.features_url + "?fields=id,custom_id,name,data", token),
          ]);

          const sourceLayer = metadata.vector_layers?.[0]?.id || "default";
          const features = featuresRes.data || featuresRes;
          const lookup = Object.fromEntries(features.map((f) => [f.id, f]));

          return {
            key, config, header, sourceLayer, features, lookup,
            color: REGION_COLORS[i % REGION_COLORS.length],
          };
        }),
      );
      this.#regionCount = this.#regionData.length;

      // 3 — Render map.
      this.#showStatus("Rendering map…");
      this.#renderMap();
      this.#buildLegend();
      this.#hideStatus();
    } catch (err) {
      this.#showError(err.message);
    } finally {
      this.#setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // API helpers
  // -------------------------------------------------------------------------
  async #fetchConfigs(regionIds, token) {
    const res = await fetch(`${API_BASE}/api/v1/geodisplay/configs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ regions: regionIds }),
    });
    if (!res.ok) throw new Error("Failed to fetch configs: HTTP " + res.status);
    return res.json();
  }

  async #fetchJSON(url, token) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Map rendering — 100% vector tiles via PMTiles.
  // Overlap is shown visually by stacking translucent fills from each region.
  // -------------------------------------------------------------------------
  #renderMap() {
    const container = this.#el("map-container");
    if (this.#map) { this.#map.remove(); this.#map = null; }

    this.#map = new maplibregl.Map({
      container,
      style: BASE_STYLE,
      center: [0, 0],
      zoom: 1,
      attributionControl: true,
    });

    this.#map.on("load", () => {
      this.#addSources();
      this.#addLayers();
      this.#fitAllBounds();
      this.#setupInteractions();
    });
  }

  #addSources() {
    for (let i = 0; i < this.#regionCount; i++) {
      this.#map.addSource(`region-${i}`, {
        type: "vector",
        url: `pmtiles://${this.#regionData[i].config.tiles_url}`,
      });
    }
  }

  #addLayers() {
    const NONE = ["==", ["get", "feature_id"], "__none__"];

    for (let i = 0; i < this.#regionCount; i++) {
      const color = this.#regionData[i].color;
      const sl = this.#regionData[i].sourceLayer;

      // Invisible fill — hit-test target for hover detection
      this.#map.addLayer({
        id: `region-${i}-hit`,
        type: "fill",
        source: `region-${i}`,
        "source-layer": sl,
        paint: { "fill-color": color, "fill-opacity": 0.001 },
      });

      // Hover fill — only shown when 2+ regions overlap at cursor.
      // Each region's fill stacks visually to highlight the shared area.
      this.#map.addLayer({
        id: `region-${i}-hover`,
        type: "fill",
        source: `region-${i}`,
        "source-layer": sl,
        paint: { "fill-color": color, "fill-opacity": 0.2 },
        filter: NONE,
      });

      // Outline — always visible
      this.#map.addLayer({
        id: `region-${i}-outline`,
        type: "line",
        source: `region-${i}`,
        "source-layer": sl,
        paint: { "line-color": color, "line-width": 2, "line-opacity": 0.7 },
      });

      // Thicker outline for hovered features
      this.#map.addLayer({
        id: `region-${i}-outline-hover`,
        type: "line",
        source: `region-${i}`,
        "source-layer": sl,
        paint: { "line-color": color, "line-width": 3.5, "line-opacity": 1 },
        filter: NONE,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Fit bounds to all regions combined (from PMTiles headers)
  // -------------------------------------------------------------------------
  #fitAllBounds() {
    const bounds = new maplibregl.LngLatBounds();

    for (const rd of this.#regionData) {
      const h = rd.header;
      bounds.extend([h.minLon, h.minLat]);
      bounds.extend([h.maxLon, h.maxLat]);
    }

    if (!bounds.isEmpty()) {
      this.#map.fitBounds(bounds, { padding: 40, maxZoom: 14 });
    }
  }

  // -------------------------------------------------------------------------
  // Hover interactions
  //
  // On mousemove: highlight hovered features with translucent fill + bold
  // outline. Where 2+ regions share screen space, their fills naturally
  // stack — producing a visibly denser area that indicates overlap.
  // -------------------------------------------------------------------------
  #setupInteractions() {
    const map = this.#map;
    let popup = null;
    const NONE = ["==", ["get", "feature_id"], "__none__"];

    map.on("mousemove", (e) => {
      // Collect hovered feature_ids per region
      const hoveredIds = new Map(); // regionIndex → Set<feature_id>

      for (let i = 0; i < this.#regionCount; i++) {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: [`region-${i}-hit`],
        });
        if (!hits.length) continue;

        const ids = new Set();
        for (const h of hits) {
          const fid = h.properties.feature_id;
          if (fid) ids.add(fid);
        }
        if (ids.size) hoveredIds.set(i, ids);
      }

      // Update layers for each region
      for (let i = 0; i < this.#regionCount; i++) {
        const ids = hoveredIds.get(i);
        if (ids) {
          const filterExpr = ["in", ["get", "feature_id"], ["literal", [...ids]]];
          map.setFilter(`region-${i}-outline-hover`, filterExpr);
          map.setFilter(`region-${i}-hover`, filterExpr);
        } else {
          map.setFilter(`region-${i}-hover`, NONE);
          map.setFilter(`region-${i}-outline-hover`, NONE);
        }
      }

      map.getCanvas().style.cursor = hoveredIds.size > 0 ? "pointer" : "";
    });

    // Click → popup with feature details
    map.on("click", (e) => {
      if (popup) popup.remove();

      const items = [];
      for (let i = 0; i < this.#regionCount; i++) {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: [`region-${i}-hit`],
        });
        for (const h of hits) {
          const fid = h.properties.feature_id;
          const meta = this.#regionData[i].lookup[fid] || {};
          items.push({ regionIdx: i, meta, props: h.properties });
        }
      }

      if (!items.length) return;

      let html = "";
      for (const item of items) {
        const color = this.#regionData[item.regionIdx].color;
        const name = item.meta.name || item.props.name || "Unnamed";
        const customId = item.meta.custom_id || "";
        html += `<div style="margin-bottom:6px;padding-left:10px;border-left:3px solid ${color}">`;
        html += `<strong>${this.#esc(name)}</strong>`;
        if (customId) html += `<br><span style="opacity:0.6">${this.#esc(customId)}</span>`;
        if (item.meta.data && typeof item.meta.data === "object") {
          for (const [k, v] of Object.entries(item.meta.data)) {
            html += `<br><span style="opacity:0.5;font-size:0.85em">${this.#esc(k)}: ${this.#esc(String(v))}</span>`;
          }
        }
        html += "</div>";
      }

      popup = new maplibregl.Popup({ maxWidth: "300px" })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    });
  }

  // -------------------------------------------------------------------------
  // Legend
  // -------------------------------------------------------------------------
  #buildLegend() {
    const legend = this.#el("legend");
    legend.innerHTML = "";

    for (let i = 0; i < this.#regionCount; i++) {
      const rd = this.#regionData[i];
      legend.appendChild(this.#legendItem(rd.color, rd.key));
    }

    legend.classList.remove("hidden");
  }

  #legendItem(color, label) {
    const item = document.createElement("div");
    item.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.setProperty("--swatch-color", color);

    const text = document.createElement("span");
    text.textContent = label;

    item.append(swatch, text);
    return item;
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------
  #setLoading(on) {
    const btn = this.#el("load-btn");
    if (btn) {
      btn.disabled = on;
      btn.querySelector(".btn-label").textContent = on ? "Loading…" : "Load Map";
    }
  }

  #showStatus(msg) {
    const el = this.#el("status");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  #hideStatus() { this.#el("status").classList.add("hidden"); }

  #showError(msg) {
    const el = this.#el("error");
    el.textContent = msg;
    el.classList.remove("hidden");
    this.#el("status").classList.add("hidden");
  }

  #hideError() { this.#el("error").classList.add("hidden"); }

  #esc(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }
}

customElements.define("region-map-multi", RegionMapMulti);
