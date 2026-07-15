#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(projectDir, "../..");
const adapterPath = path.join(projectDir, "src", "engine-adapter.js");
const auditPath = path.join(scriptDir, "production-integrity-audit.mjs");
const userscriptPath = path.join(repoDir, "dist", "mota-planning-lab.user.js");
const directMountPath = path.join(repoDir, "dist", "mota-planning-lab.direct-mount.js");

const original = {
  adapter: fs.readFileSync(adapterPath, "utf8"),
  userscript: fs.readFileSync(userscriptPath),
  directMount: fs.readFileSync(directMountPath),
};

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoDir,
    encoding: "utf8",
    ...options,
  });
  if (options.expectFailure) return result;
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  return result;
}

function buildBothArtifacts() {
  runNode([path.join(repoDir, "scripts", "build-userscript.js"), "mota-planning-lab"]);
  runNode([path.join(scriptDir, "build-direct-mount.mjs")]);
}

const injection = [
  "",
  "// QA-only actual production adapter injection; restored in finally.",
  "{",
  "  runtime.unknownAction.call(runtime);",
  "  runtime[dynamicMethod].apply(runtime, []);",
  "  const f=runtime[dynamicMethod]; f();",
  "}",
  "",
].join("\n");

let auditResult;
try {
  fs.writeFileSync(adapterPath, `${original.adapter}${injection}`, "utf8");
  buildBothArtifacts();
  const audit = runNode([auditPath], { expectFailure: true });
  assert.notEqual(audit.status, 0, "injected actual production tree must fail the full audit CLI");
  auditResult = JSON.parse(audit.stdout);
  assert.equal(auditResult.status, "fail");
  assert.ok(auditResult.failures.some((failure) => (
    failure.includes("UNCLASSIFIED_ENGINE_API") && failure.includes("unknownAction")
  )), JSON.stringify(auditResult));
  assert.ok(auditResult.failures.filter((failure) => (
    failure.includes("UNCLASSIFIED_ENGINE_API") && failure.includes("DYNAMIC_ENGINE_API")
  )).length >= 3, JSON.stringify(auditResult));
} finally {
  fs.writeFileSync(adapterPath, original.adapter, "utf8");
  buildBothArtifacts();
}

assert.deepEqual(fs.readFileSync(userscriptPath), original.userscript,
  "restored userscript dist must exactly match the pre-injection artifact");
assert.deepEqual(fs.readFileSync(directMountPath), original.directMount,
  "restored direct-mount dist must exactly match the pre-injection artifact");

console.log(JSON.stringify({
  status: "pass",
  injected_audit_exit_nonzero: true,
  injected_failures: auditResult.failures.filter((failure) => (
    failure.includes("UNCLASSIFIED_ENGINE_API")
  )),
  restored_both_dist_artifacts: true,
}, null, 2));
