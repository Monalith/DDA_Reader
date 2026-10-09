#!/usr/bin/env python3
"""DDA Lab local bridge.

A tiny FastAPI service bound to 127.0.0.1 that lets the DDA Lab web app ask the
locally installed Claude Code CLI to interpret an imported track schema image
(coach drawing). Everything stays on the machine: the uploaded image and the
model output are written under ``tracks/schemas/``.

Endpoints
    GET  /health          -> {"ok": true, "claude": <claude CLI available?>}
    POST /analyze-schema  -> multipart ``file`` (png/jpg/jpeg/pdf) -> SchemaResult

Run standalone:
    python dda_lab_bridge.py        # http://127.0.0.1:8777
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, File, Header, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

import os
import sys

FROZEN = bool(getattr(sys, "frozen", False))
# Bundled resources (viewer_lab, prompt) live next to this file, or inside the
# PyInstaller bundle when frozen. User data (schemas) must stay writable.
BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
DATA_DIR = Path(os.environ.get("DDA_LAB_HOME", Path.home() / "DDA_Lab")) if FROZEN else BASE_DIR
SCHEMA_DIR = DATA_DIR / "tracks" / "schemas"
PROMPT_PATH = BASE_DIR / "dda_lab_bridge_prompt.txt"

# Corridors are extracted once and then live here, so every visitor gets the
# same one instead of each browser re-downloading ~54 satellite tiles. On the
# deployed droplet this is /opt/dda-lab/corridors (DATA_DIR = BASE_DIR when the
# service is not a frozen bundle); deploy_lab.sh does not touch it.
CORRIDOR_DIR = DATA_DIR / "corridors"
# Reads are public; writes need this. Unset means the store is read-only, which
# is the right default for a host that should only ever serve what it has.
CORRIDOR_TOKEN = os.environ.get("DDA_CORRIDOR_TOKEN", "")
# The key is a caller-supplied path component on a public endpoint: allowlist it.
CORRIDOR_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# A 7 km circuit at 2 m spacing is ~3500 points; this is a generous ceiling.
CORRIDOR_MAX_POINTS = 20000
# A 20000-point corridor serialises to well under this; reject anything bigger
# before it reaches the JSON parser or the pydantic validator, so an
# unauthenticated caller (any third-party page, given allow_origins=["*"])
# cannot spend our CPU or bandwidth on an oversized body.
CORRIDOR_MAX_BODY_BYTES = 2 * 1024 * 1024

CLAUDE_TIMEOUT_S = 180
ALLOWED_IMAGE_EXT = {".png", ".jpg", ".jpeg"}
ALLOWED_EXT = ALLOWED_IMAGE_EXT | {".pdf"}

RETRY_SUFFIX = "\nYour previous output was not valid JSON. Return only the JSON object."

ALLOWED_ORIGINS = ["http://localhost:5190", "http://127.0.0.1:5190", "null"]


# --------------------------------------------------------------------------- #
# Result model                                                                #
# --------------------------------------------------------------------------- #

def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else float(v))


class Apex(BaseModel):
    turn: Optional[int] = None
    x: float
    y: float
    label: Optional[str] = None

    _clamp_xy = field_validator("x", "y")(lambda v: _clamp01(v))


class Marker(BaseModel):
    type: Literal["brake", "throttle", "note"]
    x: float
    y: float
    text: Optional[str] = None

    _clamp_xy = field_validator("x", "y")(lambda v: _clamp01(v))


class Point(BaseModel):
    x: float
    y: float

    _clamp_xy = field_validator("x", "y")(lambda v: _clamp01(v))


class TurnLabel(BaseModel):
    n: int
    x: float
    y: float

    _clamp_xy = field_validator("x", "y")(lambda v: _clamp01(v))


class SchemaResult(BaseModel):
    track_outline: list[tuple[float, float]] = Field(default_factory=list)
    racing_line: list[tuple[float, float]] = Field(default_factory=list)
    apexes: list[Apex] = Field(default_factory=list)
    markers: list[Marker] = Field(default_factory=list)
    start_finish: Optional[Point] = None
    turn_labels: list[TurnLabel] = Field(default_factory=list)

    @field_validator("track_outline", "racing_line")
    @classmethod
    def _clamp_polyline(cls, pts):
        return [(_clamp01(x), _clamp01(y)) for x, y in pts]


class CorridorPayload(BaseModel):
    version: int = Field(1, ge=1, le=1)
    trackId: str = Field(..., max_length=128)
    nPoints: int = Field(..., ge=2, le=CORRIDOR_MAX_POINTS)
    lengthM: float = Field(..., gt=0, le=100_000)
    firstPoint: tuple[float, float]
    stepM: float = Field(..., gt=0, le=1000)
    leftM: list[float]
    rightM: list[float]
    known: list[bool]

    @field_validator("leftM", "rightM", "known")
    @classmethod
    def _not_too_long(cls, v):
        if len(v) > CORRIDOR_MAX_POINTS:
            raise ValueError(f"at most {CORRIDOR_MAX_POINTS} points")
        return v

    @model_validator(mode="after")
    def _lengths_agree(self):
        n = self.nPoints
        if not (len(self.leftM) == len(self.rightM) == len(self.known) == n):
            raise ValueError("leftM, rightM and known must all have nPoints entries")
        return self


# --------------------------------------------------------------------------- #
# PDF rasterization (optional dependency)                                     #
# --------------------------------------------------------------------------- #

try:  # pragma: no cover - depends on local install
    import pypdfium2 as _pdfium

    def _render_pdf_first_page(pdf_path: Path, png_path: Path, scale: float = 2.0) -> None:
        """Render page 1 of ``pdf_path`` into ``png_path`` as PNG."""
        doc = _pdfium.PdfDocument(str(pdf_path))
        try:
            page = doc[0]
            page.render(scale=scale).to_pil().save(str(png_path))
        finally:
            doc.close()

except Exception:  # pragma: no cover - pypdfium2 missing
    _render_pdf_first_page = None  # type: ignore[assignment]


# --------------------------------------------------------------------------- #
# Claude invocation                                                           #
# --------------------------------------------------------------------------- #

class ClaudeUnavailable(RuntimeError):
    """The `claude` CLI is missing, failed, or timed out."""


def _strip_fences(text: str) -> str:
    """Remove ``` / ```json code fences and surrounding chatter."""
    t = (text or "").strip()
    fence = re.search(r"```(?:json|JSON)?\s*(.*?)```", t, re.DOTALL)
    if fence:
        t = fence.group(1).strip()
    else:
        t = re.sub(r"^```(?:json|JSON)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t).strip()
    return t


def _run_claude(prompt: str, cwd: Path) -> str:
    """Run ``claude -p`` and return the ``result`` text. Raises ClaudeUnavailable."""
    if shutil.which("claude") is None:
        raise ClaudeUnavailable("`claude` CLI not found on PATH")

    cmd = [
        "claude", "-p", prompt,
        "--output-format", "json",
        "--allowedTools", "Read",
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=CLAUDE_TIMEOUT_S,
            cwd=str(cwd),
        )
    except subprocess.TimeoutExpired:
        raise ClaudeUnavailable(f"`claude` timed out after {CLAUDE_TIMEOUT_S}s")
    except OSError as exc:
        raise ClaudeUnavailable(f"could not launch `claude`: {exc}")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:2000]
        raise ClaudeUnavailable(f"`claude` exited with {proc.returncode}: {detail}")

    stdout = proc.stdout or ""
    try:
        envelope = json.loads(stdout)
    except (ValueError, TypeError):
        # Not the documented JSON envelope: treat the raw stdout as the text.
        return stdout
    if isinstance(envelope, dict) and "result" in envelope:
        return envelope["result"] or ""
    return stdout


def _parse_schema_text(text: str) -> SchemaResult:
    """Strip fences, json.loads, validate. Raises ValueError on failure."""
    payload = json.loads(_strip_fences(text))
    if not isinstance(payload, dict):
        raise ValueError("model output was not a JSON object")
    return SchemaResult.model_validate(payload)


# --------------------------------------------------------------------------- #
# App                                                                         #
# --------------------------------------------------------------------------- #

app = FastAPI(title="DDA Lab bridge", version="1")

# Bound to 127.0.0.1 only, and `file://` pages send Origin: null, so a wildcard
# is acceptable here (ALLOWED_ORIGINS documents the intended callers).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "claude": shutil.which("claude") is not None}


@app.post("/analyze-schema")
async def analyze_schema(file: UploadFile = File(...)):
    name = Path(file.filename or "upload").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        return JSONResponse(
            status_code=415,
            content={
                "error": "unsupported_media_type",
                "detail": f"{ext or 'file'} not supported; use png/jpg/jpeg/pdf",
            },
        )
    if ext == ".pdf" and _render_pdf_first_page is None:
        return JSONResponse(
            status_code=415,
            content={
                "error": "unsupported_media_type",
                "detail": "PDF import needs pypdfium2 (pip install pypdfium2)",
            },
        )

    schema_dir = SCHEMA_DIR
    schema_dir.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="schema-", dir=str(schema_dir)))

    saved = work_dir / name
    saved.write_bytes(await file.read())

    if ext == ".pdf":
        png = work_dir / (Path(name).stem + ".png")
        try:
            _render_pdf_first_page(saved, png)
        except Exception as exc:
            return JSONResponse(
                status_code=415,
                content={"error": "unsupported_media_type",
                         "detail": f"could not rasterize PDF: {exc}"},
            )
        image_path = png
    else:
        image_path = saved

    base_prompt = PROMPT_PATH.read_text() + f"\nImage file: {image_path.resolve()}"

    last_error = ""
    for attempt in range(2):
        prompt = base_prompt if attempt == 0 else base_prompt + RETRY_SUFFIX
        try:
            text = _run_claude(prompt, cwd=schema_dir)
        except ClaudeUnavailable as exc:
            return JSONResponse(
                status_code=503,
                content={"error": "claude_unavailable", "detail": str(exc)},
            )
        try:
            result = _parse_schema_text(text)
        except Exception as exc:  # json error or pydantic ValidationError
            last_error = f"{type(exc).__name__}: {exc}"[:2000]
            continue
        (work_dir / "schema_result.json").write_text(
            json.dumps(result.model_dump(), indent=2)
        )
        return JSONResponse(status_code=200, content=result.model_dump())

    return JSONResponse(
        status_code=422,
        content={"error": "invalid_model_output", "detail": last_error},
    )


def _corridor_path(key: str) -> Optional[Path]:
    """Resolved path for `key`, or None when the key is not in the allowlist."""
    if not CORRIDOR_KEY_RE.match(key):
        return None
    path = (CORRIDOR_DIR / f"{key}.json").resolve()
    # belt and braces: the allowlist already forbids separators and dots
    if path.parent != CORRIDOR_DIR.resolve():
        return None
    return path


@app.get("/corridors/{key}")
def get_corridor(key: str):
    path = _corridor_path(key)
    if path is None:
        return JSONResponse(status_code=400, content={"error": "bad_key"})
    if not path.exists():
        return JSONResponse(status_code=404, content={"error": "not_found"})
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        # Corrupt file: a missing corridor is recoverable (the client just
        # re-extracts), a corrupt one left in place would 500 forever.
        path.unlink(missing_ok=True)
        return JSONResponse(status_code=404, content={"error": "not_found"})
    return JSONResponse(content=data)


@app.put("/corridors/{key}")
async def put_corridor(key: str, request: Request, x_corridor_token: str = Header("")):
    # Order matters: an unauthenticated caller must never reach the JSON
    # parser or the pydantic validator (previously FastAPI validated the body
    # during dependency injection, before this function even ran, letting
    # anyone drive CPU and a large error response with no token at all).
    if not CORRIDOR_TOKEN:
        return JSONResponse(
            status_code=503,
            content={"error": "read_only", "detail": "DDA_CORRIDOR_TOKEN is not set on this host"},
        )
    if x_corridor_token != CORRIDOR_TOKEN:
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    path = _corridor_path(key)
    if path is None:
        return JSONResponse(status_code=400, content={"error": "bad_key"})

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            too_big = int(content_length) > CORRIDOR_MAX_BODY_BYTES
        except ValueError:
            too_big = False
        if too_big:
            return JSONResponse(status_code=413, content={"error": "payload_too_large"})

    body = await request.body()
    if len(body) > CORRIDOR_MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"error": "payload_too_large"})
    try:
        payload = CorridorPayload.model_validate_json(body)
    except ValidationError:
        # Do not echo the caller's input back; a short reason is enough.
        return JSONResponse(status_code=422, content={"error": "invalid_payload"})

    CORRIDOR_DIR.mkdir(parents=True, exist_ok=True)
    # Write to a per-request temp file (not a deterministic sibling, so two
    # concurrent PUTs to the same key cannot interleave into one corrupt
    # file), then rename, so a reader never sees a half-written file.
    fd, tmp_name = tempfile.mkstemp(dir=CORRIDOR_DIR, suffix=".json.tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload.model_dump_json())
        os.replace(tmp, path)
    finally:
        # No-op once the rename above succeeded; cleans up the orphan on any
        # failure in between.
        tmp.unlink(missing_ok=True)
    return {"ok": True, "key": key, "nPoints": payload.nPoints}


# Serve the built DDA Lab web app (ES modules need http://, not file://).
LAB_DIR = BASE_DIR / "viewer_lab"
if LAB_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/lab", StaticFiles(directory=str(LAB_DIR), html=True), name="lab")


def main(argv=None):
    """Run the bridge. `--open` launches the browser, `--port N` overrides 8777."""
    import argparse
    import threading
    import webbrowser

    import uvicorn

    ap = argparse.ArgumentParser(description="DDA Lab local server + Claude bridge")
    ap.add_argument("--port", type=int, default=int(os.environ.get("DDA_LAB_PORT", "8777")))
    ap.add_argument("--open", action="store_true", help="open the app in the default browser")
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args(argv)
    url = f"http://{args.host}:{args.port}/lab/"
    print(f"DDA Lab: {url}  (Ctrl+C to stop)", flush=True)
    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
