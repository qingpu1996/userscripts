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
node "$PROJECT_DIR/scripts/static-compliance.mjs"
git diff --check

echo "Mota Planning Lab offline QA: PASS"
