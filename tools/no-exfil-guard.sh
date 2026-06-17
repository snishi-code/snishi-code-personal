#!/usr/bin/env bash
# tools/no-exfil-guard.sh
# snishi-code.com 全リポ共通の「外部送信ゼロ」機械ガード。
#
# 正本は apex リポ (snishi-code.com)。本ファイルはそのコピーに
# snishi-foundation 向けの拡張を加えた派生版(拡張内容は下記 [EXT])。
# apex 正本への upstream 提案は docs/questions.md 参照(人間判断)。
#
# 方針: ユーザーデータの外部送信は **絶対禁止・例外なし(サイト全体)**。
#   (1) 送信系 API は、該当行に  // network-ok: <理由>  の明示注釈が無ければ違反。
#       （正規の同一オリジン通信 = service worker のキャッシュ取得などはこれで承認する）
#   (2) 自ドメイン以外のリソース読込(外部CDN・トラッキング画像等)は例外なく違反。
#
# [EXT-1] 対象拡張: *.ts / *.tsx / *.jsx を追加 (React + TypeScript 構成のため)。
# [EXT-2] ビルド成果物スキャン: apps/*/dist が存在すれば追加スキャンする。
#         minify でコメント(network-ok 注釈)が失われるため、dist では
#         「コメント承認」方式が成立しない。よって dist は
#           (a) sendBeacon / WebSocket / EventSource (正規依存 react/zod/jsqr が
#               使わないプリミティブ) をハードフェイル
#           (b) 外部リソース読込(http(s):// の src/href/url())をハードフェイル
#         とし、fetch/XHR の実行時防壁は CSP connect-src 'self' が担う
#         (docs/security.md 参照)。
set -uo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root" || exit 2

# 対象 = git 管理下の「配信されるクライアントコード」のみ。
# test / tooling / ビルド前生成物 / 自分自身(tools/) は除外し、誤検知をゼロにする。
files=$(git ls-files -- '*.html' '*.js' '*.mjs' '*.css' '*.ts' '*.tsx' '*.jsx' \
  | grep -vE '(^|/)(node_modules|tools)/' \
  | grep -vE '\.claude/worktrees/' \
  | grep -vE '(^|/)(test|tests|e2e)/' \
  | grep -vE '(\.|-)(test|spec)\.' \
  | grep -vE 'playwright' \
  | grep -vE '(^|/)test-setup\.' || true)

fail=0

check_net_with_comments() {
  # $1 = 改行区切りファイルリスト。network-ok コメント承認方式。
  local list="$1"
  [ -z "$list" ] && return 0
  local net
  net=$(printf '%s\n' "$list" | tr '\n' '\0' | xargs -0 grep -nEH \
    '(^|[^A-Za-z0-9_])(fetch|XMLHttpRequest|WebSocket|EventSource)[[:space:]]*\(|(^|[^A-Za-z0-9_])sendBeacon[[:space:]]*\(' \
    2>/dev/null || true)
  if [ -n "$net" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in
        *network-ok:*) ;;                       # 明示承認済み → 許可
        *) printf '  X [送信系API] %s\n' "$line"; fail=1 ;;
      esac
    done <<EOF
$net
EOF
  fi
}

check_external_resources() {
  # $1 = 改行区切りファイルリスト。外部リソース読込は無条件違反(自ドメインのみ許可)。
  local list="$1"
  [ -z "$list" ] && return 0
  local res
  res=$(printf '%s\n' "$list" | tr '\n' '\0' | xargs -0 grep -nEiH \
    '<(script|link|img|iframe|source|audio|video)[^>]+(src|href)[[:space:]]*=[[:space:]]*["'\'']https?://|@import[[:space:]]+["'\'']?https?://|url\([[:space:]]*["'\'']?https?://' \
    2>/dev/null || true)
  if [ -n "$res" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in
        *snishi-code.com*) ;;                   # 自ドメインのみ許可
        *) printf '  X [外部リソース読込] %s\n' "$line"; fail=1 ;;
      esac
    done <<EOF
$res
EOF
  fi
}

check_dist_primitives() {
  # [EXT-2](a): dist では sendBeacon / new WebSocket / EventSource をハードフェイル。
  local list="$1"
  [ -z "$list" ] && return 0
  local hit
  hit=$(printf '%s\n' "$list" | tr '\n' '\0' | xargs -0 grep -nEH \
    '(^|[^A-Za-z0-9_])sendBeacon[[:space:]]*\(|new[[:space:]]+WebSocket[[:space:]]*\(|new[[:space:]]+EventSource[[:space:]]*\(' \
    2>/dev/null || true)
  if [ -n "$hit" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      printf '  X [dist 送信プリミティブ] %s\n' "$line"; fail=1
    done <<EOF
$hit
EOF
  fi
}

# ---- ソーススキャン(git 管理ファイル) ----
if [ -z "$files" ]; then
  echo "no-exfil-guard: ソース対象ファイルなし"
else
  check_net_with_comments "$files"
  check_external_resources "$files"
fi

# ---- [EXT-2] ビルド成果物スキャン(存在する場合のみ) ----
dist_files=""
for d in apps/*/dist packages/*/dist; do
  [ -d "$d" ] || continue
  found=$(find "$d" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.html' -o -name '*.css' \) 2>/dev/null || true)
  [ -n "$found" ] && dist_files="${dist_files}${found}
"
done
if [ -n "$dist_files" ]; then
  check_dist_primitives "$dist_files"
  check_external_resources "$dist_files"
  echo "no-exfil-guard: dist スキャン実施 ($(printf '%s' "$dist_files" | grep -c . ) files)"
fi

if [ "$fail" -ne 0 ]; then
  cat <<'MSG'

----------------------------------------------------------------
 no-exfil-guard: 外部送信/外部読込の疑いを検出しました。
 snishi-code.com は「ユーザーデータの外部送信を絶対禁止」(全リポ共通)。

  - 正規の同一オリジン通信(例: service worker のキャッシュ取得)は、
    該当行に  // network-ok: <理由>  を付けて明示承認してください。
  - 外部CDN/トラッキング等のリソース読込は不可(バンドルに含める)。
----------------------------------------------------------------
MSG
  exit 1
fi

echo "OK no-exfil-guard: clean (送信系・外部読込なし)"
exit 0
