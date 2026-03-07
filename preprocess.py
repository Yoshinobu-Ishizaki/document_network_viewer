#!/usr/bin/env python3
"""Preprocess documents in data/ and generate data/index.json.

Usage:
    uv run preprocess.py

Reads config.yaml for L1 categories, calls the Claude API to assign each
document to an L1 category and generate an L2 subcategory, then writes
data/index.json for the web app to consume.

Results are cached in data/.cache.json — only changed files trigger new
API calls on subsequent runs.
"""

import hashlib
import json
import sys
from pathlib import Path

import frontmatter
import yaml
from anthropic import Anthropic

DATA_DIR = Path("data")
CACHE_FILE = DATA_DIR / ".cache.json"
INDEX_FILE = DATA_DIR / "index.json"
CONFIG_FILE = Path("config.yaml")

BATCH_SIZE = 20
MODEL = "claude-haiku-4-5-20251001"


def load_config() -> list[str]:
    with open(CONFIG_FILE) as f:
        config = yaml.safe_load(f)
    return config["categories"]


def load_cache() -> dict:
    if CACHE_FILE.exists():
        with open(CACHE_FILE) as f:
            return json.load(f)
    return {}


def save_cache(cache: dict) -> None:
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def file_hash(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def read_document(path: Path) -> str:
    if path.suffix.lower() == ".md":
        post = frontmatter.load(str(path))
        return post.content[:1500]
    elif path.suffix.lower() == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(path))
            text = ""
            for page in reader.pages[:3]:
                text += page.extract_text() or ""
            return text[:1500]
        except Exception:
            return ""
    return ""


def categorize_batch(
    client: Anthropic,
    docs: list[dict],
    categories: list[str],
) -> list[dict]:
    """Call Claude to assign L1 + generate L2 categories for a batch of documents."""
    categories_str = "\n".join(f"- {c}" for c in categories)
    docs_str = "\n\n".join(
        f"[{i + 1}] filename: {d['filename']}\ncontent snippet:\n{d['content']}"
        for i, d in enumerate(docs)
    )

    prompt = f"""You are categorizing technical documents into a two-level hierarchy.

Top-level categories (L1) — you MUST pick exactly one per document:
{categories_str}

For each document, assign:
1. l1: The best matching L1 category (must be exactly one of the above, verbatim)
2. l2: A short subcategory name (2–4 words). Use the same language as the document filename.

Respond ONLY with a valid JSON array, no extra text:
[
  {{"index": 1, "l1": "<L1 category>", "l2": "<subcategory>"}},
  ...
]

Documents:
{docs_str}"""

    message = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )

    text = message.content[0].text.strip()
    start = text.find("[")
    end = text.rfind("]") + 1
    return json.loads(text[start:end])


def scan_documents() -> list[Path]:
    docs = []
    for suffix in ("*.md", "*.pdf"):
        docs.extend(DATA_DIR.glob(suffix))
    return sorted(docs)


_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "in", "to", "for", "on",
    "with", "at", "by", "from", "is", "it", "its", "as", "be", "this",
    "that", "was", "are", "were", "been", "has", "have", "had", "but",
    "not", "no", "so", "do", "if", "we", "i", "you", "he", "she", "they",
    "de", "la", "le", "les", "des", "du", "en", "et",
}


def _keywords(text: str) -> set[str]:
    """Return a set of lowercased non-stopword tokens from text."""
    tokens = set()
    for word in text.lower().split():
        word = word.strip(".,;:!?\"'()[]{}/-")
        if len(word) >= 3 and word not in _STOPWORDS:
            tokens.add(word)
    return tokens


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def build_index(categorized: list[dict]) -> dict:
    nodes: list[dict] = []
    edges: list[dict] = []

    l1_seen: dict[str, str] = {}   # l1 label -> node id
    l2_seen: dict[tuple, str] = {}  # (l1, l2) -> node id
    # For semantic edge computation
    l2_keywords: dict[tuple, set] = {}   # (l1, l2) -> keyword set from doc contents
    l1_l2_names: dict[str, list[str]] = {}  # l1 -> list of l2 labels
    l1_doc_count: dict[str, int] = {}

    for doc in categorized:
        l1 = doc["l1"]
        l2 = doc["l2"]
        content = doc.get("content", "")

        if l1 not in l1_seen:
            l1_id = f"l1:{l1}"
            l1_seen[l1] = l1_id
            nodes.append({"id": l1_id, "label": l1, "level": 1})
            l1_l2_names[l1] = []
            l1_doc_count[l1] = 0

        l1_doc_count[l1] += 1

        l2_key = (l1, l2)
        if l2_key not in l2_seen:
            l2_id = f"l2:{l1}:{l2}"
            l2_seen[l2_key] = l2_id
            nodes.append({"id": l2_id, "label": l2, "level": 2, "l1": l1})
            l2_keywords[l2_key] = set()
            l1_l2_names[l1].append(l2)
        # Accumulate keywords from doc content
        l2_keywords[l2_key] |= _keywords(content)

        doc_id = f"doc:{doc['filename']}"
        nodes.append({
            "id": doc_id,
            "label": Path(doc["filename"]).stem,
            "level": 3,
            "l1": l1,
            "l2": l2,
            "file": doc["filename"],
        })
        edges.append({"from": l2_seen[l2_key], "to": doc_id})

    # ── L2↔L2 semantic edges (within same L1, keyword Jaccard similarity) ───
    l2_keys = list(l2_seen.keys())
    for i in range(len(l2_keys)):
        for j in range(i + 1, len(l2_keys)):
            ka, kb = l2_keys[i], l2_keys[j]
            if ka[0] != kb[0]:  # must share same L1
                continue
            sim = _jaccard(l2_keywords[ka], l2_keywords[kb])
            if sim >= 0.05:
                width = max(1, min(8, round(sim * 20)))
                edges.append({
                    "from": l2_seen[ka],
                    "to": l2_seen[kb],
                    "weight": round(sim, 3),
                    "width": width,
                })

    # ── L1↔L1 edges (shared subcategory topic words) ────────────────────────
    l1_list = list(l1_seen.keys())
    for i in range(len(l1_list)):
        for j in range(i + 1, len(l1_list)):
            la, lb = l1_list[i], l1_list[j]
            words_a = set()
            for name in l1_l2_names[la]:
                words_a |= _keywords(name)
            words_b = set()
            for name in l1_l2_names[lb]:
                words_b |= _keywords(name)
            sim = _jaccard(words_a, words_b)
            if sim > 0:
                count_factor = (l1_doc_count[la] * l1_doc_count[lb]) ** 0.5
                raw_width = sim * count_factor
                # Collect all raw widths first (normalise in second pass)
                edges.append({
                    "from": l1_seen[la],
                    "to": l1_seen[lb],
                    "weight": round(sim, 3),
                    "_raw_width": raw_width,
                })

    # Normalise L1 edge widths to 1–8
    l1_edges = [e for e in edges if "_raw_width" in e]
    if l1_edges:
        max_raw = max(e["_raw_width"] for e in l1_edges)
        for e in l1_edges:
            e["width"] = max(1, round(e["_raw_width"] / max_raw * 8))
            del e["_raw_width"]

    return {"nodes": nodes, "edges": edges}


def main() -> None:
    categories = load_config()
    cache = load_cache()
    client = Anthropic()

    all_docs = scan_documents()
    if not all_docs:
        print("No documents found in data/")
        sys.exit(1)

    print(f"Found {len(all_docs)} documents.")

    to_process = []
    for path in all_docs:
        h = file_hash(path)
        if path.name not in cache or cache[path.name]["hash"] != h:
            content = read_document(path)
            to_process.append({"filename": path.name, "content": content, "hash": h})

    if to_process:
        print(f"Categorizing {len(to_process)} documents via Claude API...")
        for i in range(0, len(to_process), BATCH_SIZE):
            batch = to_process[i : i + BATCH_SIZE]
            print(f"  Batch {i // BATCH_SIZE + 1} ({len(batch)} docs)...")
            results = categorize_batch(client, batch, categories)
            for r in results:
                doc = batch[r["index"] - 1]
                cache[doc["filename"]] = {
                    "hash": doc["hash"],
                    "l1": r["l1"],
                    "l2": r["l2"],
                    "content": doc["content"],
                }
        save_cache(cache)
        print("Cache saved.")
    else:
        print("All documents already cached, skipping API calls.")

    # Back-fill content for cache entries that predate the content field
    for path in all_docs:
        entry = cache.get(path.name, {})
        if "content" not in entry:
            entry["content"] = read_document(path)
            cache[path.name] = entry

    categorized = [
        {
            "filename": path.name,
            "l1": cache[path.name]["l1"],
            "l2": cache[path.name]["l2"],
            "content": cache[path.name].get("content", ""),
        }
        for path in all_docs
        if path.name in cache
    ]

    index = build_index(categorized)
    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(
        f"Written {INDEX_FILE} "
        f"({len(index['nodes'])} nodes, {len(index['edges'])} edges)."
    )


if __name__ == "__main__":
    main()
