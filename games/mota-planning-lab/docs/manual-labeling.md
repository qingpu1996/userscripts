# 人工打标

> Protocol v2 中，block 标签仍按 `id + cls + trigger` 审计；世界身份改为 session 内 `map_instance_id`，不能用显示楼层号合并地图。对新 topology revision 的证据必须保留 map instance、topology fingerprint 和 dimensions。打标只解释当前已观察对象，不得补录未进入地图或出口目标。

人工标签只来自服务保存的当前层 pause evidence。不要根据攻略、记忆地图、录像或未访问楼层预填知识，也不要直接编辑游戏。

以下命令假设当前目录是 `games/mota-planning-lab`，且使用项目 `.venv`：

```bash
export PYTHONPATH=service
```

如启动服务时配置了 `MOTA_LAB_STATE_DIR` 或 `MOTA_LAB_KNOWLEDGE_DIR`，运行标签命令时使用相同环境变量。

## 查看暂停包

```bash
python -m mota_lab labels list
python -m mota_lab labels show
```

`labels list` 只显示 evidence 路径、pause_kind、detail_code、floorId 和 fingerprint 摘要。原始包包含当前层 observation、未知 block 坐标、最近行动及差分证据，不包含截图或存档。

## 登记新楼层

选择 `UNKNOWN_FLOOR` 的 evidence 文件：

```bash
python -m mota_lab labels apply-floor \
  --pause "$HOME/.local/state/mota-planning-lab/pauses/<pause-file>.json" \
  --name "4F"
```

floorId 从 evidence 的当前 observation 读取，命令行不允许凭空填写或猜测 engine floorId。登记楼层只表示“已经合法到达并允许建模”，不自动登记 blocks。

## 登记 block

先从 `NEW_OBJECT_OR_MECHANISM` evidence 中选定坐标，再显式说明类别和安全语义。以下仅演示命令形状，坐标与字段必须换成 evidence 中真实出现的当前层数据：

```bash
python -m mota_lab labels apply-block \
  --pause /absolute/path/to/pause.json \
  --x 2 --y 3 \
  --category wall \
  --blocked \
  --non-boundary \
  --no-fast-path \
  --supported
```

类别可选：`terrain`、`wall`、`door`、`resource`、`enemy`、`npc`、`mechanism`、`stair`、`other`。

## 标签规则

| 类别 | 典型设置 | expected_delta |
| --- | --- | --- |
| 安全普通地形 | `--passable --non-boundary --fast-path` | 不需要 |
| 墙或不可通行地形 | `--blocked --non-boundary --no-fast-path` | 不需要 |
| 门 | `--blocked --boundary --no-fast-path` | 必须明确钥匙等差分 |
| 资源 | `--passable --boundary --no-fast-path` | 必须明确生命/攻防等差分 |
| 怪物 | `--blocked --boundary --no-fast-path` | 当前 damage、金币、经验由观察计算；不要覆盖为攻略值 |
| 楼梯 | `--passable --boundary --no-fast-path` | 已知目的 floorId 时明确填写；未知目的只能采用实现允许的受控楼层变化语义 |
| NPC/机关 | 通常 `--boundary --no-fast-path` | 未实现时用 `--unsupported`；已实现时明确差分 |
| `other` / 边界地形 | 只能 `--boundary --no-fast-path` | 必须显式提供可验证的非位置 postcondition，否则用 `--unsupported` |

资源示例仍使用 synthetic 数值，不代表真实 4F：

```bash
python -m mota_lab labels apply-block \
  --pause /absolute/path/to/synthetic-pause.json \
  --x 6 --y 3 \
  --category resource \
  --passable --boundary --no-fast-path --supported \
  --expected-delta '{"hp":200}'
```

门标签可用 `{"keys":{"yellow":-1}}` 之类的显式差分。怪物、门和资源的响应会由规划器另外加入目标 block 移除；NPC、机关、`other` 和边界地形不能假定会消失，必须在标签中明确写出真实可验证的资源、block 或 floor 变化。不要为不确定机制填宽松或空差分；CLI 会拒绝受支持但没有非位置 postcondition 的边界标签，旧知识中的同类标签也只会进入 `NEW_OBJECT_OR_MECHANISM / INCOMPLETE_LABEL`，不会产生 execute。

## 从离线请求生成 evidence

只用于本地 QA 或人工整理合法请求：

```bash
python -m mota_lab labels evidence \
  --request /absolute/path/to/cycle-request.json \
  --pause-kind NEW_OBJECT_OR_MECHANISM \
  --detail-code UNKNOWN_BLOCK \
  --reason "离线 QA evidence"
```

命令会先用严格 CycleRequest schema 验证输入，不能借此导入完整 maps 或额外字段。

## 审计和回退

标签文件是 JSON，写入使用原子替换。每项带 `source` 和 `version`；无 trigger 的普通墙等标签会写成显式 `"trigger": null`，这是 identity 的必填可空部分，不能删除。序列化只省略真正未设置的 optional 字段，CLI 写入后会通过同一知识模型重新加载验证。修改前可复制用户知识目录做备份；不要把真实当前层标签提交为项目 bundled data，因为那会把针对性地图知识编码进发布产物。
