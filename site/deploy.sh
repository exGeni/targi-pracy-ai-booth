#!/usr/bin/env bash
# deploy.sh SUBDIR [TARGET] — publish one built subdirectory of site/code/dist to
# public_html/TARGET (default: SUBDIR) on MochaHost over cPanel UAPI. Only that directory is
# written; the rest of public_html is left alone. When it holds an api.php, the script then
# waits until $SITE_URL/TARGET/api.php reports the new file's revision (the host's OPcache
# serves the old file for a while).
#
#   with-envars.sh MOCHAHOST_CPANEL_URL MOCHAHOST_CPANEL_USER MOCHAHOST_CPANEL_API_TOKEN -- \
#     site/deploy.sh targi-pracy/orlen
set -euo pipefail
sub=${1:?usage: deploy.sh SUBDIR [TARGET]}
target=${2:-$sub}
here=$(cd "$(dirname "$0")" && pwd)
src="$here/code/dist/$sub"
(cd "$here/code" && node build.js >/dev/null)
[ -d "$src" ] || { echo "deploy: no $src" >&2; exit 1; }

hdr="Authorization: cpanel ${MOCHAHOST_CPANEL_USER}:${MOCHAHOST_CPANEL_API_TOKEN}"
base="${MOCHAHOST_CPANEL_URL%/}"
site="${SITE_URL:-https://exgenius.pro}"
ok() { python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if $1 else 1)"; }

# Create public_html/<target> one level at a time (API2 Fileman::mkdir; an existing dir is fine).
path=public_html
IFS=/ read -ra parts <<<"$target"
for p in "${parts[@]}"; do
  curl -sS -m 60 -G -H @<(echo "$hdr") "$base/json-api/cpanel" \
    --data-urlencode cpanel_jsonapi_user="$MOCHAHOST_CPANEL_USER" --data-urlencode cpanel_jsonapi_apiversion=2 \
    --data-urlencode cpanel_jsonapi_module=Fileman --data-urlencode cpanel_jsonapi_func=mkdir \
    --data-urlencode path="$path" --data-urlencode name="$p" >/dev/null
  path="$path/$p"
done
# mkdir answers the same for "created" and "exists"; listing the directory is the real check.
curl -sS -m 60 -G -H @<(echo "$hdr") "$base/execute/Fileman/list_files" --data-urlencode dir="$path" \
  | ok 'd.get("status")' || { echo "deploy: cannot create $path" >&2; exit 1; }

# api.php goes last, so a page and styles that match it are already in place when it switches.
files=()
for f in "$src"/*; do
  [ -f "$f" ] || { echo "deploy: $(basename "$f") is not a file; subdirectories are not deployed" >&2; exit 1; }
  [ "$(basename "$f")" = api.php ] || files+=("$f")
done
[ -f "$src/api.php" ] && files+=("$src/api.php")
for f in "${files[@]}"; do
  resp=$(curl -sS -m 120 -H @<(echo "$hdr") -F dir="$path" -F overwrite=1 -F file-1=@"$f" "$base/execute/Fileman/upload_files")
  echo "$resp" | ok 'd.get("status") and d["data"]["succeeded"]==1' \
    || { echo "deploy: upload failed: $(basename "$f")" >&2; exit 1; }
  echo "deploy: $path/$(basename "$f")"
done

if [ -f "$src/api.php" ]; then
  rev=$(md5sum "$src/api.php" | cut -c1-12)
  for _ in $(seq 1 "${SMOKE_TRIES:-30}"); do
    curl -sS -m 20 "$site/$target/api.php?a=status&id=0000000000000000" 2>/dev/null | ok "d.get('rev')=='$rev'" \
      && { echo "deploy: $site/$target/api.php serves revision $rev"; exit 0; }
    sleep 2
  done
  echo "deploy: $site/$target/api.php does not serve revision $rev" >&2
  exit 1
fi
