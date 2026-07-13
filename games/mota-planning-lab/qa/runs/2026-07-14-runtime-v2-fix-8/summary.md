# 第八轮离线 QA 摘要

- 状态：完整离线 QA 通过，可以移交全新只读验收；本 Agent 不自验替代。首次完整运行在 evidence 链接创建前如预期停在 docs missing-link，创建本目录后已从头重跑通过。
- 红灯：新增 AST 3 项最小测试初始 `0/3`，journal 前代自证最小测试初始失败；static fixture 同时准确报告两项攻击漏检与参数 shadow 误报。
- targeted：assignment destructure 与 IIFE 实参传播在 src、userscript、direct-mount 三份实际文本内存注入均拦截；参数名 `core` 的局部正例通过；journal base/gap/adjacent/overflow 对抗通过。
- 完整 QA：第七轮 `188/188` 基线扩展为 `101 JS + 90 Python + 1 integration = 192/192`；fixtures/schema、Protocol wire、Python compile、全部 JS syntax、双构建确定性、Acorn AST、docs/JSON、`git diff --check` 与隔离 prospective staged check 全绿。
- userscript：4164 行，170984 bytes，SHA-256 `9372f6fb9ea26cecc7e328e11ec9b7fddba47353e938bd66088fbde41cca75db`。
- direct mount：4107 行，161510 bytes，SHA-256 `1b6a1dd572124fc8ca021b55ff739ee52da9a481fa6f85137c09ee5c1fba2c68`。
- Acorn 8.16.0 vendor、MIT LICENSE、provenance 与固定 SHA-256 未改变。
- Git：branch `codex/mota-planning-lab-runtime-v2`，HEAD `fed28f7c6407e81ca65858ce91dda08858d7ad84`；真实 index 前后 SHA-256 均为 `2add78eb6b7ee74c43de89114e97b262f6b36b2a8fa2a242e2879fd62c7515a9`。
- 现场：`not-run`；未访问浏览器、游戏、存档或外网。
