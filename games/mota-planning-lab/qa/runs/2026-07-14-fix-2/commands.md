# fix-2 实际命令与结果

工作目录：

```text
/Users/nihplod/.codex/worktrees/mota-planning-lab-v0.1.0
```

## 旧实现 targeted 复现

```bash
node --test games/mota-planning-lab/tests/js/journal-client-controller.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  /opt/homebrew/bin/python3.12 -m unittest \
  games/mota-planning-lab/tests/python/test_models_api.py \
  games/mota-planning-lab/tests/python/test_storage_recovery_cli.py -v
```

旧实现结果：JS exit 0，21/21；Python exit 1，36 tests / 30 pass / 5 fail / 1 error。具体红灯与 [`summary.md`](summary.md) 的六项逐一对应。

## 修复后 targeted

使用同一命令，外加必填可空模型审计和 SQLite sequence 碰撞/重启用例。最终结果：JS 21/21，Python 38/38，均 exit 0。

## 一键全量 QA

```bash
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

结果：exit 0，末行 `Mota Planning Lab offline QA: PASS`。实际覆盖 fixtures、56 项 JS、55 项 Python、1 项 localhost + fake-core integration、Pydantic/JSON Schema shared protocol、compileall、全部 JS syntax、userscript 构建/语法、静态盲玩扫描和 `git diff --check`。

## 生成物与补充检查

```bash
wc -l -c dist/mota-planning-lab.user.js
shasum -a 256 dist/mota-planning-lab.user.js
node scripts/build-userscript.js mota-planning-lab
node --check dist/mota-planning-lab.user.js
node games/mota-planning-lab/scripts/static-compliance.mjs
```

结果：

```text
2657 101229 dist/mota-planning-lab.user.js
c0b48cf3394114dd773500ff663b9d7046db77e3d081a138e66cbc76b8cd79ac
```

另用只读 Node 检查器逐个解析 Markdown 本地相对链接和全部 JSON；用 `rg` 检查行尾空白，并执行 `git diff --check`。二次构建哈希不变，全部 PASS。

解释器：Node `v24.16.0`，Python `3.12.13`。
