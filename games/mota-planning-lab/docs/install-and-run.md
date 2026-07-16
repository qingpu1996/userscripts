# 构建与运行边界

旧 Python 后端已删除，当前仓库不提供可启动的决策服务。浏览器产物仅保留采集、控制和执行契约，等待未来 Rust shadow runtime 接入。

重建两个实际使用的产物：

```bash
node scripts/build-userscript.js mota-planning-lab
node games/mota-planning-lab/scripts/build-direct-mount.mjs
```

安装时使用 `dist/mota-planning-lab.user.js`；受控测试可直接注入 `dist/mota-planning-lab.direct-mount.js`。在 Rust runtime 尚未实现前，不应把任一产物用于真实存档自动驾驶。

未来运行态只保留进程内存：JS 采集当前游戏状态，Rust 以当前状态作出一个决策，JS 执行一个动作。旧 action、世界和规划状态不跨启动保存；唯一允许的持久化是本次启动的旁路复盘日志，运行时只写不读。
