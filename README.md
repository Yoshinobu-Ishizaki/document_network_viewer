# Document Network Viewer

ローカルで動作するPDF・Markdownドキュメントブラウザです。LLMによる自動分類とインタラクティブなネットワークグラフで、ドキュメントコレクションを視覚的に探索できます。

## 機能

- **グラフビュー**: ドキュメントを3階層のネットワークグラフで表示。L1カテゴリ間はサブカテゴリの共通トピック数、L2サブカテゴリ間はキーワード類似度でエッジを重み付け。
- **ドリルダウンナビゲーション**: グループノードをダブルクリックして子ノードを展開。ブレッドクラムで上位階層に戻れる。
- **ドキュメントビュー**: ドキュメントノードをクリックするとリサイズ可能なサイドパネルに内容を表示。
- **キーワード検索**: ヘッダーの検索バーで全ドキュメントのテキストをgrep検索し、該当ドキュメントに移動。
- **フィルタリング**: カテゴリ・ドキュメントの表示/非表示を事前定義の属性で制御。
- **サブカテゴリ管理**: L2ノードを右クリックしてサブカテゴリの名前変更や他サブカテゴリへのマージが可能。

## 前提条件

- Python 3.13 以上
- [uv](https://docs.astral.sh/uv/) (Pythonパッケージ管理ツール)

## セットアップ

### 1. リポジトリのクローン

```bash
git clone <repository-url>
cd document_network_viewer
```

### 2. ドキュメントの配置

`data/` フォルダにPDFまたはMarkdownファイルを配置します。

```
data/
├── document1.pdf
├── document2.md
└── ...
```

### 3. 環境設定

`.env.sample` をコピーして `.env` を作成し、使用するLLMプロバイダーのAPIキーを設定します。

```bash
cp .env.sample .env
```

## 使い方

### Step 1: .env の設定

`.env` ファイルを編集してLLMプロバイダーとAPIキーを設定します。

```env
LLM_PROVIDER=anthropic    # anthropic | openai | gemini | claude-code
ANTHROPIC_API_KEY=your_api_key_here
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

APIキーを持っていない場合、Claude Code（`claude` CLI）にログイン済みであれば `LLM_PROVIDER=claude-code` を設定することでAPIキーなしで利用できます。この場合、APIキーの設定は不要です。

### Step 2: 前処理の実行

ドキュメントをLLMで分類し、インデックスを生成します。

```bash
# 増分モード（新規ファイルのみ処理）
uv run preprocess.py

# フルリビルド（キャッシュから全再生成）
uv run preprocess.py --rebuild
```

増分モードでは既存の `index.json` があれば新規ファイルのみLLMに送信し、UIで行った名前変更・マージの編集を保持します。

セマンティック距離の計算アルゴリズムを選択するには `--algo` オプションを使用します。

```bash
uv run preprocess.py --algo tfidf    # TF-IDF（デフォルト: embed）
```

### Step 3: サーバーの起動

```bash
uv run app.py
```

ブラウザで `http://localhost:8001` を開くとアプリが利用できます。

## 設定

### config.yaml

L1カテゴリとサブカテゴリ制約を定義します。

```yaml
categories:
  - Jigs & Tools
  - Manufacturing
  - Programming
  - Meeting & Business Trip
  - Other Stuff

subcategory_constraints:
  max_subcategories: 8         # L1ごとのサブカテゴリ上限数
  min_docs_per_subcategory: 2  # これ未満のL2は最近傍にマージ
```

`subcategory_constraints` ブロックを削除すると制約が無効になります。

## LLMプロバイダーの設定

| プロバイダー | 環境変数 | 追加インストール |
|---|---|---|
| Anthropic (デフォルト) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | 不要 |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` | `uv add openai` |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL` | `uv add google-generativeai` |
| claude-code | `CLAUDE_CODE_MODEL`（省略可） | 不要（`claude` CLIへのログインが必要） |

`claude-code` プロバイダーは `claude` CLIにログイン済みのアカウントを使用するため、APIキーが不要です。`claude login` でログインしておく必要があります。

## グラフ操作

| 操作 | 動作 |
|---|---|
| ノードをダブルクリック | グループノードを展開（ドリルダウン） |
| ドキュメントノードをクリック | サイドパネルにドキュメントを表示 |
| L2ノードを右クリック | サブカテゴリの名前変更・マージメニュー |
| ブレッドクラムをクリック | 上位階層に戻る |
| 検索バーに入力 | 全文検索して該当ドキュメントへ移動 |

## ドキュメント

### セマンティック距離アルゴリズムの比較

前処理で使用するセマンティック距離アルゴリズムの詳細な比較・分析は以下のmarimoノートブックを参照してください。

- [`docs/semantic-distance-comparison.py`](docs/semantic-distance-comparison.py)

Jaccard類似度、TF-IDF、BM25、埋め込みベクトル（Embed）の4種類のアルゴリズムを比較しており、各アルゴリズムの特性や適切な使いどころを確認できます。

marimoがインストールされていれば以下のコマンドで開けます。

```bash
uv run marimo edit docs/semantic-distance-comparison.py
```

## プロジェクト構成

```
document_network_viewer/
├── app.py              # FastAPI バックエンド
├── preprocess.py       # 前処理CLI（LLM分類・インデックス生成）
├── config.yaml         # L1カテゴリ・サブカテゴリ制約設定
├── .env.sample         # LLMプロバイダー設定テンプレート
├── pyproject.toml
├── data/               # ドキュメント格納フォルダ（gitignored）
├── .local/             # ローカルファイル（gitignored）
│   ├── index.json      # preprocess.py が生成するインデックス
│   ├── .cache.json     # LLM結果キャッシュ
│   └── .text_cache/    # キーワード検索用テキストキャッシュ
├── docs/               # ドキュメント・分析ノートブック
│   └── semantic-distance-comparison.py
└── static/
    ├── index.html
    ├── main.js
    └── style.css
```
