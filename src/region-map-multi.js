// ---------------------------------------------------------------------------
// <region-map-multi> Web Component
//
// Displays multiple RegionFlex regions on a single map with overlap analysis.
//
// Default state: outlines only — no fill.
// Hover: reveals the overlap geometry (intersection) and highlights the full
//        extent of each contributing feature in its region's color.
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
import { intersect } from "@turf/intersect";
import { bbox } from "@turf/bbox";
import { featureCollection } from "@turf/helpers";
import styles from "./region-map-multi.css?inline";
import markup from "./region-map-multi.html?raw";

// --- Shared styles & template -----------------------------------------------

const mapSheet = new CSSStyleSheet();
mapSheet.replaceSync(maplibreCSS);

const componentSheet = new CSSStyleSheet();
componentSheet.replaceSync(styles);

const tmpl = document.createElement("template");
tmpl.innerHTML = markup;

// --- Palette ----------------------------------------------------------------

const REGION_COLORS = [
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
];

const OVERLAP_COLOR = "#8b5cf6"; // purple

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
  #regionData = [];      // [{ key, config, geojson, features, lookup }]
  #overlapsFC = null;    // FeatureCollection of intersection geometries
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

      // 2 — Load GeoJSON shapes + feature metadata in parallel
      this.#showStatus("Loading region shapes…");
      this.#regionData = await Promise.all(
        regionIds.map(async (key, i) => {
          const config = configs[key];
          if (!config)
            throw new Error(`Region "${key}" was not returned by the API. Check the identifier and token access.`);

          const [geojson, featuresRes] = await Promise.all([
            this.#fetchJSON(config.geojson_url, token),
            this.#fetchJSON(
              config.features_url + "?fields=id,custom_id,name,data",
              token,
            ),
          ]);

          const features = featuresRes.data || featuresRes;
          const lookup = Object.fromEntries(features.map((f) => [f.id, f]));

          return { key, config, geojson, features, lookup, color: REGION_COLORS[i % REGION_COLORS.length] };
        }),
      );
      this.#regionCount = this.#regionData.length;

      // 3 — Compute pairwise intersection geometries
      this.#showStatus("Computing region overlaps…");
      this.#computeOverlaps();

      // 4 — Render
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
  // Overlap computation (Turf.js)
  //
  // For every pair of features from different regions, compute their
  // geometric intersection. Store which region features contributed so the
  // hover logic can show the full extent of each.
  // -------------------------------------------------------------------------
  #computeOverlaps() {
    const overlaps = [];

    for (let i = 0; i < this.#regionCount; i++) {
      for (let j = i + 1; j < this.#regionCount; j++) {
        const shapesA = this.#regionData[i].geojson.features;
        const shapesB = this.#regionData[j].geojson.features;

        for (const a of shapesA) {
          for (const b of shapesB) {
            try {
              const inter = intersect(featureCollection([a, b]));
              if (!inter) continue;

              inter.properties = {
                [`source_${i}`]: a.properties.feature_id,
                [`source_${j}`]: b.properties.feature_id,
              };
              overlaps.push(inter);
            } catch (_) {
              // Some geometry pairs can't be intersected cleanly — skip
            }
          }
        }
      }
    }

    this.#overlapsFC = { type: "FeatureCollection", features: overlaps };
  }

  // -------------------------------------------------------------------------
  // Map rendering
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
        type: "geojson",
        data: this.#regionData[i].geojson,
      });
    }
    this.#map.addSource("overlaps", {
      type: "geojson",
      data: this.#overlapsFC,
    });
  }

  #addLayers() {
    const NONE = ["==", ["get", "feature_id"], "__none__"];

    for (let i = 0; i < this.#regionCount; i++) {
      const color = this.#regionData[i].color;

      // Invisible fill — hit-test target for hover detection
      this.#map.addLayer({
        id: `region-${i}-hit`,
        type: "fill",
        source: `region-${i}`,
        paint: { "fill-color": color, "fill-opacity": 0.001 },
      });

      // Hover fill — visible only for hovered features
      this.#map.addLayer({
        id: `region-${i}-hover`,
        type: "fill",
        source: `region-${i}`,
        paint: { "fill-color": color, "fill-opacity": 0.18 },
        filter: NONE,
      });

      // Outline — always visible
      this.#map.addLayer({
        id: `region-${i}-outline`,
        type: "line",
        source: `region-${i}`,
        paint: { "line-color": color, "line-width": 2, "line-opacity": 0.7 },
      });

      // Thicker outline for hovered features
      this.#map.addLayer({
        id: `region-${i}-outline-hover`,
        type: "line",
        source: `region-${i}`,
        paint: { "line-color": color, "line-width": 3.5, "line-opacity": 1 },
        filter: NONE,
      });
    }

    // Overlap layers (on top of everything)
    this.#map.addLayer({
      id: "overlap-hover",
      type: "fill",
      source: "overlaps",
      paint: { "fill-color": OVERLAP_COLOR, "fill-opacity": 0.35 },
      filter: ["==", ["id"], -1], // show nothing initially
    });

    this.#map.addLayer({
      id: "overlap-outline-hover",
      type: "line",
      source: "overlaps",
      paint: {
        "line-color": OVERLAP_COLOR,
        "line-width": 2.5,
        "line-dasharray": [4, 3],
        "line-opacity": 0.9,
      },
      filter: ["==", ["id"], -1],
    });
  }

  // -------------------------------------------------------------------------
  // Fit bounds to all regions combined
  // -------------------------------------------------------------------------
  #fitAllBounds() {
    const bounds = new maplibregl.LngLatBounds();
    const extend = (coords) => {
      if (typeof coords[0] === "number") bounds.extend(coords);
      else for (const c of coords) extend(c);
    };

    for (const rd of this.#regionData) {
      for (const f of rd.geojson.features) {
        extend(f.geometry.coordinates);
      }
    }

    if (!bounds.isEmpty()) {
      this.#map.fitBounds(bounds, { padding: 40, maxZoom: 14 });
    }
  }

  // -------------------------------------------------------------------------
  // Hover interactions
  //
  // On mousemove:
  //   1. Query all region hit layers for features at the cursor point
  //   2. For each hovered feature, also find overlaps it participates in
  //   3. For each overlap, add the *other* region's contributing feature
  //      so its full extent is revealed too
  //   4. Update filters on hover/outline layers accordingly
  //
  // Result: you see the overlap zone in purple, and each contributing
  // feature's full shape in its region color.
  // -------------------------------------------------------------------------
  #setupInteractions() {
    const map = this.#map;
    let popup = null;

    // Build list of hit-test layer ids
    const hitLayers = [];
    for (let i = 0; i < this.#regionCount; i++) hitLayers.push(`region-${i}-hit`);

    map.on("mousemove", (e) => {
      // 1. Find features at cursor from each region
      const hoveredIds = new Map(); // regionIndex → Set<feature_id>

      for (let i = 0; i < this.#regionCount; i++) {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: [`region-${i}-hit`],
        });
        if (hits.length > 0) {
          const ids = new Set();
          for (const h of hits) {
            const fid = h.properties.feature_id;
            if (fid) ids.add(fid);
          }
          if (ids.size) hoveredIds.set(i, ids);
        }
      }

      // 2. Find overlaps involving any hovered feature and pull in the
      //    contributing features from the *other* regions
      const matchingOverlapIndices = [];
      for (let oi = 0; oi < this.#overlapsFC.features.length; oi++) {
        const props = this.#overlapsFC.features[oi].properties;
        let involved = false;

        for (const [regionIdx, featureIds] of hoveredIds) {
          const sourceKey = `source_${regionIdx}`;
          if (featureIds.has(props[sourceKey])) {
            involved = true;

            // Pull in the other region's contributing feature
            for (const key of Object.keys(props)) {
              if (!key.startsWith("source_")) continue;
              const otherIdx = parseInt(key.split("_")[1], 10);
              if (otherIdx === regionIdx) continue;
              if (!hoveredIds.has(otherIdx)) hoveredIds.set(otherIdx, new Set());
              hoveredIds.get(otherIdx).add(props[key]);
            }
          }
        }

        if (involved) matchingOverlapIndices.push(oi);
      }

      // 3. Update region hover layers
      const anythingHovered = hoveredIds.size > 0;
      for (let i = 0; i < this.#regionCount; i++) {
        const ids = hoveredIds.get(i);
        if (ids && ids.size > 0) {
          const filterExpr = ["in", ["get", "feature_id"], ["literal", [...ids]]];
          map.setFilter(`region-${i}-hover`, filterExpr);
          map.setFilter(`region-${i}-outline-hover`, filterExpr);
        } else {
          const none = ["==", ["get", "feature_id"], "__none__"];
          map.setFilter(`region-${i}-hover`, none);
          map.setFilter(`region-${i}-outline-hover`, none);
        }
      }

      // 4. Update overlap layers
      if (matchingOverlapIndices.length > 0) {
        // Filter by feature index (MapLibre auto-assigns numeric ids to GeoJSON features)
        const overlapFilter = [
          "in",
          ["id"],
          ["literal", matchingOverlapIndices],
        ];
        map.setFilter("overlap-hover", overlapFilter);
        map.setFilter("overlap-outline-hover", overlapFilter);
      } else {
        map.setFilter("overlap-hover", ["==", ["id"], -1]);
        map.setFilter("overlap-outline-hover", ["==", ["id"], -1]);
      }

      // Cursor
      map.getCanvas().style.cursor = anythingHovered ? "pointer" : "";
    });

    // Click → popup with feature details
    map.on("click", (e) => {
      if (popup) popup.remove();

      // Collect all features at click point
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
      const name = rd.key;
      legend.appendChild(this.#legendItem(rd.color, name, false));
    }

    if (this.#overlapsFC.features.length > 0) {
      legend.appendChild(this.#legendItem(OVERLAP_COLOR, "Overlap (hover to reveal)", true));
    }

    legend.classList.remove("hidden");
  }

  #legendItem(color, label, isOverlap) {
    const item = document.createElement("div");
    item.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch" + (isOverlap ? " legend-swatch--overlap" : "");
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
