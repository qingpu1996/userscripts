# 运行循环性能重构证据

## 目标与结果

- 真实页面旧基线：完整 observation 约 501 KB；journal 热路径约 2.14 s；纯 completed ACK 浏览器总耗时约 8.49 s，服务端结算约 3 ms。
- 27 层等价大模型 fixture 的新 journal：最大槽位 12,072 B，不包含 `engine_model` 或跨层 `floors`。
- 完整 QA 本轮性能采样：热态 `snapshot` p50 0.049 ms，prepared 21.786 ms，completed 15.594 ms。
- 普通循环把 completed ACK 与下一决策合并为同一个 `/cycle` 响应；稳态每个行动不再额外发送独立 ACK 请求，也没有 ACK 后 300 ms 等待。
- 长空走廊到单边界的调用序列由单次完整 `setAutomaticRoute(boundary)` 改为 `moveDirectly(approach)`、稳定确认、`setAutomaticRoute(boundary)`；相邻边界仍只有后者，direct 不可用时安全回退。

## 安全边界

journal 仍保留 A/B generation、precondition witness、底层双读回、候选 envelope 校验与刷新恢复。pending 的最小当前层投影足以执行 pre 相同、expected post、ambiguous 三态分类；完整游戏运行态仍由页面实时重建。guard、expected delta、非位置边界变化、稳定两轮与 action ledger 均未放松。

## 验证

```text
Node: 150 passed
Python: 119 passed
Integration: 1 passed
Protocol/schema: passed
Static/production audit: passed
Deterministic userscript/direct-mount build: passed
Docs/JSON: passed
```

完整命令：

```sh
MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
games/mota-planning-lab/scripts/run-offline-qa.sh
```
