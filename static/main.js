/**
 * Document Network Viewer — main.js
 */

// ── State ──────────────────────────────────────────────────────────────────
let graphData = null;
let network = null;
let searchHighlight = null;    // { l1Id, l2Id, docId } | null
let nodesDataRef = null;
let edgesDataRef = null;
let nodePositionCache = {};    // { [nodeId]: {x, y} } — persists across renderGraph calls
let skipPositionSnapshot = false; // when true, renderGraph won't snapshot current positions
let selectionState = null;    // { type: 'node', id } or { type: 'edge', edgeId, endpoints: Set }

// Independent expand/collapse state (replaces drill-down navigation)
let expandedL1s = new Set();   // L1 base labels
let expandedL2s = new Set();   // L2 node IDs

// ── Color presets ──────────────────────────────────────────────────────────
const PRESET_LIGHT = {
  l1Bg: "#2563eb", l1Border: "#1d4ed8",
  l2Bg: "#7c3aed", l2Border: "#6d28d9",
  docBg: "#ffffff", docBorder: "#475569",
  semanticEdge: "#64748b",
  containEdge: "#a78bfa",
  selectionColor: "#06b6d4",
  searchHighlightColor: "#fbbf24",
};
const PRESET_DARK = {
  l1Bg: "#3b82f6", l1Border: "#60a5fa",
  l2Bg: "#a78bfa", l2Border: "#c4b5fd",
  docBg: "#1e293b", docBorder: "#64748b",
  semanticEdge: "#94a3b8",
  containEdge: "#7c3aed",
  selectionColor: "#22d3ee",
  searchHighlightColor: "#f59e0b",
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

  const allNodes = buildVisibleNodes();
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
    solver: "barnesHut",
    barnesHut: {
      gravitationalConstant: -8000,
      centralGravity: 0.1,
      springLength: 150,
      springConstant: 0.04,
      avoidOverlap: 1,
    },
    stabilization: { iterations: 200 },
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

  // Load saved UI state (positions + expand state) from server
  const stateRes = await fetch("/api/ui-state");
  if (stateRes.ok) {
    const saved = await stateRes.json();
    if (saved.positions) Object.assign(nodePositionCache, saved.positions);
    if (saved.expandedL1s) expandedL1s = new Set(saved.expandedL1s);
    if (saved.expandedL2s) expandedL2s = new Set(saved.expandedL2s);
  }

  // Restore search panel width from localStorage
  const savedSearchW = localStorage.getItem("searchPanelWidth");
  if (savedSearchW) {
    document.documentElement.style.setProperty("--search-panel-w", `${savedSearchW}px`);
  }

  renderGraph();
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

// ── Visible nodes (expansion-based, replaces drill-down) ──────────────────
function buildVisibleNodes() {
  const visible = [];
  const l1Nodes = graphData.nodes.filter(n => n.level === 1);
  visible.push(...l1Nodes);

  for (const l1n of l1Nodes) {
    const l1Label = l1n._baseLabel || l1n.label;
    if (!expandedL1s.has(l1Label)) continue;
    const l2Nodes = graphData.nodes.filter(n => n.level === 2 && n.l1 === l1Label);
    visible.push(...l2Nodes);

    for (const l2n of l2Nodes) {
      if (!expandedL2s.has(l2n.id)) continue;
      const l2Base = l2n._baseLabel || l2n.label;
      const docNodes = graphData.nodes.filter(n =>
        n.level === 3 && n.l1 === l1Label && n.l2 === l2Base);
      visible.push(...docNodes);
    }
  }
  return visible;
}

// ── Edges ──────────────────────────────────────────────────────────────────
function edgesForNodes(nodeIds) {
  const idSet = new Set(nodeIds);
  const levelOf = {};
  for (const n of graphData.nodes) {
    if (idSet.has(n.id)) levelOf[n.id] = n.level;
  }

  const semanticEdges = graphData.edges
    .filter(e => idSet.has(e.from) && idSet.has(e.to) && levelOf[e.from] === levelOf[e.to])
    .map(e => ({
      ...e,
      color: { color: appColors.semanticEdge, highlight: appColors.semanticEdge, inherit: false },
    }));

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
      sizeOverride = { size: Math.round(20 + ratio * 20) };
    } else if (n.level === 2 && n.ndocs) {
      const ratio = n.ndocs / maxNdocs[2];
      sizeOverride = { size: Math.round(14 + ratio * 16) };
    }
    let extra = {};
    if (searchHighlight) {
      const hl = appColors.searchHighlightColor;
      if (n.id === searchHighlight.docId || n.id === searchHighlight.l2Id || n.id === searchHighlight.l1Id)
        extra = {
          color: { background: hl, border: "#b45309", highlight: { background: hl, border: "#b45309" } },
          font: { color: "#1e2229" },
        };
    }
    // Selection highlight (searchHighlight takes precedence)
    if (!extra.color && selectionState) {
      const hl = appColors.selectionColor;
      const hlStyle = {
        color: { background: hl, border: hl, highlight: { background: hl, border: hl } },
        font: { color: "#fff" },
      };
      if (selectionState.type === 'node') {
        const sel = graphData.nodes.find(nd => nd.id === selectionState.id);
        if (sel) {
          const selBase = sel._baseLabel || sel.label;
          if (n.id === sel.id) {
            extra = hlStyle;
          } else if (sel.level === 1 && n.level === 2 && n.l1 === selBase) {
            extra = hlStyle;
          } else if (sel.level === 2 && n.level === 3 && n.l1 === sel.l1 && n.l2 === selBase) {
            extra = hlStyle;
          }
        }
      } else if (selectionState.type === 'edge') {
        if (selectionState.endpoints.has(n.id)) {
          extra = hlStyle;
        } else if (n.level === 3) {
          if (selectionState.endpoints.has(`l2:${n.l1}:${n.l2}`) ||
              selectionState.endpoints.has(`l1:${n.l1}`)) {
            extra = hlStyle;
          }
        } else if (n.level === 2) {
          if (selectionState.endpoints.has(`l1:${n.l1}`)) {
            extra = hlStyle;
          }
        }
      }
    }
    return { ...n, ...style, ...sizeOverride, ...extra };
  });
}

// ── MDS-based initial node positioning ────────────────────────────────────

function cosineSim(a, b) {
  if (!a || !b) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (const [k, v] of Object.entries(a)) {
    magA += v * v;
    if (b[k] != null) dot += v * b[k];
  }
  for (const v of Object.values(b)) magB += v * v;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function powerIterate(B, n, iters = 60) {
  // Returns [eigenvector, eigenvalue] for dominant eigenvector of B
  let v = Array.from({ length: n }, () => Math.random() - 0.5);
  let lambda = 0;
  for (let iter = 0; iter < iters; iter++) {
    // Bv
    const Bv = Array(n).fill(0);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        Bv[i] += B[i][j] * v[j];
    // Norm
    lambda = Math.sqrt(Bv.reduce((s, x) => s + x * x, 0));
    if (lambda < 1e-10) break;
    v = Bv.map(x => x / lambda);
  }
  return [v, lambda];
}

function deflate(B, v, lambda, n) {
  // Deflation: B' = B - lambda * v * v^T
  return B.map((row, i) => row.map((val, j) => val - lambda * v[i] * v[j]));
}

function computeInitialPositions(nodes, edges, spread = 350) {
  const n = nodes.length;
  if (n === 0) return {};
  if (n === 1) return { [nodes[0].id]: { x: 0, y: 0 } };
  if (n === 2) return {
    [nodes[0].id]: { x: -spread * 0.23, y: 0 },
    [nodes[1].id]: { x:  spread * 0.23, y: 0 },
  };

  // Build pairwise similarity from node.keywords
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    sim[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      // Only compare same-level nodes for meaningful similarity
      if (nodes[i].level !== nodes[j].level) continue;
      const s = cosineSim(nodes[i].keywords, nodes[j].keywords);
      sim[i][j] = sim[j][i] = s;
    }
  }

  // Merge in precomputed edge weights
  const idxOf = {};
  nodes.forEach((nd, i) => { idxOf[nd.id] = i; });
  for (const e of edges) {
    const i = idxOf[e.from], j = idxOf[e.to];
    if (i != null && j != null && e.weight) {
      sim[i][j] = sim[j][i] = Math.max(sim[i][j], e.weight);
    }
  }

  // Dissimilarity matrix
  const D = sim.map(row => row.map(s => 1 - s));

  // Classical MDS: double-center D²
  const D2 = D.map(row => row.map(v => v * v));
  const rowMean = D2.map(row => row.reduce((a, b) => a + b, 0) / n);
  const colMean = D2[0].map((_, j) => D2.reduce((a, row) => a + row[j], 0) / n);
  const grand = rowMean.reduce((a, b) => a + b, 0) / n;
  const B = D2.map((row, i) => row.map((v, j) => -0.5 * (v - rowMean[i] - colMean[j] + grand)));

  const [v1, l1] = powerIterate(B, n);
  const B2 = deflate(B, v1, l1, n);
  const [v2, l2] = powerIterate(B2, n);

  const scale1 = Math.sqrt(Math.max(l1, 0)) || 1;
  const scale2 = Math.sqrt(Math.max(l2, 0)) || 1;

  const positions = {};
  for (let i = 0; i < n; i++) {
    positions[nodes[i].id] = {
      x: v1[i] * scale1 * spread,
      y: v2[i] * scale2 * spread,
    };
  }
  return positions;
}

// Compute initial positions with hierarchical grouping:
// - L1 nodes: MDS among themselves
// - L2 nodes: MDS within each L1 group, offset relative to L1 parent
// - Doc nodes: MDS within each L2 group, offset relative to L2 parent
function computeHierarchicalPositions(allNodes, allEdges, existingPositions = {}) {
  const positions = { ...existingPositions };

  // L1 nodes
  const l1Nodes = allNodes.filter(n => n.level === 1);
  if (l1Nodes.length > 0) {
    const l1Edges = allEdges.filter(e =>
      l1Nodes.some(n => n.id === e.from) && l1Nodes.some(n => n.id === e.to));
    const l1Pos = computeInitialPositions(l1Nodes, l1Edges);
    Object.assign(positions, l1Pos);
  }

  // L2 nodes grouped by L1
  const l2Nodes = allNodes.filter(n => n.level === 2);
  const l2ByL1 = {};
  for (const n of l2Nodes) {
    (l2ByL1[n.l1] = l2ByL1[n.l1] || []).push(n);
  }
  for (const [l1Label, group] of Object.entries(l2ByL1)) {
    const l1Id = `l1:${l1Label}`;
    const l1Center = positions[l1Id] || { x: 0, y: 0 };
    const groupEdges = allEdges.filter(e =>
      group.some(n => n.id === e.from) && group.some(n => n.id === e.to));
    const groupPos = computeInitialPositions(group, groupEdges);

    // Offset so cluster is near L1 parent
    const OFFSET = 400;
    const angle = (Object.keys(l2ByL1).indexOf(l1Label) / Object.keys(l2ByL1).length) * 2 * Math.PI;
    const ox = l1Center.x + Math.cos(angle) * OFFSET;
    const oy = l1Center.y + Math.sin(angle) * OFFSET;
    for (const [id, pos] of Object.entries(groupPos)) {
      positions[id] = { x: pos.x + ox, y: pos.y + oy };
    }
    // If only 1 node, place near parent
    if (group.length === 1) {
      positions[group[0].id] = { x: ox, y: oy };
    }
  }

  // Doc nodes grouped by L2
  const docNodes = allNodes.filter(n => n.level === 3);
  const docsByL2 = {};
  for (const n of docNodes) {
    const key = `l2:${n.l1}:${n.l2}`;
    (docsByL2[key] = docsByL2[key] || []).push(n);
  }
  for (const [l2Id, group] of Object.entries(docsByL2)) {
    const l2Center = positions[l2Id] || { x: 0, y: 0 };
    const groupEdges = allEdges.filter(e =>
      group.some(n => n.id === e.from) && group.some(n => n.id === e.to));
    const groupPos = computeInitialPositions(group, groupEdges, 100);

    const OFFSET = 130;
    const l2Keys = Object.keys(docsByL2);
    const angle = (l2Keys.indexOf(l2Id) / Math.max(l2Keys.length, 1)) * 2 * Math.PI;
    const ox = l2Center.x + Math.cos(angle) * OFFSET;
    const oy = l2Center.y + Math.sin(angle) * OFFSET;
    for (const [id, pos] of Object.entries(groupPos)) {
      positions[id] = { x: pos.x + ox, y: pos.y + oy };
    }
    if (group.length === 1) {
      positions[group[0].id] = { x: ox, y: oy };
    }
  }

  return positions;
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderGraph() {
  // Snapshot current positions before wiping (skip when rearranging)
  if (network && !skipPositionSnapshot) {
    Object.assign(nodePositionCache, network.getPositions());
  }
  skipPositionSnapshot = false;

  const allNodes = buildVisibleNodes();
  const nodeIds = allNodes.map(n => n.id);
  const edges = edgesForNodes(nodeIds);

  // Compute positions for nodes not yet in cache (before creating DataSet)
  const newNodes = allNodes.filter(n => !nodePositionCache[n.id]);
  if (newNodes.length > 0) {
    const newEdges = edgesForNodes(newNodes.map(n => n.id));
    const initPos = computeHierarchicalPositions(newNodes, newEdges, nodePositionCache);
    for (const [id, pos] of Object.entries(initPos)) {
      nodePositionCache[id] = pos;
    }
  }

  // Embed positions and pin directly in node data so vis.js uses them from the start
  const nodesWithPos = styledNodes(allNodes).map(n => {
    const pos = nodePositionCache[n.id];
    return pos ? { ...n, x: pos.x, y: pos.y, fixed: { x: true, y: true } } : n;
  });

  const nodesDataset = new vis.DataSet(nodesWithPos);
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
    network.on("click", onNetworkClick);
    network.on("oncontext", onNodeRightClick);
  }

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

  updateBreadcrumb();
}

async function reloadGraph() {
  const res = await fetch("/api/graph");
  if (!res.ok) return;
  graphData = await res.json();
  applyDocCounts(graphData);
  searchHighlight = null;
  selectionState = null;
  nodePositionCache = {};
  renderGraph();
}

// ── Interaction ─────────────────────────────────────────────────────────────
function onNodeDoubleClick(params) {
  if (!params.nodes.length) return;
  const nodeId = params.nodes[0];
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  if (node.level === 1) {
    const label = node._baseLabel || node.label;
    if (expandedL1s.has(label)) {
      expandedL1s.delete(label);
      // Collapse all its L2s
      graphData.nodes
        .filter(n => n.level === 2 && n.l1 === label)
        .forEach(l2 => expandedL2s.delete(l2.id));
    } else {
      expandedL1s.add(label);
    }
  } else if (node.level === 2) {
    if (expandedL2s.has(nodeId)) {
      expandedL2s.delete(nodeId);
    } else {
      expandedL2s.add(nodeId);
    }
  }
  renderGraph();
}

document.getElementById("expand-all-btn").addEventListener("click", () => {
  graphData.nodes
    .filter(n => n.level === 1)
    .forEach(n => expandedL1s.add(n._baseLabel || n.label));
  renderGraph();
});
document.getElementById("collapse-all-btn").addEventListener("click", () => {
  expandedL1s.clear();
  expandedL2s.clear();
  renderGraph();
});
document.getElementById("rearrange-btn").addEventListener("click", () => {
  nodePositionCache = {};
  skipPositionSnapshot = true;
  renderGraph();
});

function applySelectionHighlight() {
  if (!nodesDataRef) return;
  const allNodes = buildVisibleNodes();
  nodesDataRef.update(styledNodes(allNodes).map(n => ({ id: n.id, color: n.color, font: n.font })));
}

function onNetworkClick(params) {
  if (params.nodes.length) {
    const nodeId = params.nodes[0];
    const node = graphData.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (node.level === 3 && node.file) {
      openDoc(node.file, node.label, node);
      selectionState = null;
    } else {
      // Toggle selection on L1/L2
      if (selectionState?.type === 'node' && selectionState.id === nodeId) {
        selectionState = null;
      } else {
        selectionState = { type: 'node', id: nodeId };
      }
    }
  } else if (params.edges.length) {
    const edgeId = params.edges[0];
    const edgeData = edgesDataRef?.get(edgeId);
    if (edgeData) {
      if (selectionState?.type === 'edge' && selectionState.edgeId === edgeId) {
        selectionState = null;
      } else {
        selectionState = { type: 'edge', edgeId, endpoints: new Set([edgeData.from, edgeData.to]) };
      }
    }
  } else {
    selectionState = null;
  }
  applySelectionHighlight();
}

// ── Doc panel ──────────────────────────────────────────────────────────────
async function openDoc(filename, title, docNode) {
  const titleEl = document.getElementById("doc-title");
  const contentEl = document.getElementById("doc-content");

  titleEl.textContent = title;
  contentEl.innerHTML = "<p style='color:#6b7280'>Loading…</p>";
  showDocPanel();

  if (docNode) {
    showDocMeta(docNode);
  } else {
    docMetaEl.classList.add("hidden");
    currentDocNode = null;
  }

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
  docMetaEl.classList.add("hidden");
  currentDocNode = null;
});

function showDocPanel() {
  docPanel.classList.remove("hidden");
  resizeHandle.classList.remove("hidden");
}

// ── Resizable doc panel ─────────────────────────────────────────────────────
const PANEL_MIN = 200;
const PANEL_MAX_RATIO = 0.8;

const savedDocWidth = localStorage.getItem("docPanelWidth");
if (savedDocWidth) docPanel.style.width = `${savedDocWidth}px`;

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

// ── Resizable search panel ──────────────────────────────────────────────────
const searchPanel = document.getElementById("search-results");
const searchResizeHandle = document.getElementById("search-resize-handle");
const SEARCH_PANEL_MIN = 200;
const SEARCH_PANEL_MAX_RATIO = 0.6;

searchResizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  searchResizeHandle.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function onMouseMove(e) {
    const maxW = window.innerWidth * SEARCH_PANEL_MAX_RATIO;
    const newW = Math.min(maxW, Math.max(SEARCH_PANEL_MIN, e.clientX));
    document.documentElement.style.setProperty("--search-panel-w", `${newW}px`);
  }

  function onMouseUp() {
    searchResizeHandle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--search-panel-w"));
    localStorage.setItem("searchPanelWidth", w);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
});

// ── Breadcrumb ──────────────────────────────────────────────────────────────
function updateBreadcrumb() {
  const bc = document.getElementById("breadcrumb");
  bc.innerHTML = "";

  const nL1 = expandedL1s.size;
  const nL2 = expandedL2s.size;

  const root = document.createElement("span");
  root.className = "crumb" + (nL1 === 0 ? " active" : "");
  root.textContent = "All";
  if (nL1 > 0) {
    root.addEventListener("click", () => {
      expandedL1s.clear();
      expandedL2s.clear();
      renderGraph();
    });
  }
  bc.appendChild(root);

  if (nL1 > 0) {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "›";
    bc.appendChild(sep);

    const info = document.createElement("span");
    info.className = "crumb active";
    if (nL1 === 1) {
      const l1Label = [...expandedL1s][0];
      info.textContent = nL2 > 0 ? `${l1Label} (${nL2} subcategory open)` : l1Label;
    } else {
      info.textContent = `${nL1} categories open`;
    }
    bc.appendChild(info);
  }
}

// ── Context menus ────────────────────────────────────────────────────────────
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
  if (!node) return;
  if (node.level !== 2) return;

  contextNode = node;

  ctxMenu.style.left = `${params.event.clientX}px`;
  ctxMenu.style.top  = `${params.event.clientY}px`;
  ctxMenu.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});

// ── Rename subcategory ───────────────────────────────────────────────────────
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
  await reloadGraph();
});

// ── Merge subcategory ────────────────────────────────────────────────────────
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

// ── Move doc (inline in doc viewer pane) ────────────────────────────────────
const docMetaEl = document.getElementById("doc-meta");
const docMetaL1 = document.getElementById("doc-meta-l1");
const docMetaL2 = document.getElementById("doc-meta-l2");
const docMetaNewL2 = document.getElementById("doc-meta-new-l2");
let currentDocNode = null;   // doc node currently shown in viewer

function populateDocMetaL2(l1Label, selectedL2) {
  const l2Nodes = graphData ? graphData.nodes.filter(n => n.level === 2 && n.l1 === l1Label) : [];
  docMetaL2.innerHTML = l2Nodes.map(n => {
    const base = n._baseLabel || n.label;
    return `<option value="${base}"${base === selectedL2 ? " selected" : ""}>${base}</option>`;
  }).join("");
}

function showDocMeta(docNode) {
  currentDocNode = docNode;
  docMetaNewL2.value = "";

  const l1Nodes = graphData ? graphData.nodes.filter(n => n.level === 1) : [];
  docMetaL1.innerHTML = l1Nodes.map(n => {
    const base = n._baseLabel || n.label;
    return `<option value="${base}"${base === docNode.l1 ? " selected" : ""}>${base}</option>`;
  }).join("");
  populateDocMetaL2(docNode.l1, docNode.l2);

  docMetaEl.classList.remove("hidden");
}

docMetaL1.addEventListener("change", () => {
  populateDocMetaL2(docMetaL1.value, null);
  docMetaNewL2.value = "";
});

document.getElementById("doc-meta-move").addEventListener("click", async () => {
  if (!currentDocNode) return;

  const newL1 = docMetaL1.value;
  const newL2Raw = docMetaNewL2.value.trim();
  const newL2 = newL2Raw || docMetaL2.value;
  const createNew = !!newL2Raw;

  const oldL1 = currentDocNode.l1;
  const oldL2 = currentDocNode.l2;

  if (newL1 === oldL1 && newL2 === oldL2 && !createNew) return;

  const res = await fetch("/api/doc/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: currentDocNode.file,
      old_l1: oldL1,
      old_l2: oldL2,
      new_l1: newL1,
      new_l2: newL2,
      create_new_l2: createNew,
    }),
  });
  if (!res.ok) { alert("Move failed."); return; }
  currentDocNode = null;
  docMetaEl.classList.add("hidden");
  await reloadGraph();
});

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
      openDoc(match.filename, label, docNode || null);

      if (docNode) {
        searchHighlight = {
          l1Id: `l1:${docNode.l1}`,
          l2Id: `l2:${docNode.l1}:${docNode.l2}`,
          docId: docNode.id,
        };
        // Expand the doc's L1 and L2 so search highlight is visible
        expandedL1s.add(docNode.l1);
        expandedL2s.add(`l2:${docNode.l1}:${docNode.l2}`);
        renderGraph();
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

// ── Position persistence ──────────────────────────────────────────────────────
function buildUiState() {
  return {
    positions: network ? network.getPositions() : {},
    expandedL1s: [...expandedL1s],
    expandedL2s: [...expandedL2s],
  };
}

async function saveState() {
  if (!network) return;
  await fetch("/api/ui-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildUiState()),
  }).catch(() => {});
}

window.addEventListener("beforeunload", () => {
  if (!network) return;
  fetch("/api/ui-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildUiState()),
    keepalive: true,
  });
});

// ── Quit ─────────────────────────────────────────────────────────────────────
document.getElementById("quit-btn").addEventListener("click", async () => {
  if (!confirm("Stop the server and quit?")) return;
  await saveState();
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  window.close();
  document.body.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#6b7280;">
      <p>Server stopped. You can close this tab.</p>
    </div>`;
});

// ── Boot ──────────────────────────────────────────────────────────────────
init();
