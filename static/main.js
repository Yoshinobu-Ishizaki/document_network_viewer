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

// ── vis.js visual options ──────────────────────────────────────────────────
const LEVEL_STYLES = {
  1: { color: { background: "#3b82f6", border: "#1d4ed8", highlight: { background: "#2563eb", border: "#1e40af" } }, font: { color: "#ffffff", size: 15, face: "sans-serif" }, shape: "ellipse", size: 28 },
  2: { color: { background: "#8b5cf6", border: "#6d28d9", highlight: { background: "#7c3aed", border: "#5b21b6" } }, font: { color: "#ffffff", size: 13, face: "sans-serif" }, shape: "ellipse", size: 22 },
  3: { color: { background: "#ffffff", border: "#94a3b8", highlight: { background: "#f0f9ff", border: "#3b82f6" } }, font: { color: "#1e2229", size: 12, face: "sans-serif" }, shape: "box", size: 16 },
};

const NETWORK_OPTIONS = {
  physics: {
    enabled: true,
    solver: "forceAtlas2Based",
    forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.01, springLength: 120, springConstant: 0.08 },
    stabilization: { iterations: 150 },
  },
  interaction: { hover: true, tooltipDelay: 200 },
  edges: {
    color: { color: "#cbd5e1", highlight: "#94a3b8" },
    width: 1.5,
    smooth: { type: "continuous" },
    arrows: { to: { enabled: false } },
  },
  nodes: { borderWidth: 2 },
};

// ── Initialise ─────────────────────────────────────────────────────────────
async function init() {
  const res = await fetch("/api/graph");
  if (!res.ok) {
    document.getElementById("graph").innerHTML =
      `<p style="padding:20px;color:#ef4444">Failed to load graph data.<br>Run <code>uv run preprocess.py</code> first.</p>`;
    return;
  }
  graphData = await res.json();
  applyDocCounts(graphData);
  renderLevel("root", null, null);
}

// ── Document counts ────────────────────────────────────────────────────────
function applyDocCounts(data) {
  const l1Count = {};   // l1 label → total doc count
  const l2Count = {};   // "l1\0l2" → doc count

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

// ── Render helpers ─────────────────────────────────────────────────────────

// Style for the anchor (parent) node shown in drill-down views — dimmed, fixed
const ANCHOR_STYLE = {
  color: { background: "#e2e8f0", border: "#94a3b8", highlight: { background: "#e2e8f0", border: "#94a3b8" } },
  font: { color: "#94a3b8", size: 13, face: "sans-serif" },
  fixed: true,
  physics: false,
};

function nodesForLevel(level, l1, l2) {
  if (level === "root") {
    return { children: graphData.nodes.filter(n => n.level === 1), anchor: null };
  }
  if (level === "l1") {
    // No anchor: L2 nodes connect to each other via semantic edges
    const children = graphData.nodes.filter(n => n.level === 2 && n.l1 === l1);
    return { children, anchor: null };
  }
  if (level === "l2") {
    const anchor = graphData.nodes.find(n => n.level === 2 && n.l1 === l1 && (n._baseLabel || n.label) === l2);
    const children = graphData.nodes.filter(n => n.level === 3 && n.l1 === l1 && n.l2 === l2);
    return { children, anchor };
  }
  return { children: [], anchor: null };
}

function edgesForNodes(nodeIds) {
  const idSet = new Set(nodeIds);
  return graphData.edges
    .filter(e => idSet.has(e.from) && idSet.has(e.to))
    .map(e => e.width != null ? { ...e, width: e.width } : e);
}

function styledNodes(nodes, anchorId) {
  return nodes.map(n => {
    if (n.id === anchorId) {
      return { ...n, ...ANCHOR_STYLE, shape: "ellipse" };
    }
    const style = LEVEL_STYLES[n.level] || {};
    return { ...n, ...style };
  });
}

function renderLevel(level, l1, l2) {
  currentLevel = level;
  currentL1 = l1;
  currentL2 = l2;

  const { children, anchor } = nodesForLevel(level, l1, l2);
  const allNodes = anchor ? [anchor, ...children] : children;
  const nodeIds = allNodes.map(n => n.id);
  const edges = edgesForNodes(nodeIds);

  const dataset = {
    nodes: new vis.DataSet(styledNodes(allNodes, anchor?.id)),
    edges: new vis.DataSet(edges),
  };

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

// ── Interaction ────────────────────────────────────────────────────────────
function onNodeDoubleClick(params) {
  if (!params.nodes.length) return;
  const nodeId = params.nodes[0];
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  // Don't drill into the anchor (parent) node shown in the current view
  // Use _baseLabel (without count) as the routing key
  if (node.level === 1 && currentLevel === "root") {
    renderLevel("l1", node._baseLabel || node.label, null);
  } else if (node.level === 2 && currentLevel === "l1") {
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

// ── Doc panel ─────────────────────────────────────────────────────────────
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

// Show resize handle whenever doc panel opens
function showDocPanel() {
  docPanel.classList.remove("hidden");
  resizeHandle.classList.remove("hidden");
}

// ── Resizable doc panel ────────────────────────────────────────────────────
const PANEL_MIN = 200;
const PANEL_MAX_RATIO = 0.8;

// Restore saved width from previous session
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

// ── Breadcrumb ────────────────────────────────────────────────────────────
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

// ── Rename / Merge subcategories ──────────────────────────────────────────
let contextNode = null;  // L2 node currently targeted by right-click menu

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
  await reloadGraph();
});

document.getElementById("ctx-merge").addEventListener("click", () => {
  if (!contextNode) return;
  const sourceName = contextNode._baseLabel || contextNode.label;
  const sourceL1 = contextNode.l1;
  hideContextMenu();

  // Build list of other L2 nodes in the same L1
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

// ── Keyword search ────────────────────────────────────────────────────────
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
    // Find the doc node in graphData
    const docNode = graphData?.nodes.find(n => n.level === 3 && n.file === match.filename);

    const li = document.createElement("li");
    li.innerHTML = `
      <div class="result-name">${docNode ? docNode.label : match.filename}</div>
      <div class="result-snippet">${match.snippet || ""}</div>
    `;

    li.addEventListener("click", () => {
      closeSearchResults();
      if (docNode) {
        // Navigate to the doc's L2 view, then open the doc panel
        renderLevel("l2", docNode.l1, docNode.l2);
        openDoc(docNode.file, docNode.label);
      }
    });

    searchResultsList.appendChild(li);
  }
}

// ── Quit ──────────────────────────────────────────────────────────────────
document.getElementById("quit-btn").addEventListener("click", async () => {
  if (!confirm("Stop the server and quit?")) return;
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  document.body.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#6b7280;">
      <p>Server stopped. You can close this tab.</p>
    </div>`;
});

// ── Boot ──────────────────────────────────────────────────────────────────
init();
