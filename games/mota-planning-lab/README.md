# 魔塔自动驾驶 Planning Lab

这是运行在 `h5mota.com` 页面与本机 `127.0.0.1:18724` 决策服务之间的实验性自动驾驶系统。游戏运行时 observation（地图、角色、怪物、资源和菜单）是每轮规划的唯一权威。

> **禁止用于真实存档自动驾驶。** 当前 planner 只是有限预算、人工权重的滚动启发式基线。真实运行已经证明它会做出错误的开门和资源决策，并可能把存档推进到无法继续的状态。在全局可行路线求解器完成并通过独立验收前，本项目只允许离线测试和受控合成现场研究。

## 当前运行契约

- 页面和服务的运行状态只存在于各自当前进程内存中。
- 服务或页面重新实例化后建立 fresh session，重新采集实时 observation；不会恢复、补发或重放旧 action。
- 同一进程内仍执行 single-flight、唯一 action identity、guard、稳定采样、expected delta 和 ACK，防止当前运行中重复执行。
- 不读取或写入浏览器 storage、运行目录、数据库文件、sidecar、manifest、后台日志或暂停证据。
- `--state-dir` 与 `--knowledge-dir` 仅为命令行兼容参数，`serve` 明确忽略它们。
- 规划规则只从随代码发布的 `service/data/` 在启动时只读载入一次；缺失或非法时启动失败，不回退到用户目录。
- “导出”是用户主动下载当前诊断快照，不是后台持久化或恢复机制。

## 启动

```bash
cd games/mota-planning-lab/service
python -m mota_lab serve --allow-direct-mount-origin https://h5mota.com
```

然后加载 `dist/mota-planning-lab.user.js`，或在受控测试中注入 `dist/mota-planning-lab.direct-mount.js`。面板不会自动确认基线或启动行动。

## 安全边界

每个动作都绑定当前 observation 的 guard 和 expected delta。执行期间 guard 不符、采样不稳定、结果差分不符、未知交互或协议错误会暂停。受支持商店通过绑定 choice identity 的 `menu_choice` 执行，并在当前进程内保持 at-most-once。

这些机制只验证“动作按预期执行”，不验证“决策在战略上正确”。当前 planner 在有限 planning budget 内，以人工资源权重对局部和跨图 frontier 打分，每轮只执行滚动计划的第一步；它不搜索到通关终局，不证明开门后的全局可行性，也不保证全局最优或安全通关。地图数据完整不等于状态转移和终局约束已经被完整求解。

静态游戏数据可以用于理解规则和地图定义，但不会读取攻略、标准路线或录像，也不会直接改英雄、地图或存档。

## 验证

```bash
cd games/mota-planning-lab
./scripts/run-offline-qa.sh
```

测试覆盖动态地图解压、实时 observation、有限预算 world search、同进程 single-flight/ACK/guard/delta、商店 at-most-once、fresh restart、hostile 旧目录零访问、协议与双构建确定性。测试通过只证明这些工程契约，没有证明 planner 的战略正确性。

详细契约见 [状态机](docs/state-machine.md)、[运行状态](docs/storage.md)、[QA 手册](docs/qa-runbook.md)。
