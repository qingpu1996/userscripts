# 完整引擎模型纵向功能总结

- 浏览器每轮读取全 floors/status maps、blocksInfo、items/enemies/values 与 inventory，输出 JSON 安全 `engine_model`。
- 服务本轮临时派生 floor 与 block labels；engine model 高于历史 knowledge，不落盘为第二份权威缓存。
- 墙/地形、门成本、普通资源、实时怪物和楼梯通用分类；简单 `itemEffect` 只做受限算术解释，不执行 JS。
- MT2-like 空 knowledge 请求已从 `FLOOR_MODEL_MISSING` 修复为黄钥匙原子 execute，guard/idempotency/真实差分链保持原实现。
- 复杂 choice/useItemEvent/任意脚本仍保持 opaque；需由后续真实现场验证是否有游戏特有的简单表达式不在当前子集。
