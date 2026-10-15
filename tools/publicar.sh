#!/bin/bash
# Pasa lo que está en prueba (rama dev) al sitio oficial (rama main → GitHub Pages).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Hay cambios sin commitear en dev"; exit 1; }
git checkout -q dev && git pull -q --rebase origin dev 2>/dev/null || true
git checkout -q main && git pull -q --rebase origin main
git merge -q --no-edit dev
python3 tools/stamp.py
git add -A && (git diff --cached --quiet || git commit -qm "stamp")
git push -q origin main
git checkout -q dev && git merge -q --no-edit main && git push -q origin dev
gh workflow run seo.yml >/dev/null 2>&1 || true  # regenera las páginas para Google con el código nuevo
echo "Publicado en https://quieromisfotos.com.ar (tarda 1-2 min)"
