import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./vendor/acorn-8.16.0/acorn.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(scriptDir, "vendor", "acorn-8.16.0");
const EXPECTED_VENDOR_HASHES = Object.freeze({
  "acorn.mjs": "efb0124a960b34d53f9928c4926bfcfd300bb6a3d7ab64ee949b3a8bed1c7e5f",
  LICENSE: "76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7",
  "PROVENANCE.md": "5a848c0a053f52a1cd9802aef0708ac49d35545730e892e3f72a71e059f3ef69",
});

export function verifyAstVendor() {
  for (const [name, expected] of Object.entries(EXPECTED_VENDOR_HASHES)) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(vendorDir, name))).digest("hex");
    if (actual !== expected) throw new Error(`Vendored Acorn integrity mismatch: ${name}`);
  }
  return true;
}

const LOCAL = Object.freeze({ kind: "local" });
const UNKNOWN = Object.freeze({ kind: "unknown" });
const GLOBAL = Object.freeze({ kind: "global" });
const MUTATION_METHODS = new Set([
  "Object.assign", "Object.defineProperty", "Object.defineProperties", "Object.setPrototypeOf",
  "Object.freeze", "Object.seal", "Object.preventExtensions",
  "Reflect.set", "Reflect.deleteProperty", "Reflect.defineProperty", "Reflect.setPrototypeOf",
  "Reflect.preventExtensions",
]);
const CONTAINER_MUTATION_METHODS = new Set([
  "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "copyWithin", "fill",
  "set", "add", "delete", "clear",
]);
const MEMOIZABLE_RESULT_KINDS = new Set([
  "constant", "runtime", "local", "unknown", "global", "builtin",
]);

function runtime(pathParts = []) { return { kind: "runtime", path: pathParts }; }
function builtin(name) { return { kind: "builtin", name }; }
function mutation(method, target = null, bound = []) { return { kind: "mutation", method, target, bound }; }
function wrapper(callable, wrapperName) {
  return { kind: "wrapper", callable, wrapper: wrapperName };
}
function constant(value) { return { kind: "constant", value }; }
function functionValue(node, closure) { return { kind: "function", node, closure }; }
function arrayValue(elements, fallback = null) { return { kind: "array", elements, fallback, owners: new Set() }; }
function objectValue(properties, fallback = null) { return { kind: "object", properties, fallback, owners: new Set() }; }
function mapValue(entries = new Map(), fallback = null) { return { kind: "map", entries, fallback, owners: new Set() }; }
function setValue(elements = [], fallback = null) { return { kind: "set", elements, fallback, owners: new Set() }; }
function iteratorValue(element) { return { kind: "iterator", element }; }
function native(method, target = null) { return { kind: "native", method, target }; }

class AnalysisLimit extends Error {
  constructor(node, reason) {
    super(reason);
    this.node = node;
    this.reason = reason;
  }
}

class Scope {
  constructor(parent = null, identity = 0) {
    this.parent = parent;
    this.identity = identity;
    this.bindings = new Map();
    this.revision = 0;
  }
  declare(name, value = LOCAL) {
    this.bindings.set(name, value);
    this.revision += 1;
    return this;
  }
  assign(name, value) {
    if (this.bindings.has(name)) {
      this.bindings.set(name, value);
      this.revision += 1;
      return this;
    }
    if (this.parent) return this.parent.assign(name, value);
    this.bindings.set(name, value);
    this.revision += 1;
    return this;
  }
  lookup(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent ? this.parent.lookup(name) : null;
  }
}

function patternNames(pattern, names = []) {
  if (!pattern) return names;
  if (pattern.type === "Identifier") names.push(pattern.name);
  else if (pattern.type === "RestElement") patternNames(pattern.argument, names);
  else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, names);
  else if (pattern.type === "ArrayPattern") {
    for (const item of pattern.elements) patternNames(item, names);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) patternNames(property.value || property.argument, names);
  }
  return names;
}

function predeclareStatements(statements, scope) {
  for (const statement of statements || []) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        for (const name of patternNames(declaration.id)) scope.declare(name, LOCAL);
      }
    } else if (statement.type === "FunctionDeclaration" && statement.id) {
      scope.declare(statement.id.name, functionValue(statement, scope));
    } else if (statement.type === "ClassDeclaration" && statement.id) scope.declare(statement.id.name, LOCAL);
  }
}

export function structuredRuntimeViolations(source, options = {}) {
  const maxSourceLength = Number.isSafeInteger(options.maxSourceLength) && options.maxSourceLength > 0
    ? options.maxSourceLength : 2_000_000;
  if (source.length > maxSourceLength) {
    return [{ code: "UNSAFE_RUNTIME_MUTATION_ANALYSIS", start: 0,
      root: "analysis", properties: ["source-length"] }];
  }
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest", sourceType: "script", allowHashBang: true,
      preserveParens: true, locations: false,
    });
  } catch (error) {
    return [{ code: "SYNTAX_ERROR", start: Number.isInteger(error.pos) ? error.pos : 0,
      root: "parser", properties: [] }];
  }
  // This is a project lint, not a JavaScript sandbox or a proof over arbitrary
  // programs.  Reject a few identity-producing constructs that are outside the
  // deliberately supported subset instead of growing the analysis into an
  // interpreter.  Production sources are also checked by the independent
  // allowlist/instrumentation gates; these diagnostics only prevent unsupported
  // syntax from entering that controlled source set silently.
  const unsupported = [];
  const SAFE_CONSTRUCTORS = new Set([
    "AbortController", "Array", "Blob", "BlobType", "Boolean", "Date", "Error", "Map",
    "Number", "Object", "Promise", "RegExp", "Set", "String", "TypeError",
    "URL", "WeakMap", "WeakSet",
  ]);
  function unsupportedMemberName(member) {
    if (!member || member.type !== "MemberExpression") return null;
    if (!member.computed && member.property.type === "Identifier") return member.property.name;
    if (member.computed && member.property.type === "Literal"
      && typeof member.property.value === "string") return member.property.value;
    return null;
  }
  function containsNestedCallable(node, rootCallable) {
    let found = false;
    function visit(value) {
      if (found || !value || typeof value !== "object") return;
      if (value !== rootCallable && [
        "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration",
      ].includes(value.type)) {
        found = true;
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (["start", "end", "loc"].includes(key)) continue;
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    }
    visit(node);
    return found;
  }
  function visitUnsupported(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ThisExpression") {
      let cursor = parent;
      while (cursor && ![
        "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration",
      ].includes(cursor.type)) cursor = cursor.__lintParent || null;
      const propertyMethod = cursor?.__lintParent?.type === "Property"
        && cursor.__lintParent.method === true;
      if (cursor && cursor.type !== "ArrowFunctionExpression" && !propertyMethod) {
        unsupported.push({ start: node.start, reason: "unsupported-bound-this" });
      }
    }
    if (node.type === "NewExpression" && node.callee.type === "Identifier"
      && !SAFE_CONSTRUCTORS.has(node.callee.name)) {
      unsupported.push({ start: node.start, reason: "unsupported-user-constructor" });
    }
    if (node.type === "CallExpression" && ["map", "flatMap"].includes(unsupportedMemberName(node.callee))) {
      const callback = node.arguments[0];
      if (callback && ["ArrowFunctionExpression", "FunctionExpression"].includes(callback.type)
        && containsNestedCallable(callback.body, callback)) {
        unsupported.push({ start: callback.start, reason: "unsupported-identity-callback" });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (["start", "end", "loc", "__lintParent"].includes(key)) continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object") {
            Object.defineProperty(item, "__lintParent", { value: node, configurable: true });
            visitUnsupported(item, node);
          }
        }
      } else if (child && typeof child === "object") {
        Object.defineProperty(child, "__lintParent", { value: node, configurable: true });
        visitUnsupported(child, node);
      }
    }
  }
  visitUnsupported(ast);
  if (unsupported.length > 0) {
    return unsupported.map((item) => ({
      code: "UNSAFE_RUNTIME_MUTATION_ANALYSIS",
      start: item.start,
      root: "analysis",
      properties: [item.reason],
    }));
  }
  const violations = [];
  const reported = new Set();
  const activeFunctions = new Set();
  const returnCollectors = [];
  const functionMemo = new WeakMap();
  const maxSteps = Number.isSafeInteger(options.maxSteps) && options.maxSteps > 0
    ? options.maxSteps : 500_000;
  const maxCallDepth = Number.isSafeInteger(options.maxCallDepth) && options.maxCallDepth > 0
    ? options.maxCallDepth : 128;
  let steps = 0;
  let callDepth = 0;
  let nextScopeIdentity = 1;

  function newScope(parent = null) {
    return new Scope(parent, nextScopeIdentity++);
  }

  function registerValueOwner(value, scope, seen = new Set()) {
    if (!value || !scope || seen.has(value)) return;
    seen.add(value);
    if (!["array", "object", "map", "set", "iterator"].includes(value.kind)) return;
    if (value.owners) value.owners.add(scope);
    if (value.kind === "array" || value.kind === "set") {
      for (const item of value.elements) registerValueOwner(item, scope, seen);
      registerValueOwner(value.fallback, scope, seen);
    } else if (value.kind === "object") {
      for (const item of value.properties.values()) registerValueOwner(item, scope, seen);
      registerValueOwner(value.fallback, scope, seen);
    } else if (value.kind === "map") {
      for (const item of value.entries.values()) registerValueOwner(item, scope, seen);
      registerValueOwner(value.fallback, scope, seen);
    } else if (value.kind === "iterator") registerValueOwner(value.element, scope, seen);
  }

  function noteContainerMutation(target, insertedValues = []) {
    const owners = target?.owners ? [...target.owners] : [];
    for (const owner of owners) owner.revision += 1;
    for (const value of insertedValues) {
      for (const owner of owners) registerValueOwner(value, owner);
    }
  }

  function consume(node) {
    steps += 1;
    if (steps > maxSteps) throw new AnalysisLimit(node, "step-budget");
  }

  function report(code, node, value) {
    const identity = `${code}:${node.start}`;
    if (reported.has(identity)) return;
    reported.add(identity);
    violations.push({ code, start: node.start,
      root: value?.root || "ast", properties: value?.path || [] });
  }

  function valueSignature(value, seen = new Set()) {
    if (!value) return "null";
    if (seen.has(value)) return `${value.kind}:cycle`;
    if (value.kind === "runtime") return `runtime:${value.path.join(".")}`;
    if (value.kind === "constant") return `constant:${JSON.stringify(value.value)}`;
    if (["unknown", "local", "global"].includes(value.kind)) return value.kind;
    seen.add(value);
    if (value.kind === "array" || value.kind === "set") {
      return `${value.kind}:[${value.elements.map((item) => valueSignature(item, seen)).join(",")}]`
        + `:${valueSignature(value.fallback, seen)}`;
    }
    if (value.kind === "object" || value.kind === "map") {
      const entries = value.kind === "object" ? value.properties : value.entries;
      return `${value.kind}:{${[...entries].map(([key, item]) => (
        `${key}=${valueSignature(item, seen)}`
      )).join(",")}}:${valueSignature(value.fallback, seen)}`;
    }
    if (value.kind === "iterator") return `iterator:${valueSignature(value.element, seen)}`;
    if (value.kind === "function") {
      return `function:${value.node.start}@${scopeSignature(value.closure)}`;
    }
    if (value.kind === "builtin") return `builtin:${value.name}`;
    if (value.kind === "native") return `native:${value.method}:${valueSignature(value.target, seen)}`;
    if (value.kind === "mutation") return `mutation:${value.method}:${valueSignature(value.target, seen)}`;
    return value.kind;
  }

  function memoizableResult(value) {
    // A function may return either a captured container (the same JS object on
    // every call) or a freshly allocated container (a distinct object on every
    // call). A value-only summary cannot distinguish those allocation effects.
    // Caching either a clone or the original is therefore unsound: cloning
    // breaks captured aliases, while sharing invents aliases for fresh values.
    // Callable summaries can carry the same allocation-sensitive identity via
    // a closure, bound arguments, or an abstract receiver. Keep only genuinely
    // scalar/runtime-immutable DAG summaries; re-evaluate heap/callable results.
    return !value || MEMOIZABLE_RESULT_KINDS.has(value.kind);
  }

  function scopeSignature(scope) {
    const revisions = [];
    for (let current = scope; current; current = current.parent) {
      revisions.push(`${current.identity}:${current.revision}`);
    }
    return revisions.join("/");
  }

  function propertyName(node, scope) {
    if (!node) return null;
    if (!node.computed && node.property.type === "Identifier") return node.property.name;
    const value = evaluate(node.property, scope);
    return value.kind === "constant"
      && (typeof value.value === "string" || Number.isSafeInteger(value.value))
      ? String(value.value) : null;
  }

  function memberValue(objectValue, property) {
    if (property === null) {
      if (objectValue.kind === "runtime") return runtime([...objectValue.path, "*"]);
      const candidates = objectValue.kind === "array" || objectValue.kind === "set"
        ? objectValue.elements
        : (objectValue.kind === "object" ? [...objectValue.properties.values()]
          : (objectValue.kind === "map" ? [...objectValue.entries.values()] : []));
      const carried = candidates.map((value) => runtimeReference(value)).find((value) => value !== null);
      return carried || (objectValue.fallback ? runtimeReference(objectValue.fallback) : null) || UNKNOWN;
    }
    if (objectValue.kind === "global") {
      if (property === "core") return runtime([]);
      if (["window", "unsafeWindow", "globalThis", "windowScope"].includes(property)) return GLOBAL;
      return UNKNOWN;
    }
    if (objectValue.kind === "runtime") {
      if (CONTAINER_MUTATION_METHODS.has(property)) {
        return mutation(`container.${property}`, objectValue);
      }
      return runtime([...objectValue.path, property]);
    }
    if (objectValue.kind === "array") {
      if (/^\d+$/u.test(property)) {
        return objectValue.elements[Number(property)]
          || (objectValue.fallback ? memberValue(objectValue.fallback, "*") : UNKNOWN);
      }
      if (CONTAINER_MUTATION_METHODS.has(property)) {
        return mutation(`container.${property}`, objectValue);
      }
      if (["values", "keys", "entries"].includes(property)) return native(`array.${property}`, objectValue);
      if (["slice", "concat", "flat"].includes(property)) return native(`array.${property}`, objectValue);
      if (["at", "find", "findLast", "filter", "map", "flatMap", "forEach", "some", "every", "reduce"]
        .includes(property)) return native(`array.${property}`, objectValue);
      if (["includes", "indexOf", "lastIndexOf", "join"].includes(property)) {
        return native("safe.read", objectValue);
      }
      return native("unsupported.carrier-call", objectValue);
    }
    if (objectValue.kind === "object") {
      return objectValue.properties.get(property)
        || (objectValue.fallback ? memberValue(objectValue.fallback, property) : UNKNOWN);
    }
    if (objectValue.kind === "map") {
      if (["set", "delete", "clear"].includes(property)) {
        return mutation(`container.${property}`, objectValue);
      }
      if (["get", "values", "keys", "entries", "forEach"].includes(property)) {
        return native(`map.${property}`, objectValue);
      }
      if (property === "has") return native("safe.read", objectValue);
      return native("unsupported.carrier-call", objectValue);
    }
    if (objectValue.kind === "set") {
      if (["add", "delete", "clear"].includes(property)) {
        return mutation(`container.${property}`, objectValue);
      }
      if (["values", "keys", "entries", "forEach"].includes(property)) return native(`set.${property}`, objectValue);
      if (property === "has") return native("safe.read", objectValue);
      return native("unsupported.carrier-call", objectValue);
    }
    if (objectValue.kind === "iterator" && property === "next") return native("iterator.next", objectValue);
    if (objectValue.kind === "builtin") {
      const method = `${objectValue.name}.${property}`;
      if (MUTATION_METHODS.has(method)
        || (["Array.prototype", "Map.prototype", "Set.prototype"].includes(objectValue.name)
          && CONTAINER_MUTATION_METHODS.has(property))) return mutation(method);
      if (["Array", "Map", "Set"].includes(objectValue.name) && property === "prototype") {
        return builtin(`${objectValue.name}.prototype`);
      }
      if (objectValue.name === "Array.prototype"
        && ["values", "keys", "entries", "slice", "concat", "flat", "at", "find", "findLast",
          "filter", "map", "flatMap", "forEach", "some", "every", "reduce"].includes(property)) {
        return native(`array.${property}`);
      }
      if (objectValue.name === "Map.prototype"
        && ["get", "values", "keys", "entries", "forEach"].includes(property)) return native(`map.${property}`);
      if (objectValue.name === "Set.prototype"
        && ["values", "keys", "entries", "forEach"].includes(property)) return native(`set.${property}`);
      return builtin(method);
    }
    if (objectValue.kind === "mutation" && ["call", "apply", "bind"].includes(property)) {
      return wrapper(objectValue, property);
    }
    if (["function", "bound-function", "native", "builtin"].includes(objectValue.kind)
      && ["call", "apply", "bind"].includes(property)) {
      return wrapper(objectValue, property);
    }
    return UNKNOWN;
  }

  function runtimeReference(value, seen = new Set()) {
    if (!value || seen.has(value)) return null;
    if (value.kind === "runtime") return value;
    seen.add(value);
    if (value.kind === "array") {
      for (const item of value.elements) {
        const found = runtimeReference(item, seen);
        if (found) return found;
      }
      return runtimeReference(value.fallback, seen);
    }
    if (value.kind === "object") {
      for (const item of value.properties.values()) {
        const found = runtimeReference(item, seen);
        if (found) return found;
      }
      return runtimeReference(value.fallback, seen);
    }
    if (value.kind === "map") {
      for (const item of value.entries.values()) {
        const found = runtimeReference(item, seen);
        if (found) return found;
      }
      return runtimeReference(value.fallback, seen);
    }
    if (value.kind === "set") {
      for (const item of value.elements) {
        const found = runtimeReference(item, seen);
        if (found) return found;
      }
      return runtimeReference(value.fallback, seen);
    }
    if (value.kind === "iterator") return runtimeReference(value.element, seen);
    return null;
  }

  function joinValues(left, right) {
    if (left.kind === right.kind) {
      if (left.kind === "global") return GLOBAL;
      if (left.kind === "runtime" && JSON.stringify(left.path) === JSON.stringify(right.path)) return left;
      if (left.kind === "constant" && left.value === right.value) return left;
    }
    if (left.kind === "global" || right.kind === "global") return GLOBAL;
    if (left.kind === "runtime" || right.kind === "runtime") {
      const candidate = left.kind === "runtime" ? left : right;
      return candidate;
    }
    return UNKNOWN;
  }

  function expandArray(value) {
    if (value?.kind === "array") return value.fallback
      ? [...value.elements, value.fallback] : value.elements;
    if (value?.kind === "object") {
      const length = value.properties.get("length");
      if (length?.kind === "constant" && Number.isSafeInteger(length.value) && length.value >= 0) {
        return Array.from({ length: length.value }, (_, index) => (
          value.properties.get(String(index)) || UNKNOWN
        ));
      }
      const elements = [];
      while (value.properties.has(String(elements.length))) {
        elements.push(value.properties.get(String(elements.length)));
      }
      return elements;
    }
    return [];
  }

  function aggregate(values, fallback = null) {
    const all = fallback ? [...values, fallback] : values;
    if (all.length === 0) return UNKNOWN;
    return all.reduce(joinValues);
  }

  function iterableElement(value) {
    if (!value) return UNKNOWN;
    if (value.kind === "iterator") return value.element;
    if (value.kind === "array" || value.kind === "set") {
      return aggregate(value.elements, value.fallback);
    }
    if (value.kind === "map") {
      const pairs = [...value.entries.entries()].map(([key, item]) => arrayValue([constant(key), item]));
      const fallback = value.fallback ? arrayValue([UNKNOWN, value.fallback]) : null;
      return aggregate(pairs, fallback);
    }
    if (value.kind === "runtime") return value;
    return UNKNOWN;
  }

  function localMutation(callable, args, target) {
    if (["array", "object", "map", "set"].includes(target?.kind)) {
      noteContainerMutation(target, args);
    }
    const containerMethod = callable.method.startsWith("container.")
      ? callable.method.slice("container.".length)
      : (callable.method.includes(".prototype.") ? callable.method.split(".prototype.")[1] : null);
    if (target?.kind === "array" && containerMethod) {
      const method = containerMethod;
      if (method === "push") target.elements.push(...args);
      else if (method === "unshift") target.elements.unshift(...args);
      else if (method === "pop") return target.elements.pop() || target.fallback || UNKNOWN;
      else if (method === "shift") return target.elements.shift() || target.fallback || UNKNOWN;
      else if (method === "fill" && args.length > 0) target.elements.fill(args[0]);
      else if (method === "reverse") target.elements.reverse();
      else if (method === "copyWithin") {
        const indexes = args.slice(0, 3).map((value, index) => (
          value?.kind === "constant" && Number.isInteger(value.value)
            ? value.value : (index === 2 ? target.elements.length : 0)
        ));
        target.elements.copyWithin(indexes[0], indexes[1], indexes[2]);
      }
      else if (method === "splice") {
        const start = args[0]?.kind === "constant" && Number.isInteger(args[0].value)
          ? args[0].value : 0;
        const count = args[1]?.kind === "constant" && Number.isInteger(args[1].value)
          ? args[1].value : target.elements.length;
        return arrayValue(target.elements.splice(start, count, ...args.slice(2)), target.fallback);
      }
      return target;
    }
    if (target?.kind === "map" && containerMethod) {
      if (containerMethod === "set") {
        const key = args[0]?.kind === "constant" ? String(args[0].value) : null;
        if (key === null) target.fallback = joinValues(target.fallback || UNKNOWN, args[1] || UNKNOWN);
        else target.entries.set(key, args[1] || UNKNOWN);
        return target;
      }
      if (containerMethod === "delete") {
        const key = args[0]?.kind === "constant" ? String(args[0].value) : null;
        if (key !== null) target.entries.delete(key);
        return UNKNOWN;
      }
      if (containerMethod === "clear") {
        target.entries.clear(); target.fallback = null; return UNKNOWN;
      }
    }
    if (target?.kind === "set" && containerMethod) {
      if (containerMethod === "add") { target.elements.push(args[0] || UNKNOWN); return target; }
      if (containerMethod === "clear") { target.elements.length = 0; target.fallback = null; }
      return UNKNOWN;
    }
    if (target?.kind === "object" && callable.method === "Object.assign") {
      for (const source of args.slice(1)) {
        if (source.kind === "object") {
          for (const [key, value] of source.properties) target.properties.set(key, value);
          target.fallback ||= source.fallback;
        } else if (source.kind === "runtime") target.fallback ||= source;
      }
      return target;
    }
    if (target?.kind === "object" && callable.method === "Object.defineProperties") {
      const descriptors = args[1];
      if (descriptors?.kind === "object") {
        for (const [key, descriptor] of descriptors.properties) {
          if (descriptor.kind === "object") {
            target.properties.set(key, descriptor.properties.get("value") || UNKNOWN);
          }
        }
      }
      return target;
    }
    if (target?.kind === "object"
      && ["Object.setPrototypeOf", "Reflect.setPrototypeOf"].includes(callable.method)) {
      target.fallback = args[1] || target.fallback;
      return target;
    }
    if (["object", "array"].includes(target?.kind) && callable.method === "Reflect.deleteProperty") {
      const key = args[1]?.kind === "constant" ? String(args[1].value) : null;
      if (key !== null && target.kind === "object") target.properties.delete(key);
      else if (key !== null && target.kind === "array" && /^\d+$/u.test(key)) {
        delete target.elements[Number(key)];
      }
      return target;
    }
    if (["Reflect.set", "Object.defineProperty", "Reflect.defineProperty"].includes(callable.method)
      && ["object", "array"].includes(target?.kind)) {
      const key = args[1]?.kind === "constant" ? String(args[1].value) : null;
      let value = args[2] || UNKNOWN;
      if (callable.method !== "Reflect.set" && value.kind === "object") {
        value = value.properties.get("value") || UNKNOWN;
      }
      if (key !== null && target.kind === "object") target.properties.set(key, value);
      else if (key !== null && target.kind === "array" && /^\d+$/u.test(key)) {
        target.elements[Number(key)] = value;
      } else if (key === null) target.fallback = joinValues(target.fallback || UNKNOWN, value);
      return target;
    }
    return UNKNOWN;
  }

  function callBuiltin(callable, args, node) {
    if (callable.name === "Reflect.apply") {
      return invoke(wrapper(args[0] || UNKNOWN, "apply"), [args[1] || UNKNOWN, args[2] || UNKNOWN], node);
    }
    if (callable.name === "Object.values") {
      const value = args[0] || UNKNOWN;
      if (value.kind === "object") return arrayValue([...value.properties.values()], value.fallback);
      if (value.kind === "runtime") return arrayValue([], value);
      return arrayValue([]);
    }
    if (callable.name === "Object.entries") {
      const value = args[0] || UNKNOWN;
      if (value.kind === "object") {
        return arrayValue([...value.properties].map(([key, item]) => arrayValue([constant(key), item])),
          value.fallback ? arrayValue([UNKNOWN, value.fallback]) : null);
      }
      if (value.kind === "runtime") return arrayValue([], arrayValue([UNKNOWN, value]));
      return arrayValue([]);
    }
    if (callable.name === "Object.keys") return arrayValue([]);
    if (callable.name === "Object.fromEntries") {
      const result = objectValue(new Map());
      for (const pair of expandArray(args[0])) {
        if (pair?.kind === "array" && pair.elements[0]?.kind === "constant") {
          result.properties.set(String(pair.elements[0].value), pair.elements[1] || UNKNOWN);
        } else {
          const carried = runtimeReference(pair);
          if (carried) result.fallback = carried;
        }
      }
      return result;
    }
    if (callable.name === "Array.from") {
      const value = args[0] || UNKNOWN;
      if (value.kind === "array") return arrayValue([...value.elements], value.fallback);
      return arrayValue([], iterableElement(value));
    }
    return UNKNOWN;
  }

  function callNative(callable, args, node) {
    const target = callable.target;
    if (callable.method === "safe.read") return UNKNOWN;
    if (callable.method === "unsupported.carrier-call") {
      const carried = runtimeReference(target);
      if (carried) report("UNSAFE_RUNTIME_MUTATION_ANALYSIS", node, carried);
      return UNKNOWN;
    }
    if (callable.method === "array.values") return iteratorValue(iterableElement(target));
    if (callable.method === "array.keys") return iteratorValue(UNKNOWN);
    if (callable.method === "array.entries") {
      return iteratorValue(arrayValue([UNKNOWN, iterableElement(target)]));
    }
    if (callable.method === "array.slice") return arrayValue([...target.elements], target.fallback);
    if (callable.method === "array.concat") {
      const result = arrayValue([...target.elements], target.fallback);
      for (const value of args) {
        if (value.kind === "array") {
          result.elements.push(...value.elements); result.fallback ||= value.fallback;
        } else result.elements.push(value);
      }
      return result;
    }
    if (callable.method === "array.flat") return arrayValue(target.elements.flatMap((item) => (
      item.kind === "array" ? item.elements : [item]
    )), target.fallback);
    if (callable.method === "array.at") {
      const index = args[0]?.kind === "constant" && Number.isInteger(args[0].value) ? args[0].value : null;
      if (index === null) return iterableElement(target);
      const normalized = index < 0 ? target.elements.length + index : index;
      return target.elements[normalized] || target.fallback || UNKNOWN;
    }
    if (["array.find", "array.findLast"].includes(callable.method)) {
      if (args[0]) callCallable(args[0], [iterableElement(target), UNKNOWN, target], node);
      return iterableElement(target);
    }
    if (callable.method === "array.filter") {
      if (args[0]) callCallable(args[0], [iterableElement(target), UNKNOWN, target], node);
      return arrayValue([...target.elements], target.fallback);
    }
    if (["array.map", "array.flatMap"].includes(callable.method)) {
      const mapped = args[0] ? callCallable(args[0], [iterableElement(target), UNKNOWN, target], node) : UNKNOWN;
      return callable.method === "array.flatMap" && mapped.kind === "array"
        ? arrayValue([...mapped.elements], mapped.fallback) : arrayValue([], mapped);
    }
    if (["array.forEach", "array.some", "array.every"].includes(callable.method)) {
      if (args[0]) callCallable(args[0], [iterableElement(target), UNKNOWN, target], node);
      return UNKNOWN;
    }
    if (callable.method === "array.reduce") {
      const item = iterableElement(target);
      return args[0] ? callCallable(args[0], [args[1] || item, item, UNKNOWN, target], node) : UNKNOWN;
    }
    if (callable.method === "map.get") {
      const key = args[0]?.kind === "constant" ? String(args[0].value) : null;
      return key === null ? aggregate([...target.entries.values()], target.fallback)
        : target.entries.get(key) || target.fallback || UNKNOWN;
    }
    if (callable.method === "map.values") return iteratorValue(aggregate([...target.entries.values()], target.fallback));
    if (callable.method === "map.keys") return iteratorValue(UNKNOWN);
    if (callable.method === "map.entries") return iteratorValue(iterableElement(target));
    if (callable.method === "map.forEach") {
      if (args[0]) callCallable(args[0], [aggregate([...target.entries.values()], target.fallback), UNKNOWN, target], node);
      return UNKNOWN;
    }
    if (["set.values", "set.keys"].includes(callable.method)) return iteratorValue(iterableElement(target));
    if (callable.method === "set.entries") {
      const item = iterableElement(target); return iteratorValue(arrayValue([item, item]));
    }
    if (callable.method === "set.forEach") {
      const item = iterableElement(target);
      if (args[0]) callCallable(args[0], [item, item, target], node);
      return UNKNOWN;
    }
    if (callable.method === "iterator.next") {
      return objectValue(new Map([["value", target.element], ["done", UNKNOWN]]));
    }
    return UNKNOWN;
  }

  function callCallable(callable, argumentValues, node) {
    if (callable.kind === "mutation") {
      const args = [...callable.bound, ...argumentValues];
      const target = callable.target || args[0] || null;
      if (target?.kind === "runtime") report("DIRECT_RUNTIME_STATE_MUTATION", node, target);
      else return localMutation(callable, args, target);
      return UNKNOWN;
    }
    if (callable.kind === "function") {
      return visitFunction(callable.node, callable.closure, argumentValues);
    }
    if (callable.kind === "bound-function") {
      return callCallable(callable.callable, [...callable.bound, ...argumentValues], node);
    }
    if (callable.kind === "builtin") return callBuiltin(callable, argumentValues, node);
    if (callable.kind === "native") return callNative(callable, argumentValues, node);
    return UNKNOWN;
  }

  function invoke(callee, argumentValues, node) {
    if (callee.kind !== "wrapper") return callCallable(callee, argumentValues, node);
    const receiverSensitiveMutation = callee.callable.kind === "mutation"
      && (callee.callable.method.includes(".prototype.")
        || callee.callable.method.startsWith("container."));
    const receiverSensitiveNative = callee.callable.kind === "native" && !callee.callable.target;
    if (callee.wrapper === "call") {
      const callable = receiverSensitiveMutation
        ? mutation(callee.callable.method, argumentValues[0], callee.callable.bound)
        : (receiverSensitiveNative ? native(callee.callable.method, argumentValues[0]) : callee.callable);
      return callCallable(callable, argumentValues.slice(1), node);
    }
    if (callee.wrapper === "apply") {
      const callable = receiverSensitiveMutation
        ? mutation(callee.callable.method, argumentValues[0], callee.callable.bound)
        : (receiverSensitiveNative ? native(callee.callable.method, argumentValues[0]) : callee.callable);
      return callCallable(callable, expandArray(argumentValues[1]), node);
    }
    if (callee.wrapper === "bind") {
      const bound = argumentValues.slice(1);
      if (callee.callable.kind === "mutation") {
        return mutation(callee.callable.method,
          receiverSensitiveMutation ? argumentValues[0] : callee.callable.target,
          [...callee.callable.bound, ...bound]);
      }
      if (receiverSensitiveNative) return native(callee.callable.method, argumentValues[0]);
      if (["function", "bound-function", "native", "builtin"].includes(callee.callable.kind)) {
        return { kind: "bound-function", callable: callee.callable, bound };
      }
    }
    return UNKNOWN;
  }

  function bindIdentifier(name, value, scope, declaration) {
    const owner = declaration ? scope.declare(name, value) : scope.assign(name, value);
    registerValueOwner(value, owner);
  }

  function bindPattern(pattern, value, scope, declaration = false) {
    if (!pattern) return;
    if (pattern.type === "Identifier") bindIdentifier(pattern.name, value, scope, declaration);
    else if (pattern.type === "MemberExpression") {
      const target = evaluate(pattern.object, scope);
      const property = propertyName(pattern, scope);
      if (target.kind === "runtime") {
        report("DIRECT_RUNTIME_STATE_MUTATION", pattern,
          property === null ? target : runtime([...target.path, property]));
      } else if (target.kind === "object" && property !== null) {
        noteContainerMutation(target, [value]);
        target.properties.set(property, value);
      } else if (target.kind === "array" && property !== null && /^\d+$/u.test(property)) {
        noteContainerMutation(target, [value]);
        target.elements[Number(property)] = value;
      } else if (["object", "array"].includes(target.kind) && property === null) {
        noteContainerMutation(target, [value]);
        target.fallback = joinValues(target.fallback || UNKNOWN, value);
      }
    } else if (pattern.type === "AssignmentPattern") {
      const assigned = value.kind === "unknown" ? evaluate(pattern.right, scope) : value;
      bindPattern(pattern.left, assigned, scope, declaration);
    } else if (pattern.type === "RestElement") bindPattern(pattern.argument, value, scope, declaration);
    else if (pattern.type === "ArrayPattern") {
      for (let index = 0; index < pattern.elements.length; index += 1) {
        const item = pattern.elements[index];
        if (item?.type === "RestElement") {
          const rest = value.kind === "array"
            ? arrayValue(value.elements.slice(index), value.fallback)
            : (value.kind === "runtime" ? arrayValue([], value) : UNKNOWN);
          bindPattern(item.argument, rest, scope, declaration);
          break;
        }
        bindPattern(item, memberValue(value, String(index)), scope, declaration);
      }
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          const rest = value.kind === "runtime" ? objectValue(new Map(), value)
            : (value.kind === "object" ? objectValue(new Map(value.properties), value.fallback) : LOCAL);
          bindPattern(property.argument, rest, scope, declaration);
        }
        else {
          const member = memberValue(value,
            property.computed ? constantString(property.key, scope) : property.key.name || property.key.value);
          bindPattern(property.value, member, scope, declaration);
        }
      }
    }
  }

  function constantString(node, scope) {
    const value = evaluate(node, scope);
    return value.kind === "constant" && typeof value.value === "string" ? value.value : null;
  }

  function evaluate(node, scope) {
    if (!node) return UNKNOWN;
    consume(node);
    if (node.type === "ParenthesizedExpression" || node.type === "ChainExpression") {
      return evaluate(node.expression, scope);
    }
    if (node.type === "Identifier") {
      const bound = scope.lookup(node.name);
      if (bound !== null) return bound;
      if (["core", "runtime"].includes(node.name)) return Object.assign(runtime([]), { root: node.name });
      if (["window", "unsafeWindow", "globalThis", "windowScope"].includes(node.name)) return GLOBAL;
      if (["Object", "Reflect", "Array", "Map", "Set"].includes(node.name)) return builtin(node.name);
      return UNKNOWN;
    }
    if (node.type === "Literal") return constant(node.value);
    if (node.type === "TemplateLiteral") {
      return node.expressions.length === 0 ? constant(node.quasis[0].value.cooked) : UNKNOWN;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = evaluate(node.left, scope);
      const right = evaluate(node.right, scope);
      return left.kind === "constant" && right.kind === "constant"
        ? constant(left.value + right.value) : UNKNOWN;
    }
    if (node.type === "LogicalExpression") {
      return joinValues(evaluate(node.left, scope), evaluate(node.right, scope));
    }
    if (node.type === "ConditionalExpression") {
      evaluate(node.test, scope);
      return joinValues(evaluate(node.consequent, scope), evaluate(node.alternate, scope));
    }
    if (node.type === "SequenceExpression") {
      let value = UNKNOWN;
      for (const expression of node.expressions) value = evaluate(expression, scope);
      return value;
    }
    if (node.type === "MemberExpression") {
      const objectValue = evaluate(node.object, scope);
      return memberValue(objectValue, propertyName(node, scope));
    }
    if (node.type === "AssignmentExpression") {
      const value = evaluate(node.right, scope);
      if (node.operator === "=" && ["Identifier", "ObjectPattern", "ArrayPattern", "AssignmentPattern", "RestElement"]
        .includes(node.left.type)) {
        bindPattern(node.left, value, scope);
      } else if (node.operator === "=" && node.left.type === "MemberExpression") {
        bindPattern(node.left, value, scope);
      } else {
        const target = node.left.type === "MemberExpression"
          ? evaluate(node.left.object, scope) : evaluate(node.left, scope);
        if (target.kind === "runtime") {
          const property = node.left.type === "MemberExpression" ? propertyName(node.left, scope) : null;
          report("DIRECT_RUNTIME_STATE_MUTATION", node.left,
            property === null ? target : runtime([...target.path, property]));
        }
      }
      return value;
    }
    if (node.type === "UpdateExpression") {
      const target = node.argument.type === "MemberExpression"
        ? evaluate(node.argument.object, scope) : evaluate(node.argument, scope);
      if (target.kind === "runtime") {
        report("DIRECT_RUNTIME_STATE_MUTATION", node.argument, target);
      }
      return target;
    }
    if (node.type === "UnaryExpression") {
      const target = node.argument?.type === "MemberExpression"
        ? evaluate(node.argument.object, scope) : evaluate(node.argument, scope);
      if (node.operator === "delete" && target.kind === "runtime") {
        report("DIRECT_RUNTIME_STATE_MUTATION", node.argument, target);
      }
      return UNKNOWN;
    }
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      const callee = evaluate(node.callee, scope);
      const argumentValues = [];
      for (const argument of node.arguments) {
        const value = evaluate(argument?.type === "SpreadElement" ? argument.argument : argument, scope);
        if (argument?.type === "SpreadElement" && value.kind === "array") {
          argumentValues.push(...value.elements);
          if (value.fallback) argumentValues.push(value.fallback);
        } else argumentValues.push(value);
      }
      if (node.type === "CallExpression") return invoke(callee, argumentValues, node);
      if (callee.kind === "builtin" && callee.name === "Map") {
        const result = mapValue();
        for (const pair of expandArray(argumentValues[0])) {
          if (pair?.kind === "array" && pair.elements[0]?.kind === "constant") {
            result.entries.set(String(pair.elements[0].value), pair.elements[1] || UNKNOWN);
          } else {
            const carried = runtimeReference(pair);
            if (carried) result.fallback = carried;
          }
        }
        return result;
      }
      if (callee.kind === "builtin" && callee.name === "Set") {
        const input = argumentValues[0] || arrayValue([]);
        return input.kind === "array" ? setValue([...input.elements], input.fallback)
          : setValue([], iterableElement(input));
      }
      return UNKNOWN;
    }
    if (["ArrowFunctionExpression", "FunctionExpression"].includes(node.type)) {
      const callable = functionValue(node, scope);
      visitFunction(node, scope);
      return callable;
    }
    if (node.type === "ArrayExpression") {
      const elements = [];
      let fallback = null;
      for (const item of node.elements) {
        const value = evaluate(item?.type === "SpreadElement" ? item.argument : item, scope);
        if (item?.type === "SpreadElement" && value.kind === "array") {
          elements.push(...value.elements); fallback ||= value.fallback;
        } else if (item?.type === "SpreadElement") {
          const carried = iterableElement(value);
          if (runtimeReference(carried)) fallback = joinValues(fallback || UNKNOWN, carried);
        } else elements.push(value);
      }
      return arrayValue(elements, fallback);
    }
    if (node.type === "ObjectExpression") {
      const properties = new Map();
      let fallback = null;
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          const spread = evaluate(property.argument, scope);
          if (spread.kind === "object") {
            for (const [key, value] of spread.properties) properties.set(key, value);
            fallback ||= spread.fallback;
          } else if (spread.kind === "runtime") fallback ||= spread;
          continue;
        }
        const key = property.computed
          ? constantString(property.key, scope) : String(property.key.name ?? property.key.value);
        const value = property.value ? evaluate(property.value, scope) : UNKNOWN;
        if (key !== null) properties.set(key, value);
        else if (runtimeReference(value)) fallback = joinValues(fallback || UNKNOWN, value);
      }
      return objectValue(properties, fallback);
    }
    if (node.type === "AwaitExpression" || node.type === "YieldExpression") return evaluate(node.argument, scope);
    return UNKNOWN;
  }

  function visitFunction(node, parentScope, argumentValues = null) {
    consume(node);
    const hasArguments = argumentValues !== null;
    const memoKey = hasArguments
      ? `${scopeSignature(parentScope)}|${argumentValues.map((value) => valueSignature(value)).join(";")}`
      : null;
    const memo = hasArguments ? (functionMemo.get(node) || new Map()) : null;
    if (memoKey !== null && memo.has(memoKey)) return memo.get(memoKey);
    if (activeFunctions.has(node)) {
      const carried = argumentValues?.map((value) => runtimeReference(value)).find(Boolean);
      if (carried) report("UNSAFE_RUNTIME_MUTATION_ANALYSIS", node, carried);
      return UNKNOWN;
    }
    callDepth += 1;
    if (callDepth > maxCallDepth) throw new AnalysisLimit(node, "call-depth");
    activeFunctions.add(node);
    const scope = newScope(parentScope);
    const collector = [];
    returnCollectors.push(collector);
    try {
      if (node.id) scope.declare(node.id.name, functionValue(node, parentScope));
      for (let index = 0; index < (node.params || []).length; index += 1) {
        const parameter = node.params[index];
        if (parameter.type === "RestElement") {
          bindPattern(parameter.argument, argumentValues ? arrayValue(argumentValues.slice(index)) : UNKNOWN,
            scope, true);
          break;
        }
        bindPattern(parameter, argumentValues?.[index] || UNKNOWN, scope, true);
      }
      if (node.body.type === "BlockStatement") visitBlock(node.body, scope);
      else collector.push(evaluate(node.body, scope));
      const result = collector.length === 0 ? UNKNOWN : collector.reduce(joinValues);
      if (memoKey !== null && memoizableResult(result)) {
        memo.set(memoKey, result);
        functionMemo.set(node, memo);
      }
      return result;
    } finally {
      returnCollectors.pop();
      activeFunctions.delete(node);
      callDepth -= 1;
    }
  }

  function visitBlock(block, parentScope) {
    const scope = newScope(parentScope);
    predeclareStatements(block.body, scope);
    for (const statement of block.body) visit(statement, scope);
  }

  function visit(node, scope) {
    if (!node) return;
    consume(node);
    switch (node.type) {
      case "Program": {
        predeclareStatements(node.body, scope);
        for (const statement of node.body) visit(statement, scope);
        break;
      }
      case "BlockStatement": visitBlock(node, scope); break;
      case "FunctionDeclaration":
        if (node.id) scope.assign(node.id.name, functionValue(node, scope));
        visitFunction(node, scope);
        break;
      case "VariableDeclaration":
        for (const declaration of node.declarations) {
          bindPattern(declaration.id, declaration.init ? evaluate(declaration.init, scope) : LOCAL, scope);
        }
        break;
      case "ExpressionStatement": evaluate(node.expression, scope); break;
      case "ReturnStatement": {
        const value = evaluate(node.argument, scope);
        if (returnCollectors.length > 0) returnCollectors[returnCollectors.length - 1].push(value);
        break;
      }
      case "ThrowStatement": evaluate(node.argument, scope); break;
      case "IfStatement":
        evaluate(node.test, scope); visit(node.consequent, scope); visit(node.alternate, scope); break;
      case "WhileStatement": case "DoWhileStatement":
        evaluate(node.test, scope); visit(node.body, scope); break;
      case "ForStatement":
        if (node.init?.type === "VariableDeclaration") visit(node.init, scope); else evaluate(node.init, scope);
        evaluate(node.test, scope); evaluate(node.update, scope); visit(node.body, scope); break;
      case "ForInStatement": case "ForOfStatement": {
        const right = evaluate(node.right, scope);
        const item = node.type === "ForOfStatement" ? iterableElement(right) : UNKNOWN;
        if (node.left?.type === "VariableDeclaration") {
          for (const declaration of node.left.declarations) bindPattern(declaration.id, item, scope);
        } else if (node.left) bindPattern(node.left, item, scope);
        visit(node.body, scope); break;
      }
      case "TryStatement":
        visit(node.block, scope);
        if (node.handler) {
          const catchScope = newScope(scope);
          for (const name of patternNames(node.handler.param)) catchScope.declare(name, LOCAL);
          visitBlock(node.handler.body, catchScope);
        }
        visit(node.finalizer, scope); break;
      case "SwitchStatement":
        evaluate(node.discriminant, scope);
        for (const item of node.cases) {
          evaluate(item.test, scope);
          for (const statement of item.consequent) visit(statement, scope);
        }
        break;
      case "LabeledStatement": visit(node.body, scope); break;
      case "ClassDeclaration": case "ClassExpression":
        evaluate(node.superClass, scope);
        for (const item of node.body.body) evaluate(item.value, scope);
        break;
      default:
        if (node.type && node.type.endsWith("Expression")) evaluate(node, scope);
    }
  }

  try {
    visit(ast, newScope());
  } catch (error) {
    if (!(error instanceof AnalysisLimit)) throw error;
    report("UNSAFE_RUNTIME_MUTATION_ANALYSIS", error.node || ast,
      { root: "analysis", path: [error.reason] });
  }
  return violations;
}
