#!/usr/bin/env python3
"""Document Network Viewer — FastAPI backend.

Usage:
    uv run app.py

Serves the web UI at http://localhost:8000
Requires data/index.json to exist (run preprocess.py first).
"""

import json
import urllib.parse
from pathlib import Path

import frontmatter
import markdown as md
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

DATA_DIR = Path("data")
INDEX_FILE = DATA_DIR / "index.json"
STATIC_DIR = Path("static")

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


# Serve static files (must be after API routes)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
