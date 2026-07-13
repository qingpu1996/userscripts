# fix-1 实际命令与结果

工作目录：

```text
/Users/nihplod/.codex/worktrees/mota-planning-lab-v0.1.0
```

## 旧实现针对性复现

```bash
node --test \
  games/mota-planning-lab/tests/js/observer-and-compliance.test.js \
  games/mota-planning-lab/tests/js/journal-client-controller.test.js \
  games/mota-planning-lab/tests/js/guard-delta-recovery.test.js
```

在修源码前的结果：exit 1，45 tests / 39 pass / 6 fail。失败项与 [`summary.md`](summary.md) 列出的六条首次验收复现一一对应。

Python 新增严格 response model 测试在旧实现上因 `mota_lab.models.ErrorResponse` 不存在而收集失败。

## 修复后一键全量 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：exit 0，末行 `Mota Planning Lab offline QA: PASS`。该命令实际覆盖：

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

## 生成物

```bash
wc -l -c dist/mota-planning-lab.user.js
shasum -a 256 dist/mota-planning-lab.user.js
```

结果：

```text
2657 101229 dist/mota-planning-lab.user.js
c0b48cf3394114dd773500ff663b9d7046db77e3d081a138e66cbc76b8cd79ac  dist/mota-planning-lab.user.js
```

## 补充文档与确定性检查

在全量 QA 后另行执行：

```bash
before=$(shasum -a 256 dist/mota-planning-lab.user.js | awk '{print $1}')
node scripts/build-userscript.js mota-planning-lab
after=$(shasum -a 256 dist/mota-planning-lab.user.js | awk '{print $1}')
test "$before" = "$after"
node --check dist/mota-planning-lab.user.js
node games/mota-planning-lab/scripts/static-compliance.mjs
if rg -n '[[:blank:]]+$' games/mota-planning-lab dist/mota-planning-lab.user.js; then exit 1; fi
git diff --check
```

另用只读 Node 检查器逐个解析 15 个 Markdown 文件的本地相对链接，并用 `JSON.parse` 重新解析项目全部 JSON。结果：二次构建哈希不变，Markdown links、全部 JSON、未跟踪文件行尾空白和 `git diff --check` 均 PASS。

解释器：Node `v24.16.0`，Python `3.12.13`。
