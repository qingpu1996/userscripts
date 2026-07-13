# 实际命令与结果

工作目录均为：

```text
/Users/nihplod/.codex/worktrees/mota-planning-lab-v0.1.0
```

## 一键全量 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：exit 0，末行 `Mota Planning Lab offline QA: PASS`。

该命令实际执行：

```bash
node games/mota-planning-lab/scripts/validate-fixtures.mjs
node --test games/mota-planning-lab/tests/js/*.test.js
PYTHONPATH=... /opt/homebrew/bin/python3.12 -m unittest discover \
  -s games/mota-planning-lab/tests/python -p 'test_*.py' -v
PYTHONPATH=... /opt/homebrew/bin/python3.12 \
  games/mota-planning-lab/scripts/validate_protocol.py
MOTA_LAB_PYTHON=... MOTA_LAB_PYTHONPATH=... \
  node --test games/mota-planning-lab/tests/integration/*.test.js
/opt/homebrew/bin/python3.12 -m compileall -q games/mota-planning-lab/service/mota_lab
node --check games/mota-planning-lab/src/*.js
node scripts/build-userscript.js mota-planning-lab
node --check dist/mota-planning-lab.user.js
node games/mota-planning-lab/scripts/static-compliance.mjs
git diff --check
```

逐项结果：

| 检查 | 结果 |
| --- | --- |
| fixture/schema provenance | PASS，7 JSON files |
| JS `node:test` | 49 pass / 0 fail |
| Python unittest | 44 pass / 0 fail |
| shared wire protocol models | PASS，1 observation + 3 responses |
| localhost integration | 1 pass / 0 fail |
| Python compileall | PASS |
| JS source syntax | PASS，17 files |
| userscript build | PASS |
| generated userscript syntax | PASS |
| static blind-play compliance | PASS，17 source files + generated userscript |
| `git diff --check` | PASS |

## 生成物校验

```bash
shasum -a 256 dist/mota-planning-lab.user.js
wc -l -c dist/mota-planning-lab.user.js
```

结果：

```text
26e1db0edd71c856b0679172f7b564ac36266818eafb9271293e8bfe3c7c640c  dist/mota-planning-lab.user.js
2330 88206 dist/mota-planning-lab.user.js
```
