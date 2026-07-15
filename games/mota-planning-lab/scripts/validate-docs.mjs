#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(projectDir);
for (const file of files.filter((item) => item.endsWith(".json"))) {
  try { JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    failures.push(`${path.relative(projectDir, file)}: ${error.message}`);
  }
}
let links = 0;
for (const file of files.filter((item) => item.endsWith(".md"))) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (/^(?:https?:|#)/u.test(target)) continue;
    links += 1;
    const relative = decodeURIComponent(target.split("#", 1)[0]);
    if (relative && !fs.existsSync(path.resolve(path.dirname(file), relative))) {
      failures.push(`${path.relative(projectDir, file)}: missing link ${target}`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Docs/JSON validation: PASS (${files.filter((f) => f.endsWith(".md")).length} markdown, ${links} local links, ${files.filter((f) => f.endsWith(".json")).length} JSON)`);
}
