#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./vendor/acorn-8.16.0/acorn.mjs";
import { structuredRuntimeViolations, verifyAstVendor } from "./ast-runtime-compliance.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(projectDir, "../..");
const engineAdapterPath = path.join(projectDir, "src", "engine-adapter.js");
const sourceDir = path.join(projectDir, "src");
const serviceDir = path.join(projectDir, "service", "mota_lab");
const userscriptConfigPath = path.join(projectDir, "userscript.config.json");
const distPaths = [
  path.join(repoDir, "dist", "mota-planning-lab.user.js"),
  path.join(repoDir, "dist", "mota-planning-lab.direct-mount.js"),
];

export const READ_ONLY_ENGINE_APIS = Object.freeze([
  "canMoveDirectly", "getDamage", "getEnemyInfo", "getMapBlocksObj", "isMoving",
]);
export const ACTION_ENGINE_APIS = Object.freeze([
  "moveDirectly", "setAutomaticRoute", "stopAutomaticRoute",
]);

const MUTATOR_METHODS = new Set([
  "add", "clear", "copyWithin", "delete", "fill", "pop", "push", "reverse",
  "set", "shift", "sort", "splice", "unshift",
]);
const STATIC_MUTATORS = new Set([
  "Object.assign", "Object.defineProperties", "Object.defineProperty",
  "Object.preventExtensions", "Object.seal", "Object.setPrototypeOf",
  "Reflect.defineProperty", "Reflect.deleteProperty", "Reflect.preventExtensions",
  "Reflect.set", "Reflect.setPrototypeOf",
]);

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  visitor(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visitor, node));
    else walk(value, visitor, node);
  }
}

function memberName(node) {
  if (!node || node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal"
    && typeof node.property.value === "string") return node.property.value;
  return null;
}

function dottedName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return null;
  const left = dottedName(node.object);
  const right = memberName(node);
  return left && right ? `${left}.${right}` : null;
}

function expressionTouchesAuthority(node, tainted) {
  let found = false;
  walk(node, (current) => {
    if (current.type === "Identifier" && tainted.has(current.name)) found = true;
    if (current.type === "MemberExpression" && dottedName(current) === "scope.core") found = true;
    if (current.type === "CallExpression" && current.callee.type === "Identifier"
      && ["currentCore", "requireRuntime"].includes(current.callee.name)) found = true;
  });
  return found;
}

function recursiveFiles(root, extension) {
  const found = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(extension)) found.push(absolute);
    }
  }
  visit(root);
  return found.sort();
}

export function discoverProductionSources() {
  const browserFiles = recursiveFiles(sourceDir, ".js");
  const serviceFiles = recursiveFiles(serviceDir, ".py");
  const config = JSON.parse(fs.readFileSync(userscriptConfigPath, "utf8"));
  const manifestFiles = (Array.isArray(config.sources) ? config.sources : [])
    .map((relative) => path.resolve(repoDir, relative)).sort();
  const browserSet = new Set(browserFiles);
  const manifestSet = new Set(manifestFiles);
  const failures = [];
  for (const file of browserFiles) {
    if (!manifestSet.has(file)) {
      failures.push(`${path.relative(repoDir, file)}: production source missing from userscript manifest`);
    }
  }
  for (const file of manifestFiles) {
    if (!browserSet.has(file)) {
      failures.push(`${path.relative(repoDir, file)}: userscript manifest entry is not a discovered src production module`);
    }
  }
  if (manifestSet.size !== manifestFiles.length) {
    failures.push("userscript manifest contains duplicate production source entries");
  }
  return { browserFiles, serviceFiles, manifestFiles, failures };
}

export function auditEngineAdapter(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  // Deliberate inventory of the authoritative references in the actual
  // adapter.  This is reviewed when engine-adapter changes; derived snapshot
  // values are intentionally absent because mutating them is local work.
  const tainted = new Set([
    "core", "runtime", "hero", "loc", "maps", "currentMap", "dynamicGrid",
    "declaredValidCells", "eventState", "info",
  ]);
  const engineAliases = new Set(["core", "runtime"]);
  const memberAliases = new Map();
  const dynamicMemberAliases = new Set();
  const failures = [];
  const failureKeys = new Set();
  function fail(node, reason) {
    const key = `${node.start}:${reason}`;
    if (failureKeys.has(key)) return;
    failureKeys.add(key);
    failures.push({ start: node.start, reason });
  }
  function dynamicEngineFailure(node) {
    fail(node, "UNCLASSIFIED_ENGINE_API: DYNAMIC_ENGINE_API: unclassified engine API call: <dynamic>");
  }

  function isCoreMember(node) {
    if (!node || node.type !== "MemberExpression" || memberName(node) !== "core") return false;
    const owner = dottedName(node.object);
    return ["scope", "globalThis", "window", "unsafeWindow"].includes(owner);
  }
  function isEngineExpression(node) {
    if (!node) return false;
    if (node.type === "Identifier") return engineAliases.has(node.name);
    if (node.type === "MemberExpression") return isCoreMember(node);
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      return ["currentCore", "requireRuntime"].includes(node.callee.name);
    }
    if (node.type === "SequenceExpression" && node.expressions.length > 0) {
      return isEngineExpression(node.expressions[node.expressions.length - 1]);
    }
    if (node.type === "LogicalExpression" || node.type === "ConditionalExpression") {
      const candidates = node.type === "ConditionalExpression"
        ? [node.consequent, node.alternate] : [node.left, node.right];
      return candidates.some(isEngineExpression);
    }
    return false;
  }
  function engineMemberReference(node) {
    if (!node) return null;
    if (node.type === "MemberExpression" && isEngineExpression(node.object)) {
      const method = memberName(node);
      return method === null ? { dynamic: true, method: null } : { dynamic: false, method };
    }
    if (node.type === "Identifier") {
      if (dynamicMemberAliases.has(node.name)) return { dynamic: true, method: null };
      if (memberAliases.has(node.name)) {
        return { dynamic: false, method: memberAliases.get(node.name) };
      }
    }
    return null;
  }
  function boundEngineMember(node) {
    if (!node || node.type !== "CallExpression" || node.callee.type !== "MemberExpression"
      || memberName(node.callee) !== "bind") return null;
    return engineMemberReference(node.callee.object);
  }
  function patternIdentifier(pattern) {
    if (!pattern) return null;
    if (pattern.type === "Identifier") return pattern.name;
    if (pattern.type === "AssignmentPattern") return patternIdentifier(pattern.left);
    return null;
  }
  function rememberMemberAlias(name, reference) {
    if (!reference) return false;
    if (reference.dynamic) {
      const changedAlias = memberAliases.delete(name);
      if (dynamicMemberAliases.has(name)) return changedAlias;
      dynamicMemberAliases.add(name);
      return true;
    }
    if (dynamicMemberAliases.has(name)) return false;
    const existing = memberAliases.get(name);
    if (existing === undefined) {
      memberAliases.set(name, reference.method);
      return true;
    }
    if (existing === reference.method) return false;
    memberAliases.delete(name);
    dynamicMemberAliases.add(name);
    return true;
  }

  // Resolve the deliberately supported, nearby alias forms to a fixed point.
  // This is an inventory gate for this controlled adapter, not a general JS
  // interpreter: anything outside the forms below remains unclassified.
  let changed = true;
  while (changed) {
    changed = false;
    walk(ast, (node) => {
      if (node.type !== "VariableDeclarator" && node.type !== "AssignmentExpression") return;
      const target = node.type === "VariableDeclarator" ? node.id : node.left;
      const value = node.type === "VariableDeclarator" ? node.init : node.right;
      if (!value) return;
      if (target.type === "Identifier") {
        if (isEngineExpression(value) && !engineAliases.has(target.name)) {
          engineAliases.add(target.name);
          tainted.add(target.name);
          changed = true;
        }
        const directMember = engineMemberReference(value);
        const boundMember = boundEngineMember(value);
        const aliasedMember = value.type === "Identifier"
          ? engineMemberReference(value) : null;
        if (rememberMemberAlias(target.name, directMember || boundMember || aliasedMember)) changed = true;
      } else if (target.type === "ObjectPattern" && isEngineExpression(value)) {
        for (const property of target.properties) {
          if (property.type !== "Property") continue;
          const staticComputed = property.computed && property.key.type === "Literal"
            && typeof property.key.value === "string";
          const dynamic = property.computed && !staticComputed;
          const method = staticComputed ? String(property.key.value) : property.key.name;
          const local = patternIdentifier(property.value);
          if (local && rememberMemberAlias(local, dynamic
            ? { dynamic: true, method: null } : { dynamic: false, method })) changed = true;
        }
      }
    });
  }

  const calls = { read: [], action: [] };
  const readSet = new Set(READ_ONLY_ENGINE_APIS);
  const actionSet = new Set(ACTION_ENGINE_APIS);
  function targetIsAuthority(node) {
    if (!node) return false;
    if (node.type === "MemberExpression") return expressionTouchesAuthority(node, tainted);
    if (["ArrayPattern", "ObjectPattern", "AssignmentPattern", "RestElement"].includes(node.type)) {
      return expressionTouchesAuthority(node, tainted);
    }
    return false;
  }
  function valueIsAuthority(node) { return expressionTouchesAuthority(node, tainted); }

  function classifyCall(node) {
    if (!node || node.type !== "CallExpression") return { engine: false, method: null };
    const direct = engineMemberReference(node.callee);
    if (direct) {
      return { engine: true, ...direct };
    }
    if (node.callee.type === "MemberExpression"
      && ["call", "apply", "bind"].includes(memberName(node.callee))) {
      const wrapped = engineMemberReference(node.callee.object);
      if (wrapped) return { engine: true, ...wrapped };
    }
    const immediatelyBound = boundEngineMember(node.callee);
    return immediatelyBound
      ? { engine: true, ...immediatelyBound }
      : { engine: false, method: null };
  }

  function recordEngineCall(node, method, dynamic = false) {
    if (dynamic) {
      dynamicEngineFailure(node);
      return;
    }
    if (readSet.has(method)) calls.read.push(method);
    else if (actionSet.has(method)) calls.action.push(method);
    else fail(node, `UNCLASSIFIED_ENGINE_API: unclassified engine API call: ${String(method)}`);
  }

  walk(ast, (node) => {
    if (node.type === "MemberExpression" && isEngineExpression(node.object)
      && memberName(node) === null) {
      dynamicEngineFailure(node);
    }
    if ((node.type === "VariableDeclarator" || node.type === "AssignmentExpression")) {
      const target = node.type === "VariableDeclarator" ? node.id : node.left;
      const value = node.type === "VariableDeclarator" ? node.init : node.right;
      if (target && target.type === "ObjectPattern" && isEngineExpression(value)) {
        for (const property of target.properties) {
          if (property.type === "Property" && property.computed
            && !(property.key.type === "Literal" && typeof property.key.value === "string")) {
            dynamicEngineFailure(property);
          }
        }
      }
    }
    if (node.type === "AssignmentExpression" && targetIsAuthority(node.left)) {
      fail(node, "assignment to authoritative runtime alias");
    } else if (node.type === "UpdateExpression" && targetIsAuthority(node.argument)) {
      fail(node, "update of authoritative runtime alias");
    } else if (node.type === "UnaryExpression" && node.operator === "delete"
      && targetIsAuthority(node.argument)) {
      fail(node, "delete from authoritative runtime alias");
    }
    if (node.type !== "CallExpression") return;
    const staticName = dottedName(node.callee);
    if (STATIC_MUTATORS.has(staticName) && node.arguments[0]
      && valueIsAuthority(node.arguments[0])) {
      fail(node, `${staticName} targets authoritative runtime alias`);
    }
    if (node.callee.type === "MemberExpression") {
      const method = memberName(node.callee);
      if (MUTATOR_METHODS.has(method) && valueIsAuthority(node.callee.object)) {
        fail(node, `${method} mutates authoritative runtime alias`);
      }
    }
    const classified = classifyCall(node);
    if (classified.engine) recordEngineCall(node, classified.method, classified.dynamic);
  });
  return {
    failures,
    calls: {
      read: [...new Set(calls.read)].sort(),
      action: [...new Set(calls.action)].sort(),
    },
    tainted_bindings: [...tainted].sort(),
    engine_aliases: [...engineAliases].sort(),
    engine_member_aliases: Object.fromEntries([
      ...memberAliases,
      ...[...dynamicMemberAliases].map((name) => [name, "<dynamic-engine-api>"]),
    ].sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function auditProductionTree(options = {}) {
  verifyAstVendor();
  const discovered = discoverProductionSources();
  const failures = discovered.failures.slice();
  const jsFiles = discovered.browserFiles;
  const pythonFiles = discovered.serviceFiles;
  for (const file of [...jsFiles, ...distPaths]) {
    const source = fs.readFileSync(file, "utf8");
    for (const violation of structuredRuntimeViolations(source)) {
      failures.push(`${path.relative(repoDir, file)}:${violation.start}:${violation.code}`);
    }
  }
  for (const file of pythonFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (/\b(?:unsafeWindow|globalThis\.core|window\.core)\b/u.test(source)) {
      failures.push(`${path.relative(repoDir, file)}: browser runtime bridge in service source`);
    }
  }
  const adapterSource = typeof options.engineAdapterSource === "string"
    ? options.engineAdapterSource : fs.readFileSync(engineAdapterPath, "utf8");
  const adapter = auditEngineAdapter(adapterSource);
  for (const failure of adapter.failures) {
    failures.push(`${path.relative(repoDir, engineAdapterPath)}:${failure.start}:${failure.reason}`);
  }
  if (adapter.calls.action.join(",") !== ACTION_ENGINE_APIS.slice().sort().join(",")) {
    failures.push(`engine action API inventory changed: ${adapter.calls.action.join(",")}`);
  }
  for (const call of adapter.calls.read) {
    if (!READ_ONLY_ENGINE_APIS.includes(call)) failures.push(`unapproved read API: ${call}`);
  }
  return {
    status: failures.length === 0 ? "pass" : "fail",
    scope: {
      browser_sources: jsFiles.length,
      service_sources: pythonFiles.length,
      dist_artifacts: distPaths.length,
      manifest_sources: discovered.manifestFiles.length,
      discovery: "recursive-src-and-service-with-exact-userscript-manifest-match",
    },
    engine_api_inventory: adapter.calls,
    engine_api_aliases: {
      objects: adapter.engine_aliases,
      members: adapter.engine_member_aliases,
    },
    authoritative_aliases_reviewed: adapter.tainted_bindings,
    failures,
    assurance: "controlled-project-source-audit-not-a-javascript-sandbox",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditProductionTree();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") process.exitCode = 1;
}
