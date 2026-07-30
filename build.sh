#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Pages build:
#   Assemble dist-site/ from the category site assets (site/) and the built apps.
#   Public URLs:
#     - app:   <origin>/simple-ledger/   <origin>/template-memo/
#     - about: <origin>/about/simple-ledger/   <origin>/about/template-memo/

if [ "${SKIP_NPM_CI:-0}" != "1" ]; then
  npm ci
fi

npm run build --workspace simple-ledger
npm run build --workspace template-memo

rm -rf dist-site
mkdir -p dist-site/simple-ledger dist-site/about/simple-ledger
mkdir -p dist-site/template-memo dist-site/about/template-memo

# Category top page + shared assets.
cp site/index.html site/shared.css site/site-links.js dist-site/

# App about pages -> /about/<app>/.
cp site/about/simple-ledger/index.html dist-site/about/simple-ledger/index.html
cp site/about/template-memo/index.html dist-site/about/template-memo/index.html

# Built PWAs -> /<app>/.
cp -R apps/simple-ledger/dist/. dist-site/simple-ledger/
cp -R apps/template-memo/dist/. dist-site/template-memo/

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
