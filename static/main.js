/**
 * Document Network Viewer — main.js
 */

// ── State ──────────────────────────────────────────────────────────────────
let graphData = null;
let network = null;
let currentLevel = "root";
let currentL1 = null;
let currentL2 = null;
let searchHighlight = null;    // { l1Id, l2Id } | null
let nodesDataRef = null;
let edgesDataRef = null;
let nodePositionCache = {};    // { [nodeId]: {x, y} } — persists across renderLevel calls

// ── Color presets ──────────────────────────────────────────────────────────
const PRESET_LIGHT = {
  l1Bg: "#2563eb", l1Border: "#1d4ed8",
  l2Bg: "#7c3aed", l2Border: "#6d28d9",
  docBg: "#ffffff", docBorder: "#475569",
  semanticEdge: "#64748b",
  containEdge: "#a78bfa",
  selectionColor: "#f59e0b",
  searchL1Color: "#fb923c",
  searchL2Color: "#fbbf24",
};
const PRESET_DARK = {
  l1Bg: "#3b82f6", l1Border: "#60a5fa",
  l2Bg: "#a78bfa", l2Border: "#c4b5fd",
  docBg: "#1e293b", docBorder: "#64748b",
  semanticEdge: "#94a3b8",
  containEdge: "#7c3aed",
  selectionColor: "#fbbf24",
  searchL1Color: "#f97316",
  searchL2Color: "#f59e0b",
};

let colorMode = "auto";
let appColors = { ...PRESET_LIGHT };
let currentSavedSettings = {};

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
    1: {
      color: {
        background: appColors.l1Bg, border: appColors.l1Border,
        highlight: { background: appColors.selectionColor, border: appColors.selectionColor },
      },
      font: { color: "#ffffff", size: 15, face: "sans-serif" }, shape: "ellipse", size: 28,
    },
    2: {
      color: {
        background: appColors.l2Bg, border: appColors.l2Border,
        highlight: { background: appColors.selectionColor, border: appColors.selectionColor },
      },
      font: { color: "#ffffff", size: 13, face: "sans-serif" }, shape: "ellipse", size: 22,
    },
    3: {
      color: {
        background: appColors.docBg, border: appColors.docBorder,
        highlight: { background: appColors.selectionColor, border: appColors.selectionColor },
      },
      font: { color: docFont, size: 12, face: "sans-serif" }, shape: "box", size: 16,
    },
  };
}

let LEVEL_STYLES = buildLevelStyles();

// Update colors in-place without resetting node positions or physics
function refreshDisplayedColors() {
  if (!nodesDataRef || !edgesDataRef) return;
  LEVEL_STYLES = buildLevelStyles();

  const allNodes = nodesForLevel(currentLevel, currentL1, currentL2);
  const nodeUpdates = styledNodes(allNodes).map(n => ({ id: n.id, color: n.color, font: n.font }));
  nodesDataRef.update(nodeUpdates);

  const edgeUpdates = edgesDataRef.getIds().map(id => {
    const e = edgesDataRef.get(id);
    if (e.dashes) {
      return { id, color: { color: appColors.containEdge, highlight: appColors.containEdge, inherit: false } };
    } else {
      return { id, color: { color: appColors.semanticEdge, highlight: appColors.semanticEdge, inherit: false } };
    }
  });
  edgesDataRef.update(edgeUpdates);
}

function applyTheme(colors) {
  Object.assign(appColors, colors);
  LEVEL_STYLES = buildLevelStyles();
  document.documentElement.setAttribute("data-theme", resolveEffectiveTheme());
  if (network && nodesDataRef && edgesDataRef) {
    refreshDisplayedColors();
  }
}

function loadThemeColors(savedSettings) {
  colorMode = savedSettings.colorMode || "auto";
  const theme = resolveEffectiveTheme();
  const preset = theme === "dark" ? PRESET_DARK : PRESET_LIGHT;
  const saved = savedSettings[theme + "Colors"] || {};
  applyTheme({ ...preset, ...saved });
}

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
    color: { color: "#64748b", highlight: "#64748b", inherit: false },
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
  if (level === "all-l2") {
    return [
      ...graphData.nodes.filter(n => n.level === 1),
      ...graphData.nodes.filter(n => n.level === 2),
    ];
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

  // Semantic edges — explicit color, no inheritance
  const semanticEdges = graphData.edges
    .filter(e => idSet.has(e.from) && idSet.has(e.to) && levelOf[e.from] === levelOf[e.to])
    .map(e => ({
      ...e,
      color: { color: appColors.semanticEdge, highlight: appColors.semanticEdge, inherit: false },
    }));

  // Containment edges (parent → child, dashed)
  const containmentEdges = [];
  for (const n of graphData.nodes) {
    if (!idSet.has(n.id)) continue;
    if (n.level === 2) {
      const l1Id = `l1:${n.l1}`;
      if (idSet.has(l1Id)) {
        containmentEdges.push({
          from: l1Id, to: n.id, dashes: true, width: 1,
          color: { color: appColors.containEdge, highlight: appColors.containEdge, inherit: false },
        });
      }
    } else if (n.level === 3) {
      const l2Id = `l2:${n.l1}:${n.l2}`;
      if (idSet.has(l2Id)) {
        containmentEdges.push({
          from: l2Id, to: n.id, dashes: true, width: 1,
          color: { color: appColors.containEdge, highlight: appColors.containEdge, inherit: false },
        });
      }
    }
  }

  return [...semanticEdges, ...containmentEdges];
}

function styledNodes(nodes) {
  // Compute max ndocs per level for proportional size scaling
  const maxNdocs = { 1: 1, 2: 1 };
  for (const n of nodes) {
    if ((n.level === 1 || n.level === 2) && n.ndocs > maxNdocs[n.level]) {
      maxNdocs[n.level] = n.ndocs;
    }
  }

  return nodes.map(n => {
    const style = LEVEL_STYLES[n.level] || {};
    let sizeOverride = {};
    if (n.level === 1 && n.ndocs) {
      const ratio = n.ndocs / maxNdocs[1];
      sizeOverride = { size: Math.round(20 + ratio * 20) };  // 20–40
    } else if (n.level === 2 && n.ndocs) {
      const ratio = n.ndocs / maxNdocs[2];
      sizeOverride = { size: Math.round(14 + ratio * 16) };  // 14–30
    }
    let extra = {};
    if (searchHighlight) {
      if (n.id === searchHighlight.l2Id)
        extra = {
          color: { background: appColors.searchL2Color, border: "#d97706", highlight: { background: appColors.searchL2Color, border: "#d97706" } },
          font: { color: "#1e2229" },
        };
      else if (n.id === searchHighlight.l1Id)
        extra = {
          color: { background: appColors.searchL1Color, border: "#ea580c", highlight: { background: appColors.searchL1Color, border: "#ea580c" } },
          font: { color: "#ffffff" },
        };
    }
    return { ...n, ...style, ...sizeOverride, ...extra };
  });
}

function renderLevel(level, l1, l2) {
  currentLevel = level;
  currentL1 = l1;
  currentL2 = l2;

  // Snapshot positions before wiping the graph so they can be restored after setData
  if (network) {
    Object.assign(nodePositionCache, network.getPositions());
  }

  const allNodes = nodesForLevel(level, l1, l2);
  const nodeIds = allNodes.map(n => n.id);
  const edges = edgesForNodes(nodeIds);

  // Bake current searchHighlight into node styles
  const nodesDataset = new vis.DataSet(styledNodes(allNodes));
  const edgesDataset = new vis.DataSet(edges);
  nodesDataRef = nodesDataset;
  edgesDataRef = edgesDataset;

  const dataset = { nodes: nodesDataset, edges: edgesDataset };
  const container = document.getElementById("graph");

  if (network) {
    network.setOptions({ physics: { enabled: true } });
    network.setData(dataset);
  } else {
    network = new vis.Network(container, dataset, NETWORK_OPTIONS);
    network.on("doubleClick", onNodeDoubleClick);
    network.on("click", onNodeClick);
    network.on("oncontext", onNodeRightClick);
  }

  // Restore saved positions and pin them so physics doesn't move them;
  // only new/unseen nodes will float during stabilization.
  const pinnedUpdates = [];
  for (const n of allNodes) {
    const saved = nodePositionCache[n.id];
    if (saved) {
      network.moveNode(n.id, saved.x, saved.y);
      pinnedUpdates.push({ id: n.id, fixed: { x: true, y: true } });
    }
  }
  if (pinnedUpdates.length) {
    nodesDataset.update(pinnedUpdates);
  }

  // Disable physics after layout so nodes stay put.
  // Uses network.on + manual removal (network.once is not in vis-network 9.1.9's public API).
  // Fallback timer ensures the graph appears even if the event never fires.
  let physicsOffTimer;
  const onStabilized = () => {
    network.off("stabilizationIterationsDone", onStabilized);
    clearTimeout(physicsOffTimer);
    nodesDataset.update(allNodes.map(n => ({ id: n.id, fixed: false })));
    network.setOptions({ physics: { enabled: false } });
    network.fit();
  };
  network.on("stabilizationIterationsDone", onStabilized);
  physicsOffTimer = setTimeout(() => {
    network.off("stabilizationIterationsDone", onStabilized);
    nodesDataset.update(allNodes.map(n => ({ id: n.id, fixed: false })));
    network.setOptions({ physics: { enabled: false } });
    network.fit();
  }, 5000);

  updateBreadcrumb(level, l1, l2);
}

// Navigate: clears search highlight before rendering
function navigateTo(level, l1, l2) {
  searchHighlight = null;
  renderLevel(level, l1, l2);
}

// ── Interaction ─────────────────────────────────────────────────────────────
function onNodeDoubleClick(params) {
  if (!params.nodes.length) return;
  const nodeId = params.nodes[0];
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  if (node.level === 1) {
    navigateTo("l1", node._baseLabel || node.label, null);
  } else if (node.level === 2) {
    navigateTo("l2", node.l1, node._baseLabel || node.label);
  }
}

document.getElementById("expand-all-btn").addEventListener("click", () => {
  navigateTo("all-l2", null, null);
});
document.getElementById("collapse-all-btn").addEventListener("click", () => {
  navigateTo("root", null, null);
});

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
  } else if (level === "all-l2") {
    bc.appendChild(crumb("All", () => navigateTo("root", null, null), false));
    bc.appendChild(sep());
    bc.appendChild(crumb("Expanded", null, true));
  } else if (level === "l1") {
    bc.appendChild(crumb("All", () => navigateTo("root", null, null), false));
    bc.appendChild(sep());
    bc.appendChild(crumb(l1, null, true));
  } else if (level === "l2") {
    bc.appendChild(crumb("All", () => navigateTo("root", null, null), false));
    bc.appendChild(sep());
    bc.appendChild(crumb(l1, () => navigateTo("l1", l1, null), false));
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
  const nodeL1 = contextNode.l1;
  hideContextMenu();

  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === oldName) return;

  const res = await fetch("/api/subcategory", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ l1: nodeL1, old_l2: oldName, new_l2: newName.trim() }),
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
  searchHighlight = null;
  nodePositionCache = {};
  renderLevel(currentLevel, currentL1, currentL2);
}

// ── Keyword search ──────────────────────────────────────────────────────────
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const searchResults = document.getElementById("search-results");
const searchResultsList = document.getElementById("search-results-list");
const searchResultsLabel = document.getElementById("search-results-label");

let activeResultLi = null;

function closeSearchResults() {
  searchResults.classList.add("hidden");
  searchInput.value = "";
  activeResultLi = null;
  searchHighlight = null;
  if (nodesDataRef) refreshDisplayedColors();
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
  activeResultLi = null;

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
      if (activeResultLi) activeResultLi.classList.remove("result-selected");
      li.classList.add("result-selected");
      activeResultLi = li;

      const label = docNode ? docNode.label : match.filename;
      openDoc(match.filename, label);

      if (docNode) {
        searchHighlight = {
          l1Id: `l1:${docNode.l1}`,
          l2Id: `l2:${docNode.l1}:${docNode.l2}`,
        };
        refreshDisplayedColors();  // Highlight visible nodes without navigating
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

function readSettingsInputs() {
  const updated = {};
  document.querySelectorAll("#settings-panel input[data-key]").forEach(inp => {
    updated[inp.dataset.key] = inp.value;
  });
  return updated;
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

document.getElementById("settings-apply").addEventListener("click", () => {
  applyTheme(readSettingsInputs());
});

document.getElementById("settings-save").addEventListener("click", async () => {
  const updated = readSettingsInputs();
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
  document.querySelectorAll("#settings-panel input[data-key]").forEach(inp => {
    inp.value = preset[inp.dataset.key] || "#000000";
  });
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
