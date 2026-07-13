#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(projectDir, "../..");
const srcDir = path.join(projectDir, "src");
const configPath = path.join(projectDir, "userscript.config.json");
const distPath = path.join(repoDir, "dist", "mota-planning-lab.user.js");

const failures = [];

function fail(file, message) {
  failures.push(`${path.relative(repoDir, file)}: ${message}`);
}

function stripCommentsAndStrings(source) {
  let output = "";
  let state = "code";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (current === "\n") {
        state = "code";
        output += "\n";
      } else output += " ";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else output += current === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "string") {
      if (current === "\\") {
        output += "  ";
        index += 1;
      } else if (current === quote) {
        output += " ";
        state = "code";
        quote = null;
      } else output += current === "\n" ? "\n" : " ";
      continue;
    }
    if (current === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block-comment";
    } else if (current === "\"" || current === "'" || current === "`") {
      output += " ";
      state = "string";
      quote = current;
    } else output += current;
  }
  return output;
}

const sourceFiles = fs.existsSync(srcDir)
  ? fs.readdirSync(srcDir).filter((name) => name.endsWith(".js")).sort()
    .map((name) => path.join(srcDir, name))
  : [];

if (sourceFiles.length === 0) fail(srcDir, "no browser runtime source files found");

const textualForbidden = [
  [/\bcore\s*\.\s*floors\b/u, "forbidden floor catalogue access"],
  [/floors\.min\.js/iu, "forbidden game map source reference"],
  [/\bmaterial\b/iu, "forbidden full material reference"],
  [/\bscreenshot\b/iu, "forbidden screenshot path"],
  [/\bocr\b/iu, "forbidden OCR path"],
  [/\bgetImageData\s*\(/iu, "forbidden image extraction"],
  [/\btoDataURL\s*\(/iu, "forbidden canvas export"],
  [/JSON\.stringify\s*\(\s*(?:core|status|maps|floors|material)\b/iu,
    "forbidden whole-runtime serialization"],
];

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  const executable = stripCommentsAndStrings(source);
  for (const [pattern, message] of textualForbidden) {
    if (pattern.test(source)) fail(file, message);
  }
  if (path.basename(file) !== "engine-adapter.js"
    && (/\bunsafeWindow\b/u.test(executable) || /\bcore\b/u.test(executable))) {
    fail(file, "page core access exists outside engine-adapter.js");
  }
  if (/\bcore\s*\.\s*status(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]]+\])*\s*=(?!=)/u.test(executable)) {
    fail(file, "direct core.status assignment");
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
}

if (fs.existsSync(distPath)) {
  const dist = fs.readFileSync(distPath, "utf8");
  for (const [pattern, message] of textualForbidden) {
    if (pattern.test(dist)) fail(distPath, message);
  }
  if (/^\/\/ @(?:updateURL|downloadURL)\b/mu.test(dist)) {
    fail(distPath, "generated metadata contains an auto-update URL");
  }
  const localhostUrls = dist.match(/https?:\/\/[^\s"'`]+/gu) || [];
  for (const url of localhostUrls) {
    if (url !== "http://127.0.0.1:18724/cycle" && url !== "https://h5mota.com/games/24/*") {
      fail(distPath, `unexpected runtime URL ${url}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Static blind-play compliance: FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Static blind-play compliance: PASS (${sourceFiles.length} source files${
    fs.existsSync(distPath) ? " + generated userscript" : ""})`);
}
