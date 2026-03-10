#!/usr/bin/env python3
"""Preprocess documents in data/ and generate .local/index.json.

Usage:
    uv run preprocess.py

Reads config.yaml for L1 categories, calls the Claude API to assign each
document to an L1 category and generate an L2 subcategory, then writes
.local/index.json for the web app to consume.

Results are cached in .local/.cache.json — only changed files trigger new
API calls on subsequent runs.
"""

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import frontmatter
import yaml
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv()  # reads .env if present; env vars already set take priority

DATA_DIR = Path("data")
LOCAL_DIR = Path(".local")
CACHE_FILE = LOCAL_DIR / ".cache.json"
INDEX_FILE = LOCAL_DIR / "index.json"
TEXT_CACHE_DIR = LOCAL_DIR / ".text_cache"
EMBED_CACHE_FILE = LOCAL_DIR / ".embed_cache.json"
CONFIG_FILE = Path("config.yaml")

BATCH_SIZE = 20


# ── LLM provider abstraction ────────────────────────────────────────────────

class LLMClient:
    """Thin wrapper around LLM provider APIs with a uniform chat() interface."""

    def __init__(self) -> None:
        self.provider = os.environ.get("LLM_PROVIDER", "anthropic").lower()

        if self.provider == "anthropic":
            from anthropic import Anthropic as _Anthropic
            self.model = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
            self._client = _Anthropic()

        elif self.provider == "openai":
            try:
                from openai import OpenAI as _OpenAI
            except ImportError:
                sys.exit("OpenAI provider requires the 'openai' package: uv add openai")
            self.model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
            self._client = _OpenAI(
                organization=os.environ.get("OPENAI_ORG_ID") or None,
                project=os.environ.get("OPENAI_PROJECT_ID") or None,
            )

        elif self.provider == "gemini":
            try:
                import google.generativeai as genai  # type: ignore
            except ImportError:
                sys.exit(
                    "Gemini provider requires the 'google-generativeai' package: "
                    "uv add google-generativeai"
                )
            self.model = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
            api_key = os.environ.get("GEMINI_API_KEY")
            if not api_key:
                sys.exit("GEMINI_API_KEY is not set. Add it to .env or your environment.")
            genai.configure(api_key=api_key)
            self._genai = genai
            self._client = None  # Gemini uses module-level calls

        elif self.provider == "gemini-login":
            try:
                import vertexai
                from vertexai.generative_models import GenerativeModel as _GenerativeModel
            except ImportError:
                sys.exit(
                    "gemini-login provider requires 'google-cloud-aiplatform': "
                    "uv add google-cloud-aiplatform"
                )
            self.model = os.environ.get("GEMINI_LOGIN_MODEL", "gemini-1.5-flash")
            project = os.environ.get("GEMINI_PROJECT")
            location = os.environ.get("GEMINI_LOCATION", "us-central1")
            vertexai.init(project=project, location=location)
            self._GenerativeModel = _GenerativeModel
            self._client = None

        elif self.provider == "claude-code":
            # Uses the `claude` CLI with your existing login — no API key required.
            self.model = os.environ.get("CLAUDE_CODE_MODEL", "claude-haiku-4-5-20251001")
            self._client = None

        else:
            sys.exit(f"Unknown LLM_PROVIDER '{self.provider}'. Use: anthropic | openai | gemini | gemini-login | claude-code")

        print(f"Using LLM provider: {self.provider} / {self.model}")

    def chat(self, prompt: str, max_tokens: int = 2048) -> str:
        if self.provider == "anthropic":
            msg = self._client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text.strip()

        elif self.provider == "openai":
            resp = self._client.chat.completions.create(
                model=self.model,
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
            return resp.choices[0].message.content.strip()

        elif self.provider == "gemini":
            model = self._genai.GenerativeModel(self.model)
            resp = model.generate_content(prompt)
            return resp.text.strip()

        elif self.provider == "gemini-login":
            model = self._GenerativeModel(self.model)
            resp = model.generate_content(
                prompt,
                generation_config={"max_output_tokens": max_tokens},
            )
            return resp.text.strip()

        elif self.provider == "claude-code":
            result = subprocess.run(
                ["claude", "--model", self.model, "-p", prompt],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=120,
            )
            if result.returncode != 0:
                raise RuntimeError(f"claude CLI failed: {result.stderr.strip()}")
            return result.stdout.strip()

        raise RuntimeError(f"Unsupported provider: {self.provider}")


def load_config() -> tuple[list[str], dict]:
    with open(CONFIG_FILE) as f:
        config = yaml.safe_load(f)
    categories = config["categories"]
    constraints = config.get("subcategory_constraints", {})
    return categories, constraints


def load_index() -> dict | None:
    if INDEX_FILE.exists():
        with open(INDEX_FILE, encoding="utf-8") as f:
            return json.load(f)
    return None


def write_text_cache(all_docs: list[Path], cache: dict) -> None:
    """Write extracted text for each doc to .text_cache/ for keyword search."""
    TEXT_CACHE_DIR.mkdir(exist_ok=True)
    for path in tqdm(all_docs, desc="Writing text cache", unit="file", leave=False):
        rel = str(path.relative_to(DATA_DIR))
        entry = cache.get(rel, {})
        text = entry.get("content", "")
        if text:
            safe_name = rel.replace("/", "__").replace("\\", "__")
            (TEXT_CACHE_DIR / (safe_name + ".txt")).write_text(text, encoding="utf-8")


def index_doc_assignments(index: dict) -> dict[str, dict]:
    """Return filename -> {l1, l2} from existing index.json (preserves UI edits)."""
    result = {}
    for node in index["nodes"]:
        if node.get("level") == 3 and node.get("file"):
            result[node["file"]] = {"l1": node["l1"], "l2": node["l2"]}
    return result


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
    client: LLMClient,
    docs: list[dict],
    categories: list[str],
) -> list[dict]:
    """Call LLM to assign L1 + generate L2 categories for a batch of documents."""
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
2. l2: A short subcategory name (2–5 words). Documents are primarily in Japanese — write l2 in Japanese unless the filename is clearly in another language.

Respond ONLY with a valid JSON array, no extra text:
[
  {{"index": 1, "l1": "<L1 category>", "l2": "<subcategory>"}},
  ...
]

Documents:
{docs_str}"""

    text = client.chat(prompt)
    start = text.find("[")
    end = text.rfind("]") + 1
    return json.loads(text[start:end])


def scan_documents() -> list[Path]:
    docs = []
    for suffix in ("*.md", "*.pdf"):
        docs.extend(
            p for p in DATA_DIR.rglob(suffix)
            if ".text_cache" not in p.parts
        )
    return sorted(docs)


_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "in", "to", "for", "on",
    "with", "at", "by", "from", "is", "it", "its", "as", "be", "this",
    "that", "was", "are", "were", "been", "has", "have", "had", "but",
    "not", "no", "so", "do", "if", "we", "i", "you", "he", "she", "they",
    "de", "la", "le", "les", "des", "du", "en", "et",
}

# Unicode ranges covering CJK Unified Ideographs, Hiragana, Katakana,
# Katakana Phonetic Extensions, and common CJK Extension blocks.
_CJK_RANGES = (
    (0x3040, 0x30FF),   # Hiragana + Katakana
    (0x3400, 0x4DBF),   # CJK Unified Ideographs Extension A
    (0x4E00, 0x9FFF),   # CJK Unified Ideographs
    (0xF900, 0xFAFF),   # CJK Compatibility Ideographs
    (0x20000, 0x2A6DF), # CJK Unified Ideographs Extension B
)


def _is_cjk(char: str) -> bool:
    cp = ord(char)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def _keywords(text: str) -> set[str]:
    """Return keyword token set from text (used by constraint-enforcement code)."""
    return set(_keyword_counts(text).keys())


def _keyword_counts(text: str) -> Counter:
    """Return term-frequency Counter from text.

    For CJK (Japanese) runs: character bigrams.
    For ASCII/Latin runs: lowercased word tokens, stopwords removed.
    """
    counts: Counter = Counter()
    cjk_run: list[str] = []

    def _flush_cjk() -> None:
        if len(cjk_run) >= 2:
            for i in range(len(cjk_run) - 1):
                counts[cjk_run[i] + cjk_run[i + 1]] += 1
        cjk_run.clear()

    for char in text:
        if _is_cjk(char):
            cjk_run.append(char)
        else:
            _flush_cjk()
    _flush_cjk()

    # ASCII/Latin word tokens
    for word in text.lower().split():
        word = word.strip(".,;:!?\"'()[]{}/-")
        if len(word) >= 3 and word not in _STOPWORDS and not any(_is_cjk(c) for c in word):
            counts[word] += 1

    return counts


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _cosine(a: dict, b: dict) -> float:
    """Cosine similarity between two TF-IDF weight dicts."""
    if not a or not b:
        return 0.0
    shared = set(a) & set(b)
    dot = sum(a[t] * b[t] for t in shared)
    mag_a = math.sqrt(sum(v * v for v in a.values()))
    mag_b = math.sqrt(sum(v * v for v in b.values()))
    if mag_a == 0.0 or mag_b == 0.0:
        return 0.0
    return dot / (mag_a * mag_b)


_EMBED_MODEL = None


def _get_embed_model():
    global _EMBED_MODEL
    if _EMBED_MODEL is None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            sys.exit("'embed' algo requires sentence-transformers: uv add sentence-transformers")
        print("  Loading sentence-transformer model (paraphrase-multilingual-MiniLM-L12-v2)…")
        _EMBED_MODEL = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
    return _EMBED_MODEL


def _bm25_vectors(doc_tf: dict[str, Counter], k1: float = 1.5, b: float = 0.75) -> dict[str, dict]:
    """Compute BM25-weighted term vectors for each document."""
    N = len(doc_tf)
    if N == 0:
        return {}
    df: Counter = Counter(term for counts in doc_tf.values() for term in counts)
    doc_lens = {doc_id: sum(counts.values()) for doc_id, counts in doc_tf.items()}
    avgdl = sum(doc_lens.values()) / N

    def bm25_idf(term: str) -> float:
        return math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1.0)

    result: dict[str, dict] = {}
    for doc_id, counts in doc_tf.items():
        dl = doc_lens[doc_id]
        result[doc_id] = {
            term: (tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))) * bm25_idf(term)
            for term, tf in counts.items()
        }
    return result


def _embed_similarities(contents: dict[str, str]) -> dict[tuple[str, str], float]:
    """Compute pairwise cosine similarities using sentence-transformer embeddings.

    Uses EMBED_CACHE_FILE to skip re-encoding unchanged texts.
    contents: {id -> text}
    Returns: {(id_a, id_b) -> similarity} for all pairs.
    """
    if len(contents) < 2:
        return {}

    # Load embedding cache (keyed by md5 of text)
    embed_cache: dict[str, list] = {}
    if EMBED_CACHE_FILE.exists():
        with open(EMBED_CACHE_FILE, encoding="utf-8") as f:
            embed_cache = json.load(f)

    ids = list(contents.keys())
    text_hashes = {i: hashlib.md5(contents[i].encode()).hexdigest() for i in ids}
    to_encode_ids = [i for i in ids if text_hashes[i] not in embed_cache]

    if to_encode_ids:
        print(f"  Encoding {len(to_encode_ids)} text(s) with sentence-transformer…")
        model = _get_embed_model()
        texts_to_encode = [contents[i] for i in to_encode_ids]
        new_embeddings = model.encode(texts_to_encode, normalize_embeddings=True, show_progress_bar=True)
        for i, emb in zip(to_encode_ids, new_embeddings):
            embed_cache[text_hashes[i]] = emb.tolist()
        EMBED_CACHE_FILE.parent.mkdir(exist_ok=True)
        with open(EMBED_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(embed_cache, f)
        print(f"  Embed cache updated ({len(embed_cache)} entries).")

    # Compute pairwise similarities via matrix multiply (embeddings are L2-normalised)
    import numpy as np
    mat = np.array([embed_cache[text_hashes[i]] for i in ids], dtype="float32")
    sim_mat = mat @ mat.T
    sims: dict[tuple[str, str], float] = {}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            sims[(ids[i], ids[j])] = float(sim_mat[i, j])
    return sims


def _top_keywords(tfidf: dict, n: int = 30) -> dict:
    """Return top-n keywords by TF-IDF score, rounded to 4 decimal places."""
    top = sorted(tfidf.items(), key=lambda x: x[1], reverse=True)[:n]
    return {k: round(v, 4) for k, v in top}


def build_index(categorized: list[dict], algo: str = "embed") -> dict:
    nodes: list[dict] = []
    edges: list[dict] = []

    l1_seen: dict[str, str] = {}   # l1 label -> node id
    l2_seen: dict[tuple, str] = {}  # (l1, l2) -> node id
    l2_kw_sets: dict[tuple, set] = {}   # (l1, l2) -> keyword set (for Jaccard edges)
    l1_l2_names: dict[str, list[str]] = {}  # l1 -> list of l2 labels
    l1_doc_count: dict[str, int] = {}
    l2_doc_count: dict[tuple, int] = {}  # (l1, l2) -> doc count
    doc_tf: dict[str, Counter] = {}       # doc_id -> raw term Counter (for TF-IDF keywords)
    doc_kw_sets: dict[str, set] = {}      # doc_id -> keyword set (for Jaccard edges)
    docs_by_l2: dict[tuple, list[str]] = {}  # (l1, l2) -> [doc_id, ...]

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
        l2_doc_count[l2_key] = l2_doc_count.get(l2_key, 0) + 1
        if l2_key not in l2_seen:
            l2_id = f"l2:{l1}:{l2}"
            l2_seen[l2_key] = l2_id
            nodes.append({"id": l2_id, "label": l2, "level": 2, "l1": l1})
            l2_kw_sets[l2_key] = set()
            l1_l2_names[l1].append(l2)

        kw = _keywords(content)
        l2_kw_sets[l2_key] |= kw

        doc_id = f"doc:{doc['filename']}"
        nodes.append({
            "id": doc_id,
            "label": Path(doc["filename"]).stem,
            "level": 3,
            "l1": l1,
            "l2": l2,
            "file": doc["filename"],
        })
        doc_tf[doc_id] = _keyword_counts(content)
        doc_kw_sets[doc_id] = kw
        docs_by_l2.setdefault(l2_key, []).append(doc_id)

    # Set ndocs on L1 and L2 nodes now that counts are final
    for node in nodes:
        if node["level"] == 1:
            node["ndocs"] = l1_doc_count.get(node["label"], 0)
        elif node["level"] == 2:
            node["ndocs"] = l2_doc_count.get((node["l1"], node["label"]), 0)

    # ── TF-IDF keyword vectors (stored on nodes for client-side MDS) ─────────
    N = len(doc_tf)

    df: Counter = Counter()
    for counts in doc_tf.values():
        for term in counts:
            df[term] += 1

    def idf(term: str) -> float:
        return math.log((N + 1) / (df[term] + 1)) + 1.0

    doc_tfidf: dict[str, dict] = {}
    for doc_id, counts in doc_tf.items():
        total = sum(counts.values()) or 1
        doc_tfidf[doc_id] = {term: (count / total) * idf(term) for term, count in counts.items()}

    l2_tfidf: dict[tuple, dict] = {}
    for l2_key, doc_ids in docs_by_l2.items():
        agg: dict[str, float] = {}
        for did in doc_ids:
            for term, score in doc_tfidf[did].items():
                agg[term] = agg.get(term, 0.0) + score
        l2_tfidf[l2_key] = agg

    l1_tfidf: dict[str, dict] = {}
    for l1 in l1_seen:
        agg = {}
        for l2_key, vec in l2_tfidf.items():
            if l2_key[0] == l1:
                for term, score in vec.items():
                    agg[term] = agg.get(term, 0.0) + score
        l1_tfidf[l1] = agg

    node_by_id = {n["id"]: n for n in nodes}
    for doc_id, vec in doc_tfidf.items():
        if doc_id in node_by_id:
            node_by_id[doc_id]["keywords"] = _top_keywords(vec, 30)
    for l2_key, vec in l2_tfidf.items():
        l2_id = l2_seen[l2_key]
        if l2_id in node_by_id:
            node_by_id[l2_id]["keywords"] = _top_keywords(vec, 30)
    for l1, vec in l1_tfidf.items():
        l1_id = l1_seen[l1]
        if l1_id in node_by_id:
            node_by_id[l1_id]["keywords"] = _top_keywords(vec, 30)

    print(f"Building index with similarity algorithm: {algo}")

    # ── BM25 vectors (algo == 'bm25') ─────────────────────────────────────────
    doc_bm25: dict[str, dict] = {}
    l2_bm25: dict[tuple, dict] = {}
    l1_bm25: dict[str, dict] = {}
    if algo == "bm25":
        doc_bm25 = _bm25_vectors(doc_tf)
        for l2_key, doc_ids in docs_by_l2.items():
            agg: dict[str, float] = {}
            for did in doc_ids:
                for term, score in doc_bm25[did].items():
                    agg[term] = agg.get(term, 0.0) + score
            l2_bm25[l2_key] = agg
        for l1 in l1_seen:
            agg = {}
            for l2_key, vec in l2_bm25.items():
                if l2_key[0] == l1:
                    for term, score in vec.items():
                        agg[term] = agg.get(term, 0.0) + score
            l1_bm25[l1] = agg

    # ── Embed similarities (algo == 'embed') ──────────────────────────────────
    embed_sims: dict[tuple[str, str], float] = {}
    if algo == "embed":
        doc_embed_content: dict[str, str] = {}
        for doc in categorized:
            doc_embed_content[f"doc:{doc['filename']}"] = doc.get("content", "")
        l2_embed_content: dict[str, str] = {}
        for l2_key, doc_ids in docs_by_l2.items():
            l2_embed_content[l2_seen[l2_key]] = " ".join(
                doc_embed_content.get(did, "") for did in doc_ids
            )
        l1_embed_content: dict[str, str] = {}
        for l1, l1_id in l1_seen.items():
            l1_embed_content[l1_id] = " ".join(
                l2_embed_content.get(l2_seen[lk], "")
                for lk in l2_seen if lk[0] == l1
            )
        all_embed_contents = {**doc_embed_content, **l2_embed_content, **l1_embed_content}
        embed_sims = _embed_similarities(all_embed_contents)

    # ── Doc↔Doc semantic edges (within same L2) ───────────────────────────────
    for doc_ids_in_l2 in tqdm(docs_by_l2.values(), desc="Computing doc edges", unit="group", leave=False):
        for i in range(len(doc_ids_in_l2)):
            for j in range(i + 1, len(doc_ids_in_l2)):
                da, db = doc_ids_in_l2[i], doc_ids_in_l2[j]
                if algo == "jaccard":
                    sim = _jaccard(doc_kw_sets[da], doc_kw_sets[db])
                elif algo == "tfidf":
                    sim = _cosine(doc_tfidf[da], doc_tfidf[db])
                elif algo == "bm25":
                    sim = _cosine(doc_bm25[da], doc_bm25[db])
                else:  # embed
                    sim = embed_sims.get((da, db), embed_sims.get((db, da), 0.0))
                if sim >= 0.05:
                    width = max(1, min(8, round(sim * 20)))
                    edges.append({
                        "from": da,
                        "to": db,
                        "weight": round(sim, 3),
                        "width": width,
                    })

    # ── L2↔L2 semantic edges (within same L1) ────────────────────────────────
    l2_keys = list(l2_seen.keys())
    for i in tqdm(range(len(l2_keys)), desc="Computing L2 edges", unit="node", leave=False):
        for j in range(i + 1, len(l2_keys)):
            ka, kb = l2_keys[i], l2_keys[j]
            if ka[0] != kb[0]:  # must share same L1
                continue
            if algo == "jaccard":
                sim = _jaccard(l2_kw_sets[ka], l2_kw_sets[kb])
            elif algo == "tfidf":
                sim = _cosine(l2_tfidf[ka], l2_tfidf[kb])
            elif algo == "bm25":
                sim = _cosine(l2_bm25[ka], l2_bm25[kb])
            else:  # embed
                la_id, lb_id = l2_seen[ka], l2_seen[kb]
                sim = embed_sims.get((la_id, lb_id), embed_sims.get((lb_id, la_id), 0.0))
            if sim >= 0.05:
                width = max(1, min(8, round(sim * 20)))
                edges.append({
                    "from": l2_seen[ka],
                    "to": l2_seen[kb],
                    "weight": round(sim, 3),
                    "width": width,
                })

    # ── L1↔L1 edges ───────────────────────────────────────────────────────────
    l1_list = list(l1_seen.keys())
    for i in range(len(l1_list)):
        for j in range(i + 1, len(l1_list)):
            la, lb = l1_list[i], l1_list[j]
            if algo == "jaccard":
                words_a = set()
                for name in l1_l2_names[la]:
                    words_a |= _keywords(name)
                words_b = set()
                for name in l1_l2_names[lb]:
                    words_b |= _keywords(name)
                sim = _jaccard(words_a, words_b)
                if sim > 0:
                    count_factor = (l1_doc_count[la] * l1_doc_count[lb]) ** 0.5
                    edges.append({
                        "from": l1_seen[la],
                        "to": l1_seen[lb],
                        "weight": round(sim, 3),
                        "_raw_width": sim * count_factor,
                    })
            elif algo == "tfidf":
                sim = _cosine(l1_tfidf[la], l1_tfidf[lb])
                if sim > 0:
                    edges.append({
                        "from": l1_seen[la],
                        "to": l1_seen[lb],
                        "weight": round(sim, 3),
                        "_raw_width": sim,
                    })
            elif algo == "bm25":
                sim = _cosine(l1_bm25[la], l1_bm25[lb])
                if sim > 0:
                    edges.append({
                        "from": l1_seen[la],
                        "to": l1_seen[lb],
                        "weight": round(sim, 3),
                        "_raw_width": sim,
                    })
            else:  # embed
                la_id, lb_id = l1_seen[la], l1_seen[lb]
                sim = embed_sims.get((la_id, lb_id), embed_sims.get((lb_id, la_id), 0.0))
                if sim > 0:
                    edges.append({
                        "from": la_id,
                        "to": lb_id,
                        "weight": round(sim, 3),
                        "_raw_width": sim,
                    })

    # Normalise L1 edge widths to 1–8
    l1_edges = [e for e in edges if "_raw_width" in e]
    if l1_edges:
        max_raw = max(e["_raw_width"] for e in l1_edges)
        for e in l1_edges:
            e["width"] = max(1, round(e["_raw_width"] / max_raw * 8))
            del e["_raw_width"]

    return {"nodes": nodes, "edges": edges}



def apply_constraints(
    categorized: list[dict],
    constraints: dict,
    client: LLMClient,
    categories: list[str],
) -> list[dict]:
    """Enforce max_subcategories / min_docs / max_docs constraints per L1."""
    if not constraints:
        return categorized

    max_subcats = constraints.get("max_subcategories", 999)
    min_docs = constraints.get("min_docs_per_subcategory", 1)

    # Group by l1
    by_l1: dict[str, list[dict]] = {}
    for doc in categorized:
        by_l1.setdefault(doc["l1"], []).append(doc)

    result: list[dict] = []
    for l1, docs in by_l1.items():
        # Group by l2
        def get_groups(docs: list[dict]) -> dict[str, list[dict]]:
            groups: dict[str, list[dict]] = {}
            for d in docs:
                groups.setdefault(d["l2"], []).append(d)
            return groups

        groups = get_groups(docs)

        # ── Merge small subcategories ─────────────────────────────────────────
        changed = True
        while changed:
            changed = False
            groups = get_groups(docs)  # recompute from full list so in-place l2 updates are visible
            small = [l2 for l2, ds in groups.items() if len(ds) < min_docs]
            if not small or len(groups) <= 1:
                break
            for l2_small in small:
                if l2_small not in groups or len(groups) <= 1:
                    continue
                # Find nearest neighbor by keyword similarity
                kw_small = set()
                for d in groups[l2_small]:
                    kw_small |= _keywords(d.get("content", "") + " " + l2_small)
                best_l2, best_sim = None, -1.0
                for l2_other, ds_other in groups.items():
                    if l2_other == l2_small:
                        continue
                    kw_other = set()
                    for d in ds_other:
                        kw_other |= _keywords(d.get("content", "") + " " + l2_other)
                    sim = _jaccard(kw_small, kw_other)
                    if sim > best_sim:
                        best_sim, best_l2 = sim, l2_other
                if best_l2 is None:
                    best_l2 = next(l2 for l2 in groups if l2 != l2_small)
                print(f"  Merging small subcat '{l2_small}' ({len(groups[l2_small])} docs) → '{best_l2}' in {l1}")
                for d in groups[l2_small]:
                    d["l2"] = best_l2
                del groups[l2_small]
                changed = True

        # ── Merge excess subcategories to enforce max_subcategories ──────────
        groups = get_groups(docs)
        while len(groups) > max_subcats:
            # Merge the smallest subcategory into its most similar neighbor
            l2_small = min(groups, key=lambda l2: len(groups[l2]))
            kw_small = set()
            for d in groups[l2_small]:
                kw_small |= _keywords(d.get("content", "") + " " + l2_small)
            best_l2, best_sim = None, -1.0
            for l2_other, ds_other in groups.items():
                if l2_other == l2_small:
                    continue
                kw_other = set()
                for d in ds_other:
                    kw_other |= _keywords(d.get("content", "") + " " + l2_other)
                sim = _jaccard(kw_small, kw_other)
                if sim > best_sim:
                    best_sim, best_l2 = sim, l2_other
            if best_l2 is None:
                best_l2 = next(l2 for l2 in groups if l2 != l2_small)
            print(f"  Merging excess subcat '{l2_small}' ({len(groups[l2_small])} docs) → '{best_l2}' in {l1}")
            for d in groups[l2_small]:
                d["l2"] = best_l2
            del groups[l2_small]
            groups = get_groups(docs)

        result.extend(sum(groups.values(), []))

    return result


def categorize_new_docs(
    client: LLMClient,
    to_process: list[dict],
    categories: list[str],
    cache: dict,
) -> None:
    """Call LLM for uncached/changed docs and update cache in-place."""
    print(f"Categorizing {len(to_process)} document(s) via LLM...")
    batches = [to_process[i : i + BATCH_SIZE] for i in range(0, len(to_process), BATCH_SIZE)]

    def _run_batch(batch: list[dict]) -> tuple[list[dict], list[dict]]:
        return batch, categorize_batch(client, batch, categories)

    all_results: list[tuple[list[dict], list[dict]]] = []
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(_run_batch, b): b for b in batches}
        for future in tqdm(as_completed(futures), total=len(futures), desc="Categorizing batches", unit="batch"):
            all_results.append(future.result())

    for batch, results in all_results:
        covered_indices: set[int] = set()
        for r in results:
            doc = batch[r["index"] - 1]
            cache[doc["filename"]] = {
                "hash": doc["hash"],
                "l1": r["l1"],
                "l2": r["l2"],
                "content": doc["content"],
            }
            covered_indices.add(r["index"] - 1)
        # Fallback for docs the LLM omitted from its response
        for idx, doc in enumerate(batch):
            if idx not in covered_indices:
                tqdm.write(f"  WARNING: LLM did not categorize '{doc['filename']}' — assigning to fallback category.")
                cache[doc["filename"]] = {
                    "hash": doc["hash"],
                    "l1": categories[0],
                    "l2": "未分類",
                    "content": doc["content"],
                }
    save_cache(cache)
    print("Cache saved.")


def backfill_content(cache: dict, all_docs: list[Path]) -> None:
    """Ensure every cache entry has a content field (back-compat)."""
    updated = False
    for path in tqdm(all_docs, desc="Backfilling content", unit="file", leave=False):
        rel = str(path.relative_to(DATA_DIR))
        entry = cache.get(rel, {})
        if entry and "content" not in entry:
            entry["content"] = read_document(path)
            cache[rel] = entry
            updated = True
    if updated:
        save_cache(cache)


def refine_l2_groups(
    categorized: list[dict],
    client: LLMClient,
    categories: list[str],
) -> list[dict]:
    """Stage-2 subcategorization: for each L1 group, ask LLM to assign
    consistent, coherent L2 names by seeing all docs in the group at once."""
    from collections import defaultdict

    by_l1: dict[str, list] = defaultdict(list)
    for doc in categorized:
        by_l1[doc["l1"]].append(doc)

    refined = {doc["filename"]: doc["l2"] for doc in categorized}

    def _refine_one(l1: str, docs: list[dict]) -> dict[str, str]:
        docs_str = "\n\n".join(
            f"[{i + 1}] filename: {d['filename']}\n"
            f"current draft subcategory: {d['l2']}\n"
            f"content snippet:\n{d['content'][:600]}"
            for i, d in enumerate(docs)
        )
        prompt = f"""You are organizing {len(docs)} documents that all belong to the top-level category "{l1}".

Your task:
1. Design a set of 3–8 coherent, descriptive subcategory names that together cover all these documents.
   - Names should be 2–5 words, in Japanese if the documents are primarily Japanese.
   - Reuse the same name for documents on the same topic — consistency is critical.
   - Each name should be meaningfully different from the others.
2. Assign each document to exactly one of those subcategory names.

Respond ONLY with a valid JSON array, no extra text:
[
  {{"index": 1, "l2": "<subcategory name>"}},
  ...
]

Documents:
{docs_str}"""

        try:
            text = client.chat(prompt)
            start = text.find("[")
            end = text.rfind("]") + 1
            results = json.loads(text[start:end])
            return {docs[r["index"] - 1]["filename"]: r["l2"] for r in results}
        except Exception as e:
            tqdm.write(f"  WARNING: L2 refinement failed for '{l1}': {e} — keeping draft names.")
            return {}

    eligible = {l1: docs for l1, docs in by_l1.items() if len(docs) >= 2}
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(_refine_one, l1, docs): l1 for l1, docs in eligible.items()}
        for future in tqdm(as_completed(futures), total=len(futures), desc="Refining subcategories", unit="category"):
            refined.update(future.result())

    return [{**doc, "l2": refined[doc["filename"]]} for doc in categorized]


def main() -> None:
    parser = argparse.ArgumentParser(description="Preprocess documents into .local/index.json")
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Ignore existing index.json and rebuild from scratch (clears UI renames/merges)",
    )
    parser.add_argument(
        "--algo",
        choices=["jaccard", "tfidf", "bm25", "embed"],
        default="embed",
        help=(
            "Similarity algorithm for semantic edges (default: embed). "
            "jaccard: keyword set overlap; tfidf: TF-IDF cosine; "
            "bm25: BM25 cosine; embed: sentence-transformer embeddings "
            "(requires: uv add sentence-transformers)"
        ),
    )
    args = parser.parse_args()

    LOCAL_DIR.mkdir(exist_ok=True)
    categories, constraints = load_config()
    cache = load_cache()
    client = LLMClient()

    all_docs = scan_documents()
    if not all_docs:
        print("No documents found in data/")  # source docs still in data/
        sys.exit(1)

    print(f"Found {len(all_docs)} document(s).")

    # ── Determine which files need LLM categorization ─────────────────────────
    def _hash_and_read(path: Path) -> tuple[str, str, str]:
        rel = str(path.relative_to(DATA_DIR))
        h = file_hash(path)
        content = read_document(path)
        return rel, h, content

    to_process = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(_hash_and_read, p): p for p in all_docs}
        for future in tqdm(as_completed(futures), total=len(all_docs), desc="Scanning files", unit="file"):
            rel, h, content = future.result()
            if rel not in cache or cache[rel]["hash"] != h:
                to_process.append({"filename": rel, "content": content, "hash": h})

    if to_process:
        categorize_new_docs(client, to_process, categories, cache)
    else:
        print("All documents already cached, skipping API calls.")

    backfill_content(cache, all_docs)

    # ── Build categorized list, preserving UI edits in incremental mode ───────
    existing_index = None if args.rebuild else load_index()

    if existing_index and not args.rebuild:
        # Incremental: use current index.json assignments (which may have been
        # renamed/merged via the UI), only apply cache for *new* files.
        ui_assignments = index_doc_assignments(existing_index)
        new_filenames = {d["filename"] for d in to_process}

        categorized = []
        for path in all_docs:
            rel = str(path.relative_to(DATA_DIR))
            if rel not in cache:
                continue
            if rel in new_filenames:
                # New file — use fresh LLM assignment from cache
                entry = cache[rel]
                categorized.append({
                    "filename": rel,
                    "l1": entry["l1"],
                    "l2": entry["l2"],
                    "content": entry.get("content", ""),
                })
            elif rel in ui_assignments:
                # Existing file — use UI assignment to preserve renames/merges
                ui = ui_assignments[rel]
                categorized.append({
                    "filename": rel,
                    "l1": ui["l1"],
                    "l2": ui["l2"],
                    "content": cache[rel].get("content", ""),
                })
            else:
                # In cache but not in index (e.g. index was manually edited) — use cache
                entry = cache[rel]
                categorized.append({
                    "filename": rel,
                    "l1": entry["l1"],
                    "l2": entry["l2"],
                    "content": entry.get("content", ""),
                })

        new_count = len(new_filenames & {str(p.relative_to(DATA_DIR)) for p in all_docs})
        if new_count:
            print(f"Incremental mode: added {new_count} new document(s), preserving existing categorization.")
        else:
            print("Incremental mode: no new documents found. Re-computing edges from current index.")
    else:
        if args.rebuild:
            print("Rebuild mode: regenerating index from cache (UI renames/merges will be reset).")
        categorized = [
            {
                "filename": str(path.relative_to(DATA_DIR)),
                "l1": cache[str(path.relative_to(DATA_DIR))]["l1"],
                "l2": cache[str(path.relative_to(DATA_DIR))]["l2"],
                "content": cache[str(path.relative_to(DATA_DIR))].get("content", ""),
            }
            for path in all_docs
            if str(path.relative_to(DATA_DIR)) in cache
        ]

    # Stage-2: refine L2 names per L1 group for consistency (skip pure incremental
    # with no new docs to avoid overwriting UI renames/merges)
    needs_refinement = args.rebuild or bool(to_process)
    if needs_refinement:
        print("Refining L2 subcategories for consistency…")
        categorized = refine_l2_groups(categorized, client, categories)

    if constraints:
        print("Applying subcategory constraints...")
        categorized = apply_constraints(categorized, constraints, client, categories)

    write_text_cache(all_docs, cache)

    index = build_index(categorized, algo=args.algo)
    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(
        f"Written {INDEX_FILE} "
        f"({len(index['nodes'])} nodes, {len(index['edges'])} edges)."
    )


if __name__ == "__main__":
    main()
