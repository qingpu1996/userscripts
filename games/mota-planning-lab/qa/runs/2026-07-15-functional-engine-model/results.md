# 功能结果

MT2-like 13×13、空 knowledge 的 localhost `/cycle` 实际响应：

```json
{
  "status": "execute",
  "action_kind": "MOVE_TO_RESOURCE",
  "operations": [{"type": "grid", "x": 2, "y": 2}],
  "expected_delta": {
    "keys": {"yellow": 1},
    "removed_blocks": [{"x": 2, "y": 2, "id": "yellowKey", "cls": "items", "trigger": "getItem", "numeric_id": 31}
  }
}
```

响应不包含 `FLOOR_MODEL_MISSING` 或 `UNKNOWN_BLOCK`。完整离线 QA 通过；最终 userscript SHA-256 为 `6f54d27c90b3f61461957f466accbc383bfc13cb3fb750d061f74eaf4d293b47`，direct mount SHA-256 为 `15ea5315968f5e85ce79098b4cd893e00337ff6b5e4175481da2f5219b67fd10`。
