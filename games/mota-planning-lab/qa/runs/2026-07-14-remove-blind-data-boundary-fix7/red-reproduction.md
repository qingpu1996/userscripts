# Fix 7 红灯复现

在修改 production audit 与 fake-core instrumentation 前，先加入以下回归：

- `const engine=runtime; engine.unknownAction()`；
- `scope.core.unknownAction()`、`globalThis.core.unknownAction()` 与动态 engine method；
- engine method 的对象解构、member alias、`bind/call/apply`；
- `src` 嵌套 production module 未进入 manifest；
- `core/status/maps/hero/current map/blocks/enemy` 根和子容器的 `set/delete/defineProperty`。

首次运行 `node --test games/mota-planning-lab/tests/js/production-integrity-audit.test.js`：

```text
tests 7
pass 2
fail 5
```

关键失败：

- engine alias 样例返回 `failures: []`、inventory 为空；
- `discoverProductionSources is not a function`；
- root `core` 写入只抛通用 `runtime write`，没有统一写入证据，maps/status 的 delete/define 路径未覆盖。

修复后同文件扩展为 9 项，包含 full production-tree 的临时 actual-adapter 注入，`9/9` 通过；完整 QA 为 `251/251`。
