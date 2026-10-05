#!/usr/bin/env python3
"""
Package DDA Lab for another computer.

  python package_lab.py portable   -> dist/DDA_Lab_portable.zip
        viewer_lab/ + bridge + start scripts; needs Python 3.10+ on the target
        (the start script creates its own venv and installs fastapi/uvicorn).
  python package_lab.py app        -> dist/DDA Lab (macOS/Linux binary) or dist/DDA Lab.exe
        single-file PyInstaller build of the bridge with the web app inside;
        no Python needed on the target. Build on the target OS.
  python package_lab.py all        -> both

Run `npm run build` in dda_lab/ first (or pass --build to do it here).
"""
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
LAB = ROOT / "viewer_lab"

START_SH = """#!/bin/bash
# DDA Lab launcher (macOS / Linux). Creates a local venv on first run.
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then echo "Python 3.10+ is required: https://www.python.org/downloads/"; read -p "Press Enter"; exit 1; fi
if [ ! -x .venv/bin/python ]; then
  echo "[*] First run: creating virtual environment..."
  "$PY" -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r requirements-lab.txt
fi
exec .venv/bin/python dda_lab_bridge.py --open "$@"
"""

START_BAT = """@echo off
REM DDA Lab launcher (Windows). Creates a local venv on first run.
cd /d "%~dp0"
where python >nul 2>nul || (echo Python 3.10+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
if not exist .venv\\Scripts\\python.exe (
  echo [*] First run: creating virtual environment...
  python -m venv .venv && .venv\\Scripts\\python -m pip install -q --upgrade pip && .venv\\Scripts\\pip install -q -r requirements-lab.txt
)
.venv\\Scripts\\python dda_lab_bridge.py --open %*
"""

README = """# DDA Lab (portable)

Professional analysis workspace for Ducati DDA telemetry: charts on the left, satellite map
on the right, lap/turn/sector analysis, math channels, filters, Claude-assisted track schema
import.

## Run
* macOS / Linux: double-click `start_lab.command` (or `./start_lab.command` in a terminal)
* Windows: double-click `start_lab.bat`

The first start creates a `.venv` folder and installs the few Python packages it needs
(needs Python 3.10+ and internet once). Then it opens http://127.0.0.1:8777/lab/ in your
browser. Keep the terminal window open while you work; Ctrl+C stops it.

Options: `start_lab.command --port 9000` to use another port.

## Files
* `viewer_lab/` – the web app (static build)
* `dda_lab_bridge.py` – tiny local server; also calls the `claude` CLI for schema analysis
  (optional: if `claude` is not installed, schema import falls back to manual marking)
* `tracks/` – your saved track models and schema images (created on use)
* `docs/MATH_GUIDE.md` – math channel & filter guide (also inside the app: Math → Guide)

Open `.dda` files directly in the app (📂 Open sessions); DDA_Reader `.json`/`.csv` exports,
onboard-video telemetry JSON and `.lab.json` bundles also load.
"""


def run(cmd, **kw):
    print("[*]", " ".join(str(c) for c in cmd))
    subprocess.check_call(cmd, **kw)


def ensure_build():
    if not (LAB / "index.html").exists() or "--build" in sys.argv:
        run(["npm", "run", "build"], cwd=ROOT / "dda_lab")
    if not (LAB / "index.html").exists():
        sys.exit("viewer_lab/index.html missing: run `npm run build` in dda_lab/")


def portable():
    ensure_build()
    out = DIST / "DDA_Lab_portable"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copytree(LAB, out / "viewer_lab")
    for f in ("dda_lab_bridge.py", "dda_lab_bridge_prompt.txt"):
        shutil.copy(ROOT / f, out / f)
    (out / "docs").mkdir()
    shutil.copy(ROOT / "docs" / "MATH_GUIDE.md", out / "docs" / "MATH_GUIDE.md")
    (out / "requirements-lab.txt").write_text(
        "fastapi>=0.115\nuvicorn>=0.30\npython-multipart>=0.0.9\npydantic>=2\npypdfium2>=4\n"
    )
    (out / "start_lab.command").write_text(START_SH)
    os.chmod(out / "start_lab.command", 0o755)
    (out / "start_lab.sh").write_text(START_SH)
    os.chmod(out / "start_lab.sh", 0o755)
    (out / "start_lab.bat").write_text(START_BAT)
    (out / "README.md").write_text(README)
    zpath = DIST / "DDA_Lab_portable.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for p in out.rglob("*"):
            if p.is_file():
                info = zipfile.ZipInfo(str(p.relative_to(DIST)))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o755 if p.suffix in (".command", ".sh") else 0o644) << 16
                z.writestr(info, p.read_bytes())
    print(f"[+] {zpath} ({zpath.stat().st_size / 1e6:.1f} MB)")


def app():
    ensure_build()
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "pyinstaller"])
    sep = ";" if sys.platform.startswith("win") else ":"
    name = "DDA Lab"
    cmd = [
        sys.executable, "-m", "PyInstaller", f"--name={name}", "--onefile", "--clean", "--noconfirm",
        "--console",
        f"--add-data=viewer_lab{sep}viewer_lab",
        f"--add-data=dda_lab_bridge_prompt.txt{sep}.",
        "--collect-submodules=uvicorn", "--hidden-import=multipart",
        "--hidden-import=pypdfium2",
        "dda_lab_bridge.py",
    ]
    run(cmd, cwd=ROOT)
    exe = DIST / (f"{name}.exe" if sys.platform.startswith("win") else name)
    print(f"[+] {exe} ({exe.stat().st_size / 1e6:.1f} MB) — run it with --open")
    launcher = DIST / "DDA Lab.command"
    if sys.platform == "darwin":
        launcher.write_text('#!/bin/bash\ncd "$(dirname "$0")"\n./"DDA Lab" --open\n')
        os.chmod(launcher, 0o755)
        zpath = DIST / "DDA_Lab_macOS.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for p in (exe, launcher):
                info = zipfile.ZipInfo(p.name)
                info.external_attr = 0o755 << 16
                z.writestr(info, p.read_bytes())
        print(f"[+] {zpath}")


if __name__ == "__main__":
    what = next((a for a in sys.argv[1:] if not a.startswith("--")), "all")
    if what in ("portable", "all"):
        portable()
    if what in ("app", "all"):
        app()
