# 第七轮离线 QA 摘要

- 状态：完整离线 QA 通过，可以移交全新只读验收；本 Agent 不自验替代。
- 红灯：dual-slot 初始 `0/6`；新增 AST 五个攻击与三个 shadow 正例初始 `8/8` 未满足。
- targeted：dual-slot 扩展后 `9/9`；JavaScript 全套 `97/97`；AST 静态扫描通过。
- 完整 QA：`97 JS + 90 Python + 1 integration = 188/188`；fixtures/schema、Protocol wire、Python compile、全部 JS syntax、双构建确定性、Acorn AST、docs/JSON、`git diff --check` 与隔离 prospective staged check 全绿。
- userscript：4160 行，170752 bytes，SHA-256 `50911bfc0d9b5867c86046af4a2acdbec24affb967a847978f5e6b6365bc4417`。
- direct mount：4103 行，161286 bytes，SHA-256 `7d5b5ee433cbb7c72fd6c4126839955eeff5dcb633c306407a41f48fd7007f7e`。
- Acorn 8.16.0：`acorn.mjs` SHA-256 `efb0124a960b34d53f9928c4926bfcfd300bb6a3d7ab64ee949b3a8bed1c7e5f`；MIT `LICENSE` SHA-256 `76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7`；`PROVENANCE.md` SHA-256 `5a848c0a053f52a1cd9802aef0708ac49d35545730e892e3f72a71e059f3ef69`。
- Git：branch `codex/mota-planning-lab-runtime-v2`，HEAD `fed28f7c6407e81ca65858ce91dda08858d7ad84`；真实 index 前后 SHA-256 均为 `2add78eb6b7ee74c43de89114e97b262f6b36b2a8fa2a242e2879fd62c7515a9`。
- 现场：`not-run`；未访问浏览器、游戏、存档或外网。
