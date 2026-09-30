#!/bin/bash
# Ducati DDA Reader launcher (venv: ../dda_venv, Python 3.11)
cd "$(dirname "$0")"
exec ../dda_venv/bin/python dda_converter_gui.py "$@"
