# Fix 3 红灯复现

修改 AST analyzer 前，在 worktree HEAD `9a61f85d72dd6423ed6e53ab54d26c83cdde2e26` 加载当前未提交实现并执行：

```bash
node --input-type=module -e "import { structuredRuntimeViolations as v } from './games/mota-planning-lab/scripts/ast-runtime-compliance.mjs'; const cases = [\`function outer(x) { function inner() { return x; } return inner(); } outer(core.status.hero).hp = 0;\`, \`const outer = (x) => { const inner = () => x; return inner(); }; outer({ hp: 1 }); outer(core.status.hero).hp = 0;\`]; for (const [i,s] of cases.entries()) console.log(JSON.stringify({case:i+1,violations:v(s)}));"
```

实际红灯输出：

```json
{"case":1,"violations":[]}
{"case":2,"violations":[]}
```

两例都应拒绝，但均被错误放行。根因是嵌套函数摘要键只包含捕获 scope 的 revision 数字和当前实参签名；预分析 `UNKNOWN` 与真实调用、以及不同外层调用创建的不同 closure environment 可以生成相同 revision 序列，导致错误复用旧摘要。

将闭包隔离回归加入测试、尚未修改 analyzer 时，定向红灯如下：

```bash
node --test --test-name-pattern='嵌套 closure|recursion fail-closed' \
  games/mota-planning-lab/tests/js/ast-runtime-compliance.test.js
```

```text
tests 2
pass 1
fail 1
AssertionError: outer(core.status.hero).hp = 0; false !== true
```
