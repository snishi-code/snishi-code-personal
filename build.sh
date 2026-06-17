#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Pages build:
#   Build source app from apps/simple-ledger and publish dist-site/.
#   Existing public URL remains <origin>/simple-ledger/.

if [ "${SKIP_NPM_CI:-0}" != "1" ]; then
  npm ci
fi

npm run build --workspace simple-ledger

rm -rf dist-site
mkdir -p dist-site/simple-ledger

for f in index.html simple-ledger-about.html shared.css site-links.js; do
  if [ -f "$f" ]; then
    cp "$f" dist-site/
  fi
done

cp -R apps/simple-ledger/dist/. dist-site/simple-ledger/

echo "Build complete (personal): dist-site/"
