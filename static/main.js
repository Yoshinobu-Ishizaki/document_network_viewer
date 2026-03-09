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
let nodeAreaCache = {};        // { [nodeId]: {x1,y1,x2,y2} } — treemap cell rects
let skipPositionSnapshot = false; // when true, renderGraph won't snapshot current positions
let selectionState = null;    // { type: 'node', id } or { type: 'edge', edgeId, endpoints: Set }
let dragGroupStart = null;    // { draggedId, positions: { [id]: {x,y} } } | null
let rubberBandState = null;  // { startX, startY } in canvas DOM coords
let panDragState = null;     // { startDOMX, startDOMY, startViewPos }
let lastSearchMatches = null; // [{ filename, snippet }] — for re-render after graph reload
let activeResultFile = null;  // filename of currently selected result (stable across re-renders)
let activeFilter = null;         // string keyword | null — NOT persisted
let filterBehavior = localStorage.getItem("filterBehavior") || "gray"; // "gray" | "hide" — persisted in localStorage
let filterDebounceTimer = null;
let currentFilterMatches = null; // { matchedDocs, matchedL2s, matchedL1s } | null

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

function buildDimmedColors() {
  return resolveEffectiveTheme() === "dark"
    ? { l1: "#1e3050", l2: "#2a1f4a", doc: "#1a2233", font: "#475569" }
    : { l1: "#dbeafe", l2: "#ede9fe", doc: "#e2e8f0", font: "#94a3b8" };
}

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
  interaction: { hover: true, tooltipDelay: 200, dragView: false },
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
  if (activeFilter && filterBehavior === "hide" && currentFilterMatches) {
    const { matchedDocs, matchedL2s, matchedL1s } = currentFilterMatches;
    return visible.filter(n => {
      if (n.level === 1) return matchedL1s.has(n.id);
      if (n.level === 2) return matchedL2s.has(n.id);
      return matchedDocs.has(n.id);
    });
  }
  return visible;
}

// ── Filter helpers ─────────────────────────────────────────────────────────
function computeFilterMatches(keyword, apiMatchSet = new Set()) {
  if (!keyword || !graphData) return null;
  const lc = keyword.toLowerCase();
  const matchedDocs = new Set();
  const matchedL2s = new Set();
  const matchedL1s = new Set();
  for (const n of graphData.nodes) {
    if (n.level === 3) {
      const labelMatch = (n.label || "").toLowerCase().includes(lc);
      const fileMatch = apiMatchSet.has(n.file);
      if (labelMatch || fileMatch) {
        matchedDocs.add(n.id);
        matchedL2s.add(`l2:${n.l1}:${n.l2}`);
        matchedL1s.add(`l1:${n.l1}`);
      }
    }
  }
  return { matchedDocs, matchedL2s, matchedL1s };
}

function applyFilter(keyword) {
  activeFilter = keyword || null;
  if (!activeFilter) {
    currentFilterMatches = null;
    filterInputEl.classList.remove("filter-active");
    filterClearBtn.classList.add("hidden");
  } else {
    filterInputEl.classList.add("filter-active");
    filterClearBtn.classList.remove("hidden");
    currentFilterMatches = computeFilterMatches(activeFilter, new Set());
  }
  if (filterBehavior === "hide") {
    renderGraph();
  } else if (nodesDataRef) {
    nodesDataRef.update(styledNodes(buildVisibleNodes()).map(n => ({
      id: n.id, color: n.color, font: n.font,
    })));
  }
}

async function applyFilterWithApiResults(keyword) {
  let apiMatchSet = new Set();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(keyword)}`);
    if (res.ok) {
      const data = await res.json();
      apiMatchSet = new Set(data.matches.map(m => m.filename));
    }
  } catch (_) {}
  if (activeFilter !== keyword) return; // stale
  currentFilterMatches = computeFilterMatches(keyword, apiMatchSet);
  if (filterBehavior === "hide") {
    renderGraph();
  } else if (nodesDataRef) {
    nodesDataRef.update(styledNodes(buildVisibleNodes()).map(n => ({
      id: n.id, color: n.color, font: n.font,
    })));
  }
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
    let dimmedExtra = {};
    if (activeFilter && filterBehavior === "gray" && currentFilterMatches) {
      const { matchedDocs, matchedL2s, matchedL1s } = currentFilterMatches;
      const matches =
        (n.level === 1 && matchedL1s.has(n.id)) ||
        (n.level === 2 && matchedL2s.has(n.id)) ||
        (n.level === 3 && matchedDocs.has(n.id));
      if (!matches) {
        const dim = buildDimmedColors();
        const bg = n.level === 1 ? dim.l1 : n.level === 2 ? dim.l2 : dim.doc;
        dimmedExtra = {
          color: { background: bg, border: bg, highlight: { background: bg, border: bg } },
          font: { color: dim.font },
        };
      }
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
      } else if (selectionState.type === 'multi') {
        if (selectionState.ids.has(n.id)) extra = hlStyle;
      }
    }
    return { ...n, ...style, ...sizeOverride, ...dimmedExtra, ...extra };
  });
}

// ── Highlighted node IDs (mirrors selection logic from styledNodes) ────────
function getHighlightedNodeIds() {
  if (!selectionState || !graphData) return new Set();
  if (selectionState.type === 'multi') return new Set(selectionState.ids);
  const allNodes = buildVisibleNodes();
  const ids = new Set();
  for (const n of allNodes) {
    if (selectionState.type === 'node') {
      const sel = graphData.nodes.find(nd => nd.id === selectionState.id);
      if (sel) {
        const selBase = sel._baseLabel || sel.label;
        if (n.id === sel.id ||
            (sel.level === 1 && n.level === 2 && n.l1 === selBase) ||
            (sel.level === 2 && n.level === 3 && n.l1 === sel.l1 && n.l2 === selBase)) {
          ids.add(n.id);
        }
      }
    } else if (selectionState.type === 'edge') {
      if (selectionState.endpoints.has(n.id) ||
          (n.level === 3 && (selectionState.endpoints.has(`l2:${n.l1}:${n.l2}`) ||
                             selectionState.endpoints.has(`l1:${n.l1}`))) ||
          (n.level === 2 && selectionState.endpoints.has(`l1:${n.l1}`))) {
        ids.add(n.id);
      }
    }
  }
  return ids;
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

// ── Treemap layout helpers ──────────────────────────────────────────────────

function _worstRatio(areas, rowArea, shortSide) {
  const stripLen = rowArea / shortSide;
  let worst = 0;
  for (const a of areas) {
    const itemLen = a / stripLen;
    const r = Math.max(stripLen / itemLen, itemLen / stripLen);
    if (r > worst) worst = r;
  }
  return worst;
}

function _squarifyHelper(items, rect, results) {
  if (items.length === 0) return;
  if (items.length === 1) {
    results.push({ id: items[0].id, rect });
    return;
  }

  const totalArea = items.reduce((s, it) => s + it.size, 0);
  const rectW = rect.x2 - rect.x1;
  const rectH = rect.y2 - rect.y1;
  const rectArea = rectW * rectH;
  const shortSide = Math.min(rectW, rectH);

  // Build optimal row greedily
  let rowItems = [];
  let rowArea = 0;
  let prevWorst = Infinity;
  for (let i = 0; i < items.length; i++) {
    const normalizedArea = (items[i].size / totalArea) * rectArea;
    const candidate = [...rowItems, { ...items[i], normArea: normalizedArea }];
    const candidateArea = rowArea + normalizedArea;
    const candidateWorst = _worstRatio(candidate.map(c => c.normArea), candidateArea, shortSide);
    if (rowItems.length > 0 && candidateWorst > prevWorst) break;
    rowItems = candidate;
    rowArea = candidateArea;
    prevWorst = candidateWorst;
  }

  // Lay out the row strip
  const isHorizontal = rectW >= rectH; // strip along short side
  const stripSize = rowArea / (isHorizontal ? rectH : rectW);
  let cursor = isHorizontal ? rect.x1 : rect.y1;
  const rowTotalSize = rowItems.reduce((s, it) => s + it.normArea, 0);
  for (const it of rowItems) {
    const itemLen = (it.normArea / rowTotalSize) * (isHorizontal ? rectH : rectW);
    let itemRect;
    if (isHorizontal) {
      itemRect = { x1: rect.x1, y1: cursor, x2: rect.x1 + stripSize, y2: cursor + itemLen };
    } else {
      itemRect = { x1: cursor, y1: rect.y1, x2: cursor + itemLen, y2: rect.y1 + stripSize };
    }
    results.push({ id: it.id, rect: itemRect });
    cursor += itemLen;
  }

  // Recurse on remaining items in remaining sub-rect
  const remaining = items.slice(rowItems.length);
  if (remaining.length === 0) return;
  let remainRect;
  if (isHorizontal) {
    remainRect = { x1: rect.x1 + stripSize, y1: rect.y1, x2: rect.x2, y2: rect.y2 };
  } else {
    remainRect = { x1: rect.x1, y1: rect.y1 + stripSize, x2: rect.x2, y2: rect.y2 };
  }
  _squarifyHelper(remaining, remainRect, results);
}

function squarifiedTreemap(items, rect) {
  // items: [{id, size}], size > 0
  // returns [{id, rect: {x1,y1,x2,y2}}]
  const sorted = [...items].sort((a, b) => b.size - a.size);
  const totalSize = sorted.reduce((s, it) => s + it.size, 0);
  if (totalSize === 0) return sorted.map(it => ({ id: it.id, rect }));
  const results = [];
  _squarifyHelper(sorted, rect, results);
  return results;
}

function padRect(rect, padding) {
  return {
    x1: rect.x1 + padding,
    y1: rect.y1 + padding,
    x2: rect.x2 - padding,
    y2: rect.y2 - padding,
  };
}

function scalePosToRect(posMap, rect) {
  // Scale MDS output {id: {x,y}} to fill rect
  const ids = Object.keys(posMap);
  if (ids.length === 0) return {};
  const cx = (rect.x1 + rect.x2) / 2;
  const cy = (rect.y1 + rect.y2) / 2;
  if (ids.length === 1) return { [ids[0]]: { x: cx, y: cy } };

  const xs = ids.map(id => posMap[id].x);
  const ys = ids.map(id => posMap[id].y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX, rangeY = maxY - minY;
  const outW = rect.x2 - rect.x1, outH = rect.y2 - rect.y1;

  const result = {};
  for (const id of ids) {
    const nx = rangeX > 1e-6 ? (posMap[id].x - minX) / rangeX : 0.5;
    const ny = rangeY > 1e-6 ? (posMap[id].y - minY) / rangeY : 0.5;
    result[id] = { x: rect.x1 + nx * outW, y: rect.y1 + ny * outH };
  }
  return result;
}

// Compute initial positions using proportional treemap layout:
// - L1 nodes divide the viewport by doc count
// - L2 nodes divide their L1 area by doc count
// - Doc nodes fill their L2 area using MDS semantic clustering
function computeProportionalPositions(allNodes, allEdges) {
  const positions = {};
  const VIEWPORT = { x1: -1500, y1: -1000, x2: 1500, y2: 1000 };

  // Count docs per L1
  const docCountByL1 = {};
  for (const n of graphData.nodes) {
    if (n.level === 3) {
      docCountByL1[n.l1] = (docCountByL1[n.l1] || 0) + 1;
    }
  }

  // Step 1: L1 nodes
  const l1Nodes = allNodes.filter(n => n.level === 1);
  const newL1Nodes = l1Nodes.filter(n => !nodePositionCache[n.id]);
  if (newL1Nodes.length > 0 || l1Nodes.some(n => !nodeAreaCache[n.id])) {
    const l1Items = l1Nodes.map(n => ({
      id: n.id,
      size: Math.max(docCountByL1[n._baseLabel || n.label] || 1, 1),
    }));
    const l1Cells = squarifiedTreemap(l1Items, VIEWPORT);
    for (const cell of l1Cells) {
      nodeAreaCache[cell.id] = cell.rect;
      if (!nodePositionCache[cell.id]) {
        const rx = (cell.rect.x1 + cell.rect.x2) / 2;
        const ry = (cell.rect.y1 + cell.rect.y2) / 2;
        positions[cell.id] = { x: rx, y: ry };
      }
    }
  }

  // Count docs per L2
  const docCountByL2 = {};
  for (const n of graphData.nodes) {
    if (n.level === 3) {
      const key = `l2:${n.l1}:${n.l2}`;
      docCountByL2[key] = (docCountByL2[key] || 0) + 1;
    }
  }

  // Step 2: L2 nodes grouped by L1
  const l2Nodes = allNodes.filter(n => n.level === 2);
  const l2ByL1 = {};
  for (const n of l2Nodes) {
    (l2ByL1[n.l1] = l2ByL1[n.l1] || []).push(n);
  }
  for (const [l1Label, group] of Object.entries(l2ByL1)) {
    const l1Id = `l1:${l1Label}`;
    const l1Rect = nodeAreaCache[l1Id];
    if (!l1Rect) continue;
    const hasNewL2 = group.some(n => !nodePositionCache[n.id]);
    const needsAreaUpdate = group.some(n => !nodeAreaCache[n.id]);
    if (!hasNewL2 && !needsAreaUpdate) continue;

    const l2Items = group.map(n => ({
      id: n.id,
      size: Math.max(docCountByL2[n.id] || 1, 1),
    }));
    const l2Cells = squarifiedTreemap(l2Items, padRect(l1Rect, 80));
    for (const cell of l2Cells) {
      nodeAreaCache[cell.id] = cell.rect;
      if (!nodePositionCache[cell.id]) {
        const rx = (cell.rect.x1 + cell.rect.x2) / 2;
        const ry = (cell.rect.y1 + cell.rect.y2) / 2;
        positions[cell.id] = { x: rx, y: ry };
      }
    }
  }

  // Step 3: Doc nodes grouped by L2
  const docNodes = allNodes.filter(n => n.level === 3);
  const docsByL2 = {};
  for (const n of docNodes) {
    const key = `l2:${n.l1}:${n.l2}`;
    (docsByL2[key] = docsByL2[key] || []).push(n);
  }
  for (const [l2Id, group] of Object.entries(docsByL2)) {
    const newDocs = group.filter(n => !nodePositionCache[n.id]);
    if (newDocs.length === 0) continue;
    const l2Rect = nodeAreaCache[l2Id];
    if (!l2Rect) continue;

    const innerRect = padRect(l2Rect, 40);
    const groupEdges = allEdges.filter(e =>
      group.some(n => n.id === e.from) && group.some(n => n.id === e.to));
    const mdsPos = computeInitialPositions(group, groupEdges, 100);
    const scaled = scalePosToRect(mdsPos, innerRect);
    for (const n of newDocs) {
      if (scaled[n.id]) positions[n.id] = scaled[n.id];
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
    const allEdges = edgesForNodes(allNodes.map(n => n.id));
    const initPos = computeProportionalPositions(allNodes, allEdges);
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

    network.on("dragStart", (params) => {
      if (!params.nodes.length || !selectionState) return;
      const draggedId = params.nodes[0];
      const highlighted = getHighlightedNodeIds();
      if (!highlighted.has(draggedId)) return;
      dragGroupStart = {
        draggedId,
        positions: network.getPositions([...highlighted]),
      };
    });

    network.on("dragging", (params) => {
      if (!dragGroupStart || !params.nodes.length) return;
      const draggedId = params.nodes[0];
      if (draggedId !== dragGroupStart.draggedId) return;
      const cur = network.getPositions([draggedId])[draggedId];
      const start = dragGroupStart.positions[draggedId];
      if (!cur || !start) return;
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      for (const [id, pos] of Object.entries(dragGroupStart.positions)) {
        if (id === draggedId) continue;
        network.moveNode(id, pos.x + dx, pos.y + dy);
      }
    });

    network.on("dragEnd", (params) => {
      if (!dragGroupStart || !params.nodes.length) return;
      if (params.nodes[0] !== dragGroupStart.draggedId) return;
      const finalPos = network.getPositions(Object.keys(dragGroupStart.positions));
      Object.assign(nodePositionCache, finalPos);
      dragGroupStart = null;
    });

    // ── Rubber band selection + right-click pan ─────────────────────────────
    const rbEl = document.createElement("div");
    rbEl.id = "rubber-band";
    container.appendChild(rbEl);

    container.querySelector("canvas").addEventListener("contextmenu", e => e.preventDefault());

    container.querySelector("canvas").addEventListener("mousedown", e => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const nodeAt = network.getNodeAt({ x, y });

      if (e.button === 0 && !nodeAt) {
        rubberBandState = { startX: x, startY: y };
        Object.assign(rbEl.style, { display: "block", left: x+"px", top: y+"px", width: "0", height: "0" });
        e.preventDefault();
      } else if (e.button === 2 && !nodeAt) {
        panDragState = { startDOMX: e.clientX, startDOMY: e.clientY, startViewPos: network.getViewPosition() };
      }
    });

    window.addEventListener("mousemove", e => {
      if (rubberBandState) {
        const rect = container.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top;
        const x = Math.min(rubberBandState.startX, curX);
        const y = Math.min(rubberBandState.startY, curY);
        Object.assign(rbEl.style, {
          left: x+"px", top: y+"px",
          width: Math.abs(curX - rubberBandState.startX)+"px",
          height: Math.abs(curY - rubberBandState.startY)+"px",
        });
      }
      if (panDragState) {
        const dx = e.clientX - panDragState.startDOMX;
        const dy = e.clientY - panDragState.startDOMY;
        const scale = network.getScale();
        const { x: vx, y: vy } = panDragState.startViewPos;
        network.moveTo({ position: { x: vx - dx/scale, y: vy - dy/scale }, scale, animation: false });
      }
    });

    window.addEventListener("mouseup", e => {
      if (rubberBandState && e.button === 0) {
        const rect = container.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top;
        rbEl.style.display = "none";
        const ids = getNodesInRect(rubberBandState.startX, rubberBandState.startY, curX, curY);
        rubberBandState = null;
        selectionState = ids.size > 0 ? { type: 'multi', ids } : null;
        applySelectionHighlight();
      }
      if (panDragState && e.button === 2) {
        panDragState = null;
      }
    });
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
  if (activeFilter) {
    currentFilterMatches = computeFilterMatches(activeFilter, new Set());
  }
  applyDocCounts(graphData);
  searchHighlight = null;
  selectionState = null;
  nodePositionCache = {};
  nodeAreaCache = {};
  renderGraph();
  if (lastSearchMatches && !searchResults.classList.contains("hidden")) {
    renderSearchResults(lastSearchMatches);
  }
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
  nodeAreaCache = {};
  skipPositionSnapshot = true;
  renderGraph();
});

function applySelectionHighlight() {
  if (!nodesDataRef) return;
  const allNodes = buildVisibleNodes();
  nodesDataRef.update(styledNodes(allNodes).map(n => ({ id: n.id, color: n.color, font: n.font })));
}

function getNodesInRect(x1, y1, x2, y2) {
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  if (maxX - minX < 4 && maxY - minY < 4) return new Set();
  const ids = nodesDataRef.getIds();
  const positions = network.getPositions(ids);
  const result = new Set();
  for (const [id, canvasPos] of Object.entries(positions)) {
    const domPos = network.canvasToDOM(canvasPos);
    if (domPos.x >= minX && domPos.x <= maxX && domPos.y >= minY && domPos.y <= maxY) {
      result.add(id);
    }
  }
  return result;
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
  activeResultFile = null;
  lastSearchMatches = null;
  searchHighlight = null;
  if (nodesDataRef) refreshDisplayedColors();
}

function renderSearchResults(matches) {
  searchResultsList.innerHTML = "";
  activeResultLi = null;

  for (const match of matches) {
    const docNode = graphData?.nodes.find(n => n.level === 3 && n.file === match.filename);

    const li = document.createElement("li");
    const catText = docNode ? `${docNode.l1} › ${docNode.l2}` : "";
    li.innerHTML = `
      <div class="result-name">${docNode ? docNode.label : match.filename}</div>
      ${catText ? `<div class="result-category">${catText}</div>` : ""}
      <div class="result-snippet">${match.snippet || ""}</div>
    `;

    if (match.filename === activeResultFile) {
      li.classList.add("result-selected");
      activeResultLi = li;
    }

    li.addEventListener("click", () => {
      if (activeResultLi) activeResultLi.classList.remove("result-selected");
      li.classList.add("result-selected");
      activeResultLi = li;
      activeResultFile = match.filename;

      const label = docNode ? docNode.label : match.filename;
      openDoc(match.filename, label, docNode || null);

      if (docNode) {
        searchHighlight = {
          l1Id: `l1:${docNode.l1}`,
          l2Id: `l2:${docNode.l1}:${docNode.l2}`,
          docId: docNode.id,
        };
        expandedL1s.add(docNode.l1);
        expandedL2s.add(`l2:${docNode.l1}:${docNode.l2}`);
        renderGraph();
      }
    });

    searchResultsList.appendChild(li);
  }
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
    lastSearchMatches = null;
    searchResultsLabel.textContent = `No results for "${q}"`;
    return;
  }

  searchResultsLabel.textContent = `${data.matches.length} result(s) for "${q}"`;
  lastSearchMatches = data.matches;
  activeResultFile = null;
  renderSearchResults(data.matches);
}

// ── Keyword filter ──────────────────────────────────────────────────────────
const filterInputEl = document.getElementById("filter-input");
const filterClearBtn = document.getElementById("filter-clear");
const filterModeBtnEl = document.getElementById("filter-mode-btn");

// Sync button to persisted value
if (filterBehavior === "hide") {
  filterModeBtnEl.textContent = "\u2297 Hide";
  filterModeBtnEl.classList.add("mode-hide");
}

filterModeBtnEl.addEventListener("click", () => {
  filterBehavior = filterBehavior === "gray" ? "hide" : "gray";
  filterModeBtnEl.textContent = filterBehavior === "gray" ? "\u25d1 Dim" : "\u2297 Hide";
  filterModeBtnEl.classList.toggle("mode-hide", filterBehavior === "hide");
  localStorage.setItem("filterBehavior", filterBehavior);
  if (activeFilter) {
    renderGraph();
  }
});

filterInputEl.addEventListener("input", () => {
  const val = filterInputEl.value.trim();
  applyFilter(val);
  clearTimeout(filterDebounceTimer);
  if (val) {
    filterDebounceTimer = setTimeout(() => applyFilterWithApiResults(val), 300);
  }
});

filterInputEl.addEventListener("keydown", e => {
  if (e.key === "Escape") { filterInputEl.value = ""; applyFilter(""); }
});

filterClearBtn.addEventListener("click", () => {
  filterInputEl.value = "";
  applyFilter("");
});

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
