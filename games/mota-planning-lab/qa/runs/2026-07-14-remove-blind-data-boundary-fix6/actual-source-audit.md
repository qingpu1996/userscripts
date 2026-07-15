# 实际 production source 审计清单

- 范围：19 个 `src/*.js`、16 个 `service/mota_lab/*.py`、userscript 与 direct-mount 两个 dist。
- page core 入口：只允许 `src/engine-adapter.js`。
- 读取 API：`canMoveDirectly`、`getDamage`、`getEnemyInfo`、`getMapBlocksObj`、`isMoving`。
- 行动 API：`moveDirectly`、`setAutomaticRoute`、`stopAutomaticRoute`。
- 已审查权威 alias：`core`、`runtime`、`hero`、`loc`、`maps`、`currentMap`、`dynamicGrid`、`declaredValidCells`、`eventState`、`info`。
- 结果：实际源码无权威对象 assignment/update/delete、Object/Reflect mutation 或容器原地 mutation；无未分类 engine API 调用。
- 动态核对：full-cycle 的 collector/client/service/初始化阶段权威写入数为 0；所有 hero/block 差分均记录在模拟 `moveDirectly` 或 `setAutomaticRoute` API 动态作用域。

执行命令：

```bash
node games/mota-planning-lab/scripts/production-integrity-audit.mjs
```

该审计针对实际项目生产源码，不声称分析任意 JavaScript 程序。
