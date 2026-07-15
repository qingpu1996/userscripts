# 运行状态与文件边界

production `serve` 的运行状态完全驻留内存。它不 inspect、读取、创建或修改 `state_dir`、`knowledge_dir` 以及其中任何旧文件；兼容 CLI 参数对 `serve` 无作用。

服务内部的 `Store()` 使用数据库引擎的 `:memory:` 模式作为进程内数据结构，没有文件 URI、临时 spill 或 sidecar。进程退出后 session、action、decision 和 world context 全部消失。

规划所需静态规则只从代码随附的 `service/data/block-labels.json` 与 `service/data/floor-models.json` 启动时读取一次，校验后驻留内存且只读。文件缺失或非法时 fail closed；不会寻找或修复用户目录里的替代文件。

旧的文件型 `Store(path)` 和可写知识注册表只允许离线兼容工具与隔离测试显式调用，不属于 production 工厂。用户点击“导出”仅生成主动下载的诊断快照，不会被后续实例自动读取。
