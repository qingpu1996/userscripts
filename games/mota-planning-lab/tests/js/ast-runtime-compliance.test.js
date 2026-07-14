const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { projectDir } = require("./helpers/runtime.js");
const repoDir = path.resolve(projectDir, "../..");
const analyzerUrl = pathToFileURL(path.join(projectDir, "scripts/ast-runtime-compliance.mjs")).href;

async function analyzer() {
  return import(analyzerUrl);
}

function artifacts() {
  return [
    path.join(projectDir, "src/engine-adapter.js"),
    path.join(repoDir, "dist/mota-planning-lab.user.js"),
    path.join(repoDir, "dist/mota-planning-lab.direct-mount.js"),
  ];
}

test("AST assignment destructure 在 src 与双 dist 内存注入时拦截权威运行态写入", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  for (const file of artifacts()) {
    const injected = `${fs.readFileSync(file, "utf8")}\nlet __fix8s; ({status:__fix8s}=core); __fix8s.hero.hp=1;`;
    assert.equal(
      structuredRuntimeViolations(injected).some((item) => item.code === "DIRECT_RUNTIME_STATE_MUTATION"),
      true,
      file,
    );
  }
});

test("AST IIFE 实参传播在 src 与双 dist 内存注入时拦截权威运行态写入", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  for (const file of artifacts()) {
    const injected = `${fs.readFileSync(file, "utf8")}\n((__fix8s)=>{__fix8s.hero.hp=1})(core.status);`;
    assert.equal(
      structuredRuntimeViolations(injected).some((item) => item.code === "DIRECT_RUNTIME_STATE_MUTATION"),
      true,
      file,
    );
  }
});

test("AST 函数形参只按词法 local 处理，不因名称 core 误报", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  assert.deepEqual(structuredRuntimeViolations("function legal(core){return core.floors;}"), []);
});

test("AST 允许完整游戏运行态、定义和存档结构只读分析", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const source = [
    "const floors = core.floors;",
    "const maps = core.status.maps;",
    "const material = core.material;",
    "const futureFloor = maps.MT24;",
    "const saveStructure = core.saves;",
  ].join("\n");
  assert.deepEqual(structuredRuntimeViolations(source), []);
});

test("AST 拒绝地图、怪物、事件和存档权威对象直接篡改", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  for (const source of [
    "core.status.maps.MT1.blocks[0].disable=true;",
    "Reflect.set(core.material.enemys.greenSlime,'hp',1);",
    "delete core.floors.MT1.events['1,1'];",
    "Object.assign(core.saves.slot8,{hero:null});",
  ]) {
    assert.equal(
      structuredRuntimeViolations(source).some((item) => item.code === "DIRECT_RUNTIME_STATE_MUTATION"),
      true,
      source,
    );
  }
});

test("AST 拒绝 carrier、函数返回和参数传播后的权威运行态篡改", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  for (const source of [
    "const box={hero:core.status.hero}; box.hero.hp=1;",
    "const box={}; box.hero=core.status.hero; box.hero.hp=1;",
    "const args=[core.status.hero,'hp',1]; Reflect.set.apply(null,args);",
    "const args={0:core.status.hero,1:'hp',2:1,length:3}; Reflect.set.apply(null,args);",
    "const args={target:core.status.hero}; Object.assign(args.target,{hp:1});",
    "function identity(x){return x;} const hero=identity(core.status.hero); hero.hp=1;",
    "function mutate(x){x.hp=1;} mutate(core.status.hero);",
    "const identity=(x)=>x; identity.call(null,core.status.hero).hp=1;",
    "function mutate(...args){Reflect.set(...args);} mutate(core.status.hero,'hp',1);",
    "function wrap(x){return {value:x};} wrap(core.status.hero).value.hp=1;",
    "const carrier=[core.status.hero]; carrier[0].hp=1;",
    "const carrier=[]; carrier.push(core.status.hero); carrier[0].hp=1;",
    "const carrier={}; Object.assign(carrier,{hero:core.status.hero}); carrier.hero.hp=1;",
    "const carrier={}; Reflect.set(carrier,'hero',core.status.hero); carrier.hero.hp=1;",
    "const carrier={hero:core.status.hero}; carrier[dynamicKey].hp=1;",
    "const carrier=[core.status.hero,{hp:0}]; carrier.copyWithin(1,0,1); carrier[1].hp=1;",
    "const carrier={}; Object.defineProperties(carrier,{hero:{value:core.status.hero}}); carrier.hero.hp=1;",
  ]) {
    assert.equal(
      structuredRuntimeViolations(source).some((item) => item.code === "DIRECT_RUNTIME_STATE_MUTATION"),
      true,
      source,
    );
  }
});

test("AST 拒绝 Object/Reflect call apply bind 与原地容器 mutator", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const cases = [
    "Reflect.set.call(null,core.status.hero,'hp',1);",
    "Object.assign.apply(null,[core.status.hero,{hp:1}]);",
    "const set=Reflect.set.bind(null,core.status.hero); set('hp',1);",
    "const carrier=[core.status.hero,'hp',1]; Reflect.set(...carrier);",
    "Array.prototype.splice.call(core.status.maps.F1.blocks,0,1);",
    "Map.prototype.set.call(core.status.maps.F1.runtimeIndex,'x',1);",
    "Set.prototype.add.apply(core.status.maps.F1.runtimeSet,['x']);",
    ...["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "copyWithin", "fill"]
      .map((method) => `core.status.maps.F1.blocks.${method}(0,1);`),
    ...["set", "add", "delete", "clear"]
      .map((method) => `core.status.maps.F1.runtimeIndex.${method}('x',1);`),
  ];
  for (const source of cases) {
    assert.equal(
      structuredRuntimeViolations(source).some((item) => item.code === "DIRECT_RUNTIME_STATE_MUTATION"),
      true,
      source,
    );
  }
});

test("AST 允许局部 carrier mutation 与正常引擎行动接口", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const source = [
    "const snapshot=structuredClone(core.status);",
    "snapshot.hero.hp=1; snapshot.maps.F1.blocks.splice(0,1);",
    "const carrier={hero:core.status.hero}; carrier.hero={hp:1}; carrier.hero.hp=2;",
    "const local=[]; local.push(core.status.hero); local.pop();",
    "const deletedCarrier={hero:core.status.hero}; Reflect.deleteProperty(deletedCarrier,'hero');",
    "const values=Object.values({hero:core.status.hero}); values.pop();",
    "const map=new Map([['hero',core.status.hero]]); map.delete('hero');",
    "const set=new Set([core.status.hero]); set.clear();",
    "core.setAutomaticRoute(1,2,[]); core.moveDirectly(1,2);",
    "core.stopAutomaticRoute(); core.doSL(8,'save');",
  ].join("\n");
  assert.deepEqual(structuredRuntimeViolations(source), []);
});

test("AST 拒绝数组 spread、返回型 mutator、rest 函数和 method alias carrier", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const cases = [
    "const a=[core.status.hero]; const b=[...a]; b[0].hp=1;",
    "const a=[core.status.hero]; const hero=a.pop(); hero.hp=1;",
    "const a=[core.status.hero]; const hero=a.shift(); hero.hp=1;",
    "const a=[core.status.hero]; const [hero]=a.splice(0,1); hero.hp=1;",
    "function id(...xs){return [...xs];} id(core.status.hero)[0].hp=1;",
    "const splice=[].splice; splice.call(core.status.maps.F1.blocks,0,1);",
    "const splice=Array.prototype.splice; Reflect.apply(splice,core.status.maps.F1.blocks,[0,1]);",
  ];
  for (const source of cases) {
    assert.equal(structuredRuntimeViolations(source).some((item) => (
      item.code === "DIRECT_RUNTIME_STATE_MUTATION"
    )), true, source);
  }
});

test("AST 拒绝 dynamic、loop、Reflect、Object、Map 与 Set carrier", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const cases = [
    "const a={hero:core.status.hero}; a[k].hp=1;",
    "const a={}; a[k]=core.status.hero; a[other].hp=1;",
    "const a={}; Reflect.set(a,k,core.status.hero); a[other].hp=1;",
    "for (const hero of [core.status.hero]) hero.hp=1;",
    "const a=[core.status.hero]; for (const hero of a.values()) hero.hp=1;",
    "Reflect.apply(Reflect.set,null,[core.status.hero,'hp',1]);",
    "const apply=Reflect.apply; apply(Reflect.set,null,[core.status.hero,'hp',1]);",
    "Object.values({hero:core.status.hero})[0].hp=1;",
    "Object.entries({hero:core.status.hero})[0][1].hp=1;",
    "const values=Object.values; values({hero:core.status.hero})[0].hp=1;",
    "const m=new Map([['hero',core.status.hero]]); m.get('hero').hp=1;",
    "const m=new Map(); m.set('hero',core.status.hero); m.get('hero').hp=1;",
    "for (const [,hero] of new Map([['hero',core.status.hero]])) hero.hp=1;",
    "for (const hero of new Set([core.status.hero])) hero.hp=1;",
    "const s=new Set(); s.add(core.status.hero); for (const hero of s.values()) hero.hp=1;",
    "[core.status.hero].at(0).hp=1;",
    "[core.status.hero].find(()=>true).hp=1;",
    "[core.status.hero].map((hero)=>hero)[0].hp=1;",
    "[core.status.hero].forEach((hero)=>{hero.hp=1;});",
    "new Map([['hero',core.status.hero]]).forEach((hero)=>{hero.hp=1;});",
    "new Set([core.status.hero]).forEach((hero)=>{hero.hp=1;});",
  ];
  for (const source of cases) {
    assert.equal(structuredRuntimeViolations(source).some((item) => (
      item.code === "DIRECT_RUNTIME_STATE_MUTATION"
    )), true, source);
  }
});

test("AST 函数摘要按 taint signature 隔离，并有显式性能与预算上界", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const signatureCase = [
    "function identity(x){return x;}",
    "const local=identity({hp:0}); local.hp=1;",
    "const hero=identity(core.status.hero); hero.hp=1;",
  ].join("\n");
  assert.equal(structuredRuntimeViolations(signatureCase).some((item) => (
    item.code === "DIRECT_RUNTIME_STATE_MUTATION"
  )), true);

  const lines = ["function f0(x){return x;}"];
  for (let depth = 1; depth <= 32; depth += 1) {
    lines.push(`function f${depth}(x){return f${depth - 1}(x)||f${depth - 1}(x);}`);
  }
  lines.push("f32(core.status.hero);");
  const startedAt = performance.now();
  assert.deepEqual(structuredRuntimeViolations(lines.join("\n")), []);
  assert.ok(performance.now() - startedAt < 500, "DAG function analysis exceeded 500ms");

  const limited = structuredRuntimeViolations("const hero=core.status.hero; hero.hp;", { maxSteps: 2 });
  assert.equal(limited.some((item) => item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"), true);
  const depthLimited = structuredRuntimeViolations([
    "function a(x){return b(x);}",
    "function b(x){return c(x);}",
    "function c(x){return x;}",
    "a(core.status.hero);",
  ].join("\n"), { maxCallDepth: 2 });
  assert.equal(depthLimited.some((item) => item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"), true);
  const lengthLimited = structuredRuntimeViolations("x".repeat(101), { maxSourceLength: 100 });
  assert.equal(lengthLimited.some((item) => item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"), true);
  const unsupportedCarrierCall = structuredRuntimeViolations("[core.status.hero].customTransform();");
  assert.equal(unsupportedCarrierCall.some((item) => item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"), true);
});

test("AST 嵌套 closure 摘要按捕获环境与深层 taint 隔离", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const rejected = [
    [
      "function outer(x) {",
      "  function inner() { return x; }",
      "  return inner();",
      "}",
      "outer(core.status.hero).hp = 0;",
    ].join("\n"),
    [
      "const outer = (x) => {",
      "  const inner = () => x;",
      "  return inner();",
      "};",
      "outer({ hp: 1 });",
      "outer(core.status.hero).hp = 0;",
    ].join("\n"),
    [
      "function make(x){ return () => x; }",
      "const local=make({hp:1}); local().hp=2;",
      "const live=make(core.status.hero); live().hp=0;",
    ].join("\n"),
    [
      "function make(x){ return () => x; }",
      "const live=make(core.status.hero); live().hp=0;",
      "const local=make({hp:1}); local().hp=2;",
    ].join("\n"),
    [
      "function outer(x){",
      "  const carrier={deep:{value:x}};",
      "  const inner=()=>carrier.deep.value;",
      "  return inner();",
      "}",
      "outer({hp:1}).hp=2;",
      "outer(core.status.hero).hp=0;",
    ].join("\n"),
    [
      "function outer(){",
      "  const carrier={deep:{value:{hp:1}}};",
      "  const inner=()=>carrier.deep.value;",
      "  inner();",
      "  carrier.deep.value=core.status.hero;",
      "  return inner();",
      "}",
      "outer().hp=0;",
    ].join("\n"),
  ];
  for (const source of rejected) {
    assert.equal(structuredRuntimeViolations(source).some((item) => (
      item.code === "DIRECT_RUNTIME_STATE_MUTATION"
    )), true, source);
  }

  const legal = [
    "function makeLocal(){",
    "  const local={nested:{hp:1}};",
    "  const read=()=>local.nested;",
    "  return read();",
    "}",
    "makeLocal().hp=2;",
  ].join("\n");
  assert.deepEqual(structuredRuntimeViolations(legal), []);
});

test("AST mutable return 不得因 memo clone 丢失容器 alias 与副作用", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const rejected = [
    // 同一函数、属性赋值：先 prime，再 local -> runtime -> write。
    "const c={x:{hp:1}}; function get(){return c;} get(); get().x=core.status.hero; get().x.hp=0;",
    // 无 prime 对照仍应精确拦截。
    "const c={x:{hp:1}}; function get(){return c;} get().x=core.status.hero; get().x.hp=0;",
    // 嵌套 closure 返回同一捕获容器。
    [
      "const c={x:{hp:1}};",
      "function outer(){",
      "  function get(){return c;}",
      "  get(); get().x=core.status.hero; get().x.hp=0;",
      "}",
      "outer();",
    ].join("\n"),
    // Array index assignment 和不同 memo signature。
    [
      "const c=[{hp:1}];",
      "function get(flag){return c;}",
      "get(false); get(true)[0]=core.status.hero; get(false)[0].hp=0;",
    ].join("\n"),
    // Map mutator。
    [
      "const c=new Map([['x',{hp:1}]]);",
      "function get(){return c;}",
      "get(); get().set('x',core.status.hero); get().get('x').hp=0;",
    ].join("\n"),
    "const c=new Map(); function get(){return c;} get().set('x',core.status.hero); get().get('x').hp=0;",
    // Set mutator。
    [
      "const c=new Set([{hp:1}]);",
      "function get(){return c;}",
      "get(); get().clear(); get().add(core.status.hero);",
      "for(const value of get()) value.hp=0;",
    ].join("\n"),
    // 不同函数返回同一容器。
    [
      "const c={x:{hp:1}};",
      "function read(){return c;} function write(){return c;}",
      "read(); write().x=core.status.hero; read().x.hp=0;",
    ].join("\n"),
    // 反序 runtime -> local -> runtime，同一 abstract heap identity 不得回退到旧摘要。
    [
      "const c={x:core.status.hero};",
      "function get(){return c;}",
      "get(); get().x={hp:1}; get().x=core.status.hero; get().x.hp=0;",
    ].join("\n"),
  ];
  for (const source of rejected) {
    assert.equal(structuredRuntimeViolations(source).some((item) => (
      item.code === "DIRECT_RUNTIME_STATE_MUTATION" || item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"
    )), true, source);
  }

  const legal = [
    // 真实 JS 每次调用都新建局部容器，不应因摘要复用伪造 alias。
    "function fresh(){return {x:{hp:1}};}",
    "fresh(); fresh().x=core.status.hero; fresh().x.hp=0;",
    // 捕获的纯局部容器可按同一 alias 正常修改。
    "const local={x:{hp:1}}; function same(){return local;}",
    "same(); same().x={hp:2}; same().x.hp=3;",
    "core.setAutomaticRoute(1,2,[]); core.moveDirectly(1,2);",
  ].join("\n");
  assert.deepEqual(structuredRuntimeViolations(legal), []);
});

test("AST callable return 保持每次 closure allocation identity", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const rejected = [
    // 同一表达式、相同结构实参生成两个 closure；第二个捕获对象随后承载 runtime。
    [
      "function make(x){return ()=>x;}",
      "const [x1,x2]=[{hero:{hp:1}},{hero:{hp:1}}];",
      "const [a,b]=[make(x1),make(x2)];",
      "x2.hero=core.status.hero;",
      "b().hero.hp=0;",
    ].join("\n"),
    // 调换 allocation 与调用顺序后仍必须绑定各自捕获环境。
    [
      "function make(x){return ()=>x;}",
      "const [x1,x2]=[{hero:{hp:1}},{hero:{hp:1}}];",
      "const b=make(x2); const a=make(x1);",
      "x2.hero=core.status.hero;",
      "a(); b().hero.hp=0;",
    ].join("\n"),
    // nested closure allocation 也不能复用首个实例。
    [
      "function outer(x){function middle(){return ()=>x;} return middle();}",
      "const [x1,x2]=[{hero:{hp:1}},{hero:{hp:1}}];",
      "const [a,b]=[outer(x1),outer(x2)];",
      "x2.hero=core.status.hero;",
      "b().hero.hp=0;",
    ].join("\n"),
    // closure returns closure：内外两层 callable 都必须保持 allocation identity。
    [
      "function make(x){return ()=>()=>x;}",
      "const [x1,x2]=[{hero:{hp:1}},{hero:{hp:1}}];",
      "const [a,b]=[make(x1),make(x2)];",
      "x2.hero=core.status.hero;",
      "b()().hero.hp=0;",
    ].join("\n"),
    // bind 产生的 callable allocation 仍携带底层 closure identity。
    [
      "function make(x){return (()=>x).bind(null);}",
      "const [x1,x2]=[{hero:{hp:1}},{hero:{hp:1}}];",
      "const [a,b]=[make(x1),make(x2)];",
      "x2.hero=core.status.hero;",
      "b().hero.hp=0;",
    ].join("\n"),
  ];
  for (const source of rejected) {
    assert.equal(structuredRuntimeViolations(source).some((item) => (
      item.code === "DIRECT_RUNTIME_STATE_MUTATION" || item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"
    )), true, source);
  }

  const legal = [
    // 不同 closure 捕获相同结构但不同 fresh container；a 的 taint 不得污染 b。
    [
      "function make(x){return ()=>x;}",
      "const [a,b]=[make({hero:{hp:1}}),make({hero:{hp:1}})];",
      "a().hero=core.status.hero;",
      "b().hero.hp=0;",
    ].join("\n"),
    // 反序 mutation/call 仍不得把两个 fresh captured container 合并。
    [
      "function make(x){return ()=>x;}",
      "const b=make({hero:{hp:1}}); const a=make({hero:{hp:1}});",
      "a().hero=core.status.hero;",
      "b().hero.hp=0;",
    ].join("\n"),
    // nested closure 与 closure-returning-closure 的 fresh 捕获对象同样隔离。
    [
      "function outer(x){return ()=>()=>x;}",
      "const [a,b]=[outer({hero:{hp:1}}),outer({hero:{hp:1}})];",
      "a()().hero=core.status.hero;",
      "b()().hero.hp=0;",
    ].join("\n"),
    [
      "function make(x){return (()=>x).bind(null);}",
      "const [a,b]=[make({hero:{hp:1}}),make({hero:{hp:1}})];",
      "a().hero=core.status.hero;",
      "b().hero.hp=0;",
    ].join("\n"),
  ];
  for (const source of legal) assert.deepEqual(structuredRuntimeViolations(source), [], source);

  const allocationLines = ["function make(x){const box={value:x};return ()=>box;}"];
  for (let index = 0; index < 2_000; index += 1) {
    allocationLines.push(`const f${index}=make({hero:{hp:${index}}}); f${index}().hero.hp++;`);
  }
  const allocationSource = allocationLines.join("\n");
  const startedAt = performance.now();
  assert.deepEqual(structuredRuntimeViolations(allocationSource), []);
  assert.ok(performance.now() - startedAt < 1_000, "2000 closure/container allocations exceeded 1000ms");
  assert.equal(structuredRuntimeViolations(allocationSource, { maxSteps: 1_000 }).some((item) => (
    item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS" && item.properties.includes("step-budget")
  )), true);
});

test("AST recursion fail-closed 且 depth 22/40 DAG 保持有界", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  for (const source of [
    "function self(x){return self(x);} self(core.status.hero);",
    "function left(x){return right(x);} function right(x){return left(x);} left(core.status.hero);",
  ]) {
    const startedAt = performance.now();
    assert.equal(structuredRuntimeViolations(source).some((item) => (
      item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"
    )), true, source);
    assert.ok(performance.now() - startedAt < 500, "recursive analysis exceeded 500ms");
  }

  for (const depth of [22, 40]) {
    const lines = ["function f0(x){return x;}"];
    for (let index = 1; index <= depth; index += 1) {
      lines.push(`function f${index}(x){return f${index - 1}(x)||f${index - 1}(x);}`);
    }
    lines.push(`f${depth}(core.status.hero);`);
    const startedAt = performance.now();
    assert.deepEqual(structuredRuntimeViolations(lines.join("\n")), []);
    assert.ok(performance.now() - startedAt < 500, `DAG depth ${depth} exceeded 500ms`);
  }
});

test("AST 对超出项目支持子集的 this/constructor/identity callback 显式拒绝", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  const unsupported = [
    "function setHp(){this.hp=0;} setHp.bind(core.status.hero)();",
    "const closures=[core.status.hero,{hp:1}].map((value)=>()=>value); closures[0]().hp=0;",
    "function Box(value){this.value=value;} const box=new Box(core.status.hero); box.value.hp=0;",
  ];
  for (const source of unsupported) {
    const result = structuredRuntimeViolations(source);
    assert.equal(result.some((item) => item.code === "UNSAFE_RUNTIME_MUTATION_ANALYSIS"), true, source);
  }
});
