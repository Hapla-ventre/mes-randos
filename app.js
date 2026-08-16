// ---------- Setup ----------
firebase.initializeApp(window.APP_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

const COLOR_DEFAULT = "#c0392b";  // rando au repos (ou sélectionnée, en rayures blanc/rouge)
const COLOR_EDITING = "#2980b9";  // rando en cours de modification / création

let leafletMap;
let hikes = [];               // loaded from Firestore
let hikeLayers = {};          // id -> { group, line }
let activeHikeId = null;
let distinctColorsEnabled = localStorage.getItem("distinctColors") === "1";

let drawing = false;
let editingHikeId = null;     // id of the hike being modified, or null when creating a new one
let editingHikeData = null;   // full hike object being modified, for prefilling the save form
let waypointMarkers = [];     // draggable L.marker[], in click order (A, B, C…)
let waypointLayer = null;     // layer group holding the markers
let routeLayer = null;        // visible polyline for the route currently being drawn/edited
let routeOutlineLayer = null; // white halo companion drawn beneath routeLayer
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

const chkDistinctColors = document.getElementById("chk-distinct-colors");
chkDistinctColors.checked = distinctColorsEnabled;
chkDistinctColors.addEventListener("change", () => {
  distinctColorsEnabled = chkDistinctColors.checked;
  localStorage.setItem("distinctColors", distinctColorsEnabled ? "1" : "0");
  renderHikeList();
  renderHikeLayers();
});

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
  // the metro-style offset targets a constant pixel gap, so it has to be recomputed on zoom
  leafletMap.on("zoomend", () => { if (distinctColorsEnabled) renderHikeLayers(); });
}

let suppressNextMapClick = false;

function onMapClick(e) {
  if (suppressNextMapClick) { suppressNextMapClick = false; return; }
  if (!drawing) return;
  addWaypoint(e.latlng);
}

// ---------- Waypoints (draggable A, B, C…) ----------
function waypointLabel(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function waypointIcon(index) {
  return L.divIcon({
    className: "",
    html: `<div class="waypoint-icon"><span>${waypointLabel(index)}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 34],
  });
}

function createWaypointMarker(latlng, index) {
  const marker = L.marker(latlng, { icon: waypointIcon(index), draggable: true, zIndexOffset: 1000 }).addTo(waypointLayer);
  marker.on("dragend", () => {
    // the mouseup that ends a marker drag also reaches the map as a click — without this guard
    // it would be read as "add a new point here" and append a stray point at the end.
    suppressNextMapClick = true;
    scheduleReroute();
  });
  return marker;
}

// Re-applies A, B, C… labels in current array order — needed after an insert or a delete
// anywhere but the end, since points keep their position but their index shifts.
function relabelWaypoints() {
  waypointMarkers.forEach((m, i) => m.setIcon(waypointIcon(i)));
}

function addWaypoint(latlng) {
  const marker = createWaypointMarker(latlng, waypointMarkers.length);
  waypointMarkers.push(marker);
  renderWaypointList();
  renderDrawStats(waypointMarkers.length, "computing");
  scheduleReroute();
}

function insertWaypoint(index, latlng) {
  const marker = createWaypointMarker(latlng, index);
  waypointMarkers.splice(index, 0, marker);
  relabelWaypoints();
  renderWaypointList();
}

function removeWaypointAt(index) {
  const marker = waypointMarkers[index];
  if (!marker) return;
  if (waypointLayer) waypointLayer.removeLayer(marker);
  waypointMarkers.splice(index, 1);
  relabelWaypoints();
  renderWaypointList();
  renderDrawStats(waypointMarkers.length, "computing");
  scheduleReroute();
}

function renderWaypointList() {
  const el = document.getElementById("waypoint-list");
  el.innerHTML = "";
  waypointMarkers.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "waypoint-row";
    row.innerHTML = `<span class="waypoint-row-label">${waypointLabel(i)}</span><span class="waypoint-row-hint">glisse sur la carte pour déplacer</span>`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "waypoint-row-del";
    del.title = "Supprimer ce point";
    del.textContent = "✕";
    del.addEventListener("click", () => removeWaypointAt(i));
    row.appendChild(del);
    el.appendChild(row);
  });
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
  if (routeOutlineLayer) leafletMap.removeLayer(routeOutlineLayer);
  routeOutlineLayer = L.polyline(result.coordinates, { color: "#ffffff", weight: 7, opacity: 1 }).addTo(leafletMap);
  routeLayer = L.polyline(result.coordinates, {
    color: COLOR_EDITING, weight: 4, opacity: 0.9, className: "route-line-editable",
  }).addTo(leafletMap);
  routeLayer.on("mousedown", onRouteLineMouseDown);
  renderDrawStats(positions.length);
}

// Grab the route line itself (not one of the lettered points) to insert a new point right there
// and drag it into place — this is how you "pull" the path onto a different street/trail.
function onRouteLineMouseDown(e) {
  if (!drawing) return;
  if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
  leafletMap.dragging.disable();

  const index = findInsertIndex(e.latlng);
  insertWaypoint(index, e.latlng);
  const marker = waypointMarkers[index];

  function onMove(ev) {
    marker.setLatLng(ev.latlng);
  }
  function onUp() {
    leafletMap.off("mousemove", onMove);
    leafletMap.off("mouseup", onUp);
    leafletMap.dragging.enable();
    suppressNextMapClick = true; // same click-leak as marker drag — don't add a second point
    scheduleReroute();
  }
  leafletMap.on("mousemove", onMove);
  leafletMap.on("mouseup", onUp);
}

// Finds which existing segment (between waypoint i and i+1) a point is closest to, so an
// inserted point lands at the right place in the A→B→C… sequence.
function findInsertIndex(latlng) {
  const positions = currentWaypointPositions();
  if (positions.length < 2) return positions.length;
  let bestIndex = positions.length;
  let bestDist = Infinity;
  for (let i = 0; i < positions.length - 1; i++) {
    const d = distanceToSegment([latlng.lat, latlng.lng], positions[i], positions[i + 1]);
    if (d < bestDist) { bestDist = d; bestIndex = i + 1; }
  }
  return bestIndex;
}

// Planar approximation (fine at hiking-route scale) of the distance from a point to a segment.
function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------- Draw hike flow ----------
const drawPanel = document.getElementById("draw-panel");
const savePanel = document.getElementById("save-panel");

document.getElementById("btn-new-hike").addEventListener("click", startDrawing);
document.getElementById("btn-cancel-draw").addEventListener("click", cancelDrawing);
document.getElementById("btn-undo-point").addEventListener("click", () => {
  const marker = waypointMarkers.pop();
  if (marker && waypointLayer) waypointLayer.removeLayer(marker);
  renderWaypointList();
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

  // Hikes saved before routing existed have no separate "waypoints" — their coordinates
  // were the raw click points, so they work as a starting point for editing.
  const startPoints = hike.waypoints.length > 0 ? hike.waypoints : hike.coordinates;
  startPoints.forEach((pos) => addWaypoint(L.latLng(pos[0], pos[1])));

  const bounds = L.polyline(hike.coordinates).getBounds();
  leafletMap.fitBounds(bounds, { padding: [40, 40] });
}

function resetDrawingState() {
  clearTimeout(rerouteTimer);
  waypointMarkers = [];
  if (waypointLayer) { leafletMap.removeLayer(waypointLayer); waypointLayer = null; }
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (routeOutlineLayer) { leafletMap.removeLayer(routeOutlineLayer); routeOutlineLayer = null; }
  routeResult = null;
  document.getElementById("waypoint-list").innerHTML = "";
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
    const swatchColor = distinctColorsEnabled ? colorForHikeId(h.id) : COLOR_DEFAULT;
    el.innerHTML = `
      <div class="name"><span class="swatch" style="background:${swatchColor}"></span>${escapeHtml(h.name)}</div>
      <div class="meta">${h.date ? formatDate(h.date) : "Sans date"} · ${h.distanceKm != null ? h.distanceKm.toFixed(1) + " km" : ""}${h.elevationGainM != null ? " · D+ " + Math.round(h.elevationGainM) + " m" : ""}</div>
    `;
    el.addEventListener("click", () => showDetail(h.id));
    listEl.appendChild(el);
  });
}

// Builds the map layers for one hike: the line itself (default red — or a distinct color when
// that mode is on —, selected red/white stripes, or editing blue) plus black/white-outlined
// arrowheads along it showing the direction of travel, legible against any basemap.
function buildHikeLayerGroup(coords, state, baseColor) {
  const group = L.layerGroup();
  const color = baseColor || COLOR_DEFAULT;
  const lineWeight = state === "selected" ? 6 : state === "editing" ? 5 : 4;
  let line;

  // White halo under every state, not just when selected, so the line itself stays legible
  // over dark/busy basemaps (satellite, relief) the same way the arrowheads already do.
  L.polyline(coords, { color: "#ffffff", weight: lineWeight + 3, opacity: 1 }).addTo(group);

  if (state === "selected") {
    line = L.polyline(coords, { color, weight: lineWeight, opacity: 1, dashArray: "12,12" }).addTo(group);
  } else if (state === "editing") {
    line = L.polyline(coords, { color: COLOR_EDITING, weight: lineWeight, opacity: 0.95 }).addTo(group);
  } else {
    line = L.polyline(coords, { color, weight: lineWeight, opacity: 0.95 }).addTo(group);
  }

  // Pixel offsets/repeat (not "%") so spacing tracks the map's current scale: zoom in and more
  // arrowheads appear per screen, instead of them thinning out to nothing on a long hike.
  L.polylineDecorator(line, {
    patterns: [{
      offset: 20,
      repeat: 90,
      symbol: L.Symbol.arrowHead({
        pixelSize: 13,
        headAngle: 32,        // narrow tip angle = a clean, unmistakably isosceles triangle
        polygon: true,
        pathOptions: { color: "#ffffff", weight: 1.5, fillColor: "#161616", fillOpacity: 1, lineJoin: "miter" },
      }),
    }],
  }).addTo(group);

  return { group, line };
}

function renderHikeLayers() {
  Object.values(hikeLayers).forEach(({ group }) => leafletMap.removeLayer(group));
  hikeLayers = {};

  const visible = hikes.filter((h) => h.id !== editingHikeId);
  const coordsById = distinctColorsEnabled ? computeOverlapOffsets(visible) : null;

  visible.forEach((h) => {
    const state = h.id === activeHikeId ? "selected" : "default";
    const baseColor = distinctColorsEnabled ? colorForHikeId(h.id) : COLOR_DEFAULT;
    const coords = coordsById ? coordsById[h.id] : h.coordinates;
    const { group, line } = buildHikeLayerGroup(coords, state, baseColor);
    group.addTo(leafletMap);
    line.on("click", () => showDetail(h.id));
    line.bindTooltip(h.name);
    hikeLayers[h.id] = { group, line };
  });
}

// ---------- Distinct colors & metro-style overlap offset ----------
const DISTINCT_COLORS = ["#2e7d32", "#2980b9", "#e67e22", "#8e44ad", "#16a085", "#d35400", "#c0392b", "#2c3e50", "#f39c12", "#7f8c8d"];

function colorForHikeId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return DISTINCT_COLORS[hash % DISTINCT_COLORS.length];
}

// Roughly how many meters one screen pixel covers at a given latitude/zoom (standard Web
// Mercator tile math) — lets the offset target a constant screen gap instead of a constant
// real-world one, so it neither vanishes when zoomed out nor looks absurdly wide zoomed in.
function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// Approximation, not true segment-level route bundling: wherever two hikes pass within
// OFFSET_THRESHOLD_M of each other in reality, nudge them apart perpendicular to their
// direction so they read like parallel metro lines instead of one solid stack. Everywhere
// else, paths stay exact. The "are they close" check is a fixed real-world distance (generous,
// since two independently-drawn/routed digitizations of "the same trail" can easily land
// 15-20m apart); the visual gap itself is computed in pixels so it holds steady as the map
// is zoomed, and sized to clear the line's full rendered width (halo included).
function computeOverlapOffsets(hikeList) {
  const OFFSET_THRESHOLD_M = 20;
  const OFFSET_PIXELS = 8;
  const marginDeg = OFFSET_THRESHOLD_M / 111320;
  const zoom = leafletMap.getZoom();

  const boxes = hikeList.map((h) => boundsOf(h.coordinates));
  const result = {};

  hikeList.forEach((h, hi) => {
    const nearby = [];
    hikeList.forEach((other, oi) => {
      if (oi === hi) return;
      if (boxesOverlap(boxes[hi], boxes[oi], marginDeg)) nearby.push(other);
    });

    if (nearby.length === 0) {
      result[h.id] = h.coordinates;
      return;
    }

    result[h.id] = h.coordinates.map(([lat, lng], i) => {
      // Every hike coincident at this exact spot, sorted the same deterministic way (by id) no
      // matter which of them is doing the computing — that's what guarantees two overlapping
      // hikes always land on DIFFERENT sides instead of a coin-flip chance of picking the same one.
      const coincidentIds = [h.id];
      nearby.forEach((other) => {
        if (other.coordinates.some(([olat, olng]) => haversineMeters([lat, lng], [olat, olng]) < OFFSET_THRESHOLD_M)) {
          coincidentIds.push(other.id);
        }
      });
      if (coincidentIds.length <= 1) return [lat, lng];
      coincidentIds.sort();
      const rank = coincidentIds.indexOf(h.id) - (coincidentIds.length - 1) / 2;
      if (rank === 0) return [lat, lng];

      const prev = h.coordinates[Math.max(0, i - 1)];
      const next = h.coordinates[Math.min(h.coordinates.length - 1, i + 1)];
      const dLat = next[0] - prev[0], dLng = next[1] - prev[1];
      const len = Math.hypot(dLat, dLng) || 1;
      const perpLat = -dLng / len, perpLng = dLat / len;
      const offsetStepM = OFFSET_PIXELS * metersPerPixel(lat, zoom);
      const offsetDeg = (rank * offsetStepM) / 111320;
      return [lat + perpLat * offsetDeg, lng + perpLng * offsetDeg];
    });
  });

  return result;
}

function boundsOf(coords) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  coords.forEach(([lat, lng]) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  });
  return { minLat, maxLat, minLng, maxLng };
}

function boxesOverlap(a, b, marginDeg) {
  return !(
    a.maxLat + marginDeg < b.minLat || b.maxLat + marginDeg < a.minLat ||
    a.maxLng + marginDeg < b.minLng || b.maxLng + marginDeg < a.minLng
  );
}

// ---------- Detail panel ----------
const detailPanel = document.getElementById("detail-panel");

function showDetail(id) {
  activeHikeId = id;
  const h = hikes.find((x) => x.id === id);
  if (!h) return;

  renderHikeList();

  document.getElementById("detail-name-input").value = h.name;
  document.getElementById("detail-date-input").value = h.date || "";
  document.getElementById("detail-notes-input").value = h.notes || "";
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

// Quick edit for name/date/notes only — no need to touch the route just to fix a typo or a date.
document.getElementById("btn-save-info").addEventListener("click", async () => {
  if (!activeHikeId) return;
  const name = document.getElementById("detail-name-input").value.trim() || "Rando sans nom";
  const date = document.getElementById("detail-date-input").value || null;
  const notes = document.getElementById("detail-notes-input").value.trim();
  try {
    await db.collection("hikes").doc(activeHikeId).update({ name, date, notes });
  } catch (err) {
    alert("Erreur : " + err.message);
    return;
  }
  const id = activeHikeId;
  await loadHikes();
  showDetail(id);
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
    // ORS returns one elevation sample per vertex, which can sit only 1-2m apart on curves —
    // at that spacing, tiny DEM rounding reads as a cliff. Smooth before using it for anything,
    // and compute D+/D- ourselves (ORS's own ascent/descent sums every bit of that same DEM
    // noise with no filtering, which is why it ran noticeably higher than other apps).
    const rawElevations = feature.geometry.coordinates.map((c) => c[2] ?? 0);
    const elevations = smoothElevations(coords, rawElevations, 5);
    const { gain, loss } = computeGainLossHysteresis(elevations);
    const props = feature.properties || {};
    const distanceKm = (props.summary && props.summary.distance != null ? props.summary.distance : pathDistanceKm(coords) * 1000) / 1000;

    return {
      coordinates: coords,
      elevations,
      distanceKm,
      gainM: gain,
      lossM: loss,
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
    const elevations = smoothElevations(dense, rawElevations, 5);
    const { gain, loss } = computeGainLossHysteresis(elevations);
    return {
      coordinates: dense,
      elevations,
      distanceKm,
      gainM: gain,
      lossM: loss,
      maxSlopePct: computeMaxSlopePct(dense, elevations),
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
  // Below ~15m, normal DEM/GPS noise (a meter or two of elevation jitter) reads as a cliff —
  // real trail grades need more horizontal run than that to be measured meaningfully.
  const MIN_SEGMENT_M = 15;
  let max = 0;
  for (let i = 1; i < coords.length; i++) {
    const segM = haversineMeters(coords[i - 1], coords[i]);
    if (segM < MIN_SEGMENT_M) continue;
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

// Moving average over a fixed real-world distance rather than a fixed point count: routed
// geometry isn't evenly spaced (dense on curves, sparse on straights), so a point-count window
// covers a different — and unpredictable — number of meters depending on where you are on the
// path. A distance window stays meaningful everywhere and doesn't over- or under-smooth.
function smoothElevations(coords, elevations, windowMeters = 5) {
  const half = windowMeters / 2;
  return elevations.map((_, i) => {
    let sum = elevations[i];
    let count = 1;
    let dist = 0;
    for (let j = i - 1; j >= 0; j--) {
      dist += haversineMeters(coords[j], coords[j + 1]);
      if (dist > half) break;
      sum += elevations[j];
      count++;
    }
    dist = 0;
    for (let j = i + 1; j < elevations.length; j++) {
      dist += haversineMeters(coords[j - 1], coords[j]);
      if (dist > half) break;
      sum += elevations[j];
      count++;
    }
    return sum / count;
  });
}

// Elevation gain/loss via a hysteresis ("swing") filter: a climb only counts once it reverses
// by at least thresholdM, same principle GPS trip computers and hiking apps use so that every
// meter of DEM jitter doesn't get added up into inflated D+/D- numbers.
function computeGainLossHysteresis(elevations, thresholdM = 10) {
  if (!elevations || elevations.length < 2) return { gain: 0, loss: 0 };
  let gain = 0, loss = 0;
  let base = elevations[0];
  let extreme = elevations[0];
  let rising = null; // null = undecided yet, true = tracking a rise, false = tracking a fall

  for (let i = 1; i < elevations.length; i++) {
    const e = elevations[i];
    if (rising !== false) {
      if (e >= extreme) { extreme = e; rising = true; continue; }
      if (extreme - e >= thresholdM) {
        gain += extreme - base;
        base = extreme;
        extreme = e;
        rising = false;
        continue;
      }
    }
    if (rising !== true) {
      if (e <= extreme) { extreme = e; rising = false; continue; }
      if (e - extreme >= thresholdM) {
        loss += base - extreme;
        base = extreme;
        extreme = e;
        rising = true;
      }
    }
  }

  if (rising === true) gain += extreme - base;
  else if (rising === false) loss += base - extreme;

  return { gain, loss };
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
