#!/usr/bin/env bash
set -euo pipefail

if [[ -x "./venv/bin/python" ]]; then
  ./venv/bin/python -m pytest
else
  python3 -m pytest
fi
