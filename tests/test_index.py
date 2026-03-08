"""Tests for preprocess.py output correctness.

Run with: uv run pytest tests/test_index.py -v
Requires data/index.json to exist (run preprocess.py first).
"""
import json
from pathlib import Path

DATA_DIR = Path("data")
INDEX_FILE = DATA_DIR / "index.json"


def load_index():
    assert INDEX_FILE.exists(), "data/index.json not found — run preprocess.py first"
    with open(INDEX_FILE, encoding="utf-8") as f:
        return json.load(f)


def scan_files():
    """All .md and .pdf files in data/ (excluding .text_cache), matching scan_documents()."""
    files = []
    for suffix in ("*.md", "*.pdf"):
        files.extend(p for p in DATA_DIR.rglob(suffix) if ".text_cache" not in p.parts)
    return files


def load_constraints():
    import yaml
    with open("config.yaml") as f:
        cfg = yaml.safe_load(f)
    return cfg.get("subcategory_constraints") or {}


# ── Basic structure tests ─────────────────────────────────────────────────────

def test_doc_count_matches_files():
    """Number of doc nodes must equal number of .md/.pdf files in data/."""
    index = load_index()
    doc_nodes = [n for n in index["nodes"] if n.get("level") == 3]
    data_files = scan_files()
    assert len(doc_nodes) == len(data_files), (
        f"index.json has {len(doc_nodes)} doc nodes but data/ has {len(data_files)} files"
    )


def test_no_duplicate_node_ids():
    """All node IDs must be unique."""
    index = load_index()
    ids = [n["id"] for n in index["nodes"]]
    assert len(ids) == len(set(ids)), "Duplicate node IDs found in index.json"


def test_doc_nodes_have_required_fields():
    """Every doc node must have id, label, level, l1, l2, file."""
    index = load_index()
    required = {"id", "label", "level", "l1", "l2", "file"}
    for n in index["nodes"]:
        if n.get("level") == 3:
            missing = required - n.keys()
            assert not missing, f"Doc node {n.get('id')} missing fields: {missing}"


def test_doc_files_exist():
    """Every doc node's 'file' field must resolve to an existing file in data/."""
    index = load_index()
    for n in index["nodes"]:
        if n.get("level") == 3:
            path = DATA_DIR / n["file"]
            assert path.exists(), f"Doc node references missing file: {n['file']}"


# ── ndocs tests ───────────────────────────────────────────────────────────────

def test_l1_nodes_have_ndocs():
    """Every L1 node must have a positive ndocs field."""
    index = load_index()
    for n in index["nodes"]:
        if n.get("level") == 1:
            assert "ndocs" in n, f"L1 node {n['id']} missing 'ndocs' field"
            assert n["ndocs"] > 0, f"L1 node {n['id']} has ndocs={n['ndocs']}"


def test_l2_nodes_have_ndocs():
    """Every L2 node must have a positive ndocs field."""
    index = load_index()
    for n in index["nodes"]:
        if n.get("level") == 2:
            assert "ndocs" in n, f"L2 node {n['id']} missing 'ndocs' field"
            assert n["ndocs"] > 0, f"L2 node {n['id']} has ndocs={n['ndocs']}"


def test_l1_ndocs_equals_sum_of_l2_ndocs():
    """Each L1's ndocs must equal the sum of its L2 children's ndocs."""
    index = load_index()
    l1_ndocs = {n["label"]: n["ndocs"] for n in index["nodes"] if n.get("level") == 1}
    l2_by_l1: dict[str, list[int]] = {}
    for n in index["nodes"]:
        if n.get("level") == 2:
            l2_by_l1.setdefault(n["l1"], []).append(n["ndocs"])
    for l1, ndocs in l1_ndocs.items():
        l2_total = sum(l2_by_l1.get(l1, []))
        assert ndocs == l2_total, (
            f"L1 '{l1}' ndocs={ndocs} != sum of L2 ndocs={l2_total}"
        )


def test_l2_ndocs_equals_doc_node_count():
    """Each L2's ndocs must equal its actual level-3 doc node count."""
    index = load_index()
    l2_ndocs = {
        (n["l1"], n["label"]): n["ndocs"]
        for n in index["nodes"] if n.get("level") == 2
    }
    l2_actual: dict[tuple, int] = {}
    for n in index["nodes"]:
        if n.get("level") == 3:
            key = (n["l1"], n["l2"])
            l2_actual[key] = l2_actual.get(key, 0) + 1
    for key, ndocs in l2_ndocs.items():
        actual = l2_actual.get(key, 0)
        assert ndocs == actual, (
            f"L2 '{key}' ndocs={ndocs} != actual doc count={actual}"
        )


# ── Subcategory constraint tests ──────────────────────────────────────────────

def test_min_docs_per_subcategory():
    """No L2 subcategory may have fewer docs than min_docs_per_subcategory."""
    constraints = load_constraints()
    min_docs = constraints.get("min_docs_per_subcategory", 1)
    index = load_index()
    l2_counts: dict[tuple, int] = {}
    for n in index["nodes"]:
        if n.get("level") == 3:
            key = (n["l1"], n["l2"])
            l2_counts[key] = l2_counts.get(key, 0) + 1
    violations = [(k, v) for k, v in l2_counts.items() if v < min_docs]
    assert not violations, (
        f"L2 subcategories with fewer than {min_docs} docs (min_docs_per_subcategory): {violations}"
    )


def test_max_docs_per_subcategory():
    """No L2 subcategory may have more docs than max_docs_per_subcategory."""
    constraints = load_constraints()
    max_docs = constraints.get("max_docs_per_subcategory", 9999)
    index = load_index()
    l2_counts: dict[tuple, int] = {}
    for n in index["nodes"]:
        if n.get("level") == 3:
            key = (n["l1"], n["l2"])
            l2_counts[key] = l2_counts.get(key, 0) + 1
    violations = [(k, v) for k, v in l2_counts.items() if v > max_docs]
    assert not violations, (
        f"L2 subcategories with more than {max_docs} docs (max_docs_per_subcategory): {violations}"
    )


def test_max_subcategories_per_l1():
    """No L1 category may have more L2 subcategories than max_subcategories."""
    constraints = load_constraints()
    max_subcats = constraints.get("max_subcategories", 999)
    index = load_index()
    l2_by_l1: dict[str, set] = {}
    for n in index["nodes"]:
        if n.get("level") == 2:
            l2_by_l1.setdefault(n["l1"], set()).add(n["label"])
    violations = [(l1, len(s)) for l1, s in l2_by_l1.items() if len(s) > max_subcats]
    assert not violations, (
        f"L1 categories exceeding max_subcategories={max_subcats}: {violations}"
    )
