// ---------- Setup ----------
firebase.initializeApp(window.APP_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

const COLORS = ["#2e7d32", "#c0392b", "#2980b9", "#e67e22", "#8e44ad", "#16a085", "#d35400", "#2c3e50"];

let leafletMap;
let hikes = [];               // loaded from Firestore
let hikeLayers = {};          // id -> leaflet polyline
let activeHikeId = null;

let drawing = false;
let drawPoints = [];          // [[lat, lng], ...]
let drawLayer = null;
let drawMarkersLayer = null;
let pendingStats = null;

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

  L.control.layers({ "OpenStreetMap": osm, "IGN": ign }).addTo(leafletMap);

  leafletMap.on("click", onMapClick);
}

function onMapClick(e) {
  if (!drawing) return;
  drawPoints.push([e.latlng.lat, e.latlng.lng]);
  redrawDrawLayer();
}

function redrawDrawLayer() {
  if (drawLayer) leafletMap.removeLayer(drawLayer);
  if (drawMarkersLayer) leafletMap.removeLayer(drawMarkersLayer);

  drawLayer = L.polyline(drawPoints, { color: "#c0392b", weight: 4 }).addTo(leafletMap);
  drawMarkersLayer = L.layerGroup(
    drawPoints.map((p) => L.circleMarker(p, { radius: 4, color: "#c0392b", fillColor: "#c0392b", fillOpacity: 1 }))
  ).addTo(leafletMap);

  const dist = pathDistanceKm(drawPoints);
  document.getElementById("draw-stats").textContent =
    drawPoints.length > 1 ? `${drawPoints.length} points · ${dist.toFixed(2)} km (approx.)` : `${drawPoints.length} point`;
}

// ---------- Draw hike flow ----------
const drawPanel = document.getElementById("draw-panel");
const savePanel = document.getElementById("save-panel");

document.getElementById("btn-new-hike").addEventListener("click", startDrawing);
document.getElementById("btn-cancel-draw").addEventListener("click", cancelDrawing);
document.getElementById("btn-undo-point").addEventListener("click", () => {
  drawPoints.pop();
  redrawDrawLayer();
});
document.getElementById("btn-finish-draw").addEventListener("click", finishDrawing);
document.getElementById("btn-cancel-save").addEventListener("click", () => {
  savePanel.classList.add("hidden");
  cancelDrawing();
});
document.getElementById("btn-save-hike").addEventListener("click", saveHike);

function startDrawing() {
  closeDetail();
  drawing = true;
  drawPoints = [];
  document.getElementById("btn-new-hike").classList.add("hidden");
  drawPanel.classList.remove("hidden");
  document.getElementById("draw-stats").textContent = "0 point";
}

function cancelDrawing() {
  drawing = false;
  drawPoints = [];
  if (drawLayer) { leafletMap.removeLayer(drawLayer); drawLayer = null; }
  if (drawMarkersLayer) { leafletMap.removeLayer(drawMarkersLayer); drawMarkersLayer = null; }
  drawPanel.classList.add("hidden");
  document.getElementById("btn-new-hike").classList.remove("hidden");
}

async function finishDrawing() {
  if (drawPoints.length < 2) {
    alert("Place au moins deux points.");
    return;
  }
  drawing = false;
  drawPanel.classList.add("hidden");
  document.getElementById("draw-stats").textContent = "Calcul du dénivelé...";
  drawPanel.classList.remove("hidden"); // keep visible with loading text briefly
  drawPanel.classList.add("hidden");

  savePanel.classList.remove("hidden");
  document.getElementById("hike-stats-preview").innerHTML = "<span class='hint'>Calcul du dénivelé en cours…</span>";
  document.getElementById("hike-date").valueAsDate = new Date();

  try {
    pendingStats = await computeStats(drawPoints);
    renderStatsPreview("hike-stats-preview", pendingStats);
  } catch (err) {
    document.getElementById("hike-stats-preview").innerHTML =
      "<span class='hint'>Dénivelé indisponible (API altitude injoignable). Distance seule utilisée.</span>";
    pendingStats = { distanceKm: pathDistanceKm(drawPoints), gainM: null, lossM: null, elevations: null };
  }
}

async function saveHike() {
  const name = document.getElementById("hike-name").value.trim() || "Rando sans nom";
  const date = document.getElementById("hike-date").value || null;
  const notes = document.getElementById("hike-notes").value.trim();

  const payload = {
    userId: auth.currentUser.uid,
    name,
    date,
    notes,
    coordinates: drawPoints.map(([lat, lng]) => ({ lat, lng })),
    distanceKm: pendingStats.distanceKm,
    elevationGainM: pendingStats.gainM,
    elevationLossM: pendingStats.lossM,
    elevations: pendingStats.elevations,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await db.collection("hikes").add(payload);
  } catch (err) {
    alert("Erreur à l'enregistrement : " + err.message);
    return;
  }

  document.getElementById("hike-name").value = "";
  document.getElementById("hike-notes").value = "";
  savePanel.classList.add("hidden");
  document.getElementById("btn-new-hike").classList.remove("hidden");
  drawPoints = [];
  if (drawLayer) { leafletMap.removeLayer(drawLayer); drawLayer = null; }
  if (drawMarkersLayer) { leafletMap.removeLayer(drawMarkersLayer); drawMarkersLayer = null; }

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
        coordinates: d.coordinates.map((c) => [c.lat, c.lng]),
        distanceKm: d.distanceKm,
        elevationGainM: d.elevationGainM,
        elevationLossM: d.elevationLossM,
        elevations: d.elevations,
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
  hikes.forEach((h, i) => {
    const color = COLORS[i % COLORS.length];
    const el = document.createElement("div");
    el.className = "hike-item" + (h.id === activeHikeId ? " active" : "");
    el.innerHTML = `
      <div class="name"><span class="swatch" style="background:${color}"></span>${escapeHtml(h.name)}</div>
      <div class="meta">${h.date ? formatDate(h.date) : "Sans date"} · ${h.distanceKm != null ? h.distanceKm.toFixed(1) + " km" : ""}${h.elevationGainM != null ? " · D+ " + Math.round(h.elevationGainM) + " m" : ""}</div>
    `;
    el.addEventListener("click", () => showDetail(h.id));
    listEl.appendChild(el);
  });
}

function renderHikeLayers() {
  Object.values(hikeLayers).forEach((l) => leafletMap.removeLayer(l));
  hikeLayers = {};
  hikes.forEach((h, i) => {
    const color = COLORS[i % COLORS.length];
    const line = L.polyline(h.coordinates, { color, weight: 4, opacity: 0.85 })
      .addTo(leafletMap)
      .on("click", () => showDetail(h.id));
    line.bindTooltip(h.name);
    hikeLayers[h.id] = line;
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
  drawElevationProfile(h.elevations);
  detailPanel.classList.remove("hidden");

  const line = hikeLayers[id];
  if (line) leafletMap.fitBounds(line.getBounds(), { padding: [40, 40] });
}

document.getElementById("btn-close-detail").addEventListener("click", closeDetail);
function closeDetail() {
  activeHikeId = null;
  detailPanel.classList.add("hidden");
  renderHikeList();
}

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

async function computeStats(points) {
  const distanceKm = pathDistanceKm(points);
  const dense = densifyPath(points, 30);
  const elevations = await fetchElevations(dense);
  const { gain, loss, smoothed } = computeGainLoss(elevations);
  return { distanceKm, gainM: gain, lossM: loss, elevations: smoothed };
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
