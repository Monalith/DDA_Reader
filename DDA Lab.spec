# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules

hiddenimports = ['multipart', 'pypdfium2']
hiddenimports += collect_submodules('uvicorn')
# The full OCP solver runs in THIS app on the user's computer (never on the
# server): bundle the ocp package and CasADi (+ its bundled IPOPT).
hiddenimports += ['ocp', 'ocp.job_queue', 'ocp.ocp_motorcycle']
casadi_datas, casadi_binaries, casadi_hidden = collect_all('casadi')
hiddenimports += casadi_hidden


a = Analysis(
    ['dda_lab_bridge.py'],
    pathex=['.'],
    binaries=casadi_binaries,
    datas=[('viewer_lab', 'viewer_lab'), ('dda_lab_bridge_prompt.txt', '.')] + casadi_datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='DDA Lab',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
