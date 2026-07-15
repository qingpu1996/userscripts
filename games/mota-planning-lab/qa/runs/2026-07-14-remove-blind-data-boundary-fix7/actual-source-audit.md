# Fix 7 实际 production source 审计

## 发现范围

- 递归 `src/**/*.js`：19 个；
- 递归 `service/mota_lab/**/*.py`：16 个；
- userscript manifest：19 个，与递归 browser source 集合精确相等；
- dist：userscript 与 direct-mount 两个；
- `tests/**`、`qa/**` 不在 production discovery root 内，不会误纳。

回归会临时创建 `src/.audit-recursive-fixture/nested.js`；discovery 能发现它并因未进入 manifest 而失败，测试结束后删除。

## Engine API inventory

实际 `src/engine-adapter.js` inventory：

- read：`canMoveDirectly`、`getDamage`、`getEnemyInfo`、`getMapBlocksObj`、`isMoving`；
- action：`moveDirectly`、`setAutomaticRoute`、`stopAutomaticRoute`；
- 未分类 engine API：0；
- direct authoritative mutation：0。

受控 alias 支持集覆盖 `runtime/core` 简单 alias、`scope.core/globalThis.core/window.core/unsafeWindow.core`、静态 member alias、对象解构、邻近 `bind/call/apply`。未知或动态 method 报 `UNCLASSIFIED_ENGINE_API`，不会静默离开 inventory。

测试还把 `const engine=runtime; engine.unknownAction()` 与 `scope.core.unknownAction()` 临时追加到 actual adapter source，再走完整 `auditProductionTree()`；两项都产生 `UNCLASSIFIED_ENGINE_API`，production status 为 `fail`。

## 动态写入归因

fake-core 对 `core/status/maps/hero/current map/blocks/enemy` 及其数组/对象子容器统一代理。非行动作用域的 `set/delete/defineProperty` 每次都写入 `illegalWrites` 后抛错；读取 API 的 callback 不能开启 action scope。

完整 cycle 在 collector、client/service 往返和初始化阶段均为零权威写入。执行后的每条 `authoritativeWrites` 都带非空 `api`、具体 `path` 与 `operation`，且只归属于模拟 `moveDirectly` 或 `setAutomaticRoute` 的内部回调。

本审计是 controlled-project-source audit，不是任意 JavaScript 的形式化 sandbox。
