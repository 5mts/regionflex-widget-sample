// ---------------------------------------------------------------------------
// <address-lookup> Web Component
//
// Usage:
//   <script src="address-lookup.js"></script>
//   <address-lookup token="YOUR_REGIONFLEX_TOKEN"></address-lookup>
//
// Attributes:
//   token  — RegionFlex bearer token (required).
//            Can also be set later via element.setAttribute("token", "…")
//            or by letting the user paste it into the built-in token field.
// ---------------------------------------------------------------------------

class AddressLookup extends HTMLElement {
  #$;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    const token = this.getAttribute("token") || "";
    this.shadowRoot.innerHTML = this.#template(token);
    this.#bind();
  }

  // -------------------------------------------------------------------------
  // Template & styles (fully self-contained inside Shadow DOM)
  // -------------------------------------------------------------------------
  #template(token) {
    return `
      <style>${this.#styles()}</style>

      <div class="wrapper">
        <div class="header">
          <h2>Address District Lookup</h2>
          <p class="subtitle">
            Enter an address to geocode it and look up its election districts via
            <a href="https://regionflex.com" target="_blank">RegionFlex</a>.
          </p>
        </div>

        <div id="token-section" class="${token ? "hidden" : ""}">
          <label class="label" for="token-input">RegionFlex API Token</label>
          <input
            id="token-input"
            type="password"
            placeholder="Paste your bearer token here"
            class="input"
            value="${this.#escapeAttr(token)}"
          />
          <p class="hint">Token is only used in-browser and never sent anywhere else.</p>
        </div>

        <label class="label" for="address-input">Address</label>
        <div class="row">
          <input
            id="address-input"
            type="text"
            placeholder="e.g. 1600 Pennsylvania Ave NW, Washington, DC"
            class="input flex-1"
          />
          <button id="lookup-btn" class="btn"><span class="btn-label">Look Up</span></button>
        </div>

        <div id="status" class="status hidden"></div>
        <div id="error"  class="error hidden"></div>

        <div id="geocode-card" class="card hidden">
          <h3 class="card-title">Geocoded Location</h3>
          <p id="geo-name"></p>
          <div class="coord-row">
            <span>Lat: <strong id="geo-lat"></strong></span>
            <span>Lng: <strong id="geo-lng"></strong></span>
          </div>
        </div>

        <div id="district-card" class="card hidden">
          <h3 class="card-title">Election Districts</h3>
          <ul id="district-list"></ul>
          <p id="no-districts" class="empty hidden">No districts found for this location.</p>
        </div>

        <p class="footer">
          Geocoding via <a href="https://nominatim.openstreetmap.org" target="_blank">Nominatim / OpenStreetMap</a> (demo only).
          District data via <a href="https://regionflex.com/docs/api/query-features-by-location" target="_blank">RegionFlex API</a>.
        </p>
      </div>
    `;
  }

  #styles() {
    // Minimal structural styles only — inherits font, color, size from host page.
    return `
      :host { display: block; }

      * { box-sizing: border-box; font: inherit; color: inherit; }

      .wrapper  { display: flex; flex-direction: column; gap: 0.75rem; }
      h2        { margin: 0; font-size: 1.25em; font-weight: 700; }
      .subtitle { margin: 0.25rem 0 0; opacity: 0.6; }
      .subtitle a { text-decoration: underline; }

      .label { font-weight: 500; margin-bottom: -0.25rem; }
      .hint  { margin: -0.25rem 0 0; font-size: 0.85em; opacity: 0.4; }

      .input {
        display: block; width: 100%;
        border: 1px solid currentColor; opacity: 0.7;
        border-radius: 0.375rem; padding: 0.5rem 0.75rem;
      }
      .input:focus { opacity: 1; outline: 2px solid currentColor; outline-offset: 1px; }

      .row    { display: flex; gap: 0.5rem; }
      .flex-1 { flex: 1; }

      .btn {
        flex-shrink: 0; padding: 0.5rem 1rem;
        background: currentColor; border: none; border-radius: 0.375rem;
        font-weight: 500; cursor: pointer;
      }
      .btn-label { color: white; mix-blend-mode: difference; }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }

      .error { border: 1px solid #b91c1c; color: #b91c1c; border-radius: 0.375rem; padding: 0.75rem; }

      .card {
        border: 1px solid currentColor; opacity: 0.8;
        border-radius: 0.5rem; padding: 1rem;
      }
      .card-title { margin: 0 0 0.5rem; font-size: 0.8em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.5; }

      .coord-row { display: flex; gap: 1.5rem; margin-top: 0.5rem; opacity: 0.7; }

      ul { list-style: none; margin: 0; padding: 0; }
      li { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid currentColor; opacity: 0.8; }
      li:last-child { border-bottom: none; }
      .district-name { font-weight: 500; }
      .district-id   { font-size: 0.85em; opacity: 0.5; }

      .empty  { font-style: italic; opacity: 0.4; margin: 0.5rem 0 0; }

      .footer   { font-size: 0.85em; opacity: 0.4; padding-top: 0.5rem; }
      .footer a { text-decoration: underline; }

      .hidden { display: none !important; }
    `;
  }

  // -------------------------------------------------------------------------
  // Bind events
  // -------------------------------------------------------------------------
  #bind() {
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    this.#$ = $;

    $("#lookup-btn").addEventListener("click", () => this.#doLookup());
    $("#address-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.#doLookup();
    });
  }

  // -------------------------------------------------------------------------
  // Main lookup flow
  // -------------------------------------------------------------------------
  async #doLookup() {
    const $ = this.#$;
    const address = $("#address-input").value.trim();
    const token   = this.getAttribute("token") || $("#token-input").value.trim();

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
      "https://regionflex.com/api/query" +
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
    const $ = this.#$;
    $("#geo-name").textContent = displayName;
    $("#geo-lat").textContent  = lat.toFixed(6);
    $("#geo-lng").textContent  = lng.toFixed(6);
    $("#geocode-card").classList.remove("hidden");
  }

  #displayDistricts(districts) {
    const $ = this.#$;
    const list = $("#district-list");
    const none = $("#no-districts");
    list.innerHTML = "";

    if (!districts.length) {
      none.classList.remove("hidden");
    } else {
      none.classList.add("hidden");
      districts.forEach((d) => {
        const li = document.createElement("li");
        li.innerHTML =
          '<span class="district-name">' + this.#esc(d.name || "Unnamed") + "</span>" +
          '<span class="district-id">'   + this.#esc(d.custom_id || d.id || "") + "</span>";
        list.appendChild(li);
      });
    }

    $("#district-card").classList.remove("hidden");
  }

  // -------------------------------------------------------------------------
  // UI state helpers
  // -------------------------------------------------------------------------
  #setLoading(on) {
    const btn = this.#$("#lookup-btn");
    btn.disabled = on;
    btn.querySelector(".btn-label").textContent = on ? "Looking up…" : "Look Up";
  }

  #showStatus(msg) {
    const $ = this.#$;
    $("#status").textContent = msg;
    $("#status").classList.remove("hidden");
    $("#error").classList.add("hidden");
  }

  #hideStatus() { this.#$("#status").classList.add("hidden"); }

  #showError(msg) {
    const $ = this.#$;
    $("#error").textContent = msg;
    $("#error").classList.remove("hidden");
    $("#status").classList.add("hidden");
  }

  #hideResults() {
    const $ = this.#$;
    for (const id of ["#geocode-card", "#district-card", "#error", "#status"]) {
      $(id).classList.add("hidden");
    }
  }

  #esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  #escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

customElements.define("address-lookup", AddressLookup);
