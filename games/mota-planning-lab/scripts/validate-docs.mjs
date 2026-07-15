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

// Validate commands in current user-facing documentation. Historical QA run
// records and legacy snapshots intentionally remain immutable evidence and are
// excluded from this check.
const commandDocFiles = [
  path.join(projectDir, "README.md"),
  path.join(projectDir, "qa", "README.md"),
  ...files.filter((file) => file.startsWith(path.join(projectDir, "docs") + path.sep) && file.endsWith(".md")),
];
let scriptCommands = 0;
for (const file of commandDocFiles) {
  const text = fs.readFileSync(file, "utf8");
  let fenceLanguage = null;
  for (const line of text.split(/\r?\n/u)) {
    const fence = line.match(/^```([^\s`]*)/u);
    if (fence) {
      fenceLanguage = fenceLanguage === null ? fence[1].toLowerCase() : null;
      continue;
    }
    if (fenceLanguage !== "bash" && fenceLanguage !== "sh" && fenceLanguage !== "shell") continue;
    const command = line.match(/^\s*(?:bash\s+)?((?:\.\/)?scripts\/[A-Za-z0-9._/-]+\.sh)(?:\s|$)/u);
    if (!command) continue;
    scriptCommands += 1;
    const relative = command[1].replace(/^\.\//u, "");
    const target = path.resolve(projectDir, relative);
    if (!fs.existsSync(target)) {
      failures.push(`${path.relative(projectDir, file)}: missing script command ${command[1]}`);
    } else if (command[1].startsWith("./") && (fs.statSync(target).mode & 0o111) === 0) {
      failures.push(`${path.relative(projectDir, file)}: script command is not executable ${command[1]}`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Docs/JSON validation: PASS (${files.filter((f) => f.endsWith(".md")).length} markdown, ${links} local links, ${scriptCommands} script commands, ${files.filter((f) => f.endsWith(".json")).length} JSON)`);
}
