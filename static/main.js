/**
 * Document Network Viewer — main.js
 *
 * Drill-down graph: All L1 → click L1 → its L2s → click L2 → its docs → click doc → side panel
 * Breadcrumb lets you navigate back up at any level.
 */

// ── State ──────────────────────────────────────────────────────────────────
let graphData = null;          // full data/index.json
let network = null;            // vis.js Network instance
let currentLevel = "root";     // "root" | "l1" | "l2"
let currentL1 = null;
let currentL2 = null;
let searchHighlight = null;    // { l1Id, l2Id } | null — baked into styledNodes

// ── Color presets ──────────────────────────────────────────────────────────
const PRESET_LIGHT = {
  l1Bg: "#2563eb", l1Border: "#1d4ed8",
  l2Bg: "#7c3aed", l2Border: "#6d28d9",
  docBg: "#ffffff", docBorder: "#475569",
  semanticEdge: "#64748b",
  containEdge: "#a78bfa",
};
const PRESET_DARK = {
  l1Bg: "#3b82f6", l1Border: "#60a5fa",
  l2Bg: "#a78bfa", l2Border: "#c4b5fd",
  docBg: "#1e293b", docBorder: "#64748b",
  semanticEdge: "#94a3b8",
  containEdge: "#7c3aed",
};

let colorMode = "auto";          // "light" | "dark" | "auto"
let appColors = { ...PRESET_LIGHT };
let currentSavedSettings = {};   // last response from /api/settings

const THEME_LABELS = { light: "☀ Light", dark: "🌙 Dark", auto: "⚙ Auto" };
const THEME_ORDER = ["light", "dark", "auto"];

function resolveEffectiveTheme() {
  if (colorMode === "auto")
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return colorMode;
}

function buildLevelStyles() {
  const docFont = resolveEffectiveTheme() === "dark" ? "#f1f5f9" : "#1e2229";
  return {
    1: { color: { background: appColors.l1Bg, border: appColors.l1Border, highlight: { background: appColors.l1Bg, border: appColors.l1Border } }, font: { color: "#ffffff", size: 15, face: "sans-serif" }, shape: "ellipse", size: 28 },
    2: { color: { background: appColors.l2Bg, border: appColors.l2Border, highlight: { background: appColors.l2Bg, border: appColors.l2Border } }, font: { color: "#ffffff", size: 13, face: "sans-serif" }, shape: "ellipse", size: 22 },
    3: { color: { background: appColors.docBg, border: appColors.docBorder, highlight: { background: appColors.docBg, border: "#3b82f6" } }, font: { color: docFont, size: 12, face: "sans-serif" }, shape: "box", size: 16 },
  };
}

let LEVEL_STYLES = buildLevelStyles();

function applyColorOptions() {
  if (network) network.setOptions({ edges: { color: { color: appColors.semanticEdge, highlight: appColors.semanticEdge } } });
}

function applyTheme(colors) {
  Object.assign(appColors, colors);
  LEVEL_STYLES = buildLevelStyles();
  document.documentElement.setAttribute("data-theme", resolveEffectiveTheme());
  if (network) {
    renderLevel(currentLevel, currentL1, currentL2);
    applyColorOptions();
  }
}

function loadThemeColors(savedSettings) {
  colorMode = savedSettings.colorMode || "auto";
  const theme = resolveEffectiveTheme();
  const preset = theme === "dark" ? PRESET_DARK : PRESET_LIGHT;
  const saved = savedSettings[theme + "Colors"] || {};
  applyTheme({ ...preset, ...saved });
}

// React to OS dark/light preference changes when in "auto" mode
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (colorMode !== "auto") return;
  const theme = resolveEffectiveTheme();
  const preset = theme === "dark" ? PRESET_DARK : PRESET_LIGHT;
  const saved = currentSavedSettings[theme + "Colors"] || {};
  applyTheme({ ...preset, ...saved });
});

// ── vis.js network options ──────────────────────────────────────────────────
const NETWORK_OPTIONS = {
  physics: {
    enabled: true,
    solver: "forceAtlas2Based",
    forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.01, springLength: 120, springConstant: 0.08 },
    stabilization: { iterations: 150 },
  },
  interaction: { hover: true, tooltipDelay: 200 },
  edges: {
    color: { color: "#64748b", highlight: "#64748b" },
    width: 1.5,
    smooth: { type: "continuous" },
    arrows: { to: { enabled: false } },
  },
  nodes: { borderWidth: 2 },
};

// ── Initialise ─────────────────────────────────────────────────────────────
async function init() {
  const [graphRes, settingsRes] = await Promise.all([
    fetch("/api/graph"),
    fetch("/api/settings"),
  ]);

  if (!graphRes.ok) {
    document.getElementById("graph").innerHTML =
      `<p style="padding:20px;color:#ef4444">Failed to load graph data.<br>Run <code>uv run preprocess.py</code> first.</p>`;
    return;
  }

  currentSavedSettings = settingsRes.ok ? await settingsRes.json() : {};
  loadThemeColors(currentSavedSettings);
  document.getElementById("theme-btn").textContent = THEME_LABELS[colorMode];

  graphData = await graphRes.json();
  applyDocCounts(graphData);
  renderLevel("root", null, null);
  applyColorOptions();
}

// ── Document counts ────────────────────────────────────────────────────────
function applyDocCounts(data) {
  const l1Count = {};
  const l2Count = {};

  for (const n of data.nodes) {
    if (n.level !== 3) continue;
    l1Count[n.l1] = (l1Count[n.l1] || 0) + 1;
    const key = `${n.l1}\0${n.l2}`;
    l2Count[key] = (l2Count[key] || 0) + 1;
  }

  for (const n of data.nodes) {
    if (n.level === 1) {
      const c = l1Count[n.label] || 0;
      n._baseLabel = n.label;
      n.label = `${n.label} (${c})`;
    } else if (n.level === 2) {
      const key = `${n.l1}\0${n.label}`;
      const c = l2Count[key] || 0;
      n._baseLabel = n.label;
      n.label = `${n.label} (${c})`;
    }
  }
}

// ── Render helpers ──────────────────────────────────────────────────────────

function nodesForLevel(level, l1, l2) {
  if (level === "root") {
    return graphData.nodes.filter(n => n.level === 1);
  }
  if (level === "l1") {
    return [
      ...graphData.nodes.filter(n => n.level === 1),
      ...graphData.nodes.filter(n => n.level === 2 && n.l1 === l1),
    ];
  }
  if (level === "l2") {
    return [
      ...graphData.nodes.filter(n => n.level === 1),
      ...graphData.nodes.filter(n => n.level === 2 && n.l1 === l1),
      ...graphData.nodes.filter(n => n.level === 3 && n.l1 === l1 && n.l2 === l2),
    ];
  }
  return [];
}

function edgesForNodes(nodeIds) {
  const idSet = new Set(nodeIds);
  const levelOf = {};
  for (const n of graphData.nodes) {
    if (idSet.has(n.id)) levelOf[n.id] = n.level;
  }

  // Same-level semantic edges
  const semanticEdges = graphData.edges
    .filter(e => idSet.has(e.from) && idSet.has(e.to) && levelOf[e.from] === levelOf[e.to])
    .map(e => e.width != null ? { ...e, width: e.width } : e);

  // Containment edges (parent → child, dashed)
  const containmentEdges = [];
  for (const n of graphData.nodes) {
    if (!idSet.has(n.id)) continue;
    if (n.level === 2) {
      const l1Id = `l1:${n.l1}`;
      if (idSet.has(l1Id)) {
        containmentEdges.push({ from: l1Id, to: n.id, dashes: true, width: 1, color: { color: appColors.containEdge } });
      }
    } else if (n.level === 3) {
      const l2Id = `l2:${n.l1}:${n.l2}`;
      if (idSet.has(l2Id)) {
        containmentEdges.push({ from: l2Id, to: n.id, dashes: true, width: 1, color: { color: appColors.containEdge } });
      }
    }
  }

  return [...semanticEdges, ...containmentEdges];
}

function styledNodes(nodes) {
  return nodes.map(n => {
    const style = LEVEL_STYLES[n.level] || {};
    let extra = {};
    if (searchHighlight) {
      if (n.id === searchHighlight.l2Id)
        extra = { color: { background: "#fbbf24", border: "#d97706" }, font: { color: "#1e2229" } };
      else if (n.id === searchHighlight.l1Id)
        extra = { color: { background: "#fb923c", border: "#ea580c" }, font: { color: "#ffffff" } };
    }
    return { ...n, ...style, ...extra };
  });
}

function renderLevel(level, l1, l2) {
  currentLevel = level;
  currentL1 = l1;
  currentL2 = l2;

  const allNodes = nodesForLevel(level, l1, l2);
  const nodeIds = allNodes.map(n => n.id);
  const edges = edgesForNodes(nodeIds);

  const dataset = {
    nodes: new vis.DataSet(styledNodes(allNodes)),
    edges: new vis.DataSet(edges),
  };
  searchHighlight = null;  // clear after baking into dataset

  const container = document.getElementById("graph");

  if (network) {
    network.setData(dataset);
  } else {
    network = new vis.Network(container, dataset, NETWORK_OPTIONS);
    network.on("doubleClick", onNodeDoubleClick);
    network.on("click", onNodeClick);
    network.on("oncontext", onNodeRightClick);
  }

  updateBreadcrumb(level, l1, l2);
}

// ── Interaction ─────────────────────────────────────────────────────────────
function onNodeDoubleClick(params) {
  if (!params.nodes.length) return;
  const nodeId = params.nodes[0];
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  if (node.level === 1) {
    renderLevel("l1", node._baseLabel || node.label, null);
  } else if (node.level === 2) {
    renderLevel("l2", node.l1, node._baseLabel || node.label);
  }
  // level 3 (doc) is handled by single-click
}

function onNodeClick(params) {
  if (!params.nodes.length) return;
  const nodeId = params.nodes[0];
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  if (node.level === 3 && node.file) {
    openDoc(node.file, node.label);
  }
}

// ── Doc panel ──────────────────────────────────────────────────────────────
async function openDoc(filename, title) {
  const titleEl = document.getElementById("doc-title");
  const contentEl = document.getElementById("doc-content");

  titleEl.textContent = title;
  contentEl.innerHTML = "<p style='color:#6b7280'>Loading…</p>";
  showDocPanel();

  const res = await fetch(`/api/doc/${encodeURIComponent(filename)}`);
  if (!res.ok) {
    contentEl.innerHTML = `<p style='color:#ef4444'>Failed to load document.</p>`;
    return;
  }
  const data = await res.json();
  titleEl.textContent = data.title || title;
  contentEl.innerHTML = data.html;
}

const docPanel = document.getElementById("doc-panel");
const resizeHandle = document.getElementById("resize-handle");

document.getElementById("doc-close").addEventListener("click", () => {
  docPanel.classList.add("hidden");
  resizeHandle.classList.add("hidden");
});

function showDocPanel() {
  docPanel.classList.remove("hidden");
  resizeHandle.classList.remove("hidden");
}

// ── Resizable doc panel ─────────────────────────────────────────────────────
const PANEL_MIN = 200;
const PANEL_MAX_RATIO = 0.8;

const savedWidth = localStorage.getItem("docPanelWidth");
if (savedWidth) docPanel.style.width = `${savedWidth}px`;

resizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  resizeHandle.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function onMouseMove(e) {
    const maxW = window.innerWidth * PANEL_MAX_RATIO;
    const newW = Math.min(maxW, Math.max(PANEL_MIN, window.innerWidth - e.clientX));
    docPanel.style.width = `${newW}px`;
  }

  function onMouseUp() {
    resizeHandle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("docPanelWidth", parseInt(docPanel.style.width));
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
});

// ── Breadcrumb ──────────────────────────────────────────────────────────────
function updateBreadcrumb(level, l1, l2) {
  const bc = document.getElementById("breadcrumb");
  bc.innerHTML = "";

  function crumb(label, onClick, active) {
    const span = document.createElement("span");
    span.className = "crumb" + (active ? " active" : "");
    span.textContent = label;
    if (!active) span.addEventListener("click", onClick);
    return span;
  }

  function sep() {
    const s = document.createElement("span");
    s.className = "crumb-sep";
    s.textContent = "›";
    return s;
  }

  if (level === "root") {
    bc.appendChild(crumb("All", null, true));
  } else if (level === "l1") {
    bc.appendChild(crumb("All", () => renderLevel("root", null, null), false));
    bc.appendChild(sep());
    bc.appendChild(crumb(l1, null, true));
  } else if (level === "l2") {
    bc.appendChild(crumb("All", () => renderLevel("root", null, null), false));
    bc.appendChild(sep());
    bc.appendChild(crumb(l1, () => renderLevel("l1", l1, null), false));
    bc.appendChild(sep());
    bc.appendChild(crumb(l2, null, true));
  }
}

// ── Rename / Merge subcategories ────────────────────────────────────────────
let contextNode = null;

const ctxMenu = document.getElementById("context-menu");
const mergeOverlay = document.getElementById("merge-overlay");

function hideContextMenu() {
  ctxMenu.classList.add("hidden");
  contextNode = null;
}

function onNodeRightClick(params) {
  params.event.preventDefault();
  hideContextMenu();

  if (!params.nodes.length) return;
  const node = graphData.nodes.find(n => n.id === params.nodes[0]);
  if (!node || node.level !== 2) return;

  contextNode = node;
  ctxMenu.style.left = `${params.event.clientX}px`;
  ctxMenu.style.top  = `${params.event.clientY}px`;
  ctxMenu.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});

document.getElementById("ctx-rename").addEventListener("click", async () => {
  if (!contextNode) return;
  const oldName = contextNode._baseLabel || contextNode.label;
  hideContextMenu();

  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === oldName) return;

  const res = await fetch("/api/subcategory", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ l1: contextNode.l1, old_l2: oldName, new_l2: newName.trim() }),
  });
  if (!res.ok) { alert("Rename failed."); return; }
  if (currentLevel === "l2" && currentL2 === oldName) {
    currentL2 = newName.trim();
  }
  await reloadGraph();
});

document.getElementById("ctx-merge").addEventListener("click", () => {
  if (!contextNode) return;
  const sourceName = contextNode._baseLabel || contextNode.label;
  const sourceL1 = contextNode.l1;
  hideContextMenu();

  const others = graphData.nodes.filter(n =>
    n.level === 2 && n.l1 === sourceL1 && (n._baseLabel || n.label) !== sourceName
  );
  if (!others.length) { alert("No other subcategories to merge into."); return; }

  document.getElementById("merge-source-label").textContent = sourceName;
  const sel = document.getElementById("merge-target-select");
  sel.innerHTML = others.map(n => {
    const base = n._baseLabel || n.label;
    return `<option value="${base}">${base}</option>`;
  }).join("");

  mergeOverlay.classList.remove("hidden");

  document.getElementById("merge-confirm").onclick = async () => {
    const targetName = sel.value;
    mergeOverlay.classList.add("hidden");
    const res = await fetch("/api/subcategory/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ l1: sourceL1, source_l2: sourceName, target_l2: targetName }),
    });
    if (!res.ok) { alert("Merge failed."); return; }
    await reloadGraph();
  };
});

document.getElementById("merge-cancel").addEventListener("click", () => {
  mergeOverlay.classList.add("hidden");
});

async function reloadGraph() {
  const res = await fetch("/api/graph");
  if (!res.ok) return;
  graphData = await res.json();
  applyDocCounts(graphData);
  renderLevel(currentLevel, currentL1, currentL2);
}

// ── Keyword search ──────────────────────────────────────────────────────────
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const searchResults = document.getElementById("search-results");
const searchResultsList = document.getElementById("search-results-list");
const searchResultsLabel = document.getElementById("search-results-label");

function closeSearchResults() {
  searchResults.classList.add("hidden");
  searchInput.value = "";
}

document.getElementById("search-results-close").addEventListener("click", closeSearchResults);

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSearchResults();
  if (e.key === "Enter") runSearch();
});
searchBtn.addEventListener("click", runSearch);

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;

  searchResultsLabel.textContent = "Searching…";
  searchResultsList.innerHTML = "";
  searchResults.classList.remove("hidden");

  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    searchResultsLabel.textContent = "Search failed.";
    return;
  }
  const data = await res.json();

  if (!data.matches.length) {
    searchResultsLabel.textContent = `No results for "${q}"`;
    return;
  }

  searchResultsLabel.textContent = `${data.matches.length} result(s) for "${q}"`;

  for (const match of data.matches) {
    const docNode = graphData?.nodes.find(n => n.level === 3 && n.file === match.filename);

    const li = document.createElement("li");
    li.innerHTML = `
      <div class="result-name">${docNode ? docNode.label : match.filename}</div>
      <div class="result-snippet">${match.snippet || ""}</div>
    `;

    li.addEventListener("click", () => {
      // Always open doc panel first (works even if docNode not in graph)
      const label = docNode ? docNode.label : match.filename;
      openDoc(match.filename, label);
      if (docNode) {
        // Set highlight state BEFORE renderLevel so styledNodes bakes it in
        searchHighlight = {
          l1Id: `l1:${docNode.l1}`,
          l2Id: `l2:${docNode.l1}:${docNode.l2}`,
        };
        renderLevel("l2", docNode.l1, docNode.l2);
      }
    });

    searchResultsList.appendChild(li);
  }
}

// ── Theme toggle ────────────────────────────────────────────────────────────
document.getElementById("theme-btn").addEventListener("click", async () => {
  const idx = THEME_ORDER.indexOf(colorMode);
  colorMode = THEME_ORDER[(idx + 1) % 3];
  document.getElementById("theme-btn").textContent = THEME_LABELS[colorMode];
  const theme = resolveEffectiveTheme();
  const preset = theme === "dark" ? PRESET_DARK : PRESET_LIGHT;
  const saved = currentSavedSettings[theme + "Colors"] || {};
  applyTheme({ ...preset, ...saved });
  await saveSettings();
});

// ── Color settings panel ────────────────────────────────────────────────────
async function saveSettings() {
  currentSavedSettings.colorMode = colorMode;
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(currentSavedSettings),
  });
}

document.getElementById("settings-btn").addEventListener("click", () => {
  const panel = document.getElementById("settings-panel");
  panel.classList.toggle("hidden");
  panel.querySelectorAll("input[data-key]").forEach(inp => {
    inp.value = appColors[inp.dataset.key] || "#000000";
  });
});

document.getElementById("settings-close").addEventListener("click", () => {
  document.getElementById("settings-panel").classList.add("hidden");
});

document.getElementById("settings-save").addEventListener("click", async () => {
  const updated = {};
  document.querySelectorAll("#settings-panel input[data-key]").forEach(inp => {
    updated[inp.dataset.key] = inp.value;
  });
  const theme = resolveEffectiveTheme();
  currentSavedSettings[theme + "Colors"] = updated;
  applyTheme(updated);
  document.getElementById("settings-panel").classList.add("hidden");
  await saveSettings();
});

document.getElementById("settings-reset").addEventListener("click", async () => {
  const theme = resolveEffectiveTheme();
  delete currentSavedSettings[theme + "Colors"];
  const preset = theme === "dark" ? PRESET_DARK : PRESET_LIGHT;
  applyTheme(preset);
  await saveSettings();
});

// ── Quit ─────────────────────────────────────────────────────────────────────
document.getElementById("quit-btn").addEventListener("click", async () => {
  if (!confirm("Stop the server and quit?")) return;
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  window.close();
  document.body.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#6b7280;">
      <p>Server stopped. You can close this tab.</p>
    </div>`;
});

// ── Boot ──────────────────────────────────────────────────────────────────
init();
