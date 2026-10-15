#!/bin/bash
# Publica el estado ACTUAL del repo (sin commitear incluso) en https://prueba.quieromisfotos.com.ar
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tools/stamp.py
rm -rf .prueba-dist && mkdir .prueba-dist
rsync -a --exclude '.*' --exclude worker --exclude staging --exclude tests --exclude tools --exclude node_modules \
  --exclude README.md --exclude CNAME --exclude 'firebase.json' --exclude 'firestore.*' ./ .prueba-dist/
# Que Google no indexe el sitio de prueba.
printf 'User-agent: *\nDisallow: /\n' > .prueba-dist/robots.txt
printf '/*\n  X-Robots-Tag: noindex\n' > .prueba-dist/_headers
cd staging && npx wrangler deploy
