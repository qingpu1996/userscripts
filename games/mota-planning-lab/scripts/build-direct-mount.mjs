#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(projectDir, "../..");
const config = JSON.parse(fs.readFileSync(path.join(projectDir, "userscript.config.json"), "utf8"));
const sources = config.sources.map((relative) => {
  const source = fs.readFileSync(path.join(repoDir, relative), "utf8").trimEnd();
  if (!relative.endsWith("/runtime-mode.js")) return source;
  const marker = 'MotaLab.RUNTIME_MODE = "userscript";';
  if (!source.includes(marker)) throw new Error("userscript runtime marker is missing");
  return source.replace(marker, 'MotaLab.RUNTIME_MODE = "direct-mount";');
});
const output = `/* Mota Planning Lab v2 direct mount; local audited artifact. */\n(() => {\n${sources.join("\n\n")}\n})();\n`;
const outputPath = path.join(repoDir, "dist", "mota-planning-lab.direct-mount.js");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, "utf8");
console.log(path.relative(repoDir, outputPath));
