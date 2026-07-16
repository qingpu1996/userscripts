# 构建与运行边界

旧 Python 后端已删除。Stage1 提供一个可启动的 Rust shadow runtime，但它只返回只读建议，不会产生可执行动作。

重建两个实际使用的产物：

```bash
node scripts/build-userscript.js mota-planning-lab
node games/mota-planning-lab/scripts/build-direct-mount.mjs
```

启动本地只读 runtime：

```bash
cargo run --manifest-path games/mota-planning-lab/rust/shadow-runtime/Cargo.toml -- --port 18724
```

它只绑定 `127.0.0.1`，业务入口只有 `POST /cycle`；请求必须带 `Content-Type: application/json`（允许 charset）及 `X-Mota-Lab: 1`。为 direct-mount 的 `https://h5mota.com` 提供对应的严格 `OPTIONS /cycle` CORS 预检，带 Origin 的 POST 也只接受该 Origin；无 Origin 的 GM 请求仍可使用同一严格请求头。请求体上限为 9 MiB（8 MiB 前端 engine model + 最多 1 MiB cycle envelope），超过即拒绝，绝不无界读取。`--port 0` 仅用于测试，让操作系统分配临时端口；启动后会输出一行 JSON 就绪信息。

安装时使用 `dist/mota-planning-lab.user.js`；受控测试可直接注入 `dist/mota-planning-lab.direct-mount.js`。启动时会最多等待 10 秒让游戏创建 `core.status`，页面卸载或超时则安全暂停。Stage1 的 `main.js` 强制 `shadowOnly`，收到 `execute` 也会暂停而不会触发游戏移动或菜单 API；不得用于真实存档自动驾驶。

运行态只保留进程内存：JS 采集当前游戏状态，Rust 以当前状态作出一个建议，Stage1 JS 只展示/记录该建议。没有旧 Python、状态恢复、后台队列、数据库或日志文件；旁路复盘日志尚未实现。
