import marimo

__generated_with = "0.20.4"
app = marimo.App(width="medium")


@app.cell
def _(mo):
    mo.md(r"""
    # セマンティック距離アルゴリズム比較

    `preprocess.py` は `--algo` フラグで4種類のセマンティック距離アルゴリズムを切り替えられます。
    このドキュメントでは、各アルゴリズムの特性と実際のデータでの比較結果を示します。

    ## 対象アルゴリズム

    | アルゴリズム | 方式 | 特徴 |
    |-------------|------|------|
    | `jaccard`   | キーワード集合の重複率 | 最速・シンプル |
    | `tfidf`     | TF-IDFコサイン類似度 | 稀少語を重視 |
    | `bm25`      | BM25コサイン類似度 | 長さ正規化あり |
    | `embed`     | 文埋め込みコサイン類似度 | 意味的類似度・最高精度 |
    """)
    return


@app.cell
def _():
    import marimo as mo
    import json
    import math
    import time
    import hashlib
    from collections import Counter
    from pathlib import Path
    import numpy as np
    import matplotlib.pyplot as plt
    import matplotlib
    matplotlib.rcParams['font.family'] = ['DejaVu Sans', 'IPAexGothic', 'Noto Sans CJK JP']
    return Counter, Path, hashlib, json, math, mo, np, plt, time


@app.cell
def _(Path, json, mo):
    BASE = Path(__file__).parent.parent / ".local"
    CACHE_FILE = BASE / ".cache.json"
    INDEX_FILE = BASE / "index.json"
    EMBED_CACHE_FILE = BASE / ".embed_cache.json"

    if not CACHE_FILE.exists():
        mo.stop(True, mo.md("**.local/.cache.json が見つかりません。** まず `uv run preprocess.py` を実行してください。"))

    with open(CACHE_FILE, encoding="utf-8") as _f:
        _raw_cache = json.load(_f)

    with open(INDEX_FILE, encoding="utf-8") as _f:
        _index = json.load(_f)

    with open(EMBED_CACHE_FILE, encoding="utf-8") as _f:
        embed_cache = json.load(_f)

    all_docs = {
        fname: entry["content"]
        for fname, entry in _raw_cache.items()
        if entry.get("content")
    }
    doc_l1 = {fname: entry["l1"] for fname, entry in _raw_cache.items()}
    doc_l2 = {fname: entry["l2"] for fname, entry in _raw_cache.items()}
    l1_categories = sorted(set(doc_l1.values()))

    mo.md(f"**データ読み込み完了:** {len(all_docs)} 件のドキュメント / {len(l1_categories)} カテゴリ")
    return all_docs, doc_l1, embed_cache, l1_categories


@app.cell
def _(Counter, math):
    # ── アルゴリズム実装 (preprocess.py から移植) ────────────────────────────

    _CJK_RANGES = (
        (0x3040, 0x30FF),
        (0x3400, 0x4DBF),
        (0x4E00, 0x9FFF),
        (0xF900, 0xFAFF),
        (0x20000, 0x2A6DF),
    )
    _STOPWORDS = {
        "the", "a", "an", "and", "or", "of", "in", "to", "for", "on",
        "with", "at", "by", "from", "is", "it", "its", "as", "be", "this",
        "that", "was", "are", "were", "been", "has", "have", "had", "but",
        "not", "no", "so", "do", "if", "we", "i", "you", "he", "she", "they",
        "de", "la", "le", "les", "des", "du", "en", "et",
    }

    def _is_cjk(char):
        cp = ord(char)
        return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)

    def _keyword_counts(text):
        counts = Counter()
        cjk_run = []

        def _flush_cjk():
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

        for word in text.lower().split():
            word = word.strip(".,;:!?\"'()[]{}/-")
            if len(word) >= 3 and word not in _STOPWORDS and not any(_is_cjk(c) for c in word):
                counts[word] += 1
        return counts

    def _keywords(text):
        return set(_keyword_counts(text).keys())

    def _jaccard(a, b):
        if not a or not b:
            return 0.0
        return len(a & b) / len(a | b)

    def _cosine(a, b):
        if not a or not b:
            return 0.0
        shared = set(a) & set(b)
        dot = sum(a[t] * b[t] for t in shared)
        mag_a = math.sqrt(sum(v * v for v in a.values()))
        mag_b = math.sqrt(sum(v * v for v in b.values()))
        if mag_a == 0.0 or mag_b == 0.0:
            return 0.0
        return dot / (mag_a * mag_b)

    def _bm25_vectors(doc_tf, k1=1.5, b=0.75):
        N = len(doc_tf)
        if N == 0:
            return {}
        df = Counter(term for counts in doc_tf.values() for term in counts)
        doc_lens = {doc_id: sum(counts.values()) for doc_id, counts in doc_tf.items()}
        avgdl = sum(doc_lens.values()) / N

        def bm25_idf(term):
            return math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1.0)

        result = {}
        for doc_id, counts in doc_tf.items():
            dl = doc_lens[doc_id]
            result[doc_id] = {
                term: (tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))) * bm25_idf(term)
                for term, tf in counts.items()
            }
        return result

    return


@app.cell
def _(l1_categories, mo):
    ui_category = mo.ui.dropdown(
        options=l1_categories,
        value=l1_categories[0],
        label="L1カテゴリを選択",
    )
    ui_threshold = mo.ui.slider(
        start=0.01, stop=0.5, step=0.01, value=0.05,
        label="類似度しきい値",
    )
    ui_sample = mo.ui.number(
        start=5, stop=100, step=5, value=20,
        label="サンプル数 (同一カテゴリから抽出)",
    )
    mo.hstack([ui_category, ui_threshold, ui_sample], justify="start", gap="2rem")
    return ui_category, ui_sample, ui_threshold


@app.cell
def _(
    Counter,
    all_docs,
    doc_l1,
    embed_cache,
    hashlib,
    math,
    mo,
    np,
    time,
    ui_category,
    ui_sample,
    ui_threshold,
):
    selected_l1 = ui_category.value
    threshold = ui_threshold.value
    sample_n = int(ui_sample.value)

    # 選択カテゴリのドキュメントをサンプリング
    cat_docs = {
        fname: content
        for fname, content in all_docs.items()
        if doc_l1.get(fname) == selected_l1
    }
    sample_fnames = list(cat_docs.keys())[:sample_n]
    sample_contents = {f: cat_docs[f] for f in sample_fnames}
    n = len(sample_fnames)

    mo.md(f"**{selected_l1}** カテゴリ: {len(cat_docs)} 件中 {n} 件を使用")

    # ── Jaccard ──────────────────────────────────────────────────────────────
    t0 = time.perf_counter()
    kw_sets = {f: _keywords(c) for f, c in sample_contents.items()}
    jaccard_sims = {}
    for _i in range(n):
        for _j in range(_i + 1, n):
            _a, _b = sample_fnames[_i], sample_fnames[_j]
            jaccard_sims[(_a, _b)] = _jaccard(kw_sets[_a], kw_sets[_b])
    t_jaccard = time.perf_counter() - t0

    # ── TF-IDF ───────────────────────────────────────────────────────────────
    t0 = time.perf_counter()
    doc_tf = {f: _keyword_counts(c) for f, c in sample_contents.items()}
    N = len(doc_tf)
    _df = Counter(term for counts in doc_tf.values() for term in counts)

    def _idf(term):
        return math.log((N + 1) / (_df[term] + 1)) + 1.0

    doc_tfidf = {}
    for _f, _counts in doc_tf.items():
        total = sum(_counts.values()) or 1
        doc_tfidf[_f] = {term: (cnt / total) * _idf(term) for term, cnt in _counts.items()}

    tfidf_sims = {}
    for _i in range(n):
        for _j in range(_i + 1, n):
            _a, _b = sample_fnames[_i], sample_fnames[_j]
            tfidf_sims[(_a, _b)] = _cosine(doc_tfidf[_a], doc_tfidf[_b])
    t_tfidf = time.perf_counter() - t0

    # ── BM25 ─────────────────────────────────────────────────────────────────
    t0 = time.perf_counter()
    doc_bm25 = _bm25_vectors(doc_tf)
    bm25_sims = {}
    for _i in range(n):
        for _j in range(_i + 1, n):
            _a, _b = sample_fnames[_i], sample_fnames[_j]
            bm25_sims[(_a, _b)] = _cosine(doc_bm25[_a], doc_bm25[_b])
    t_bm25 = time.perf_counter() - t0

    # ── Embed ────────────────────────────────────────────────────────────────
    t0 = time.perf_counter()
    text_hashes = {f: hashlib.md5(c.encode()).hexdigest() for f, c in sample_contents.items()}
    missing_embeds = [f for f in sample_fnames if text_hashes[f] not in embed_cache]

    embed_sims = {}
    if not missing_embeds:
        mat = np.array([embed_cache[text_hashes[f]] for f in sample_fnames], dtype="float32")
        sim_mat = mat @ mat.T
        for _i in range(n):
            for _j in range(_i + 1, n):
                embed_sims[(sample_fnames[_i], sample_fnames[_j])] = float(sim_mat[_i, _j])
    t_embed = time.perf_counter() - t0

    results = {
        "jaccard": {"sims": jaccard_sims, "time": t_jaccard},
        "tfidf":   {"sims": tfidf_sims,   "time": t_tfidf},
        "bm25":    {"sims": bm25_sims,     "time": t_bm25},
        "embed":   {"sims": embed_sims,    "time": t_embed},
    }

    if missing_embeds:
        mo.callout(
            mo.md(f"**注意:** {len(missing_embeds)} 件のドキュメントの埋め込みがキャッシュにありません。`uv run preprocess.py --algo embed` を実行してキャッシュを生成してください。embed の結果は空になります。"),
            kind="warn",
        )
    return results, threshold


@app.cell
def _(mo, results, threshold):
    def _stats(sims):
        vals = list(sims.values())
        if not vals:
            return 0, 0.0, 0.0
        above = [v for v in vals if v >= threshold]
        mean = sum(vals) / len(vals)
        median = sorted(vals)[len(vals) // 2]
        return len(above), round(mean, 4), round(median, 4)

    table_data = []
    for _algo, _data in results.items():
        _above, _mean, _median = _stats(_data["sims"])
        _pairs = len(_data["sims"])
        table_data.append({
            "アルゴリズム": _algo,
            "ペア数": _pairs,
            f"エッジ数 (≥{threshold})": _above,
            "平均スコア": _mean,
            "中央値スコア": _median,
            "計算時間 (ms)": round(_data["time"] * 1000, 2),
        })

    mo.md("## エッジ統計比較")
    mo.ui.table(table_data, selection=None)
    return


@app.cell
def _(mo, plt, results, threshold):
    _fig, _axes = plt.subplots(2, 2, figsize=(12, 8))
    _fig.suptitle("類似度スコア分布", fontsize=14)
    _colors = {"jaccard": "#4C72B0", "tfidf": "#DD8452", "bm25": "#55A868", "embed": "#C44E52"}

    for _ax, (_algo, _data) in zip(_axes.flatten(), results.items()):
        _vals = list(_data["sims"].values())
        if _vals:
            _ax.hist(_vals, bins=30, color=_colors[_algo], alpha=0.8, edgecolor="white")
            _ax.axvline(threshold, color="red", linestyle="--", linewidth=1.5, label=f"しきい値={threshold}")
            _ax.set_title(f"{_algo}  (n={len(_vals)} pairs)")
            _ax.set_xlabel("類似度スコア")
            _ax.set_ylabel("頻度")
            _ax.legend(fontsize=8)
        else:
            _ax.text(0.5, 0.5, "データなし", ha="center", va="center", transform=_ax.transAxes)
            _ax.set_title(_algo)

    _fig.tight_layout()
    mo.md("## 類似度スコア分布")
    mo.mpl.interactive(_fig)
    return


@app.cell
def _(mo, np, plt, results):
    # ── アルゴリズム間スコア相関 ─────────────────────────────────────────────
    _algos = list(results.keys())
    _pairs_all = list(results[_algos[0]]["sims"].keys())

    def _get_scores(algo):
        return np.array([results[algo]["sims"].get(p, results[algo]["sims"].get((p[1], p[0]), 0.0)) for p in _pairs_all])

    _scores = {a: _get_scores(a) for a in _algos}

    _fig2, _axes2 = plt.subplots(2, 3, figsize=(14, 9))
    _fig2.suptitle("アルゴリズム間スコア相関", fontsize=14)
    _pairs_combo = [
        ("jaccard", "tfidf"), ("jaccard", "bm25"), ("jaccard", "embed"),
        ("tfidf", "bm25"), ("tfidf", "embed"), ("bm25", "embed"),
    ]

    for _ax, (_a, _b) in zip(_axes2.flatten(), _pairs_combo):
        _x, _y = _scores[_a], _scores[_b]
        if len(_x) > 0 and _y.sum() > 0:
            _corr = np.corrcoef(_x, _y)[0, 1]
            _ax.scatter(_x, _y, alpha=0.3, s=10)
            _ax.set_xlabel(_a)
            _ax.set_ylabel(_b)
            _ax.set_title(f"{_a} vs {_b}  (r={_corr:.3f})")
        else:
            _ax.set_title(f"{_a} vs {_b}  (データなし)")

    _fig2.tight_layout()
    mo.md("## アルゴリズム間スコア相関")
    mo.mpl.interactive(_fig2)
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## アルゴリズム特性まとめ

    | アルゴリズム | 速度 | 日本語対応 | 意味的深さ | 備考 |
    |-------------|------|-----------|-----------|------|
    | `jaccard`   | ★★★★★ | ★★★★ | ★★ | 最速。キーワードの単純な集合重複。同じ語が登場するかどうかだけを見る |
    | `tfidf`     | ★★★★  | ★★★★ | ★★★ | 稀少語を重視。文書内頻度と文書間頻度の比から重み付け |
    | `bm25`      | ★★★★  | ★★★★ | ★★★ | TF-IDFの改良版。文書長の違いを補正するため短文・長文が混在する場合に有利 |
    | `embed`     | ★★    | ★★★★★ | ★★★★★ | 文の意味を多次元ベクトルで表現。類義語・言い換えも捉えられる。初回実行時にモデルダウンロードが必要 |

    ## 選択ガイド

    **`jaccard` を選ぶ場合:**
    - データ量が非常に多く、速度が最優先
    - 文書が専門用語主体で、同じ語が繰り返し使われる

    **`tfidf` / `bm25` を選ぶ場合:**
    - 速度と精度のバランスが必要
    - `bm25` は文書の長さにばらつきがある場合に推奨

    **`embed` を選ぶ場合 (デフォルト・推奨):**
    - 精度を最優先にしたい
    - 言い換えや同義語が多い日本語文書
    - 初回実行後は埋め込みがキャッシュされるため、2回目以降の速度差は小さい

    ## 実行コマンド

    ```bash
    uv run preprocess.py --algo jaccard   # キーワード集合重複
    uv run preprocess.py --algo tfidf     # TF-IDFコサイン
    uv run preprocess.py --algo bm25      # BM25コサイン
    uv run preprocess.py --algo embed     # 文埋め込み (デフォルト)
    ```
    """)
    return


if __name__ == "__main__":
    app.run()
