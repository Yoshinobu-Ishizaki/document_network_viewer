#!/usr/bin/env python3
"""Document Network Viewer — FastAPI backend.

Usage:
    uv run app.py

Serves the web UI at http://localhost:8000
Requires data/index.json to exist (run preprocess.py first).
"""

import json
import os
import re
import signal
import subprocess
import threading
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Any

import frontmatter
import markdown as md
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path("data")
INDEX_FILE = DATA_DIR / "index.json"
TEXT_CACHE_DIR = DATA_DIR / ".text_cache"
STATIC_DIR = Path("static")
SETTINGS_FILE = Path("settings.json")

DEFAULT_SETTINGS: dict = {"colorMode": "auto", "lightColors": {}, "darkColors": {}}

app = FastAPI(title="Document Network Viewer")



@app.get("/api/graph")
def get_graph() -> JSONResponse:
    if not INDEX_FILE.exists():
        raise HTTPException(
            status_code=503,
            detail="data/index.json not found. Run preprocess.py first.",
        )
    with open(INDEX_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return JSONResponse(data)


@app.get("/api/doc/{filename:path}")
def get_doc(filename: str) -> JSONResponse:
    filename = urllib.parse.unquote(filename)
    path = DATA_DIR / filename

    # Prevent path traversal
    try:
        path.resolve().relative_to(DATA_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid filename.")

    if not path.exists():
        raise HTTPException(status_code=404, detail="Document not found.")

    suffix = path.suffix.lower()

    if suffix == ".md":
        post = frontmatter.load(str(path))
        html = md.markdown(
            post.content,
            extensions=["tables", "fenced_code", "nl2br"],
        )
        return JSONResponse({"type": "markdown", "title": path.stem, "html": html})

    elif suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(path))
            text = ""
            for page in reader.pages:
                text += page.extract_text() or ""
            html = "<pre>" + text.replace("<", "&lt;").replace(">", "&gt;") + "</pre>"
        except Exception as e:
            html = f"<p>Could not extract PDF text: {e}</p>"
        return JSONResponse({"type": "pdf", "title": path.stem, "html": html})

    raise HTTPException(status_code=400, detail="Unsupported file type.")


class RenameRequest(BaseModel):
    l1: str
    old_l2: str
    new_l2: str


class MergeRequest(BaseModel):
    l1: str
    source_l2: str
    target_l2: str


class MoveDocRequest(BaseModel):
    filename: str
    old_l1: str
    old_l2: str
    new_l1: str
    new_l2: str
    create_new_l2: bool = False


def load_index() -> dict[str, Any]:
    if not INDEX_FILE.exists():
        raise HTTPException(status_code=503, detail="data/index.json not found. Run preprocess.py first.")
    with open(INDEX_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_index(data: dict[str, Any]) -> None:
    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@app.get("/api/search")
def search_docs(q: str = Query(..., min_length=1)) -> JSONResponse:
    """Grep for keyword in .md files and .text_cache/ txt files. Returns matches with snippets."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Empty query.")

    matches: list[dict] = []
    seen_files: set[str] = set()

    _grep_env = {**os.environ, "LC_ALL": "C.UTF-8", "LANG": "C.UTF-8"}

    def _grep_file(path: Path, original_filename: str) -> str | None:
        """Return first matching line snippet, or None if no match."""
        try:
            result = subprocess.run(
                ["grep", "-im", "1", "--", q, str(path)],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                env=_grep_env,
            )
            if result.returncode == 0:
                return result.stdout.strip()[:200]
        except Exception:
            pass
        return None

    # Search .md files directly
    for md_file in DATA_DIR.glob("*.md"):
        if md_file.name in seen_files:
            continue
        snippet = _grep_file(md_file, md_file.name)
        if snippet is not None:
            matches.append({"filename": md_file.name, "snippet": snippet})
            seen_files.add(md_file.name)

    # Search text cache (covers PDFs and .md duplicates)
    if TEXT_CACHE_DIR.exists():
        for txt_file in TEXT_CACHE_DIR.glob("*.txt"):
            original = txt_file.name[:-4]  # strip ".txt"
            if original in seen_files:
                continue
            snippet = _grep_file(txt_file, original)
            if snippet is not None:
                matches.append({"filename": original, "snippet": snippet})
                seen_files.add(original)

    return JSONResponse({"query": q, "matches": matches})


@app.post("/api/quit")
def quit_server() -> JSONResponse:
    os.killpg(os.getpgid(os.getpid()), signal.SIGTERM)
    return JSONResponse({"status": "shutting down"})


@app.patch("/api/subcategory")
def rename_subcategory(req: RenameRequest) -> JSONResponse:
    new_l2 = req.new_l2.strip()
    if not new_l2:
        raise HTTPException(status_code=400, detail="New name cannot be empty.")

    data = load_index()

    found = False
    for node in data["nodes"]:
        if node.get("level") == 2 and node.get("l1") == req.l1 and node.get("label") == req.old_l2:
            node["label"] = new_l2
            node["id"] = f"l2:{req.l1}:{new_l2}"
            found = True
        # Update doc nodes that belonged to old L2
        elif node.get("level") == 3 and node.get("l1") == req.l1 and node.get("l2") == req.old_l2:
            node["l2"] = new_l2

    if not found:
        raise HTTPException(status_code=404, detail=f"Subcategory '{req.old_l2}' not found in '{req.l1}'.")

    # Update edges pointing to/from old L2 node id
    old_id = f"l2:{req.l1}:{req.old_l2}"
    new_id = f"l2:{req.l1}:{new_l2}"
    for edge in data["edges"]:
        if edge["from"] == old_id:
            edge["from"] = new_id
        if edge["to"] == old_id:
            edge["to"] = new_id

    save_index(data)
    return JSONResponse({"status": "ok"})


@app.post("/api/subcategory/merge")
def merge_subcategory(req: MergeRequest) -> JSONResponse:
    if req.source_l2 == req.target_l2:
        raise HTTPException(status_code=400, detail="Source and target must be different.")

    data = load_index()
    source_id = f"l2:{req.l1}:{req.source_l2}"
    target_id = f"l2:{req.l1}:{req.target_l2}"

    # Reassign doc nodes from source to target
    for node in data["nodes"]:
        if node.get("level") == 3 and node.get("l1") == req.l1 and node.get("l2") == req.source_l2:
            node["l2"] = req.target_l2

    # Re-wire edges: edges from source_id → keep target; remove edges to source_id from its L1 parent
    updated_edges = []
    for edge in data["edges"]:
        if edge["from"] == source_id:
            # doc edges: point to target instead
            edge["from"] = target_id
            # deduplicate by checking if target→doc edge already exists
            updated_edges.append(edge)
        elif edge["to"] == source_id:
            # edge from L1 to source L2 — drop it
            pass
        else:
            updated_edges.append(edge)
    data["edges"] = updated_edges

    # Remove the source L2 node
    data["nodes"] = [n for n in data["nodes"] if n.get("id") != source_id]

    save_index(data)
    return JSONResponse({"status": "ok"})


@app.post("/api/doc/move")
def move_doc(req: MoveDocRequest) -> JSONResponse:
    new_l2 = req.new_l2.strip()
    if not new_l2:
        raise HTTPException(status_code=400, detail="New subcategory name cannot be empty.")

    data = load_index()

    # Find the doc node
    doc_id = f"doc:{req.filename}"
    doc_node = next((n for n in data["nodes"] if n.get("id") == doc_id), None)
    if not doc_node:
        raise HTTPException(status_code=404, detail=f"Document '{req.filename}' not found.")

    old_l2_id = f"l2:{req.old_l1}:{req.old_l2}"
    new_l2_id = f"l2:{req.new_l1}:{new_l2}"

    # Ensure target L1 exists
    target_l1_id = f"l1:{req.new_l1}"
    if not any(n.get("id") == target_l1_id for n in data["nodes"]):
        raise HTTPException(status_code=404, detail=f"Category '{req.new_l1}' not found.")

    # Create new L2 if requested and not existing
    if req.create_new_l2 and not any(n.get("id") == new_l2_id for n in data["nodes"]):
        data["nodes"].append({
            "id": new_l2_id,
            "label": new_l2,
            "level": 2,
            "l1": req.new_l1,
            "ndocs": 0,
        })
        data["edges"].append({
            "from": target_l1_id,
            "to": new_l2_id,
            "dashes": True,
            "width": 1,
        })
    elif not any(n.get("id") == new_l2_id for n in data["nodes"]):
        raise HTTPException(status_code=404, detail=f"Subcategory '{new_l2}' not found in '{req.new_l1}'.")

    # Update the doc node
    doc_node["l1"] = req.new_l1
    doc_node["l2"] = new_l2

    # Remove old containment edge (old_l2 → doc), add new one (new_l2 → doc)
    data["edges"] = [
        e for e in data["edges"]
        if not (e.get("from") == old_l2_id and e.get("to") == doc_id)
    ]
    data["edges"].append({"from": new_l2_id, "to": doc_id, "dashes": True, "width": 1})

    # Recalculate ndocs for affected L2 and L1 nodes
    l2_counts: dict[str, int] = {}
    l1_counts: dict[str, int] = {}
    for n in data["nodes"]:
        if n.get("level") == 3:
            l2_key = f"l2:{n['l1']}:{n['l2']}"
            l2_counts[l2_key] = l2_counts.get(l2_key, 0) + 1
            l1_key = f"l1:{n['l1']}"
            l1_counts[l1_key] = l1_counts.get(l1_key, 0) + 1

    for n in data["nodes"]:
        if n.get("level") == 2:
            n["ndocs"] = l2_counts.get(n["id"], 0)
        elif n.get("level") == 1:
            n["ndocs"] = l1_counts.get(n["id"], 0)

    # Remove old L2 node if it now has no docs
    if l2_counts.get(old_l2_id, 0) == 0 and old_l2_id != new_l2_id:
        data["nodes"] = [n for n in data["nodes"] if n.get("id") != old_l2_id]
        data["edges"] = [
            e for e in data["edges"]
            if e.get("from") != old_l2_id and e.get("to") != old_l2_id
        ]

    save_index(data)
    return JSONResponse({"status": "ok"})


@app.get("/api/settings")
def get_settings() -> JSONResponse:
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        return JSONResponse({**DEFAULT_SETTINGS, **saved})
    return JSONResponse(DEFAULT_SETTINGS)


@app.post("/api/settings")
def save_settings(body: dict = Body(...)) -> JSONResponse:
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return JSONResponse({"status": "ok"})


# Serve static files (must be after API routes)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Document Network Viewer")
    parser.add_argument("--port", type=int, default=8001, help="Port to listen on (default: 8001)")
    args = parser.parse_args()

    # Skip auto-open when running via SSH (VS Code Remote-SSH port-forwarding
    # already opens a browser tab automatically).
    _in_ssh = bool(os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_CLIENT"))

    if not _in_ssh and not os.environ.get("_APP_BROWSER_OPENED"):
        os.environ["_APP_BROWSER_OPENED"] = "1"

        def _open_browser() -> None:
            import time
            time.sleep(1.0)  # wait for server to bind
            webbrowser.open(f"http://localhost:{args.port}")

        threading.Thread(target=_open_browser, daemon=True).start()

    uvicorn.run("app:app", host="127.0.0.1", port=args.port, reload=True)
