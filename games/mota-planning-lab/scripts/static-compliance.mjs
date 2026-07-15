#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { structuredRuntimeViolations, verifyAstVendor } from "./ast-runtime-compliance.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(projectDir, "../..");
const srcDir = path.join(projectDir, "src");
const configPath = path.join(projectDir, "userscript.config.json");
const distPath = path.join(repoDir, "dist", "mota-planning-lab.user.js");
const directDistPath = path.join(repoDir, "dist", "mota-planning-lab.direct-mount.js");
const failures = [];

function fail(file, message) { failures.push(`${path.relative(repoDir, file)}: ${message}`); }

function stripCommentsAndStrings(source) {
  let output = "";
  let state = "code";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (current === "\n") { state = "code"; output += "\n"; } else output += " ";
    } else if (state === "block-comment") {
      if (current === "*" && next === "/") {
        output += "  "; index += 1; state = "code";
      } else output += current === "\n" ? "\n" : " ";
    } else if (state === "string") {
      if (current === "\\") { output += "  "; index += 1; }
      else if (current === quote) { output += " "; state = "code"; quote = null; }
      else output += current === "\n" ? "\n" : " ";
    } else if (current === "/" && next === "/") {
      output += "  "; index += 1; state = "line-comment";
    } else if (current === "/" && next === "*") {
      output += "  "; index += 1; state = "block-comment";
    } else if (["\"", "'", "`"].includes(current)) {
      output += " "; state = "string"; quote = current;
    } else output += current;
  }
  return output;
}

function sourceLine(source, offset) { return source.slice(0, offset).split("\n").length; }

verifyAstVendor();

const sourceFiles = fs.existsSync(srcDir)
  ? fs.readdirSync(srcDir).filter((name) => name.endsWith(".js")).sort()
    .map((name) => path.join(srcDir, name))
  : [];
const serviceDir = path.join(projectDir, "service", "mota_lab");
const serviceFiles = fs.existsSync(serviceDir)
  ? fs.readdirSync(serviceDir).filter((name) => name.endsWith(".py")).sort()
    .map((name) => path.join(serviceDir, name)) : [];

if (sourceFiles.length === 0) fail(srcDir, "no browser runtime source files found");

// Runtime and source definitions are legal strategy inputs. This is a lint for
// the controlled project source plus the localhost build boundary; it is not a
// JavaScript sandbox, a formal safety proof, or an allowlist of readable game
// data. Production execution integrity is additionally enforced by the actual
// source API audit and full-cycle authority-write instrumentation.
const textualForbidden = [];
const structuredMessages = {
  DIRECT_RUNTIME_STATE_MUTATION: "direct authoritative game-state mutation",
  UNSAFE_RUNTIME_MUTATION_ANALYSIS: "runtime mutation analysis exceeded its safe supported subset",
  SYNTAX_ERROR: "JavaScript syntax rejected by Acorn",
};

function scanJavaScript(file, source) {
  for (const [pattern, message] of textualForbidden) {
    if (pattern.test(source)) fail(file, message);
  }
  for (const violation of structuredRuntimeViolations(source)) {
    fail(file, `${structuredMessages[violation.code]} at line ${sourceLine(source, violation.start)} (${violation.root}:${violation.properties.join(".")})`);
  }
}

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  const executable = stripCommentsAndStrings(source);
  scanJavaScript(file, source);
  if (path.basename(file) !== "engine-adapter.js"
    && (/\bunsafeWindow\b/u.test(executable) || /\bcore\b/u.test(executable))) {
    fail(file, "page core access exists outside engine-adapter.js");
  }
}

for (const file of serviceFiles) {
  const source = fs.readFileSync(file, "utf8");
  for (const [pattern, message] of textualForbidden) {
    if (pattern.test(source)) fail(file, message);
  }
}

if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (Object.hasOwn(config, "rawBaseUrl")) fail(configPath, "rawBaseUrl is forbidden");
  for (const key of ["updateURL", "downloadURL"]) {
    if (Object.hasOwn(config.metadata || {}, key)) fail(configPath, `${key} is forbidden`);
  }
  const matches = Array.isArray(config.metadata?.match) ? config.metadata.match : [];
  if (matches.length !== 1 || matches[0] !== "https://h5mota.com/games/24/*") {
    fail(configPath, "metadata match is broader than the target page");
  }
  const connect = config.metadata?.connect;
  const connects = Array.isArray(connect) ? connect : [connect];
  if (connects.length !== 1 || connects[0] !== "127.0.0.1") {
    fail(configPath, "@connect must contain only 127.0.0.1");
  }
  const grants = new Set(config.metadata?.grant || []);
  for (const required of [
    "GM_xmlhttpRequest",
  ]) {
    if (!grants.has(required)) fail(configPath, `required userscript API grant is missing: ${required}`);
  }
  for (const forbidden of ["GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues"]) {
    if (grants.has(forbidden)) fail(configPath, `runtime persistence grant is forbidden: ${forbidden}`);
  }
}

for (const generatedPath of [distPath, directDistPath]) {
  if (!fs.existsSync(generatedPath)) continue;
  const dist = fs.readFileSync(generatedPath, "utf8");
  const expectedMode = generatedPath === distPath ? "userscript" : "direct-mount";
  const otherMode = expectedMode === "userscript" ? "direct-mount" : "userscript";
  if (!dist.includes(`MotaLab.RUNTIME_MODE = "${expectedMode}";`)) {
    fail(generatedPath, `explicit ${expectedMode} runtime marker is missing`);
  }
  if (dist.includes(`MotaLab.RUNTIME_MODE = "${otherMode}";`)) {
    fail(generatedPath, `artifact contains the opposite ${otherMode} runtime marker`);
  }
  scanJavaScript(generatedPath, dist);
  if (/^\/\/ @(?:updateURL|downloadURL)\b/mu.test(dist)) {
    fail(generatedPath, "generated metadata contains an auto-update URL");
  }
  const localhostUrls = dist.match(/https?:\/\/[^\s"'`]+/gu) || [];
  for (const url of localhostUrls) {
    if (url !== "http://127.0.0.1:18724/cycle" && url !== "https://h5mota.com/games/24/*") {
      fail(generatedPath, `unexpected runtime URL ${url}`);
    }
  }
}

const fixturePath = path.join(projectDir, "tests", "fixtures", "static-compliance-cases.json");
if (!fs.existsSync(fixturePath)) fail(fixturePath, "structured scanner fixture is missing");
else {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  for (const item of fixture.invalid || []) {
    const codes = new Set(structuredRuntimeViolations(item.source).map((itemValue) => itemValue.code));
    if (!codes.has(item.code)) fail(fixturePath, `invalid case was missed: ${item.name}`);
  }
  for (const item of fixture.valid || []) {
    if (structuredRuntimeViolations(item.source).length > 0) {
      fail(fixturePath, `legal case was rejected: ${item.name}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Static project lint: FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Static project lint: PASS (${sourceFiles.length} browser + ${serviceFiles.length} service files${
    fs.existsSync(distPath) ? " + userscript" : ""}${fs.existsSync(directDistPath) ? " + direct mount" : ""}; Acorn 8.16.0 verified)`);
}
