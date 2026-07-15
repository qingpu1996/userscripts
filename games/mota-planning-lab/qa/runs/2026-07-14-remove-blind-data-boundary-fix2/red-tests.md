# Fix 2 红灯证据

在修改前直接载入 Fix 1 分析器，扫描本轮 20 个相邻反例。只有既有 dynamic object read 与两种 destructuring 路径命中，17 个案例漏报；验收点名的下列五例均为空 violation：

```text
array spread copy                         MISS
array pop return                          MISS
array splice return                       MISS
rest function returns spread array        MISS
detached [].splice + call                 MISS
```

其余漏报覆盖 `for...of`、array iterator、`Reflect.apply` 及 alias、`Object.values/entries` 及 alias、`Map` constructor/get、`Map.set/get`、`Set` constructor/loop、`Set.add/values` 等 carrier。完整初始输出为 3/20 命中、17/20 漏报。

同一 Fix 1 分析器上的重复 DAG：

```text
depth 18   440.4 ms
depth 20  1795.8 ms
depth 22  7325.2 ms
```

曲线呈指数增长，且没有明确的分析预算 violation。
