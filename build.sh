#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Pages build:
#   Assemble dist-site/ from the category site assets (site/) and the built app.
#   Public URLs:
#     - app:   <origin>/simple-ledger/
#     - about: <origin>/about/simple-ledger/

if [ "${SKIP_NPM_CI:-0}" != "1" ]; then
  npm ci
fi

npm run build --workspace simple-ledger

rm -rf dist-site
mkdir -p dist-site/simple-ledger dist-site/about/simple-ledger

# Category top page + shared assets.
cp site/index.html site/shared.css site/site-links.js dist-site/

# App about page -> /about/simple-ledger/.
cp site/about/simple-ledger/index.html dist-site/about/simple-ledger/index.html

# Built PWA -> /simple-ledger/.
cp -R apps/simple-ledger/dist/. dist-site/simple-ledger/

# Backward-compat: redirect the old /simple-ledger-about.html URL to the new path.
cat > dist-site/simple-ledger-about.html <<'EOF'
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=/about/simple-ledger/" />
    <link rel="canonical" href="/about/simple-ledger/" />
    <title>ページが移動しました — snishi-code</title>
  </head>
  <body>
    <p>このページは <a href="/about/simple-ledger/">/about/simple-ledger/</a> に移動しました。</p>
  </body>
</html>
EOF

echo "Build complete (personal): dist-site/"
