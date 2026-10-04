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

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

BASE_DIR = Path(__file__).resolve().parent
SCHEMA_DIR = BASE_DIR / "tracks" / "schemas"
PROMPT_PATH = BASE_DIR / "dda_lab_bridge_prompt.txt"

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


# Serve the built DDA Lab web app (ES modules need http://, not file://).
LAB_DIR = BASE_DIR / "viewer_lab"
if LAB_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/lab", StaticFiles(directory=str(LAB_DIR), html=True), name="lab")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8777)
