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

test("AST assignment destructure 在 src 与双 dist 内存注入时拦截 runtime status 写入", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  for (const file of artifacts()) {
    const injected = `${fs.readFileSync(file, "utf8")}\nlet __fix8s; ({status:__fix8s}=core); __fix8s.hero.hp=1;`;
    assert.equal(
      structuredRuntimeViolations(injected).some((item) => item.code === "DIRECT_HERO_STATUS_WRITE"),
      true,
      file,
    );
  }
});

test("AST IIFE 实参传播在 src 与双 dist 内存注入时拦截 runtime status 写入", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  for (const file of artifacts()) {
    const injected = `${fs.readFileSync(file, "utf8")}\n((__fix8s)=>{__fix8s.hero.hp=1})(core.status);`;
    assert.equal(
      structuredRuntimeViolations(injected).some((item) => item.code === "DIRECT_HERO_STATUS_WRITE"),
      true,
      file,
    );
  }
});

test("AST 函数形参只按词法 local 处理，不因名称 core 误报", async () => {
  const { structuredRuntimeViolations } = await analyzer();
  assert.deepEqual(structuredRuntimeViolations("function legal(core){return core.floors;}"), []);
});
