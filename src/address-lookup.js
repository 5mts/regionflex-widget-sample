// ---------------------------------------------------------------------------
// <address-lookup> Web Component
//
// Usage:
//   <script src="address-lookup.js"></script>
//   <address-lookup token="YOUR_REGIONFLEX_TOKEN"></address-lookup>
//
// Attributes:
//   token  — RegionFlex bearer token. If set, the token input field is hidden.
//            Can also be entered by the user at runtime via the built-in field.
// ---------------------------------------------------------------------------

import styles from "./address-lookup.css?inline";
import markup from "./address-lookup.html?raw";

// --- Styles & template (created once, shared across all instances) ----------

const sheet = new CSSStyleSheet();
sheet.replaceSync(styles);

const template = document.createElement("template");
template.innerHTML = markup;

// --- Component --------------------------------------------------------------

class AddressLookup extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(template.content.cloneNode(true));

    // If a token is provided via attribute, hide the token input section
    const token = this.getAttribute("token") || "";
    if (token) {
      this.#el("token-input").value = token;
      this.#el("token-section").classList.add("hidden");
    }

    this.#el("lookup-btn").addEventListener("click", () => this.#doLookup());
    this.#el("address-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.#doLookup();
    });
  }

  // Shorthand for querying inside our shadow root
  #el(id) { return this.shadowRoot.getElementById(id); }

  // -------------------------------------------------------------------------
  // Main lookup flow
  // -------------------------------------------------------------------------
  async #doLookup() {
    const address = this.#el("address-input").value.trim();
    const token   = this.getAttribute("token") || this.#el("token-input").value.trim();

    if (!address) return this.#showError("Please enter an address.");
    if (!token)   return this.#showError("Please enter your RegionFlex API token.");

    this.#hideResults();
    this.#setLoading(true);

    try {
      // Step 1 — Geocode the address via Nominatim (OpenStreetMap)
      this.#showStatus("Geocoding address…");
      const geo = await this.#geocode(address);
      this.#displayGeocode(geo);

      // Step 2 — Query RegionFlex for election districts at that point
      this.#showStatus("Querying RegionFlex for districts…");
      const districts = await this.#queryDistricts(geo.lat, geo.lng, token);
      this.#displayDistricts(districts);

      this.#hideStatus();
    } catch (err) {
      this.#showError(err.message);
    } finally {
      this.#setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Step 1: Geocode via Nominatim
  // -------------------------------------------------------------------------
  async #geocode(address) {
    const url =
      "https://nominatim.openstreetmap.org/search" +
      "?q=" + encodeURIComponent(address) +
      "&format=json&limit=1";

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Nominatim returned HTTP " + res.status);

    const data = await res.json();
    if (!data.length) throw new Error("No results found for that address.");

    return {
      displayName: data[0].display_name,
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Query RegionFlex for districts
  // Docs: https://regionflex.com/docs/api/query-features-by-location
  // -------------------------------------------------------------------------
  async #queryDistricts(lat, lng, token) {
    const url =
      "https://app.regionflex.com/api/v1/query" +
      "?lat=" + lat +
      "&lng=" + lng +
      "&fields=id,custom_id,name,region_id" +
      "&per_page=100";

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error("RegionFlex returned HTTP " + res.status + ": " + body);
    }

    const json = await res.json();
    return json.data || json;
  }

  // -------------------------------------------------------------------------
  // Display helpers
  // -------------------------------------------------------------------------
  #displayGeocode({ displayName, lat, lng }) {
    this.#el("geo-name").textContent = displayName;
    this.#el("geo-lat").textContent  = lat.toFixed(6);
    this.#el("geo-lng").textContent  = lng.toFixed(6);
    this.#el("geocode-card").classList.remove("hidden");
  }

  #displayDistricts(districts) {
    const list = this.#el("district-list");
    const none = this.#el("no-districts");
    list.innerHTML = "";

    if (!districts.length) {
      none.classList.remove("hidden");
    } else {
      none.classList.add("hidden");
      for (const d of districts) {
        const li = document.createElement("li");

        const name = document.createElement("span");
        name.className = "district-name";
        name.textContent = d.name || "Unnamed";

        const id = document.createElement("span");
        id.className = "district-id";
        id.textContent = d.custom_id || d.id || "";

        li.append(name, id);
        list.appendChild(li);
      }
    }

    this.#el("district-card").classList.remove("hidden");
  }

  // -------------------------------------------------------------------------
  // UI state helpers
  // -------------------------------------------------------------------------
  #setLoading(on) {
    const btn = this.#el("lookup-btn");
    btn.disabled = on;
    btn.querySelector(".btn-label").textContent = on ? "Looking up…" : "Look Up";
  }

  #showStatus(msg) {
    this.#el("status").textContent = msg;
    this.#el("status").classList.remove("hidden");
    this.#el("error").classList.add("hidden");
  }

  #hideStatus() { this.#el("status").classList.add("hidden"); }

  #showError(msg) {
    this.#el("error").textContent = msg;
    this.#el("error").classList.remove("hidden");
    this.#el("status").classList.add("hidden");
  }

  #hideResults() {
    for (const id of ["geocode-card", "district-card", "error", "status"]) {
      this.#el(id).classList.add("hidden");
    }
  }
}

customElements.define("address-lookup", AddressLookup);
