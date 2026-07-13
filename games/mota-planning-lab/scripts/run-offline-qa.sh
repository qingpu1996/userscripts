#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
REPO_DIR=$(CDPATH= cd -- "$PROJECT_DIR/../.." && pwd)
PYTHON_BIN=${MOTA_LAB_PYTHON:-python3}
EXTRA_PYTHONPATH=${MOTA_LAB_PYTHONPATH:-}
TEST_PYTHONPATH="$PROJECT_DIR/service:$PROJECT_DIR/tests/python"
if [[ -n "$EXTRA_PYTHONPATH" ]]; then
  TEST_PYTHONPATH="$TEST_PYTHONPATH:$EXTRA_PYTHONPATH"
fi

cd "$REPO_DIR"

node "$PROJECT_DIR/scripts/validate-fixtures.mjs"
node --test "$PROJECT_DIR"/tests/js/*.test.js

PYTHONPATH="$TEST_PYTHONPATH" "$PYTHON_BIN" -m unittest discover \
  -s "$PROJECT_DIR/tests/python" -p 'test_*.py' -v

PYTHONPATH="$TEST_PYTHONPATH" "$PYTHON_BIN" "$PROJECT_DIR/scripts/validate_protocol.py"

MOTA_LAB_PYTHON="$PYTHON_BIN" \
MOTA_LAB_PYTHONPATH="$EXTRA_PYTHONPATH" \
node --test "$PROJECT_DIR"/tests/integration/*.test.js

PYTHONPATH="$PROJECT_DIR/service:$EXTRA_PYTHONPATH" \
  "$PYTHON_BIN" -m compileall -q "$PROJECT_DIR/service/mota_lab"

for source in "$PROJECT_DIR"/src/*.js; do
  node --check "$source"
done

node scripts/build-userscript.js mota-planning-lab
node --check dist/mota-planning-lab.user.js
node "$PROJECT_DIR/scripts/build-direct-mount.mjs"
node --check dist/mota-planning-lab.direct-mount.js
FIRST_USERSCRIPT_HASH=$(shasum -a 256 dist/mota-planning-lab.user.js | awk '{print $1}')
FIRST_DIRECT_HASH=$(shasum -a 256 dist/mota-planning-lab.direct-mount.js | awk '{print $1}')
node scripts/build-userscript.js mota-planning-lab >/dev/null
node "$PROJECT_DIR/scripts/build-direct-mount.mjs" >/dev/null
test "$FIRST_USERSCRIPT_HASH" = "$(shasum -a 256 dist/mota-planning-lab.user.js | awk '{print $1}')"
test "$FIRST_DIRECT_HASH" = "$(shasum -a 256 dist/mota-planning-lab.direct-mount.js | awk '{print $1}')"
node "$PROJECT_DIR/scripts/static-compliance.mjs"
node "$PROJECT_DIR/scripts/validate-docs.mjs"
git diff --check

TEMP_GIT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mota-lab-git.XXXXXX")
TEMP_INDEX="$TEMP_GIT_DIR/index"
TEMP_OBJECTS="$TEMP_GIT_DIR/objects"
REAL_OBJECTS=$(CDPATH= cd -- "$(git rev-parse --git-common-dir)/objects" && pwd)
mkdir -p "$TEMP_OBJECTS"
trap 'rm -rf "$TEMP_GIT_DIR"' EXIT
GIT_INDEX_FILE="$TEMP_INDEX" \
GIT_OBJECT_DIRECTORY="$TEMP_OBJECTS" \
GIT_ALTERNATE_OBJECT_DIRECTORIES="$REAL_OBJECTS" \
  git read-tree HEAD
GIT_INDEX_FILE="$TEMP_INDEX" \
GIT_OBJECT_DIRECTORY="$TEMP_OBJECTS" \
GIT_ALTERNATE_OBJECT_DIRECTORIES="$REAL_OBJECTS" \
  git add -- \
  games/mota-planning-lab dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
GIT_INDEX_FILE="$TEMP_INDEX" \
GIT_OBJECT_DIRECTORY="$TEMP_OBJECTS" \
GIT_ALTERNATE_OBJECT_DIRECTORIES="$REAL_OBJECTS" \
  git diff --cached --check

echo "Mota Planning Lab offline QA: PASS"
