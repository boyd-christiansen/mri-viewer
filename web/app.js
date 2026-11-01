"use strict";
const $ = id => document.getElementById(id);
const canvas = $("image-canvas"), ctx = canvas.getContext("2d"), viewport = $("viewport");
const state = { library: null, series: null, index: 0, meta: null, bitmap: null, zoom: 1, pan: [0, 0], tool: "pan", invert: false, auto: true, center: null, width: null, playing: false, request: 0, abort: null, importing: false };
const metaCache = new Map();
let renderTimer, playTimer, toastTimer, importPoll;

async function api(path, options) {
  if (window.sharedImaging) return window.sharedImaging.api(path, options);
  const response = await fetch(path, options);
  if (!response.ok) { const body = await response.json(); throw new Error(body.error || "The request failed."); }
  return response.json();
}
function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").hidden = true, 4500); }
function dateText(raw) { return /^\d{8}$/.test(raw || "") ? `${raw.slice(4,6)}/${raw.slice(6,8)}/${raw.slice(0,4)}` : raw || "Date not supplied"; }
function setDisabled(disabled) { for (const id of ["pan-tool", "window-tool", "zoom-in", "zoom-out", "reset", "invert", "export", "fullscreen", "previous", "play", "next", "slice-slider"]) $(id).disabled = disabled; }

async function loadLibrary() {
  state.library = await api("/api/library");
  window.dispatchEvent(new CustomEvent("mri-library", {detail: state.library}));
  const { series, documents, imports, frame_count } = state.library;
  $("series-count").textContent = `${series.length} series`;
  $("document-count").textContent = documents.length;
  $("frame-count").textContent = frame_count ? frame_count.toLocaleString() : "—";
  $("series-list").replaceChildren();
  if (!series.length) { const empty = document.createElement("p"); empty.className = "list-empty"; empty.textContent = "Your image series will appear here after importing the disc."; $("series-list").append(empty); }
  let previousStudy = null;
  for (const item of series) {
    const studyKey = `${item.date}|${item.study}`;
    if (studyKey !== previousStudy) {
      const heading = document.createElement("h2"); heading.className = "series-study";
      heading.textContent = item.study; $("series-list").append(heading); previousStudy = studyKey;
    }
    const button = document.createElement("button"); button.className = "series-card"; button.dataset.id = item.id;
    button.setAttribute("aria-label", `${item.description}, ${item.count} image frames`);
    const img = document.createElement("img"); img.alt = ""; img.loading = "lazy";
    const thumbnailFrame = item.frames[Math.floor(item.count / 2)];
    if (window.sharedImaging) window.sharedImaging.thumbnail(thumbnailFrame).then(url => { img.src = url; }).catch(() => {});
    else img.src = `/api/image/${thumbnailFrame}`;
    const copy = document.createElement("span"); copy.className = "series-copy";
    const title = document.createElement("strong"); title.textContent = item.description;
    const details = document.createElement("small"); details.textContent = `${item.modality} · Series ${item.number} · ${item.count} frames`;
    copy.append(title, details); button.append(img, copy); button.onclick = () => selectSeries(item); $("series-list").append(button);
  }
  $("document-list").replaceChildren();
  if (!documents.length) { const empty = document.createElement("p"); empty.className = "list-empty"; empty.textContent = "No supported report or document files found. Your radiology report may be provided separately by the imaging center."; $("document-list").append(empty); }
  for (const doc of documents) {
    const link = document.createElement("a"); link.className = "document-link"; link.href = `/api/document/${doc.id}`; link.target = "_blank"; link.rel = "noopener";
    link.textContent = doc.study ? `${doc.study} · ${doc.name}` : doc.name; const type = document.createElement("small"); type.textContent = `${doc.kind.toUpperCase()} · Open local document ↗`; link.append(type); $("document-list").append(link);
    if (window.sharedImaging) {
      type.textContent = `${doc.kind.toUpperCase()} · Open report ↗`;
      link.href = "#"; link.removeAttribute("target");
      link.onclick = event => { event.preventDefault(); window.sharedImaging.openDocument(doc).catch(error => toast(error.message)); };
    }
  }
  if (imports.length) {
    const bytes = imports.reduce((n, i) => n + (i.bytes || 0), 0);
    $("library-note").textContent = `${(bytes / 1024 / 1024).toFixed(1)} MB local copy${imports.every(i => i.verified) ? " · Verified" : ""}`;
  }
  if (window.sharedImaging) $("library-note").textContent = "";
  setDisabled(!series.length);
  if (series.length) {
    const selected = series.find(s => s.id === state.series?.id) || series.find(s => s.modality === "MR" && s.count > 1 && !/localizer|scout|survey/i.test(s.description)) || series.find(s => s.modality === "MR") || series[0];
    await selectSeries(selected);
  }
}

async function selectSeries(series) {
  stopPlay(); state.series = series; state.index = Math.floor((series.count - 1) / 2); state.zoom = 1; state.pan = [0,0]; state.auto = true; state.invert = false;
  $("invert").setAttribute("aria-pressed", "false");
  document.querySelectorAll(".series-card").forEach(b => { b.classList.toggle("active", b.dataset.id === series.id); b.setAttribute("aria-pressed", b.dataset.id === series.id ? "true" : "false"); });
  $("study-date").textContent = `${dateText(series.date)} · ${series.modality}`;
  $("study-title").textContent = series.study;
  $("study-subtitle").textContent = [series.patient, series.body_part, `${state.library.series.length} image series`].filter(Boolean).join(" · ");
  $("series-title").textContent = series.description;
  $("slice-slider").max = series.count;
  window.dispatchEvent(new CustomEvent("mri-series", {detail: {series, index: state.index}}));
  $("empty-state").hidden = true; canvas.hidden = false; $("image-overlay").hidden = false; $("adjustments").hidden = false;
  await showSlice();
}

function currentFrame() { return state.series?.frames[state.index]; }
async function showSlice() {
  if (!state.series) return;
  const id = ++state.request, frame = currentFrame();
  state.abort?.abort(); state.abort = new AbortController(); const signal = state.abort.signal;
  $("slice-slider").value = state.index + 1;
  $("slice-label").textContent = `${state.index + 1} / ${state.series.count}`;
  window.dispatchEvent(new CustomEvent("mri-slice", {detail: {series: state.series, index: state.index}}));
  $("loading").hidden = false; $("image-error").hidden = true;
  // Hide the previous frame immediately so labels cannot describe a stale image.
  canvas.hidden = true; $("image-overlay").hidden = true;
  try {
    const meta = metaCache.get(frame) || await api(`/api/frame/${frame}`, { signal });
    if (id !== state.request) return;
    metaCache.set(frame, meta); state.meta = meta;
    if (state.auto) { state.center = meta.center; state.width = meta.width; }
    const params = new URLSearchParams();
    if (!state.auto) { params.set("center", state.center); params.set("width", state.width); }
    if (state.invert) params.set("invert", "1");
    const response = window.sharedImaging ? await window.sharedImaging.imageResponse(frame, params, signal) : await fetch(`/api/image/${frame}?${params}`, { signal });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error); }
    const bitmap = await createImageBitmap(await response.blob());
    if (id !== state.request) { bitmap.close(); return; }
    state.bitmap?.close(); state.bitmap = bitmap;
    canvas.hidden = false; $("image-overlay").hidden = false;
    updateMeta(); draw();
  } catch (error) {
    if (error.name === "AbortError" || id !== state.request) return;
    stopPlay(); $("image-error").textContent = `This image could not be displayed. ${error.message}`; $("image-error").hidden = false;
  } finally {
    if (id === state.request) { $("loading").hidden = true; if (state.playing) playTimer = setTimeout(() => step(1, true), 160); }
  }
}
function updateMeta() {
  const m = state.meta;
  $("image-details").textContent = `${m.columns} × ${m.rows} · Image ${state.index + 1} of ${state.series.count}`;
  $("window-label").textContent = `W ${Math.round(state.width)} / L ${Math.round(state.center)}${state.auto ? " · Disc / auto" : ""}`;
  $("spacing-label").textContent = m.thickness ? `${m.thickness.toFixed(2)} mm slice` : "";
  for (const edge of ["left", "right", "top", "bottom"]) $("edge-" + edge).textContent = m.edges[edge];
  const span = Math.max(m.max - m.min, 1);
  $("brightness").min = m.min - span; $("brightness").max = m.max + span; $("brightness").value = state.center;
  $("contrast").min = 1; $("contrast").max = span * 3; $("contrast").value = state.width;
  $("brightness").disabled = m.color; $("contrast").disabled = m.color; $("window-tool").disabled = m.color;
  $("original-download").href = `/api/original/${m.file_id}`;
  if (window.sharedImaging) {
    $("original-download").href = "#";
    $("original-download").onclick = event => { event.preventDefault(); window.sharedImaging.downloadOriginal(m.file_id).catch(error => toast(error.message)); };
  }
}
function draw() {
  const { width, height } = viewport.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0); ctx.fillStyle = "#070b0d"; ctx.fillRect(0,0,width,height);
  if (!state.bitmap || !state.meta) return;
  const spacing = state.meta.spacing;
  const aspect = spacing.length === 2 && spacing[0] > 0 && spacing[1] > 0 ? spacing[0] / spacing[1] : 1;
  const w = state.bitmap.width, h = state.bitmap.height * aspect;
  const fit = Math.min((width - 44) / w, (height - 44) / h);
  const scale = fit * state.zoom;
  ctx.translate(width / 2 + state.pan[0], height / 2 + state.pan[1]);
  ctx.imageSmoothingEnabled = state.zoom < 3;
  ctx.drawImage(state.bitmap, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
  $("zoom-value").textContent = state.zoom === 1 ? "Fit" : `${Math.round(state.zoom * 100)}%`;
}
new ResizeObserver(draw).observe(viewport);
function step(delta, wrap = false) {
  if (!state.series) return;
  const next = wrap ? (state.index + delta + state.series.count) % state.series.count : Math.max(0, Math.min(state.series.count - 1, state.index + delta));
  if (state.index !== next) { state.index = next; showSlice(); }
}
function stopPlay() { state.playing = false; clearTimeout(playTimer); $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play slices"); $("play").setAttribute("aria-pressed", "false"); }
function zoom(factor) { if (!state.series) return; state.zoom = Math.max(.25, Math.min(12, state.zoom * factor)); draw(); }
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(showSlice, 65); }
function reset() { if (!state.series) return; state.zoom = 1; state.pan = [0,0]; state.auto = true; state.invert = false; $("invert").setAttribute("aria-pressed", "false"); showSlice(); }
$("previous").onclick = () => { stopPlay(); step(-1); }; $("next").onclick = () => { stopPlay(); step(1); };
$("play").onclick = () => { if (state.playing) return stopPlay(); if (state.series?.count < 2) return; state.playing = true; $("play").textContent = "Ⅱ"; $("play").setAttribute("aria-label", "Pause slices"); $("play").setAttribute("aria-pressed", "true"); step(1, true); };
$("slice-slider").oninput = e => { stopPlay(); state.index = Number(e.target.value) - 1; showSlice(); };
$("zoom-in").onclick = () => zoom(1.2); $("zoom-out").onclick = () => zoom(1 / 1.2); $("reset").onclick = reset;
$("invert").onclick = () => { state.invert = !state.invert; $("invert").setAttribute("aria-pressed", String(state.invert)); showSlice(); };
for (const [id, key] of [["brightness", "center"], ["contrast", "width"]]) $(id).oninput = e => { stopPlay(); state.auto = false; state[key] = Number(e.target.value); scheduleRender(); };
$("auto-window").onclick = () => { state.auto = true; showSlice(); };
$("fullscreen").onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.querySelector(".viewer-shell").requestFullscreen().catch(e => toast(e.message)); };
$("export").onclick = async () => {
  if (!state.bitmap || !state.meta || canvas.hidden) return;
  const output = document.createElement("canvas"); output.width = state.bitmap.width; output.height = state.bitmap.height;
  output.getContext("2d").drawImage(state.bitmap,0,0);
  output.toBlob(blob => { const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = `MRI-series-${state.series.number}-image-${state.index + 1}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); toast("Saved the current image as PNG."); });
};
for (const tool of ["pan", "window"]) $(tool + "-tool").onclick = () => {
  state.tool = tool;
  for (const name of ["pan", "window"]) { $(name + "-tool").classList.toggle("selected", name === tool); $(name + "-tool").setAttribute("aria-pressed", String(name === tool)); }
};
let drag = null, wheelAt = 0;
viewport.onpointerdown = e => {
  if (!state.meta || canvas.hidden || e.target.closest("button")) return;
  stopPlay(); viewport.focus(); viewport.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, pan: [...state.pan], center: state.center, width: state.width };
};
viewport.onpointermove = e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (state.tool === "pan" || state.meta.color) { state.pan = [drag.pan[0] + dx, drag.pan[1] + dy]; draw(); }
  else { const scale = Math.max(1, (state.meta.max - state.meta.min) / 300); state.auto = false; state.width = Math.max(1, drag.width + dx * scale); state.center = drag.center + dy * scale; scheduleRender(); }
};
viewport.onpointerup = viewport.onpointercancel = () => { if (drag && state.tool === "window") scheduleRender(); drag = null; };
viewport.addEventListener("wheel", e => {
  if (!state.series) return; e.preventDefault();
  if (e.ctrlKey || e.metaKey) return zoom(e.deltaY < 0 ? 1.08 : 1 / 1.08);
  if (Date.now() - wheelAt < 70) return; wheelAt = Date.now(); stopPlay(); step(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
document.addEventListener("keydown", e => {
  if (document.body.classList.contains("spatial-mode")) return;
  if ($("import-dialog").open || !state.series || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (["ArrowDown", "ArrowRight"].includes(e.key)) { e.preventDefault(); stopPlay(); step(1); }
  if (["ArrowUp", "ArrowLeft"].includes(e.key)) { e.preventDefault(); stopPlay(); step(-1); }
  if (e.key === "+" || e.key === "=") zoom(1.2);
  if (e.key === "-") zoom(1 / 1.2);
  if (e.key.toLowerCase() === "r") reset();
});
for (const name of ["series", "reports"]) $(name + "-tab").onclick = () => {
  for (const item of ["series", "reports"]) { $(item + "-tab").setAttribute("aria-selected", String(item === name)); $(item + "-panel").hidden = item !== name; }
};

async function refreshVolumes() {
  try {
    const volumes = await api("/api/volumes"); $("volumes").replaceChildren();
    if (!volumes.length) { const notice = document.createElement("div"); notice.className = "no-disc"; const strong = document.createElement("strong"); strong.textContent = "Waiting for a mounted disc."; notice.append(strong, document.createElement("br"), "Insert the DVD and close the drive. If it clicks or does not spin up, connect it directly to the Mac or use its additional power cable. The disc should appear in Finder before importing."); $("volumes").append(notice); }
    for (const volume of volumes) {
      const row = document.createElement("div"); row.className = "volume";
      const copy = document.createElement("div"), title = document.createElement("strong"), path = document.createElement("small"), button = document.createElement("button");
      title.textContent = volume.label; path.textContent = volume.path; copy.append(title,path); button.className = "primary"; button.textContent = "Copy & import"; button.disabled = state.importing; button.onclick = () => startImport(volume.path); row.append(copy,button); $("volumes").append(row);
    }
  } catch (e) { $("import-message").textContent = e.message; }
}
async function openImport() { stopPlay(); $("import-dialog").showModal(); await refreshVolumes(); }
$("import-open").onclick = $("empty-import").onclick = openImport;
$("import-close").onclick = () => $("import-dialog").close(); $("refresh-volumes").onclick = refreshVolumes;
async function startImport(source) {
  try {
    await api("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) });
    state.importing = true; $("import-message").textContent = ""; await refreshVolumes(); pollImport();
  } catch (e) { $("import-message").textContent = e.message; }
}
async function pollImport() {
  clearTimeout(importPoll);
  try {
    const status = await api("/api/import-status");
    state.importing = ["copying", "indexing"].includes(status.phase);
    $("import-progress").hidden = !state.importing;
    if (status.phase === "copying") {
      if (status.total) { $("copy-progress").max = status.total; $("copy-progress").value = status.completed; }
      else $("copy-progress").removeAttribute("value");
      $("progress-label").textContent = status.total ? `Copied and verified ${status.completed} of ${status.total} files…` : "Reading the disc…";
    } else if (status.phase === "indexing") { $("copy-progress").removeAttribute("value"); $("progress-label").textContent = "Organizing the image series…"; }
    if (state.importing) { importPoll = setTimeout(pollImport,1000); return; }
    if (status.phase === "done") { await loadLibrary(); $("import-message").textContent = status.message; toast(status.message); }
    if (status.phase === "error") $("import-message").textContent = status.message;
    if ($("import-dialog").open) await refreshVolumes();
  } catch (e) { $("import-message").textContent = e.message; state.importing = false; }
}
setDisabled(true);
window.mriViewer = {
  api,
  get library() { return state.library; },
  get selected() { return {series: state.series, index: state.index}; },
  async imageBlob(frame, signal) {
    const response = window.sharedImaging ? await window.sharedImaging.imageResponse(frame, new URLSearchParams(), signal) : await fetch(`/api/image/${frame}`, {signal});
    if (!response.ok) throw new Error("The image could not be loaded.");
    return response.blob();
  },
  async openSlice(seriesId, index) {
    const series = state.library?.series.find(s => s.id === seriesId);
    if (!series) return;
    await selectSeries(series); state.index = index; await showSlice();
  },
  stopPlay
};
if (window.sharedImaging) {
  window.addEventListener("imaging-ready", () => loadLibrary().catch(e => toast(`Could not open the shared study. ${e.message}`)));
} else {
  loadLibrary().then(pollImport).catch(e => toast(`Could not open the local library. ${e.message}`));
  setInterval(() => { if ($("import-dialog").open && !state.importing) refreshVolumes(); }, 5000);
}
