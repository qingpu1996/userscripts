# Fix 4 红灯复现

修改 analyzer 前，在 worktree HEAD `9a61f85d72dd6423ed6e53ab54d26c83cdde2e26` 及当前未提交的 Fix 1–3 实现上，对 object、nested closure、array、Map、Set 五类可变返回值先预热 memo，再执行 `local -> runtime -> write`：

```bash
node --input-type=module <<'EOF'
import { structuredRuntimeViolations as v } from './games/mota-planning-lab/scripts/ast-runtime-compliance.mjs';
const cases = [
  `const c={x:{hp:1}}; function get(){return c;} get(); get().x=core.status.hero; get().x.hp=0;`,
  `const c={x:{hp:1}}; function outer(){ function get(){return c;} get(); get().x=core.status.hero; get().x.hp=0; } outer();`,
  `const c=[{hp:1}]; function get(){return c;} get(); get()[0]=core.status.hero; get()[0].hp=0;`,
  `const c=new Map([['x',{hp:1}]]); function get(){return c;} get(); get().set('x',core.status.hero); get().get('x').hp=0;`,
  `const c=new Set([{hp:1}]); function get(){return c;} get(); get().clear(); get().add(core.status.hero); for(const x of get()) x.hp=0;`,
];
for (const [i, source] of cases.entries()) console.log(JSON.stringify({case:i+1, violations:v(source)}));
EOF
```

实际红灯：

```json
{"case":1,"violations":[]}
{"case":2,"violations":[]}
{"case":3,"violations":[]}
{"case":4,"violations":[]}
{"case":5,"violations":[]}
```

将回归加入测试、尚未修改 analyzer 时，定向测试为 `0 pass / 1 fail`，首个 object 反例即失败。

根因：摘要 store/hit 对 `array/object/map/set/iterator` 深拷贝。预热后的每次调用都拿到新 clone，因此对函数真实返回的同一 captured container 的改写既不更新抽象 heap，也不提升 owner scope revision，后续 memo hit 继续返回过期 local clone。
