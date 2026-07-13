# 魔塔规划实验室运行态代理

面向 `https://h5mota.com/games/24/` 的本地盲玩执行层。Tampermonkey 代理只读取当前已到达楼层的动态运行态，本机 Python 服务只依据合法 observation 和历史 observation 规划一个原子边界；浏览器执行前核对 guard，执行后等待稳定并校验真实 expected_delta。

## 当前状态

v0.1.0 已完成离线实现、构建和 fake-core 自动化 QA。首次独立只读验收的 2 个 P1、1 个 P2、第二轮复验的 3 个 P1，以及第三轮复验唯一的 state dir 文档 P2 均已修复，当前通过 112 项离线回归：

- 可安装生成物：仓库根 `dist/mota-planning-lab.user.js`
- 浏览器侧当前层采集、执行、幂等恢复、面板与菜单
- FastAPI/Pydantic localhost 服务、SQLite ledger、JSONL 日志、知识标签和有限深度规划
- machine-readable protocol schemas、synthetic fixtures、JS/Python/integration/静态合规测试
- 必填可空字段的 field-aware wire/knowledge 序列化，以及 Pydantic、JSON Schema、浏览器三侧一致性测试
- SQLite 持久 issuance sequence：pending 重试保持同一 action_id，completed 后重返同一现场签发全新 action_id
- 安装、协议、合规、暂停、状态机、标签和 QA 文档

当前等待第三轮文档修复后的全新独立只读 SubAgent 复验，复验通过前不可交付或进入版本控制收尾。尚未访问真实游戏页面，未验证真实 H5 引擎 API 签名、事件时序或悬浮面板位置，也未执行真实移动、读档或存档。首次真实页面只读核对和分级现场 QA 仍需用户另行授权；项目不会自动安装、自动发布或自动覆盖存档。

> **状态恢复警告：** `MOTA_LAB_STATE_DIR` 不是可删除的 cache；它保存 action_id 身份与幂等恢复链。正常重启、升级和重新连接必须复用同一绝对路径和完整目录；有 pending 行动或现场未确认时，禁止删除、清空、迁移或改指空目录，也禁止用“清除待执行行动”绕过。详见[状态目录持久化、迁移与故障恢复](docs/install-and-run.md#21-状态目录不是缓存)。

## 安全边界

- 只读当前 `floorId`、hero 白名单、`maps[currentFloorId]`、当前动态 blocks 和当前可见怪物信息/damage。
- 不读 floor catalogue、其他 maps、全量素材、地图源码、未访问楼层或针对性攻略。
- 不使用 screenshot、Canvas 图像、OCR 或图像识别。
- 网络只向 `http://127.0.0.1:18724/cycle` 发送当前层最小 observation。
- 不直接写 hero、地图、怪物、事件或运行态；行动只走 capability-probed 引擎公开接口。
- 门、资源、怪物、楼梯、NPC 和机关每次最多一个状态变化边界。
- 同一 action_id 永不执行两次；刷新、超时和丢包按 pre / expected post / ambiguous 恢复。
- save/load 默认禁用，slot 8 永久保护。

完整说明见 [严格盲玩合规](docs/blind-play-compliance.md)。

## 架构

```text
H5 当前页面
  -> engine-adapter 唯一白名单运行时入口
  -> 当前 11x11 observation
  -> GM_xmlhttpRequest /cycle
  -> localhost FastAPI 决策器
  -> guard + registry + expected_delta 原子行动
  -> 引擎公开接口
  -> 两次稳定 fingerprint + 真实差分
  -> completed_action_id 回报
```

服务 bundled knowledge 初始为空，不包含真实 4F 地图、block 或路线。首次到达的 floor/block 只会生成当前层 pause evidence，由用户通过本地 CLI 打标；普通已知路径、零伤怪、门、资源和跨层返回之后由服务自动比较。

## 快速开始

详细步骤见 [安装与启动](docs/install-and-run.md)。最小命令如下：

```bash
cd games/mota-planning-lab
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r service/requirements.lock
PYTHONPATH=service python -m mota_lab serve
```

另开终端，在仓库根目录构建：

```bash
node scripts/build-userscript.js mota-planning-lab
node --check dist/mota-planning-lab.user.js
```

然后由用户手动导入 Tampermonkey。首次加载只核对 4F、`x=8,y=3`、HP/ATK/DEF `208/23/21`、Gold/EXP `16/63` 和钥匙 `4/1/0`；一致后仍保持停止，必须从菜单手动启动。

## UI 与菜单

折叠面板停靠页面右侧，显示自动驾驶状态、action_id、楼层/坐标、最近决定、localhost 状态和 pause_kind。

油猴菜单：

- 启动自动驾驶
- 暂停自动驾驶
- 导出当前层运行态
- 清除待执行行动
- 仅重新连接本地决策器

清 pending 只改 GM journal，不改游戏现场，也不会修复服务 ledger。只要行动尚未 completed/acknowledged、浏览器仍有 pending journal 或现场状态未确认，就绝对不得清 pending；必须先按[状态机恢复流程](docs/state-machine.md)完成核对。重新连接不会执行返回行动。

## 测试

安装依赖后，从仓库根执行：

```bash
MOTA_LAB_PYTHON="$PWD/games/mota-planning-lab/.venv/bin/python" \
  bash games/mota-planning-lab/scripts/run-offline-qa.sh
```

该流程运行 fixtures、浏览器单元测试、Python 服务测试、真实 localhost + fake-core 集成、compile/syntax、userscript 构建、静态禁区扫描和 `git diff --check`。本轮结果与未覆盖范围见 [QA 证据](qa/README.md)。

## 目录

```text
src/                 Tampermonkey 浏览器侧模块
service/mota_lab/    FastAPI 决策服务
service/data/        空的 bundled floor/block 知识
protocol/            Protocol 1 JSON schemas
tests/js/            浏览器和 fake-core 测试
tests/python/        服务、规划、ledger 与 CLI 测试
tests/integration/   localhost 全闭环 synthetic 测试
tests/fixtures/      用户 baseline 与明确 synthetic 数据
docs/                协议、合规、安装、状态机、打标和 QA
qa/                  实际验证证据
scripts/             离线 QA 与静态检查
```

## 文档

- [Protocol 1](docs/protocol.md)
- [严格盲玩合规](docs/blind-play-compliance.md)
- [暂停分类](docs/pause-taxonomy.md)
- [控制状态机与恢复](docs/state-machine.md)
- [安装与启动](docs/install-and-run.md)
- [人工打标](docs/manual-labeling.md)
- [QA Runbook](docs/qa-runbook.md)
- [实施任务与验收矩阵](TASK.md)
