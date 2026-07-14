# Fix 8 实际 production tree 注入审计

`scripts/test-production-engine-api-injection.mjs` 备份实际 `src/engine-adapter.js` 与两个已构建 dist，向实际 adapter 末尾临时注入：

```javascript
runtime.unknownAction.call(runtime);
runtime[dynamicMethod].apply(runtime, []);
const f=runtime[dynamicMethod]; f();
```

注入后实际运行两套构建，再运行完整 `scripts/production-integrity-audit.mjs` CLI。audit 非零退出，精确产生一项 `unknownAction` 与三项 `DYNAMIC_ENGINE_API` 失败。无论断言是否成功，`finally` 都恢复实际 adapter 并重建双 dist；恢复后的两个制品与注入前备份逐字节一致。恢复后完整 production audit 再次为 `pass`。

实际 inventory 保持：

- read：`canMoveDirectly`、`getDamage`、`getEnemyInfo`、`getMapBlocksObj`、`isMoving`；
- action：`moveDirectly`、`setAutomaticRoute`、`stopAutomaticRoute`；
- unknown/dynamic：0；
- production discovery：`19 browser + 16 service + 2 dist`，manifest 19 项精确一致。

该测试只操作当前 worktree 的源码与生成制品，未打开页面、未接触真实运行态、存档、state/knowledge 或端口 18724。
