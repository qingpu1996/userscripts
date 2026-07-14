# Fix 8 红灯复现

在修改 production audit 前新增点名回归并运行：

```bash
node --test games/mota-planning-lab/tests/js/production-integrity-audit.test.js
```

首次结果：`10 tests / 9 pass / 1 fail`。相邻已知 `runtime.getDamage.call(...)`、静态 bracket `apply`、direct/alias `bind` 均未进入 inventory，测试首先在 read inventory 断言处失败。

对三个点名片段逐项调用 `auditEngineAdapter()` 的原始结果均为 `failures: []`：

```javascript
runtime.unknownAction.call(runtime);
runtime[dynamicMethod].apply(runtime, []);
const f=runtime[dynamicMethod]; f();
```

对照 `runtime.unknownAction.bind(runtime)()` 在原实现中能产生 `UNCLASSIFIED_ENGINE_API`，证明漏报来自 `call/apply` 只识别 Identifier member alias，以及动态 member 未进入 alias/inventory。
