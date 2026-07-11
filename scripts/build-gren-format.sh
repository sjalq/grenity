#!/usr/bin/env bash
# Rebuild tools/gren-format/app from gilramir/gren-format and its local deps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${TMPDIR:-/tmp}/gren-format-build-$$"
PATH="$ROOT/node_modules/.bin:$PATH"
export PATH

rm -rf "$BUILD"
mkdir -p "$BUILD"
cd "$BUILD"

for r in gren-format gren-format-lib gren-argparse; do
  git clone --depth 1 "https://github.com/gilramir/$r.git"
done
git clone --depth 1 https://github.com/gilramir/gren-compiler-common.git compiler-common
git clone --depth 1 https://github.com/gilramir/gren-compiler-node.git compiler-node

python3 - <<'PY'
import json, pathlib
p = pathlib.Path("gren-format/gren.json")
d = json.loads(p.read_text())
d["gren-version"] = "0.6.6"
p.write_text(json.dumps(d, indent=4) + "\n")
PY

cd gren-format
gren make Main --output=app
mkdir -p "$ROOT/tools/gren-format"
cp app "$ROOT/tools/gren-format/app"
chmod +x "$ROOT/tools/gren-format/app"
echo "Wrote $ROOT/tools/gren-format/app"
rm -rf "$BUILD"
