# v0.1.0 离线 QA 总结

- 日期：2026-07-13（Asia/Shanghai）
- worktree：`/Users/nihplod/.codex/worktrees/mota-planning-lab-v0.1.0`
- 分支：`feature/mota-planning-lab/v0.1.0`
- 基线 HEAD：`eee41c0af3caa1f39e9cc143b681594009bda9a4`
- 范围：fake core、synthetic fixtures、本机临时 localhost 服务
- 真实游戏访问：否
- 真实存档读写：否
- screenshot / Canvas / OCR：否

## 结论

离线自动化共 94 项测试，94 通过、0 失败：

- JavaScript 浏览器侧：49/49
- Python 决策服务：44/44
- 真实 localhost 进程 + fake core 集成：1/1

另外通过：7 个 JSON fixture/schema 来源检查、共享 wire protocol 的 1 个 observation + 3 个 response 服务模型校验、Python compileall、17 个 JS 源文件语法检查、userscript 构建与语法检查、静态盲玩禁区扫描、`git diff --check`。

集成测试实际启动 `127.0.0.1:18724`，完成以下 synthetic 闭环：

```text
当前层观察
  -> UNKNOWN_FLOOR pause evidence
  -> 写入临时 synthetic floor/block 标签
  -> 安全空走廊 moveDirectly
  -> 单资源 setAutomaticRoute +200 HP
  -> 下一轮单怪 setAutomaticRoute -24 HP/+5 Gold/+4 EXP
  -> completed_action_id 回报
  -> service idle
```

资源和怪物没有打包为同一个状态边界；整个流程没有调用 save/load，也没有访问 fake core 的毒值属性。

## 生成物

- 路径：`/Users/nihplod/.codex/worktrees/mota-planning-lab-v0.1.0/dist/mota-planning-lab.user.js`
- 行数：2330
- 字节：88206
- SHA-256：`26e1db0edd71c856b0679172f7b564ac36266818eafb9271293e8bfe3c7c640c`

## 未覆盖风险

- 未在真实 H5 页面验证 `getEnemyInfo`、`getDamage`、`moveDirectly`、`setAutomaticRoute`、事件锁和稳定轮询的实际版本签名/时序。
- 未验证面板是否在目标页面布局中遮挡地图。
- bundled knowledge 有意为空；真实首次运行会先对 floor/block 取证并要求人工标签。
- 有限深度搜索是可审计启发式，不承诺全局最优路线。
- 本机 Python 3.12 没有独立安装 pytest；未联网安装。测试使用 pytest 可收集的 `unittest.TestCase`，本轮以 `unittest discover` 实际执行。
- Python 3.12 QA 复用了本机已有的 FastAPI/Uvicorn/httpx 纯 Python 包路径；正式运行应按 `requirements.lock` 建立 Python 3.11+ 项目 `.venv`。
- rate limiter 是单进程固定窗口；v0.1.0 CLI 只启动一个 Uvicorn worker。

## 明确保留未完成

- T73：首次真实页面只读基线核对，未授权、未执行。
- T74：真实空走廊/资源/门/怪物/楼梯分级验证，未授权、未执行。
- 独立只读验收、stage/commit/push/PR 均由主会话后续按门禁处理。
