# Protocol v2 首轮验收整改命令

## 测试先行

```sh
node --test games/mota-planning-lab/tests/js/runtime-v2.test.js
PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python \
  python3 -m unittest games/mota-planning-lab/tests/python/test_runtime_v2.py -v
```

修复前新增 JS 用例为 8 项、5 pass/3 fail，分别暴露 v1 baseline 绕过、ragged grid 被补矩形和同 floorId map-instance 换图协议缺口。Python 首次收集因尚无 `SchemaMigrationRequired` 与新协议 API 失败；实现后定向套件通过。

## 完整离线 QA

```sh
before=$(git ls-files -s | shasum -a 256 | awk '{print $1}')
bash games/mota-planning-lab/scripts/run-offline-qa.sh
after=$(git ls-files -s | shasum -a 256 | awk '{print $1}')
test "$before" = "$after"
```

`run-offline-qa.sh` 顺序执行 fixture/schema provenance、全部 JS、全部 Python、Protocol wire、localhost fake-core integration、compile/syntax、双构建确定性、静态盲玩扫描、文档/JSON、`git diff --check`，最后用临时 index、隔离 object directory 和真实 objects 只读 alternate 做 prospective staged diff check。

## 构建物与工作区

```sh
shasum -a 256 dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
wc -c -l dist/mota-planning-lab.user.js dist/mota-planning-lab.direct-mount.js
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
```

未运行任何真实游戏、浏览器注入、存档、移动、换图或外网命令。
