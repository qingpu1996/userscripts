#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const gamesDir = path.join(rootDir, "games");
const metadataOrder = [
  "name",
  "namespace",
  "version",
  "description",
  "match",
  "grant",
  "run-at",
  "updateURL",
  "downloadURL",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findConfigs(slug) {
  if (slug) {
    return [path.join(gamesDir, slug, "userscript.config.json")];
  }

  return fs.readdirSync(gamesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(gamesDir, entry.name, "userscript.config.json"))
    .filter((filePath) => fs.existsSync(filePath));
}

function rawUrl(config) {
  if (!config.rawBaseUrl) {
    return null;
  }

  return `${config.rawBaseUrl.replace(/\/$/, "")}/${config.output}`;
}

function metadataEntries(config) {
  const metadata = Object.assign({}, config.metadata);
  const url = rawUrl(config);

  if (url) {
    metadata.updateURL ||= url;
    metadata.downloadURL ||= url;
  }

  const keys = [
    ...metadataOrder.filter((key) => Object.prototype.hasOwnProperty.call(metadata, key)),
    ...Object.keys(metadata).filter((key) => !metadataOrder.includes(key)),
  ];

  const entries = [];

  for (const key of keys) {
    const value = metadata[key];

    if (Array.isArray(value)) {
      if (key === "grant" && value.length === 0) {
        entries.push([key, "none"]);
        continue;
      }

      for (const item of value) {
        entries.push([key, item]);
      }
      continue;
    }

    entries.push([key, value]);
  }

  return entries;
}

function renderHeader(config) {
  const entries = metadataEntries(config);
  const keyWidth = Math.max(...entries.map(([key]) => key.length), 1);
  const lines = ["// ==UserScript=="];

  for (const [key, value] of entries) {
    lines.push(`// @${key.padEnd(keyWidth)}  ${value}`);
  }

  lines.push("// ==/UserScript==");
  return lines.join("\n");
}

function indentSource(source) {
  return source
    .replace(/\s+$/u, "")
    .split("\n")
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n");
}

function renderSourceFile(sourcePath) {
  const fullPath = path.join(rootDir, sourcePath);
  const source = fs.readFileSync(fullPath, "utf8");

  return [
    `  // Source: ${sourcePath}`,
    "",
    indentSource(source),
  ].join("\n");
}

function build(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing userscript config: ${path.relative(rootDir, configPath)}`);
  }

  const config = readJson(configPath);
  const outputPath = path.join(rootDir, config.output);
  const body = config.sources.map(renderSourceFile).join("\n\n");
  const output = [
    renderHeader(config),
    "",
    "// This file is generated. Edit shared/ or games/*/src/ and rebuild it.",
    "(function () {",
    "  \"use strict\";",
    "",
    body,
    "})();",
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  console.log(`Built ${config.output}`);
}

const slug = process.argv[2];
const configs = findConfigs(slug);

if (configs.length === 0) {
  throw new Error(slug ? `No userscript config found for ${slug}` : "No userscript configs found");
}

for (const configPath of configs) {
  build(configPath);
}
