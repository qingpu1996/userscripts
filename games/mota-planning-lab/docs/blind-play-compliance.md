# 严格盲玩合规说明

## 合规结论

v0.1.0 的浏览器运行代码以 `engine-adapter.js` 为唯一 H5 引擎访问点；网络层只能序列化白名单 observation 并发往固定 localhost。决策服务不包含《魔塔24层》地图、攻略、标准路线或隐藏知识，只能根据收到的当前层观察及以前合法收到的观察建立模型。

本轮 QA 完全离线，使用 fake core 与明确标记为 synthetic 的 fixtures。没有访问真实游戏页面、真实运行态或存档，因此本文不声称已经验证真实引擎版本兼容性。

## 允许读取

| 数据 | 限制 |
| --- | --- |
| 当前 `floorId` | 每次先读取，作为唯一允许的 map 键 |
| hero | 只复制生命、攻防、金币、经验、位置、方向、三色钥匙 |
| 当前动态 map | 只读取 `maps[currentFloorId]` 的尺寸/当前显示信息，不展开 maps |
| 当前 blocks | 只用当前 floorId 调用动态 block 查询，并过滤 disable |
| 当前可见怪物 | 只按当前 observation 中的怪物坐标查敌人信息和 damage |
| 稳定性 | 只读移动、控制锁和“是否存在活动事件”的布尔结果，不发送事件内容 |

## 永久禁止

- `core.floors`、任意未到达楼层、非 current floor 的 `status.maps`。
- `floors.min.js`、游戏工程地图源码、完整初始地图或全量素材对象。
- 存档原文以及存档中尚未到达楼层的信息。
- 针对《魔塔24层》的攻略、路线、录像、地图或其他针对性资料。
- screenshot、Canvas 图像提取、OCR 或图像识别输入。
- 递归或通用序列化完整 `core`、`status`、`maps` 或页面对象。
- 直接赋值 hero、block、enemy、event 或 `core.status`。
- 鼠标逐格模拟、键盘伪造或私有写入兜底。

## 代码边界

1. `src/engine-adapter.js` 是唯一允许拿到页面 core 的文件。
2. adapter 逐字段创建普通对象，不把 core、status、hero 原对象或 map 原对象传给其他模块。
3. observer 再次白名单复制网络字段；采集期异常只保留安全标量证据和完整当前层 observation，通信层不接受任意 payload。
4. engine 行动只开放 capability-probed `moveDirectly`、`setAutomaticRoute`、`stopAutomaticRoute`。
5. save/load 默认完全禁用；slot 8 永久保护。v0.1.0 自动循环不调用真实 `doSL`。
6. 服务 models 使用 `extra=forbid`；SQLite 和 JSONL 只写合法 observation 摘要、fingerprint、决定及幂等账本。

## 网络数据流

```text
当前页面 core
  -> engine-adapter 显式字段复制
  -> observer 当前 11x11 observation
  -> protocol 再白名单复制
  -> GM_xmlhttpRequest
  -> http://127.0.0.1:18724/cycle
```

没有其他远端 URL。userscript metadata 不包含 `rawBaseUrl`、`updateURL` 或 `downloadURL`，不会自动发布或更新。

## 执行完整性

- guard 在行动前重新采集并逐字段精确比较。
- 纯空走廊同时要求当前观察路径证明与 `canMoveDirectly` 明确允许。
- 门、怪物、资源、楼梯、NPC 和机关是状态变化边界，每轮最多处理一个。
- 服务与浏览器双重要求边界具有可验证非位置 postcondition；怪物/门/资源必须声明目标 block 移除，楼梯必须声明 floor 变化。
- 行动后等待移动、控制锁和事件全部结束，fingerprint 改变后连续两次一致。
- expected_delta 不符时停止，不用宽松容差掩盖未知机制。
- action_id 先入持久 journal，再调用游戏接口；刷新和丢包不会触发盲目重放。

## 自动化证明

自动化检查包括：

- 源码与生成 userscript 的静态禁区扫描。
- Proxy fake core：未白名单属性、其他 map 键和素材访问会立即抛错。
- poisoned maps/material 值不进入 observation/request 的测试。
- guard mismatch 零行动调用、direct/route 分流、单边界停止测试。
- action_id 重复、刷新、丢包、服务重启和 ambiguous recovery 测试。
- completed 后返回同 fingerprint 的持久 A→B→C action_id 重签、碰撞跳过与 cache 行数测试。
- `null/???/NaN` 采集暂停的完整观察证据、空边界差分、仅位移 post-state 和旧 journal 恢复测试。
- 响应的必填可空 `trigger/floor`、action_id、registry version 以及根/registry/operation/guard/expected_delta 额外字段拒绝测试；真实 FastAPI JSON 同时过 Pydantic、checked-in JSON Schema 与浏览器 parser。
- metadata、固定 localhost 地址、八类 pause 枚举、slot 8 保护检查。

具体命令和结果记录在 [`qa/`](../qa/README.md)。真实页面只读核对与用户授权后的分级行动仍保持未完成。
