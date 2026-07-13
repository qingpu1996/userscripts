# QA Runbook

## 离线自动化

在已安装 `service/requirements.lock` 的 Python 3.11+ 项目环境中，从仓库根目录执行：

```bash
MOTA_LAB_PYTHON="$PWD/games/mota-planning-lab/.venv/bin/python" \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

该脚本依次验证：

1. baseline/synthetic fixtures 的来源标记与 protocol JSON 可解析性；
2. Node `node:test` 浏览器侧单元测试；
3. Python `unittest` 兼容测试（同一批 `TestCase` 也可由 pytest 收集）；
4. shared synthetic wire fixtures 同时通过 Python service models、无第三方依赖的 checked-in JSON Schema validator 和浏览器 validator；
5. 真正启动 `127.0.0.1:18724` 的 fake-core 集成测试；
6. Python compileall 与每个 JS 源文件的 `node --check`；
7. 使用仓库构建器生成 `dist/mota-planning-lab.user.js`；
8. 生成产物语法检查和静态盲玩禁区扫描；
9. `git diff --check`。

如果希望显式使用 pytest：

```bash
cd games/mota-planning-lab
PYTHONPATH=service:tests/python .venv/bin/python -m pytest tests/python -q
```

## 自动化故障注入矩阵

| 范围 | 覆盖 |
| --- | --- |
| observation | 当前 hero/keys/floor/坐标、disable 过滤、可见怪物调用、11×11、非法方向/身份、采集期未知战损的完整 pause observation |
| blind-play | Proxy poison、唯一 core 入口、其他 maps/material 毒值、wire 最小字段、静态扫描 |
| guard/executor | 任一 guard mismatch 零调用、纯走廊 direct、单边界 route、多边界拒绝、状态变化即停 |
| stability/delta | moving/lock/event、fingerprint 两次稳定、资源/怪物/block/floor 差分、边界非位置 postcondition、不符暂停 |
| idempotency | pending/completed 去重、pre/post/ambiguous 三分法、旧空 delta 边界不误 completed、response loss、service restart、replacement chain、completed 后同 fingerprint 的 A→B→C 重签 |
| localhost | header、media type、body limit、rate limit、500/超时/非法 JSON/重复 callback、四种 status 严格字段、必填可空 `trigger/floor`、Pydantic/JSON Schema/浏览器三侧 wire 矩阵 |
| service | strict Pydantic、field-aware knowledge/wire serialization、observation store、SQLite issuance sequence/ledger/cache、碰撞与重启、JSONL 摘要、graph/search/dominance |
| integration | unknown floor evidence → synthetic labels → corridor direct → resource boundary → enemy boundary → report idle |

## QA 证据规则

- 记录实际命令、解释器版本、测试计数、退出码和构建产物校验。
- 自动化运行目录写入 `qa/runs/<date>-offline/`；不得把 `/tmp` 数据冒充真实页面证据。
- 测试地图必须明确 `synthetic=true`；用户 4F baseline fixture 不得包含猜测的 floorId 或 blocks。
- 自动化 QA 不使用 screenshot、OCR 或 Canvas。
- 真实页面 QA 必须单独标记为 `not-run`、`pass` 或 `fail`，不能由 fake core 代替。

## T73：首次真实页面只读核对（本轮未执行）

只有用户明确授权后才能进行：

1. 确保 userscript 初始 journal 为空，服务是否运行均不会触发行动。
2. 打开目标页，确认面板为 `STOPPED`。
3. 导出当前层 observation，核对 4F、`x=8,y=3`、HP/ATK/DEF `208/23/21`、Gold/EXP `16/63`、钥匙 `4/1/0`。
4. 确认行动 API、save/load 调用数为零，slot 8 未读取。
5. 确认导出只有当前 11×11 动态 blocks，无其他 floor/maps/material。
6. 保存白名单 observation 摘要与结构化控制台日志；不把截图作为输入。

任一字段不符就停在 `INITIAL_BASELINE_MISMATCH`，不得继续。

## T74：用户授权后的分级现场验证（本轮未执行）

必须按以下顺序逐项授权、逐项复位和检查录像/触发器一致性：

1. 纯空走廊 `moveDirectly`；
2. 单个已知资源；
3. 单扇已知门；
4. 单个 damage 已知怪物；
5. 一次楼层切换；
6. 刷新、服务重启和响应丢失恢复。

每项只允许一个状态变化边界。真实 API 签名或稳定判断不兼容时归入 `ENGINE_API_INCOMPATIBLE`，不得私有写入兜底。
