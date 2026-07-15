# Fix 5 红灯复现

修改 analyzer 前，在 worktree HEAD `9a61f85d72dd6423ed6e53ab54d26c83cdde2e26` 及当前未提交的 Fix 1–4 实现上，使用同一 `make(x)` 表达式和结构相同、identity 不同的捕获对象创建两个 closure：

```bash
node --input-type=module <<'EOF'
import { structuredRuntimeViolations as v } from './games/mota-planning-lab/scripts/ast-runtime-compliance.mjs';
const missed = `function make(x){return ()=>x;}
const [x1,x2]=[{hero:{hp:1}},{hero:{hp:1}}];
const [a,b]=[make(x1),make(x2)];
x2.hero=core.status.hero;
b().hero.hp=0;`;
const falsePositive = `function make(x){return ()=>x;}
const [a,b]=[make({hero:{hp:1}}),make({hero:{hp:1}})];
a().hero=core.status.hero;
b().hero.hp=0;`;
console.log(JSON.stringify({missed:v(missed),falsePositive:v(falsePositive)},null,2));
EOF
```

实际红灯：

```json
{
  "missed": [],
  "falsePositive": [
    {
      "code": "DIRECT_RUNTIME_STATE_MUTATION",
      "start": 114,
      "root": "ast",
      "properties": ["status", "hero", "hp"]
    }
  ]
}
```

加入回归、尚未修改 analyzer 时，定向测试为 `0 pass / 1 fail`，首个漏报例在断言处失败。

根因：Fix 4 只把 mutable heap result 排除出 memo，`kind:function` 仍按 parent scope revision 和结构 value signature 缓存。第二次 `make(x2)` 命中第一次 `make(x1)` 的摘要，错误复用首个 closure 捕获环境；后续既会漏掉 `x2` 的 runtime taint，也会把 `x1` 的 taint伪传播到独立的 `x2`。
