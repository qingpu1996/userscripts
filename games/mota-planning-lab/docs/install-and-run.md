# 安装与运行

> 本页只描述当前 Python + Protocol v2 `/cycle` 实现。目标 Rust `/bootstrap + /step + /run-events` 单步循环与旁路日志尚未实现，不能使用本页命令验证目标架构；目标见 [求解器架构与实施方案](solver-architecture.md)。

```bash
cd games/mota-planning-lab/service
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m mota_lab serve --allow-direct-mount-origin https://h5mota.com
```

服务只允许监听 `127.0.0.1`，默认端口 `18724`。页面 endpoint 必须使用相同 loopback 端口和 `/cycle` path。

`--state-dir`、`--knowledge-dir` 及对应环境变量是兼容输入；production `serve` 不 inspect、读取、创建或修改这些目录。运行状态只在当前服务进程内存中，服务重启即清空。规则从代码随附 `service/data/` 只读载入，非法则启动失败。

用户脚本导入 `dist/mota-planning-lab.user.js`；受控调试可注入 `dist/mota-planning-lab.direct-mount.js`。两者都不使用浏览器 storage，不自动打开游戏、不确认基线、不启动行动。刷新页面会建立 fresh 页面实例；重新启动服务会建立 fresh 服务状态，不恢复旧 action。

“仅重新连接”只检查当前实例连接和当前内存 action，不触发规划。用户主动“导出”只下载当前诊断，不用于下一次运行恢复。
