// ---------- Setup ----------
firebase.initializeApp(window.APP_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

const COLOR_DEFAULT = "#c0392b";  // rando au repos (ou sélectionnée, en rayures blanc/rouge)
const COLOR_EDITING = "#2980b9";  // rando en cours de modification / création

// Bumped by hand on every change, shown in the sidebar footer — GitHub Pages can take a minute to
// actually serve a new push, and the browser can also just be showing a cached copy, so this is
// the one reliable way to confirm you're testing the version you think you're testing.
const APP_VERSION = "v30 · 2026-08-17";
document.getElementById("app-version").textContent = APP_VERSION;

let leafletMap;
let hikes = [];               // loaded from Firestore
let hikeLayers = {};          // id -> { group, line }
let activeHikeId = null;
let isolateSelectedHike = false;
let distinctColorsEnabled = localStorage.getItem("distinctColors") === "1";
let sortMode = localStorage.getItem("sortMode") || "date";
let overlapClustersCache = null;      // memoized coincidence detection, expensive part
let overlapClustersForHikes = null;   // which `hikes` array + editing state the cache was built for
let overlapClustersForEditingId = null;
let overlapClustersForDistinctColors = null;

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

async function onAuthed(user) {
  if (user) {
    loginScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
    initMapIfNeeded();
    await loadHikes();
    migrateOutdatedElevations(); // runs in the background, doesn't block the UI
  } else {
    loginScreen.classList.remove("hidden");
    appEl.classList.add("hidden");
  }
}

// Bumped whenever the elevation/gain-loss/slope math changes in a way worth recomputing old
// hikes for. Each hike stores the version it was last computed with; on login, any hike behind
// this number gets its numbers refreshed automatically — nothing else about it is touched.
const ELEVATION_SCHEMA_VERSION = 5;

async function migrateOutdatedElevations() {
  const outdated = hikes.filter((h) => h.elevationSchemaVersion < ELEVATION_SCHEMA_VERSION && h.coordinates.length > 1);
  if (outdated.length === 0) return;

  const statusEl = document.getElementById("migration-status");
  let done = 0;
  statusEl.textContent = `Recalcul du dénivelé de ${outdated.length} rando(s)…`;
  statusEl.classList.remove("hidden");

  for (const h of outdated) {
    try {
      const rawElevations = await fetchElevations(h.coordinates);
      const { gainM, lossM, displayElevations, maxSlopePct } = deriveElevationStats(h.coordinates, rawElevations);
      await db.collection("hikes").doc(h.id).update({
        elevations: displayElevations,
        elevationGainM: gainM,
        elevationLossM: lossM,
        maxSlopePct,
        elevationSchemaVersion: ELEVATION_SCHEMA_VERSION,
      });
    } catch (err) {
      console.error("Recalcul du dénivelé impossible pour cette rando, réessaiera plus tard", h.id, err);
      // left un-stamped on purpose so it's retried next time the app loads, and nothing about
      // the hike itself (coordinates, waypoints, name, notes…) was ever touched either way
      if (err.quotaExceeded) {
        // Every remaining hike in this batch would hit the exact same hourly wall — stop here
        // instead of burning through the rest one doomed attempt (and one 3x retry delay) at a
        // time, and say so plainly instead of leaving the numbers silently unchanged with no clue
        // why nothing seems to update no matter how many times the page is reloaded.
        statusEl.textContent = `Limite de l'API d'altitude atteinte pour cette heure — le recalcul reprendra tout seul plus tard (${done}/${outdated.length} rando(s) faites pour l'instant).`;
        await new Promise((resolve) => setTimeout(resolve, 4000));
        statusEl.classList.add("hidden");
        await loadHikes();
        if (activeHikeId) showDetail(activeHikeId);
        return;
      }
    }
    done++;
    statusEl.textContent = `Recalcul du dénivelé de tes randos… ${done}/${outdated.length}`;
    await new Promise((resolve) => setTimeout(resolve, 400)); // be gentle with the free elevation API
  }

  statusEl.classList.add("hidden");
  await loadHikes();
  // loadHikes() replaces the `hikes` array with the freshly recalculated numbers, but the detail
  // panel (if open) was filled in from the old snapshot at the time it was shown — without this,
  // the stats/profile on screen stay stale until the user closes and reopens it.
  if (activeHikeId) showDetail(activeHikeId);
}

const chkDistinctColors = document.getElementById("chk-distinct-colors");
chkDistinctColors.checked = distinctColorsEnabled;
chkDistinctColors.addEventListener("change", () => {
  distinctColorsEnabled = chkDistinctColors.checked;
  localStorage.setItem("distinctColors", distinctColorsEnabled ? "1" : "0");
  renderHikeList();
  renderHikeLayers();
});

const sortSelect = document.getElementById("sort-select");
sortSelect.value = sortMode;
sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value;
  localStorage.setItem("sortMode", sortMode);
  renderHikeList();
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
  editingHikeId = null;
  editingHikeData = null;
  drawing = true; // set before closeDetail() so its renderHikeLayers() call hides everything else
  closeDetail();
  resetDrawingState();
  waypointLayer = L.layerGroup().addTo(leafletMap);
  document.getElementById("btn-new-hike").classList.add("hidden");
  document.getElementById("draw-hint").textContent =
    "Clique sur la carte pour poser des points (A, B, C…) — l'itinéraire suit les sentiers entre eux. Glisse un point pour le corriger.";
  document.getElementById("btn-finish-draw").textContent = "Terminer le tracé";
  drawPanel.classList.remove("hidden");
  renderDrawStats(0);
}

function startEditingHike(hike) {
  editingHikeId = hike.id;
  editingHikeData = hike;
  drawing = true; // set before closeDetail() so its renderHikeLayers() call hides everything else
  closeDetail();

  resetDrawingState();
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
  editingHikeId = null;
  editingHikeData = null;
  resetDrawingState();
  drawPanel.classList.add("hidden");
  document.getElementById("btn-new-hike").classList.remove("hidden");
  renderHikeLayers(); // bring every hike back now that nothing is being drawn/edited
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
    elevationSchemaVersion: ELEVATION_SCHEMA_VERSION,
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
        elevationSchemaVersion: d.elevationSchemaVersion || 1,
      };
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  renderHikeList();
  renderHikeLayers();
}

function sortedHikes() {
  const list = [...hikes];
  if (sortMode === "distance") list.sort((a, b) => (b.distanceKm || 0) - (a.distanceKm || 0));
  else if (sortMode === "gain") list.sort((a, b) => (b.elevationGainM || 0) - (a.elevationGainM || 0));
  else list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return list;
}

function renderHikeList() {
  const listEl = document.getElementById("hike-list");
  listEl.innerHTML = "";
  if (hikes.length === 0) {
    listEl.innerHTML = "<p class='empty-state'>Aucune rando pour l'instant.<br>Clique sur \"Nouvelle rando\" pour tracer la première.</p>";
    return;
  }
  sortedHikes().forEach((h) => {
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
  if (drawing) return; // keep the map clear of every other hike while actively drawing/editing one

  const editingFiltered = hikes.filter((h) => h.id !== editingHikeId);

  // Self-overlap (an out-and-back's return leg lying almost — but not quite — on top of its own
  // outbound leg) is untangled unconditionally, since it's a rendering artifact of the geometry
  // itself, not tied to the "distinct colors" feature. Separating DIFFERENT hikes from each other
  // only makes sense once they actually have different colors, so that part stays gated. The
  // coincidence detection is the expensive part but doesn't depend on zoom at all — only the
  // pixel→degrees conversion of the offset does — so it's cached and only rebuilt when the hikes,
  // the editing state, or the distinct-colors toggle change; zooming just rescales the cached
  // result, which is what keeps zoom/pan smooth.
  if (overlapClustersForHikes !== hikes || overlapClustersForEditingId !== editingHikeId || overlapClustersForDistinctColors !== distinctColorsEnabled) {
    overlapClustersCache = buildOverlapClusters(editingFiltered, distinctColorsEnabled);
    overlapClustersForHikes = hikes;
    overlapClustersForEditingId = editingHikeId;
    overlapClustersForDistinctColors = distinctColorsEnabled;
  }
  const coordsById = applyOverlapClusters(editingFiltered, overlapClustersCache, leafletMap.getZoom());

  const visible = (isolateSelectedHike && activeHikeId)
    ? editingFiltered.filter((h) => h.id === activeHikeId)
    : editingFiltered;

  visible.forEach((h) => {
    const state = h.id === activeHikeId ? "selected" : "default";
    const baseColor = distinctColorsEnabled ? colorForHikeId(h.id) : COLOR_DEFAULT;
    const coords = coordsById[h.id];
    const { group, line } = buildHikeLayerGroup(coords, state, baseColor);
    group.addTo(leafletMap);
    line.on("click", () => showDetail(h.id));
    line.bindTooltip(h.name);
    hikeLayers[h.id] = { group, line };
  });
}

// ---------- Distinct colors & metro-style overlap offset ----------
//
// THE RULES, in plain terms — two completely separate mechanisms, kept deliberately independent
// so neither can interfere with the other:
//
// 1. SELF-MERGE: wherever a hike's own path comes back and retraces itself (an out-and-back), the
//    later pass is drawn exactly on top of the earlier one. Same rando, same color, so there is
//    nothing to visually tell apart — one continuous line is the correct picture, not two.
//    "Retracing itself" is decided by TWO conditions together, both required:
//      a) close by (within SELF_OVERLAP_THRESHOLD_M in real distance), AND
//      b) travelling in roughly the OPPOSITE direction at that point (a real U-turn, not just a
//         nearby bit of trail heading the same general way).
//    Condition (b) is what a plain distance check can't tell you: a switchback climbs past itself
//    every few meters without ever being "the same out-and-back leg" — those legs run roughly
//    PARALLEL (similar direction), not opposite, so the direction check correctly leaves them
//    alone. Without it, a generous distance threshold merges switchback legs into each other and
//    drags the line off the real trail — which is exactly the bug this replaced.
//
// 2. CROSS-HIKE SEPARATION: wherever a DIFFERENT hike's path comes within OVERLAP_THRESHOLD_M,
//    both are nudged a small, fixed distance to either side of their real position — genuinely
//    different trails (different color) worth telling apart, drawn like parallel metro lines
//    instead of one solid stack. This threshold stays conservative (tighter than self-merge's)
//    because merging two unrelated hikes together would be the actual mistake here, the opposite
//    problem from self-merge.
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

const OVERLAP_THRESHOLD_M = 28;        // cross-hike (different randos) separation distance — two independently-routed hikes on "the same trail" can genuinely sit further apart than they feel like they should on the ground
const SELF_OVERLAP_THRESHOLD_M = 35;   // self-merge (same rando's own out-and-back) — a bit more generous, safe because the direction check (see SELF_OPPOSITE_MAX_DOT below) is what actually guards against false positives, not this number
const SELF_OPPOSITE_MAX_DOT = -0.3;    // the two candidate points' local travel directions, as unit vectors, must dot to below this to count as "opposite ways" (-1 = exact U-turn, 0 = perpendicular, +1 = same direction) — this is what tells a real retrace apart from a switchback leg merely passing nearby
const OVERLAP_SMOOTH_WINDOW = 8;       // points of smoothing on the cross-hike offset, so it ramps in/out instead of snapping side to side
// Routed geometry from ORS is wildly uneven in point density — a bend can have a point every
// couple of meters while a long straight stretch might only have one point every 50-100m. Every
// "how long is this run / how far apart are these two points" question below is answered in real
// METERS along the trail, not point counts, so the same rule behaves consistently whether a given
// stretch happens to be point-dense or point-sparse in the routed data.
const OVERLAP_MIN_RUN_METERS = 30;     // require a sustained run before treating two paths as "running together" — a brief crossing at an angle shouldn't trigger anything
const MIN_SELF_INDEX_GAP_METERS = 40;  // how far apart ALONG THE TRAIL two points of the same hike must be before they can even be considered a separate pass (otherwise every bend would "match itself")
const BRIDGE_MAX_GAP_METERS = 60;      // bridges short dropouts (a stretch where the distance/direction check briefly fails) between two confirmed self-merge runs, so a clearly-shared corridor doesn't flicker on and off
const MAX_POINT_GAP_SAFETY_M = 150;    // worst-case ORS point spacing on a long straight — the grid's neighbor search has to reach at least this far, otherwise two hikes on the very same sparse stretch never even surface each other as CANDIDATES to distance-check, regardless of how tight OVERLAP_THRESHOLD_M itself is

// The expensive step: for every point of every hike, find every OTHER point within threshold —
// from a different hike (if includeOtherHikes), or a distant point of the SAME hike retracing its
// own path (always) — via a spatial grid so this is roughly linear in the total point count
// instead of comparing every pair. Doesn't depend on zoom, so it's cached by the caller and only
// rebuilt when the hikes (or this flag) actually change.
function buildOverlapClusters(hikeList, includeOtherHikes) {
  const hikeById = new Map(hikeList.map((h) => [h.id, h]));
  const cellIndex = new Map();
  // Sized to the LARGEST distance the ±1-cell neighbor scan below needs to reliably reach —
  // not just the overlap thresholds, but also MAX_POINT_GAP_SAFETY_M (see below): on a sparse
  // stretch, the nearest VERTEX of the other hike can legitimately sit much further away than the
  // overlap threshold even while the LINE itself is right there, so the grid has to be coarse
  // enough to still hand back that vertex as a candidate.
  const cellSizeDeg = Math.max(OVERLAP_THRESHOLD_M, SELF_OVERLAP_THRESHOLD_M, MAX_POINT_GAP_SAFETY_M) / 111320;

  function cellKey(lat, lng) {
    return Math.floor(lat / cellSizeDeg) + "_" + Math.floor(lng / cellSizeDeg);
  }

  hikeList.forEach((h) => {
    h.coordinates.forEach(([lat, lng], i) => {
      const key = cellKey(lat, lng);
      if (!cellIndex.has(key)) cellIndex.set(key, []);
      cellIndex.get(key).push({ hikeId: h.id, i, lat, lng });
    });
  });

  function neighborsOf(lat, lng) {
    const cy = Math.floor(lat / cellSizeDeg), cx = Math.floor(lng / cellSizeDeg);
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = cellIndex.get((cy + dy) + "_" + (cx + dx));
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  // Real-world distance from point p to the SEGMENT a→b (not just to its endpoints), via a flat
  // local projection — valid here since consecutive routed points are never more than a couple
  // hundred meters apart, well short of where the Earth's curvature would matter. This is what
  // cross-hike detection actually needs: on a sparse straight stretch, two independently-routed
  // hikes on the very same physical trail almost never have a VERTEX of one within a few meters of
  // a VERTEX of the other — their points interleave along the line rather than coinciding — even
  // though the lines themselves sit right on top of each other. Comparing against the nearest point
  // on the other hike's line, not just its nearest recorded vertex, is what actually answers "is
  // this the same trail here".
  function pointToSegmentMeters(p, a, b) {
    const mLat = 111320, mLng = 111320 * Math.cos((p[0] * Math.PI) / 180);
    const px = p[1] * mLng, py = p[0] * mLat;
    const ax = a[1] * mLng, ay = a[0] * mLat;
    const bx = b[1] * mLng, by = b[0] * mLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // The local direction of travel at point i, as a unit vector — used both to decide "opposite
  // direction" for self-merge and as the perpendicular nudge direction for cross-hike separation.
  function tangentAt(coords, i) {
    const prev = coords[Math.max(0, i - 1)];
    const next = coords[Math.min(coords.length - 1, i + 1)];
    const dLat = next[0] - prev[0], dLng = next[1] - prev[1];
    const len = Math.hypot(dLat, dLng) || 1;
    return [dLat / len, dLng / len];
  }

  // A distance-windowed tangent, used ONLY for the cross-hike "am I walking roughly the same way
  // as the other hike" direction check below — NOT for self-merge, which needs the sharp,
  // un-smoothed tangentAt above to tell a real retrace apart from a switchback leg (smoothing that
  // one out was tried and broke exactly that distinction). The plain one-point tangentAt is noisy
  // right at a hike's very first/last points specifically: ORS often snaps the route start onto the
  // nearest path via a short "access" segment that can point in a meaningfully different direction
  // than the trail itself for the first few meters. Confirmed against real saved hikes: one pair's
  // cross-hike dot climbed 0.37 → 0.46 → 0.57 over its first three points — just under the 0.6
  // threshold each time — even though moments later it's genuinely walking alongside the other
  // hike. Averaging over a short real-distance window smooths that initial noise out without
  // blurring real trail geometry the way a longer window would.
  const CROSS_TANGENT_WINDOW_M = 12;
  function crossTangentAt(coords, cumDist, i) {
    const here = cumDist[i];
    // Always steps at least one point each way (like the plain tangentAt) even when that single
    // step already exceeds the window — on a sparse stretch the immediate neighbor IS the best
    // available estimate; only extend further when there's denser data to smooth over.
    let a = i;
    while (a > 0 && (a === i || here - cumDist[a] < CROSS_TANGENT_WINDOW_M)) a--;
    let b = i;
    while (b < coords.length - 1 && (b === i || cumDist[b] - here < CROSS_TANGENT_WINDOW_M)) b++;
    const prev = coords[a], next = coords[b];
    const dLat = next[0] - prev[0], dLng = next[1] - prev[1];
    const len = Math.hypot(dLat, dLng) || 1;
    return [dLat / len, dLng / len];
  }

  // Cumulative real-world distance along each hike's own point list — the common ingredient every
  // "how far along the trail" check below needs, computed once per hike up front.
  const cumDistByHike = {};
  hikeList.forEach((h) => {
    const cum = [0];
    for (let i = 1; i < h.coordinates.length; i++) cum.push(cum[i - 1] + haversineMeters(h.coordinates[i - 1], h.coordinates[i]));
    cumDistByHike[h.id] = cum;
  });

  // Require a sustained run before treating two paths as "running together" (used for both self
  // and cross-hike) — a couple of trails merely crossing at an angle, or a route just grazing its
  // own earlier path once, only satisfy the distance+direction check for a point or two. Measured
  // in real trail distance (via cumDist), not point count — a run can be as few as 2 points on a
  // sparse straight stretch and still be a long, genuine overlap.
  function filterRuns(cumDist, presentAt, minMeters) {
    const n = cumDist.length;
    const filtered = new Array(n).fill(false);
    let runStart = -1;
    for (let i = 0; i <= n; i++) {
      const present = i < n && presentAt(i);
      if (present && runStart === -1) runStart = i;
      if (!present && runStart !== -1) {
        if (cumDist[i - 1] - cumDist[runStart] >= minMeters) {
          for (let j = runStart; j < i; j++) filtered[j] = true;
        }
        runStart = -1;
      }
    }
    return filtered;
  }

  // ----- 1. Self-merge detection -----
  // Nearest candidate (by distance) among same-hike points that are far enough away in the point
  // list and travelling in roughly the opposite direction. (An elevation check was tried here too —
  // reject candidates at a meaningfully different altitude, since a switchback climbs with every leg
  // while a genuine retrace revisits the same spot — but real elevation data is too noisy for that
  // to be reliable: the noise on the SAME physical point measured twice and the gain of a gentle
  // switchback leg turned out to be roughly the same size, so no tolerance value avoided rejecting
  // genuine retraces without also letting switchbacks through. Dropped in favor of the pivot check
  // below, which looks at the whole hike instead of one point at a time and doesn't have that
  // problem.)
  const selfMatchIndex = {}; // hikeId -> per-point index it re-meets its own path at, or -1
  hikeList.forEach((h) => { selfMatchIndex[h.id] = new Array(h.coordinates.length).fill(-1); });
  hikeList.forEach((h) => {
    const cumDist = cumDistByHike[h.id];
    h.coordinates.forEach(([lat, lng], i) => {
      const [tLat, tLng] = tangentAt(h.coordinates, i);
      let bestDist = Infinity;
      neighborsOf(lat, lng).forEach((q) => {
        if (q.hikeId !== h.id) return;
        if (Math.abs(cumDist[q.i] - cumDist[i]) < MIN_SELF_INDEX_GAP_METERS) return;
        const d = haversineMeters([lat, lng], [q.lat, q.lng]);
        if (d >= SELF_OVERLAP_THRESHOLD_M || d >= bestDist) return;
        const [qLat, qLng] = tangentAt(h.coordinates, q.i);
        if (tLat * qLat + tLng * qLng >= SELF_OPPOSITE_MAX_DOT) return; // not travelling opposite ways
        bestDist = d;
        selfMatchIndex[h.id][i] = q.i;
      });
    });
  });
  // Distance and direction alone still aren't enough: a switchback is made of legs that are close
  // together AND run opposite ways from one leg to the next (climb north on leg 1, climb south on
  // leg 2, north again on leg 3…) — a SINGLE leg-pair out of that switchback is geometrically
  // indistinguishable from a short genuine retrace, direction check included. What tells them apart
  // has to be a GLOBAL view of the whole hike, not a per-point or per-run local one: a real
  // out-and-back mirrors its ENTIRE overlapping stretch around one fixed turnaround point, so index
  // + matchedIndex ("the pivot") is nearly constant across potentially hundreds of matched points.
  // A switchback instead produces many small, mutually inconsistent pivots, one per leg-pair, each
  // only as long as a single leg. Group every raw match by pivot, keep only the SINGLE largest
  // group, and require that group to span a real minimum distance — long enough that it couldn't
  // just be one switchback leg pretending to be a retrace.
  const PIVOT_DRIFT_TOLERANCE = 25;
  const MIN_SELF_MERGE_SPAN_M = 100;
  function dominantPivotCluster(h) {
    const matchIndex = selfMatchIndex[h.id];
    const points = [];
    matchIndex.forEach((m, i) => { if (m !== -1) points.push({ i, pivot: i + m }); });
    points.sort((a, b) => a.pivot - b.pivot);
    const clusters = [];
    let current = [];
    points.forEach((p) => {
      if (current.length && p.pivot - current[current.length - 1].pivot > PIVOT_DRIFT_TOLERANCE) {
        clusters.push(current);
        current = [];
      }
      current.push(p);
    });
    if (current.length) clusters.push(current);
    if (clusters.length === 0) return new Set();

    const dominant = clusters.reduce((a, b) => (b.length > a.length ? b : a));
    const idx = dominant.map((p) => p.i).sort((a, b) => a - b);
    let spanM = 0;
    for (let k = idx[0]; k < idx[idx.length - 1]; k++) spanM += haversineMeters(h.coordinates[k], h.coordinates[k + 1]);
    if (spanM < MIN_SELF_MERGE_SPAN_M) return new Set();
    return new Set(idx);
  }
  const selfCandidateIndex = {};
  hikeList.forEach((h) => { selfCandidateIndex[h.id] = dominantPivotCluster(h); });

  const filteredSelf = {};
  hikeList.forEach((h) => {
    filteredSelf[h.id] = filterRuns(cumDistByHike[h.id], (i) => selfCandidateIndex[h.id].has(i), OVERLAP_MIN_RUN_METERS);
  });

  // The nearest-match choice can still drift a point or two off the "true" mirror index from one
  // point to the next, which is enough to make the snapped return leg visibly zigzag instead of
  // smoothly retracing the outbound one. Since both legs are walked in a continuous, ordered
  // fashion, the correspondence between them should also move smoothly — replace each match index
  // with the median of a small window of its neighbors to iron out that residual jitter, the same
  // principle as the elevation outlier rejection above.
  const SELF_MATCH_SMOOTH_WINDOW = 4;
  function smoothSelfMatch(filtered, matchIndex) {
    const n = filtered.length;
    const smoothed = matchIndex.slice();
    for (let i = 0; i < n; i++) {
      if (!filtered[i]) continue;
      const windowVals = [];
      for (let d = -SELF_MATCH_SMOOTH_WINDOW; d <= SELF_MATCH_SMOOTH_WINDOW; d++) {
        const j = i + d;
        if (j >= 0 && j < n && filtered[j]) windowVals.push(matchIndex[j]);
      }
      windowVals.sort((a, b) => a - b);
      smoothed[i] = windowVals[Math.floor(windowVals.length / 2)];
    }
    for (let i = 0; i < n; i++) matchIndex[i] = smoothed[i];
  }
  hikeList.forEach((h) => { smoothSelfMatch(filteredSelf[h.id], selfMatchIndex[h.id]); });

  // Bridge short dropouts (a brief gap sandwiched between two confirmed self-merge runs, e.g. one
  // point where the direction check narrowly failed) so an otherwise clearly-shared corridor
  // doesn't flicker unmerged for a few meters in the middle of it. Also requires the pivot on both
  // sides of the gap to roughly agree — without that, this would happily reconnect two runs the
  // pivot check just separated for being genuinely different retraces (e.g. two different
  // switchback leg-pairs sitting only a few points apart), undoing that check entirely.
  function bridgeSelfGaps(filtered, matchIndex, cumDist) {
    const n = filtered.length;
    let i = 0;
    while (i < n) {
      if (filtered[i]) { i++; continue; }
      let j = i;
      while (j < n && !filtered[j]) j++;
      if (i > 0 && j < n && filtered[i - 1] && filtered[j] && (cumDist[j] - cumDist[i - 1]) <= BRIDGE_MAX_GAP_METERS) {
        const startVal = matchIndex[i - 1], endVal = matchIndex[j];
        const pivotStart = (i - 1) + startVal, pivotEnd = j + endVal;
        if (Math.abs(pivotStart - pivotEnd) <= PIVOT_DRIFT_TOLERANCE) {
          for (let k = i; k < j; k++) {
            filtered[k] = true;
            matchIndex[k] = Math.round(startVal + (endVal - startVal) * ((k - (i - 1)) / (j - (i - 1))));
          }
        }
      }
      i = j;
    }
  }
  hikeList.forEach((h) => { bridgeSelfGaps(filteredSelf[h.id], selfMatchIndex[h.id], cumDistByHike[h.id]); });

  // ----- 2. Cross-hike overlap detection -----
  // Which OTHER hikes are within threshold at each point — kept per-partner, not summed yet, so
  // the run-length filter can be applied per pair. Distance alone isn't enough here either: two
  // trails simply crossing at an angle (an X-junction) are unavoidably within threshold for a
  // stretch of their own — at OVERLAP_THRESHOLD_M=28m, even a right-angle crossing has ~50m of
  // "close enough" on each side of the actual junction, and a shallow-angle crossing can stretch
  // that to hundreds of meters, comfortably beating any reasonable minimum-run-length check. What
  // actually marks two hikes as "running together" rather than "crossing" is DIRECTION: their local
  // tangents must be roughly parallel or anti-parallel (the same trail walked either way), not at a
  // real angle to each other — the same principle as the self-merge direction check above.
  const CROSS_HIKE_MIN_PARALLEL_DOT = 0.6;
  const otherSets = {};
  hikeList.forEach((h) => { otherSets[h.id] = h.coordinates.map(() => new Set()); });
  if (includeOtherHikes) {
    hikeList.forEach((h) => {
      const cumDist = cumDistByHike[h.id];
      h.coordinates.forEach(([lat, lng], i) => {
        const [tLat, tLng] = crossTangentAt(h.coordinates, cumDist, i);
        neighborsOf(lat, lng).forEach((q) => {
          if (q.hikeId === h.id) return;
          const otherCoords = hikeById.get(q.hikeId).coordinates;
          // Test against the two segments touching this candidate VERTEX, not the vertex itself —
          // on a sparse straight stretch the nearest vertex of the other hike can be tens of
          // meters away along the trail even though the trail itself passes right by, and only the
          // segment (the actual line between two of its points) captures that.
          for (const [ia, ib] of [[q.i - 1, q.i], [q.i, q.i + 1]]) {
            if (ia < 0 || ib >= otherCoords.length) continue;
            const a = otherCoords[ia], b = otherCoords[ib];
            if (pointToSegmentMeters([lat, lng], a, b) >= OVERLAP_THRESHOLD_M) continue;
            const dLat = b[0] - a[0], dLng = b[1] - a[1];
            const len = Math.hypot(dLat, dLng) || 1;
            const [qLat, qLng] = [dLat / len, dLng / len];
            if (Math.abs(tLat * qLat + tLng * qLng) < CROSS_HIKE_MIN_PARALLEL_DOT) continue; // crossing at an angle, not running alongside
            otherSets[h.id][i].add(q.hikeId);
            break;
          }
        });
      });
    });
  }
  const filteredOtherSets = {};
  hikeList.forEach((h) => {
    const raw = otherSets[h.id];
    const cumDist = cumDistByHike[h.id];
    const filtered = raw.map(() => new Set());
    const partners = new Set();
    raw.forEach((s) => s.forEach((id) => partners.add(id)));
    partners.forEach((otherId) => {
      filterRuns(cumDist, (i) => raw[i].has(otherId), OVERLAP_MIN_RUN_METERS).forEach((keep, i) => { if (keep) filtered[i].add(otherId); });
    });
    filteredOtherSets[h.id] = filtered;
  });

  // Each hike is assigned an ordinal LANE among every hike overlapping it at this exact point
  // (itself + every currently active partner), sorted by id — not a sum of independent pairwise
  // magnitudes like before. Summing independent pairwise magnitudes gave whichever hike sorts
  // first or last among its partners the FULL combined magnitude of all of them (every comparison
  // points the same way for an id at one end of the sort order), while a hike in the middle of the
  // sort order got a mix of + and - terms that partly cancelled — so at a busy junction the two
  // outer tracks ended up visibly further from their neighbor than the inner ones were from each
  // other. Ordinal lanes are evenly spaced by construction instead: N hikes always land on
  // -(N-1)/2 .. (N-1)/2 in half-integer steps, so every adjacent pair is exactly one lane-width
  // apart no matter how many hikes are in the group or where this one falls in id order — and
  // since a sorted position is always unique, there's no risk of two different hikes landing on
  // the exact same lane the way two independent magnitude sums could coincidentally collide.
  const rawLaneOffsets = {};
  hikeList.forEach((h) => {
    rawLaneOffsets[h.id] = h.coordinates.map((_, i) => {
      const partners = filteredOtherSets[h.id][i];
      if (partners.size === 0) return 0;
      const clusterIds = [h.id, ...partners].sort();
      const n = clusterIds.length;
      return clusterIds.indexOf(h.id) - (n - 1) / 2;
    });
  });

  // Smooth the lane offset along each hike's own sequence so it eases in and out gradually
  // instead of snapping between sides.
  const clusters = {};
  hikeList.forEach((h) => {
    const raw = rawLaneOffsets[h.id];
    const coords = h.coordinates;
    // Raw per-point tangents, precomputed once so the window sum below is cheap — used ONLY to
    // pick which side of the trail this hike's offset nudges to, never for detection (self-merge
    // still uses the sharp, un-smoothed tangentAt directly, see above).
    const rawTangents = coords.map((_, i) => tangentAt(coords, i));
    clusters[h.id] = raw.map((_, i) => {
      const start = Math.max(0, i - OVERLAP_SMOOTH_WINDOW);
      const end = Math.min(raw.length, i + OVERLAP_SMOOTH_WINDOW + 1);
      let sum = 0;
      for (let j = start; j < end; j++) sum += raw[j];
      let laneOffset = sum / (end - start);

      // The averaging window can wash a short run's lane offset back down toward 0 near its own
      // edges (it reaches past the run into the surrounding "no overlap" zeros) — re-assert at
      // least half of the RAW lane offset at this exact point whenever smoothing diluted it below
      // that, so dilution can soften the edges but can't erase the middle of a short run. Guarded
      // on raw[i] itself being nonzero: a hike that's exactly the middle lane of an odd-sized
      // group (e.g. rank 0 of -1, 0, +1) is SUPPOSED to sit right on the trail line — that's not
      // dilution, and re-flooring it would shove it sideways for no reason.
      if (raw[i] !== 0 && Math.abs(laneOffset) < Math.abs(raw[i]) / 2) {
        laneOffset = Math.sign(raw[i]) * Math.abs(raw[i]) / 2;
      }

      // A LATER pass (i > matchedIdx) meeting its own earlier pass gets marked to snap onto it —
      // see applyOverlapClusters. The earlier pass itself is left alone (it's the reference the
      // later one moves to), so this only ever applies to one side of a self-merge pair.
      const matchedIdx = filteredSelf[h.id][i] ? selfMatchIndex[h.id][i] : -1;
      const selfSnapToIndex = matchedIdx !== -1 && i > matchedIdx ? matchedIdx : null;
      if (Math.abs(laneOffset) < 0.05 && selfSnapToIndex === null) return null;

      // The offset direction is "perpendicular to the trail here" — but a plain per-point tangent
      // reverses ~180° at a switchback apex (the trail itself reverses direction there), which
      // flips which side the offset lands on from one point to the next: two hikes lacing through
      // the very same switchback together would see the gap between them snap from one side to
      // the other at every hairpin, an ugly, jarring jump on top of an otherwise clean separation.
      // Average the raw tangent over the same window as the lane offset above (not a fixed
      // real-distance window like crossTangentAt — this only needs to be smooth, not precise) so
      // the direction eases through a reversal instead of snapping. Two opposite-direction
      // tangents in the same window cancel out, which is also exactly the "coherence" of the
      // direction there — apply that as a multiplier on the lane offset too, so the offset PINCHES
      // BACK toward the trail line right at a genuine hairpin (where "which side" is momentarily
      // ambiguous) instead of holding full magnitude while flipping sides.
      let sumTLat = 0, sumTLng = 0;
      for (let j = start; j < end; j++) { sumTLat += rawTangents[j][0]; sumTLng += rawTangents[j][1]; }
      const coherence = Math.hypot(sumTLat, sumTLng) / (end - start);
      const tLen = Math.hypot(sumTLat, sumTLng) || 1;
      let [tLat, tLng] = [sumTLat / tLen, sumTLng / tLen];
      // Floored at 0.7: a genuine hairpin still gets tapered (softening the direction flip) but
      // can never lose more than 30% of its magnitude just because the trail curves — an uncapped
      // multiplier was crushing the offset toward invisible on any real, moderately winding trail,
      // not just at sharp switchback apexes.
      const coherenceFactor = Math.max(coherence, 0.7);
      // Canonicalize the tangent's sign before deriving the perpendicular: two hikes on the SAME
      // physical trail can be recorded in opposite walking directions (one went up, the other came
      // down — the direction check above explicitly treats that as "the same trail" via Math.abs),
      // which gives them exactly opposite tangents. Combined with the opposite lane sign a hike on
      // one side of the sorted cluster gets vs. the other, an opposite tangent flips the
      // perpendicular too, and the two flips CANCEL — both hikes end up nudged the same way
      // instead of apart (confirmed on a real reversed-recording pair: both landed ~7m further
      // north instead of splitting to either side). Always picking the "northward-leaning" version
      // of the tangent (or eastward, on an exact east-west trail) makes both hikes agree on the
      // same reference orientation regardless of which one was walked backwards.
      if (tLat < 0 || (tLat === 0 && tLng < 0)) { tLat = -tLat; tLng = -tLng; }
      return { laneOffset: laneOffset * coherenceFactor, selfSnapToIndex, perpLat: -tLng, perpLng: tLat };
    });
  });

  return clusters;
}

// The cheap step: turn the cached per-point info into an actual coordinate for the current zoom.
// Safe (and fast) to call on every zoomend.
function applyOverlapClusters(hikeList, clusters, zoom) {
  const result = {};
  hikeList.forEach((h) => {
    const clusterInfo = clusters[h.id];
    result[h.id] = h.coordinates.map(([lat, lng], i) => {
      let info = clusterInfo && clusterInfo[i];
      if (!info) return [lat, lng];
      let baseLat = lat, baseLng = lng;
      if (info.selfSnapToIndex != null) {
        // Snap to the earlier pass's coordinate — and inherit ITS cross-hike info wholesale too,
        // not just its position: this point's own perpendicular direction runs opposite to the
        // earlier pass's (they travel in opposite directions along the same trail), so applying
        // its own offset from the shared base would immediately shove the two "merged" points
        // apart again, undoing the whole point of snapping them together.
        [baseLat, baseLng] = h.coordinates[info.selfSnapToIndex];
        info = clusterInfo[info.selfSnapToIndex] || null;
      }
      if (!info || !info.laneOffset) return [baseLat, baseLng];
      // laneOffset steps by exactly 1.0 between adjacent lanes (see buildOverlapClusters), so this
      // constant IS directly the adjacent-lane pixel gap — no more guessing at how a 0.4-0.6
      // magnitude range translates to screen pixels. Requested tight, barely-clearing the white
      // halo (7-9px wide) rather than a wide dramatic split: 10px.
      const offsetStepM = 10 * metersPerPixel(baseLat, zoom);
      const offsetDeg = (info.laneOffset * offsetStepM) / 111320;
      return [baseLat + info.perpLat * offsetDeg, baseLng + info.perpLng * offsetDeg];
    });
  });
  return result;
}

// ---------- Detail panel ----------
const detailPanel = document.getElementById("detail-panel");

function showDetail(id) {
  flushAutoSaveInfo(); // don't lose an unsaved edit on the hike we're navigating away from
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
  document.getElementById("chk-isolate-hike").checked = isolateSelectedHike;

  renderHikeLayers();
  const layer = hikeLayers[id];
  if (layer) leafletMap.fitBounds(layer.line.getBounds(), { padding: [40, 40] });
}

document.getElementById("chk-isolate-hike").addEventListener("change", (e) => {
  isolateSelectedHike = e.target.checked;
  renderHikeLayers();
  const layer = hikeLayers[activeHikeId];
  if (layer) leafletMap.fitBounds(layer.line.getBounds(), { padding: [40, 40] });
});

document.getElementById("btn-close-detail").addEventListener("click", closeDetail);
function closeDetail() {
  flushAutoSaveInfo();
  activeHikeId = null;
  isolateSelectedHike = false; // isolating only makes sense while a hike's detail is open
  document.getElementById("chk-isolate-hike").checked = false;
  detailPanel.classList.add("hidden");
  renderHikeList();
  renderHikeLayers();
}

document.getElementById("btn-edit-hike").addEventListener("click", () => {
  const h = hikes.find((x) => x.id === activeHikeId);
  if (h) startEditingHike(h);
});

// Quick edit for name/date/notes only — no need to touch the route just to fix a typo or a date,
// and no explicit save button: every change is persisted automatically (debounced while typing,
// immediately on the date picker, and flushed on close/switch so nothing typed is lost).
let autoSaveInfoTimer = null;

function scheduleAutoSaveInfo() {
  clearTimeout(autoSaveInfoTimer);
  autoSaveInfoTimer = setTimeout(saveDetailInfo, 600);
}

function flushAutoSaveInfo() {
  if (autoSaveInfoTimer) {
    clearTimeout(autoSaveInfoTimer);
    autoSaveInfoTimer = null;
    saveDetailInfo();
  }
}

async function saveDetailInfo() {
  if (!activeHikeId) return;
  const id = activeHikeId;
  const name = document.getElementById("detail-name-input").value.trim() || "Rando sans nom";
  const date = document.getElementById("detail-date-input").value || null;
  const notes = document.getElementById("detail-notes-input").value.trim();
  const h = hikes.find((x) => x.id === id);
  if (h && h.name === name && h.date === date && (h.notes || "") === notes) return; // nothing changed

  try {
    await db.collection("hikes").doc(id).update({ name, date, notes });
  } catch (err) {
    console.error("Erreur d'enregistrement automatique", err);
    return;
  }
  if (h) { h.name = name; h.date = date; h.notes = notes; }
  renderHikeList();
}

document.getElementById("detail-name-input").addEventListener("input", scheduleAutoSaveInfo);
document.getElementById("detail-notes-input").addEventListener("input", scheduleAutoSaveInfo);
document.getElementById("detail-date-input").addEventListener("change", saveDetailInfo);

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
    const rawElevations = feature.geometry.coordinates.map((c) => c[2] ?? 0);
    const { gainM, lossM, displayElevations, maxSlopePct } = deriveElevationStats(coords, rawElevations);
    const props = feature.properties || {};
    const distanceKm = (props.summary && props.summary.distance != null ? props.summary.distance : pathDistanceKm(coords) * 1000) / 1000;

    return {
      coordinates: coords,
      elevations: displayElevations,
      distanceKm,
      gainM,
      lossM,
      maxSlopePct,
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
    const { gainM, lossM, displayElevations, maxSlopePct } = deriveElevationStats(dense, rawElevations);
    return {
      coordinates: dense,
      elevations: displayElevations,
      distanceKm,
      gainM,
      lossM,
      maxSlopePct,
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
  // Wider than the 25m elevation smoothing itself: a single leftover artifact in the smoothed
  // curve (still possible even after outlier rejection) only spans a short stretch, so requiring
  // the steep reading to hold up over a longer run makes an isolated glitch much less likely to
  // produce a headline number like "177%". Routed geometry is often much denser than 50m between
  // points (every 1-5m), so comparing only immediate neighbors would also skip virtually every
  // pair and silently report ~0% — instead, slide a window forward from each point to the first
  // one at least MIN_SEGMENT_M further along.
  const MIN_SEGMENT_M = 50;
  const cumDist = [0];
  for (let i = 1; i < coords.length; i++) cumDist.push(cumDist[i - 1] + haversineMeters(coords[i - 1], coords[i]));

  let max = 0;
  let j = 0;
  for (let i = 0; i < coords.length; i++) {
    if (j < i + 1) j = i + 1;
    while (j < coords.length - 1 && cumDist[j] - cumDist[i] < MIN_SEGMENT_M) j++;
    const segM = cumDist[j] - cumDist[i];
    if (segM < MIN_SEGMENT_M) continue;
    const slope = Math.abs((elevations[j] - elevations[i]) / segM) * 100;
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
    elevations.push(...(await fetchElevationChunkWithRetry(lats, lons)));
  }
  return elevations;
}

// Open-Meteo's free tier rate-limits fairly aggressively (seen firsthand while building this) —
// a 429 here isn't always a brief "try again shortly", it can also mean the HOURLY request quota
// is simply used up for the next while, which retrying within a few seconds can't fix at all.
async function fetchElevationChunkWithRetry(lats, lons, attempt = 0) {
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
  if (res.ok) {
    const elevation = (await res.json()).elevation;
    // Every downstream calculation (gain/loss, chart, max slope) assumes elevation[i] is the
    // altitude of points[i] — if the API ever returned a different count than requested (a
    // dedup of identical coordinate pairs, a partial response, anything), every point from there
    // on would silently pair with the WRONG elevation and throw off every derived number, slope
    // most visibly since it divides by a short distance. Treat a count mismatch as a failure
    // worth retrying rather than silently computing on misaligned data.
    const expected = lats.split(",").length;
    if (elevation.length !== expected) throw new Error(`Elevation count mismatch: got ${elevation.length}, expected ${expected}`);
    return elevation;
  }
  if (res.status === 429) {
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      return fetchElevationChunkWithRetry(lats, lons, attempt + 1);
    }
    // Still 429 after 3 tries a few seconds apart: this reads as the free tier's HOURLY quota,
    // not a momentary spike — retrying again right away won't help, and every other hike still
    // queued in this migration batch would hit the exact same wall. Tag the error distinctly so
    // the batch loop can give up entirely instead of burning through the rest of the queue one
    // doomed attempt at a time.
    const err = new Error("Elevation API quota exceeded");
    err.quotaExceeded = true;
    throw err;
  }
  throw new Error("Elevation API error");
}

// A single bad altitude sample (a DEM void or glitch — happens occasionally, especially near
// cliffs, bridges, or forest edges) can still throw off a moving average even over a wide window,
// since it's still one of the values being averaged. Replace anything wildly out of step with
// its neighbors' median before smoothing even starts, so the rest of the curve doesn't inherit
// its distortion. Distance-based (not a fixed ±3 points) for the same reason smoothElevations is:
// routed geometry is dense on curves and sparse on straights, so a fixed point-count window can
// span anywhere from a couple of meters to hundreds depending on where you are on the path. A
// real-world window also means dozens of samples get pooled into the median wherever points are
// dense, so a short RUN of several consecutive bad samples (not just one) still gets outvoted —
// a fixed ±3-point window has no such margin and can itself be entirely bad neighbors.
function rejectElevationOutliers(coords, elevations, thresholdM = 40, windowMeters = 60) {
  return elevations.map((e, i) => {
    const neighbors = [];
    let dist = 0;
    for (let j = i - 1; j >= 0; j--) {
      dist += haversineMeters(coords[j], coords[j + 1]);
      if (dist > windowMeters) break;
      neighbors.push(elevations[j]);
    }
    dist = 0;
    for (let j = i + 1; j < elevations.length; j++) {
      dist += haversineMeters(coords[j - 1], coords[j]);
      if (dist > windowMeters) break;
      neighbors.push(elevations[j]);
    }
    if (neighbors.length === 0) return e;
    neighbors.sort((a, b) => a - b);
    const median = neighbors[Math.floor(neighbors.length / 2)];
    return Math.abs(e - median) > thresholdM ? median : e;
  });
}

// Two different smoothing widths for two different jobs, from the same raw altitude samples:
// - a LIGHT pass (5m) feeds the hysteresis gain/loss calculation, which is itself already noise-
//   robust (it only counts a leg once it reverses by 10m) — smoothing it further than this just
//   throws away genuine small climbs and under-counts D+/D-, which is what happened when a
//   single wide window was used for both jobs.
// - a WIDE pass (25m) feeds the elevation chart and the max-slope reading. Elevation datasets are
//   often quantized to blocks tens of meters across (the source DEM's own resolution), which
//   shows up as a "staircase" when sampled every 1-2m along a route — far too coarse for a 5m
//   window to blend away, so the chart needs its own wider pass to look like a real profile
//   instead of a flight of stairs.
function deriveElevationStats(coords, rawElevations) {
  const cleaned = rejectElevationOutliers(coords, rawElevations);
  const gainLossElevations = smoothElevations(coords, cleaned, 5);
  const { gain, loss } = computeGainLossHysteresis(gainLossElevations);
  const displayElevations = smoothElevations(coords, cleaned, 25);
  return {
    gainM: gain,
    lossM: loss,
    displayElevations,
    maxSlopePct: computeMaxSlopePct(coords, displayElevations),
  };
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
