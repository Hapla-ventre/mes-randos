// ---------- Setup ----------
firebase.initializeApp(window.APP_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

const COLOR_DEFAULT = "#c0392b";  // rando au repos
const COLOR_SELECTED = "#c0392b"; // rando sélectionnée (rayures blanc/rouge)
const COLOR_EDITING = "#2980b9";  // rando en cours de modification / création

let leafletMap;
let hikes = [];               // loaded from Firestore
let hikeLayers = {};          // id -> { group, line }
let activeHikeId = null;

let drawing = false;
let editingHikeId = null;     // id of the hike being modified, or null when creating a new one
let editingHikeData = null;   // full hike object being modified, for prefilling the save form
let waypointMarkers = [];     // draggable L.marker[], in click order (A, B, C…)
let waypointLayer = null;     // layer group holding the markers
let routeLayer = null;        // visible polyline for the route currently being drawn/edited
let routeResult = null;       // { coordinates, elevations, distanceKm, gainM, lossM, maxSlopePct, surfaceSummary, routed }
let rerouteTimer = null;
let rerouteToken = 0;
let pendingStats = null;      // routeResult snapshot handed to the save panel

// ---------- Auth ----------
const loginScreen = document.getElementById("login-screen");
const appEl = document.getElementById("app");

document.getElementById("btn-signin").addEventListener("click", () => doAuth("signIn"));
document.getElementById("btn-signup").addEventListener("click", () => doAuth("signUp"));
document.getElementById("btn-logout").addEventListener("click", async () => {
  await auth.signOut();
});

async function doAuth(mode) {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  errEl.style.color = "var(--danger)";
  if (!email || !password) {
    errEl.textContent = "Renseigne un email et un mot de passe.";
    return;
  }
  try {
    if (mode === "signUp") {
      await auth.createUserWithEmailAndPassword(email, password);
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (err) {
    errEl.textContent = err.message;
  }
}

function onAuthed(user) {
  if (user) {
    loginScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
    initMapIfNeeded();
    loadHikes();
  } else {
    loginScreen.classList.remove("hidden");
    appEl.classList.add("hidden");
  }
}

// ---------- Map ----------
function initMapIfNeeded() {
  if (leafletMap) return;
  leafletMap = L.map("map").setView([45.5, 6.0], 9); // Alpes par défaut

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 19,
  }).addTo(leafletMap);

  const ign = L.tileLayer(
    "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png",
    { attribution: "&copy; IGN Géoplateforme", maxZoom: 19 }
  );

  // Courbes de niveau + estompage (relief ombré) — rendus pré-calculés par OpenTopoMap à partir
  // du même type de données (SRTM) que les cartes IGN papier, pas de calcul de relief côté client.
  const relief = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenTopoMap (CC-BY-SA), données SRTM",
    maxZoom: 17,
  });

  L.control.layers({ "OpenStreetMap": osm, "IGN": ign, "Relief (courbes + ombrage)": relief }).addTo(leafletMap);

  leafletMap.on("click", onMapClick);
}

function onMapClick(e) {
  if (!drawing) return;
  addWaypoint(e.latlng);
}

// ---------- Waypoints (draggable A, B, C…) ----------
function waypointLabel(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function createWaypointMarker(latlng, index) {
  const icon = L.divIcon({
    className: "",
    html: `<div class="waypoint-icon"><span>${waypointLabel(index)}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
  const marker = L.marker(latlng, { icon, draggable: true }).addTo(waypointLayer);
  marker.on("dragend", scheduleReroute);
  return marker;
}

function addWaypoint(latlng) {
  const marker = createWaypointMarker(latlng, waypointMarkers.length);
  waypointMarkers.push(marker);
  renderDrawStats(waypointMarkers.length, "computing");
  scheduleReroute();
}

function currentWaypointPositions() {
  return waypointMarkers.map((m) => {
    const ll = m.getLatLng();
    return [ll.lat, ll.lng];
  });
}

function scheduleReroute() {
  clearTimeout(rerouteTimer);
  rerouteTimer = setTimeout(rebuildRoute, 350);
}

async function rebuildRoute() {
  const positions = currentWaypointPositions();

  if (positions.length < 2) {
    routeResult = null;
    if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
    renderDrawStats(positions.length);
    return;
  }

  renderDrawStats(positions.length, "computing");
  const token = ++rerouteToken;
  let result = await fetchOrsRoute(positions);
  if (!result) result = await fallbackStraightRoute(positions);
  if (token !== rerouteToken) return; // a newer reroute superseded this one

  routeResult = result;
  if (routeLayer) leafletMap.removeLayer(routeLayer);
  routeLayer = L.polyline(result.coordinates, { color: COLOR_EDITING, weight: 4, opacity: 0.9 }).addTo(leafletMap);
  renderDrawStats(positions.length);
}

// ---------- Draw hike flow ----------
const drawPanel = document.getElementById("draw-panel");
const savePanel = document.getElementById("save-panel");

document.getElementById("btn-new-hike").addEventListener("click", startDrawing);
document.getElementById("btn-cancel-draw").addEventListener("click", cancelDrawing);
document.getElementById("btn-undo-point").addEventListener("click", () => {
  const marker = waypointMarkers.pop();
  if (marker && waypointLayer) waypointLayer.removeLayer(marker);
  renderDrawStats(waypointMarkers.length, "computing");
  scheduleReroute();
});
document.getElementById("btn-finish-draw").addEventListener("click", finishDrawing);
document.getElementById("btn-cancel-save").addEventListener("click", () => {
  savePanel.classList.add("hidden");
  cancelDrawing();
});
document.getElementById("btn-save-hike").addEventListener("click", saveHike);

function startDrawing() {
  closeDetail();
  editingHikeId = null;
  editingHikeData = null;
  resetDrawingState();
  drawing = true;
  waypointLayer = L.layerGroup().addTo(leafletMap);
  document.getElementById("btn-new-hike").classList.add("hidden");
  document.getElementById("draw-hint").textContent =
    "Clique sur la carte pour poser des points (A, B, C…) — l'itinéraire suit les sentiers entre eux. Glisse un point pour le corriger.";
  document.getElementById("btn-finish-draw").textContent = "Terminer le tracé";
  drawPanel.classList.remove("hidden");
  renderDrawStats(0);
}

function startEditingHike(hike) {
  closeDetail();
  editingHikeId = hike.id;
  editingHikeData = hike;
  renderHikeLayers(); // rebuild without this hike's static layer — it's now the live editable one

  resetDrawingState();
  drawing = true;
  waypointLayer = L.layerGroup().addTo(leafletMap);
  document.getElementById("btn-new-hike").classList.add("hidden");
  document.getElementById("draw-hint").textContent =
    "Glisse les points pour corriger le tracé, ajoutes-en en cliquant sur la carte, puis termine.";
  document.getElementById("btn-finish-draw").textContent = "Terminer la modification";
  drawPanel.classList.remove("hidden");

  hike.waypoints.forEach((pos) => addWaypoint(L.latLng(pos[0], pos[1])));

  const bounds = L.polyline(hike.coordinates).getBounds();
  leafletMap.fitBounds(bounds, { padding: [40, 40] });
}

function resetDrawingState() {
  clearTimeout(rerouteTimer);
  waypointMarkers = [];
  if (waypointLayer) { leafletMap.removeLayer(waypointLayer); waypointLayer = null; }
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  routeResult = null;
}

function cancelDrawing() {
  drawing = false;
  const wasEditing = editingHikeId !== null;
  editingHikeId = null;
  editingHikeData = null;
  resetDrawingState();
  drawPanel.classList.add("hidden");
  document.getElementById("btn-new-hike").classList.remove("hidden");
  if (wasEditing) renderHikeLayers(); // bring back the hike's static layer, unchanged
}

async function finishDrawing() {
  const positions = currentWaypointPositions();
  if (positions.length < 2) {
    alert("Place au moins deux points.");
    return;
  }
  drawing = false;
  clearTimeout(rerouteTimer);
  renderDrawStats(positions.length, "computing");
  await rebuildRoute(); // make sure routeResult reflects the final, possibly just-dragged, positions

  drawPanel.classList.add("hidden");
  savePanel.classList.remove("hidden");
  document.getElementById("hike-name").value = editingHikeData ? editingHikeData.name : "";
  document.getElementById("hike-notes").value = editingHikeData ? (editingHikeData.notes || "") : "";
  if (editingHikeData && editingHikeData.date) {
    document.getElementById("hike-date").value = editingHikeData.date;
  } else {
    document.getElementById("hike-date").valueAsDate = new Date();
  }
  document.getElementById("btn-save-hike").textContent = editingHikeId ? "Enregistrer les modifications" : "Enregistrer";

  pendingStats = routeResult;
  renderStatsPreview("hike-stats-preview", { distanceKm: pendingStats.distanceKm, gainM: pendingStats.gainM, lossM: pendingStats.lossM });
  renderExtraInfo("hike-extra-info", pendingStats);
}

async function saveHike() {
  const name = document.getElementById("hike-name").value.trim() || "Rando sans nom";
  const date = document.getElementById("hike-date").value || null;
  const notes = document.getElementById("hike-notes").value.trim();
  const positions = currentWaypointPositions();

  const payload = {
    userId: auth.currentUser.uid,
    name,
    date,
    notes,
    waypoints: positions.map(([lat, lng]) => ({ lat, lng })),
    coordinates: pendingStats.coordinates.map(([lat, lng]) => ({ lat, lng })),
    elevations: pendingStats.elevations,
    distanceKm: pendingStats.distanceKm,
    elevationGainM: pendingStats.gainM,
    elevationLossM: pendingStats.lossM,
    maxSlopePct: pendingStats.maxSlopePct,
    surfaceSummary: pendingStats.surfaceSummary,
    routed: pendingStats.routed,
  };

  try {
    if (editingHikeId) {
      await db.collection("hikes").doc(editingHikeId).update(payload);
    } else {
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("hikes").add(payload);
    }
  } catch (err) {
    alert("Erreur à l'enregistrement : " + err.message);
    return;
  }

  document.getElementById("hike-name").value = "";
  document.getElementById("hike-notes").value = "";
  document.getElementById("btn-save-hike").textContent = "Enregistrer";
  savePanel.classList.add("hidden");
  document.getElementById("btn-new-hike").classList.remove("hidden");
  editingHikeId = null;
  editingHikeData = null;
  resetDrawingState();

  await loadHikes();
}

// ---------- Load & render hikes ----------
async function loadHikes() {
  let snapshot;
  try {
    snapshot = await db.collection("hikes").where("userId", "==", auth.currentUser.uid).get();
  } catch (err) {
    console.error(err);
    return;
  }
  hikes = snapshot.docs
    .map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name,
        date: d.date,
        notes: d.notes,
        waypoints: (d.waypoints || []).map((c) => [c.lat, c.lng]),
        coordinates: d.coordinates.map((c) => [c.lat, c.lng]),
        distanceKm: d.distanceKm,
        elevationGainM: d.elevationGainM,
        elevationLossM: d.elevationLossM,
        elevations: d.elevations,
        maxSlopePct: d.maxSlopePct != null ? d.maxSlopePct : null,
        surfaceSummary: d.surfaceSummary || null,
        routed: !!d.routed,
      };
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  renderHikeList();
  renderHikeLayers();
}

function renderHikeList() {
  const listEl = document.getElementById("hike-list");
  listEl.innerHTML = "";
  if (hikes.length === 0) {
    listEl.innerHTML = "<p class='empty-state'>Aucune rando pour l'instant.<br>Clique sur \"Nouvelle rando\" pour tracer la première.</p>";
    return;
  }
  hikes.forEach((h) => {
    const isActive = h.id === activeHikeId;
    const el = document.createElement("div");
    el.className = "hike-item" + (isActive ? " active" : "");
    el.innerHTML = `
      <div class="name"><span class="swatch" style="background:${COLOR_DEFAULT}"></span>${escapeHtml(h.name)}</div>
      <div class="meta">${h.date ? formatDate(h.date) : "Sans date"} · ${h.distanceKm != null ? h.distanceKm.toFixed(1) + " km" : ""}${h.elevationGainM != null ? " · D+ " + Math.round(h.elevationGainM) + " m" : ""}</div>
    `;
    el.addEventListener("click", () => showDetail(h.id));
    listEl.appendChild(el);
  });
}

// Builds the map layers for one hike: the line itself (default red, selected red/white
// stripes, or editing blue) plus arrowheads along it showing the direction of travel.
function buildHikeLayerGroup(coords, state) {
  const group = L.layerGroup();
  let line;

  if (state === "selected") {
    L.polyline(coords, { color: "#ffffff", weight: 6, opacity: 1 }).addTo(group);
    line = L.polyline(coords, { color: COLOR_SELECTED, weight: 6, opacity: 1, dashArray: "12,12" }).addTo(group);
  } else if (state === "editing") {
    line = L.polyline(coords, { color: COLOR_EDITING, weight: 5, opacity: 0.95 }).addTo(group);
  } else {
    line = L.polyline(coords, { color: COLOR_DEFAULT, weight: 4, opacity: 0.9 }).addTo(group);
  }

  const arrowColor = state === "editing" ? COLOR_EDITING : COLOR_DEFAULT;
  L.polylineDecorator(line, {
    patterns: [{
      offset: "5%",
      repeat: "10%",
      symbol: L.Symbol.arrowHead({
        pixelSize: 9,
        polygon: true,
        pathOptions: { color: arrowColor, fillColor: arrowColor, fillOpacity: 1, weight: 0 },
      }),
    }],
  }).addTo(group);

  return { group, line };
}

function renderHikeLayers() {
  Object.values(hikeLayers).forEach(({ group }) => leafletMap.removeLayer(group));
  hikeLayers = {};
  hikes.forEach((h) => {
    if (h.id === editingHikeId) return; // this hike is currently shown as the live editable route instead
    const { group, line } = buildHikeLayerGroup(h.coordinates, h.id === activeHikeId ? "selected" : "default");
    group.addTo(leafletMap);
    line.on("click", () => showDetail(h.id));
    line.bindTooltip(h.name);
    hikeLayers[h.id] = { group, line };
  });
}

// ---------- Detail panel ----------
const detailPanel = document.getElementById("detail-panel");

function showDetail(id) {
  activeHikeId = id;
  const h = hikes.find((x) => x.id === id);
  if (!h) return;

  renderHikeList();

  document.getElementById("detail-name").textContent = h.name;
  document.getElementById("detail-date").textContent = h.date ? formatDate(h.date) : "";
  document.getElementById("detail-notes").textContent = h.notes || "";
  renderStatsPreview("detail-stats", {
    distanceKm: h.distanceKm,
    gainM: h.elevationGainM,
    lossM: h.elevationLossM,
  });
  renderExtraInfo("detail-extra-info", h);
  drawElevationProfile(h.elevations);
  detailPanel.classList.remove("hidden");

  renderHikeLayers();
  const layer = hikeLayers[id];
  if (layer) leafletMap.fitBounds(layer.line.getBounds(), { padding: [40, 40] });
}

document.getElementById("btn-close-detail").addEventListener("click", closeDetail);
function closeDetail() {
  activeHikeId = null;
  detailPanel.classList.add("hidden");
  renderHikeList();
  renderHikeLayers();
}

document.getElementById("btn-edit-hike").addEventListener("click", () => {
  const h = hikes.find((x) => x.id === activeHikeId);
  if (h) startEditingHike(h);
});

document.getElementById("btn-delete-hike").addEventListener("click", async () => {
  if (!activeHikeId) return;
  if (!confirm("Supprimer cette rando ?")) return;
  try {
    await db.collection("hikes").doc(activeHikeId).delete();
  } catch (err) {
    alert("Erreur : " + err.message);
    return;
  }
  closeDetail();
  await loadHikes();
});

function renderStatsPreview(elId, stats) {
  const el = document.getElementById(elId);
  el.innerHTML = `
    <div class="stat"><b>${stats.distanceKm != null ? stats.distanceKm.toFixed(2) : "–"}</b>km</div>
    <div class="stat"><b>${stats.gainM != null ? "+" + Math.round(stats.gainM) : "–"}</b>D+ (m)</div>
    <div class="stat"><b>${stats.lossM != null ? "-" + Math.round(stats.lossM) : "–"}</b>D- (m)</div>
  `;
}

function renderExtraInfo(elId, result) {
  const el = document.getElementById(elId);
  if (!result) { el.textContent = ""; return; }
  const bits = [];
  if (result.maxSlopePct != null) bits.push(`Pente max ${result.maxSlopePct.toFixed(0)} %`);
  if (result.surfaceSummary) bits.push(result.surfaceSummary);
  if (result.routed === false) bits.push("Ligne directe — itinéraire indisponible");
  el.textContent = bits.join(" · ");
}

function renderDrawStats(count, state) {
  const statsEl = document.getElementById("draw-stats");
  const extraEl = document.getElementById("draw-extra-info");

  if (count < 2) {
    statsEl.textContent = count === 0 ? "0 point" : "1 point";
    extraEl.textContent = "";
    return;
  }
  if (state === "computing") {
    statsEl.textContent = `${count} points · calcul de l'itinéraire…`;
    return;
  }
  if (!routeResult) {
    statsEl.textContent = `${count} points`;
    extraEl.textContent = "";
    return;
  }
  const r = routeResult;
  statsEl.innerHTML = `${count} points · ${r.distanceKm.toFixed(2)} km` +
    (r.gainM != null ? ` · D+ ${Math.round(r.gainM)} m · D- ${Math.round(r.lossM)} m` : "");
  renderExtraInfo("draw-extra-info", r);
}

function drawElevationProfile(elevations) {
  const canvas = document.getElementById("elevation-profile");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!elevations || elevations.length < 2) return;

  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const range = Math.max(max - min, 1);
  const w = canvas.width, h = canvas.height, pad = 6;

  ctx.beginPath();
  elevations.forEach((e, i) => {
    const x = pad + (i / (elevations.length - 1)) * (w - pad * 2);
    const y = h - pad - ((e - min) / range) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#2e7d32";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w - pad, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fillStyle = "rgba(46,125,50,0.15)";
  ctx.fill();
}

// ---------- Routing (OpenRouteService, foot-hiking) ----------
const WAYTYPE_LABELS = {
  0: "Terrain mixte", 1: "Route nationale", 2: "Route", 3: "Rue", 4: "Chemin",
  5: "Piste", 6: "Voie cyclable", 7: "Sentier", 8: "Escaliers", 9: "Bac", 10: "Chantier",
};

function summarizeWaytype(extras) {
  const wt = extras && extras.waytype;
  if (!wt || !wt.summary || !wt.summary.length) return null;
  const sorted = [...wt.summary].sort((a, b) => b.amount - a.amount);
  const top = sorted[0];
  const label = WAYTYPE_LABELS[top.value] || "Terrain mixte";
  const pct = Math.round(top.amount);
  if (sorted.length === 1 || pct >= 85) return `Principalement ${label.toLowerCase()}`;
  const second = WAYTYPE_LABELS[sorted[1].value] || "terrain mixte";
  return `${label} (${pct} %) · ${second.toLowerCase()}`;
}

async function fetchOrsRoute(positions) {
  const key = window.APP_CONFIG.ORS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openrouteservice.org/v2/directions/foot-hiking/geojson", {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinates: positions.map(([lat, lng]) => [lng, lat]),
        elevation: true,
        extra_info: ["waytype"],
      }),
    });
    if (!res.ok) return null;
    const geo = await res.json();
    const feature = geo.features && geo.features[0];
    if (!feature) return null;

    const coords = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const elevations = feature.geometry.coordinates.map((c) => c[2] ?? 0);
    const props = feature.properties || {};
    const distanceKm = (props.summary && props.summary.distance != null ? props.summary.distance : pathDistanceKm(coords) * 1000) / 1000;

    return {
      coordinates: coords,
      elevations,
      distanceKm,
      gainM: props.ascent != null ? props.ascent : null,
      lossM: props.descent != null ? props.descent : null,
      maxSlopePct: computeMaxSlopePct(coords, elevations),
      surfaceSummary: summarizeWaytype(props.extras),
      routed: true,
    };
  } catch (err) {
    console.error("Itinéraire OpenRouteService indisponible", err);
    return null;
  }
}

async function fallbackStraightRoute(positions) {
  const distanceKm = pathDistanceKm(positions);
  try {
    const dense = densifyPath(positions, 30);
    const rawElevations = await fetchElevations(dense);
    const { gain, loss, smoothed } = computeGainLoss(rawElevations);
    return {
      coordinates: dense,
      elevations: smoothed,
      distanceKm,
      gainM: gain,
      lossM: loss,
      maxSlopePct: computeMaxSlopePct(dense, smoothed),
      surfaceSummary: null,
      routed: false,
    };
  } catch (err) {
    console.error("Altitude indisponible", err);
    return {
      coordinates: positions,
      elevations: null,
      distanceKm,
      gainM: null,
      lossM: null,
      maxSlopePct: null,
      surfaceSummary: null,
      routed: false,
    };
  }
}

// ---------- Geometry / elevation helpers ----------
function haversineMeters([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pathDistanceKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total / 1000;
}

function computeMaxSlopePct(coords, elevations) {
  if (!elevations || elevations.length < 2) return null;
  let max = 0;
  for (let i = 1; i < coords.length; i++) {
    const segM = haversineMeters(coords[i - 1], coords[i]);
    if (segM < 3) continue;
    const slope = Math.abs((elevations[i] - elevations[i - 1]) / segM) * 100;
    if (slope > max) max = slope;
  }
  return max;
}

// Insert extra points along the path so elevation samples are ~every STEP meters
function densifyPath(points, stepMeters = 30) {
  const dense = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    const segMeters = haversineMeters(points[i - 1], points[i]);
    const steps = Math.max(1, Math.round(segMeters / stepMeters));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      dense.push([lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t]);
    }
  }
  return dense;
}

async function fetchElevations(points) {
  const chunkSize = 100;
  const elevations = [];
  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize);
    const lats = chunk.map((p) => p[0]).join(",");
    const lons = chunk.map((p) => p[1]).join(",");
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
    if (!res.ok) throw new Error("Elevation API error");
    const json = await res.json();
    elevations.push(...json.elevation);
  }
  return elevations;
}

// Smooth with a simple moving average to reduce dataset noise, then sum gains/losses
function computeGainLoss(elevations, smoothWindow = 3, noiseThresholdM = 1) {
  const smoothed = elevations.map((_, i) => {
    const start = Math.max(0, i - smoothWindow);
    const end = Math.min(elevations.length, i + smoothWindow + 1);
    const slice = elevations.slice(start, end);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });

  let gain = 0, loss = 0;
  for (let i = 1; i < smoothed.length; i++) {
    const diff = smoothed[i] - smoothed[i - 1];
    if (diff > noiseThresholdM) gain += diff;
    else if (diff < -noiseThresholdM) loss += -diff;
  }
  return { gain, loss, smoothed };
}

// ---------- Misc ----------
function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Boot ----------
auth.onAuthStateChanged(onAuthed);
