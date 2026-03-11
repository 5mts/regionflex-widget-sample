// ---------------------------------------------------------------------------
// <region-map> Web Component
//
// Usage:
//   <region-map token="YOUR_TOKEN" region="REGION_ID_OR_SLUG"></region-map>
//   <script type="module" src="region-map.js"></script>
//
// Attributes:
//   token  — RegionFlex bearer token. If omitted, a token input field is shown.
//   region — Region identifier (UUID, custom_id, or slug). Required.
// ---------------------------------------------------------------------------

import { API_BASE } from "./config.js";
import maplibregl from "maplibre-gl";
import maplibreCSS from "maplibre-gl/dist/maplibre-gl.css?inline";
import { PMTiles, Protocol } from "pmtiles";
import styles from "./region-map.css?inline";
import markup from "./region-map.html?raw";

// --- Styles & template (created once, shared across all instances) ----------

const mapSheet = new CSSStyleSheet();
mapSheet.replaceSync(maplibreCSS);

const componentSheet = new CSSStyleSheet();
componentSheet.replaceSync(styles);

const template = document.createElement("template");
template.innerHTML = markup;

// --- PMTiles protocol (registered once globally) ----------------------------

const pmtilesProtocol = new Protocol();
maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);

// --- Base map style (OSM raster tiles, no API key needed) -------------------

const BASE_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

// --- Component --------------------------------------------------------------

class RegionMap extends HTMLElement {
  #map = null;
  #featuresLookup = {};
  #sourceLayer = "default";

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.adoptedStyleSheets = [mapSheet, componentSheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(template.content.cloneNode(true));

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
    if (this.#map) {
      this.#map.remove();
      this.#map = null;
    }
  }

  #el(id) { return this.shadowRoot.getElementById(id); }

  // -------------------------------------------------------------------------
  // Main load flow
  // -------------------------------------------------------------------------
  async #loadMap() {
    const token = this.getAttribute("token") || this.#el("token-input").value.trim();
    const region = this.getAttribute("region");

    if (!token) return this.#showError("Please enter your RegionFlex API token.");
    if (!region) return this.#showError('Missing required "region" attribute.');

    this.#setLoading(true);
    this.#hideError();

    try {
      // Step 1 — Fetch geodisplay config for the region
      this.#showStatus("Fetching region configuration…");
      const config = await this.#fetchConfig(region, token);

      // Step 2 — Open PMTiles to read header (bounds) and metadata (layer names)
      this.#showStatus("Loading vector tiles…");
      const pm = new PMTiles(config.tiles_url);
      pmtilesProtocol.add(pm);

      const [header, metadata, featuresRes] = await Promise.all([
        pm.getHeader(),
        pm.getMetadata(),
        this.#fetchJSON(config.features_url + "?fields=id,custom_id,name,data", token),
      ]);

      // Discover the source-layer name from PMTiles metadata
      this.#sourceLayer = metadata.vector_layers?.[0]?.id || "default";

      // Build a lookup table: feature_id → feature metadata
      this.#featuresLookup = {};
      for (const f of (featuresRes.data || featuresRes)) {
        this.#featuresLookup[f.id] = f;
      }

      // Step 3 — Render the map
      this.#showStatus("Rendering map…");
      this.#renderMap(config.tiles_url, header);

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
  async #fetchConfig(region, token) {
    const url = `${API_BASE}/api/v1/regions/${encodeURIComponent(region)}/geodisplay/config`;
    return this.#fetchJSON(url, token);
  }

  async #fetchJSON(url, token) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }

    return res.json();
  }

  // -------------------------------------------------------------------------
  // Map rendering (vector tiles via PMTiles)
  // -------------------------------------------------------------------------
  #renderMap(tilesUrl, header) {
    const container = this.#el("map-container");

    if (this.#map) {
      this.#map.remove();
      this.#map = null;
    }

    this.#map = new maplibregl.Map({
      container,
      style: BASE_STYLE,
      center: [0, 0],
      zoom: 1,
      attributionControl: true,
    });

    this.#map.on("load", () => {
      const sl = this.#sourceLayer;

      this.#map.addSource("region", {
        type: "vector",
        url: `pmtiles://${tilesUrl}`,
      });

      // Fill layer
      this.#map.addLayer({
        id: "region-fill",
        type: "fill",
        source: "region",
        "source-layer": sl,
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.15,
        },
      });

      // Outline layer
      this.#map.addLayer({
        id: "region-outline",
        type: "line",
        source: "region",
        "source-layer": sl,
        paint: {
          "line-color": "#3b82f6",
          "line-width": 2,
        },
      });

      // Hover highlight
      this.#map.addLayer({
        id: "region-hover",
        type: "fill",
        source: "region",
        "source-layer": sl,
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.35,
        },
        filter: ["==", ["get", "feature_id"], ""],
      });

      // Fit map to PMTiles bounds from header
      this.#map.fitBounds(
        [[header.minLon, header.minLat], [header.maxLon, header.maxLat]],
        { padding: 40, maxZoom: 14 },
      );

      this.#setupInteractions();
    });
  }

  #setupInteractions() {
    let popup = null;

    // Cursor
    this.#map.on("mouseenter", "region-fill", () => {
      this.#map.getCanvas().style.cursor = "pointer";
    });
    this.#map.on("mouseleave", "region-fill", () => {
      this.#map.getCanvas().style.cursor = "";
      this.#map.setFilter("region-hover", ["==", ["get", "feature_id"], ""]);
    });

    // Hover highlight
    this.#map.on("mousemove", "region-fill", (e) => {
      if (e.features.length > 0) {
        const featureId = e.features[0].properties.feature_id || "";
        this.#map.setFilter("region-hover", ["==", ["get", "feature_id"], featureId]);
      }
    });

    // Click → popup
    this.#map.on("click", "region-fill", (e) => {
      if (popup) popup.remove();
      if (!e.features.length) return;

      const props = e.features[0].properties;
      const meta = this.#featuresLookup[props.feature_id] || {};

      const name = meta.name || props.name || "Unnamed feature";
      const customId = meta.custom_id || props.custom_id || "";
      const data = meta.data;

      let html = `<strong>${this.#esc(name)}</strong>`;
      if (customId) html += `<br><span style="opacity:0.6">${this.#esc(customId)}</span>`;
      if (data && typeof data === "object") {
        html += '<div style="margin-top:6px;font-size:0.85em;opacity:0.7">';
        for (const [k, v] of Object.entries(data)) {
          html += `${this.#esc(k)}: ${this.#esc(String(v))}<br>`;
        }
        html += "</div>";
      }

      popup = new maplibregl.Popup({ maxWidth: "280px" })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(this.#map);
    });
  }

  // -------------------------------------------------------------------------
  // UI state helpers
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

customElements.define("region-map", RegionMap);
