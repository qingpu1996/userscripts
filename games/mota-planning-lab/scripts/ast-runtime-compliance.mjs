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
  "Reflect.set", "Reflect.deleteProperty", "Reflect.defineProperty", "Reflect.setPrototypeOf",
]);

function runtime(pathParts = []) { return { kind: "runtime", path: pathParts }; }
function builtin(name) { return { kind: "builtin", name }; }
function mutation(method, bound = []) { return { kind: "mutation", method, bound }; }
function wrapper(method, wrapperName, bound = []) {
  return { kind: "wrapper", method, wrapper: wrapperName, bound };
}
function constant(value) { return { kind: "constant", value }; }
function functionValue(node, closure) { return { kind: "function", node, closure }; }
function arrayValue(elements) { return { kind: "array", elements }; }

class Scope {
  constructor(parent = null) { this.parent = parent; this.bindings = new Map(); }
  declare(name, value = LOCAL) { this.bindings.set(name, value); }
  assign(name, value) {
    if (this.bindings.has(name)) this.bindings.set(name, value);
    else if (this.parent) this.parent.assign(name, value);
    else this.bindings.set(name, value);
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
    } else if (["FunctionDeclaration", "ClassDeclaration"].includes(statement.type)
      && statement.id) scope.declare(statement.id.name, LOCAL);
  }
}

export function structuredRuntimeViolations(source) {
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
  const violations = [];
  const reported = new Set();
  const activeFunctions = new Set();

  function report(code, node, value) {
    const identity = `${code}:${node.start}`;
    if (reported.has(identity)) return;
    reported.add(identity);
    violations.push({ code, start: node.start,
      root: value?.root || "ast", properties: value?.path || [] });
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
      return objectValue.kind === "runtime" ? runtime([...objectValue.path, "*"]) : UNKNOWN;
    }
    if (objectValue.kind === "global") {
      if (property === "core") return runtime([]);
      if (["window", "unsafeWindow", "globalThis", "windowScope"].includes(property)) return GLOBAL;
      return UNKNOWN;
    }
    if (objectValue.kind === "runtime") return runtime([...objectValue.path, property]);
    if (objectValue.kind === "array" && /^\d+$/u.test(property)) {
      return objectValue.elements[Number(property)] || UNKNOWN;
    }
    if (objectValue.kind === "builtin") {
      const method = `${objectValue.name}.${property}`;
      return MUTATION_METHODS.has(method) ? mutation(method) : UNKNOWN;
    }
    if (objectValue.kind === "mutation" && ["call", "apply", "bind"].includes(property)) {
      return wrapper(objectValue.method, property, objectValue.bound);
    }
    return UNKNOWN;
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

  function mutationTarget(callee, args, scope) {
    let targetNode = null;
    if (callee.kind === "mutation") {
      targetNode = callee.bound[0] || args[0] || null;
    } else if (callee.kind === "wrapper") {
      if (callee.wrapper === "bind") return null;
      if (callee.wrapper === "call") targetNode = callee.bound[0] || args[1] || null;
      if (callee.wrapper === "apply") {
        const array = args[1];
        targetNode = callee.bound[0]
          || (array && array.type === "ArrayExpression" ? array.elements[0] : null);
      }
    }
    return targetNode ? evaluate(targetNode, scope) : null;
  }

  function bindIdentifier(name, value, scope, declaration) {
    if (declaration) scope.declare(name, value);
    else scope.assign(name, value);
  }

  function bindPattern(pattern, value, scope, declaration = false) {
    if (!pattern) return;
    if (pattern.type === "Identifier") bindIdentifier(pattern.name, value, scope, declaration);
    else if (pattern.type === "MemberExpression") {
      const target = evaluate(pattern, scope);
      if (target.kind === "runtime" && target.path[0] === "status") {
        report("DIRECT_HERO_STATUS_WRITE", pattern, target);
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
            ? arrayValue(value.elements.slice(index))
            : (value.kind === "runtime" ? runtime([...value.path, "*"]) : UNKNOWN);
          bindPattern(item.argument, rest, scope, declaration);
          break;
        }
        bindPattern(item, memberValue(value, String(index)), scope, declaration);
      }
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type === "RestElement") bindPattern(property.argument, value, scope, declaration);
        else {
          const member = memberValue(value,
            property.computed ? constantString(property.key, scope) : property.key.name || property.key.value);
          if (member.kind === "runtime" && member.path.includes("floors")) {
            report("FORBIDDEN_FLOOR_CATALOGUE", property, member);
          }
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
    if (node.type === "ParenthesizedExpression" || node.type === "ChainExpression") {
      return evaluate(node.expression, scope);
    }
    if (node.type === "Identifier") {
      const bound = scope.lookup(node.name);
      if (bound !== null) return bound;
      if (["core", "runtime"].includes(node.name)) return Object.assign(runtime([]), { root: node.name });
      if (["window", "unsafeWindow", "globalThis", "windowScope"].includes(node.name)) return GLOBAL;
      if (["Object", "Reflect"].includes(node.name)) return builtin(node.name);
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
      const value = memberValue(objectValue, propertyName(node, scope));
      if (value.kind === "runtime" && value.path.includes("floors")) {
        report("FORBIDDEN_FLOOR_CATALOGUE", node, value);
      }
      return value;
    }
    if (node.type === "AssignmentExpression") {
      const value = evaluate(node.right, scope);
      if (node.operator === "=" && ["Identifier", "ObjectPattern", "ArrayPattern", "AssignmentPattern", "RestElement"]
        .includes(node.left.type)) {
        bindPattern(node.left, value, scope);
      } else {
        const target = evaluate(node.left, scope);
        if (target.kind === "runtime" && (target.path[0] === "status" || target.path.includes("*"))) {
          report("DIRECT_HERO_STATUS_WRITE", node.left, target);
        }
      }
      return value;
    }
    if (node.type === "UpdateExpression") {
      const target = evaluate(node.argument, scope);
      if (target.kind === "runtime" && (target.path[0] === "status" || target.path.includes("*"))) {
        report("DIRECT_HERO_STATUS_WRITE", node.argument, target);
      }
      return target;
    }
    if (node.type === "UnaryExpression") {
      const target = evaluate(node.argument, scope);
      if (node.operator === "delete" && target.kind === "runtime"
        && (target.path[0] === "status" || target.path.includes("*"))) {
        report("DIRECT_HERO_STATUS_WRITE", node.argument, target);
      }
      return UNKNOWN;
    }
    if (["CallExpression", "NewExpression"].includes(node.type)) {
      const callee = evaluate(node.callee, scope);
      const argumentValues = node.arguments.map((argument) => evaluate(
        argument?.type === "SpreadElement" ? argument.argument : argument, scope,
      ));
      if (callee.kind === "wrapper" && callee.wrapper === "bind") {
        const bound = [...callee.bound, ...node.arguments.slice(1)];
        return mutation(callee.method, bound);
      }
      if (["mutation", "wrapper"].includes(callee.kind)) {
        const target = mutationTarget(callee, node.arguments, scope);
        if (target && target.kind === "runtime"
          && (target.path[0] === "status" || target.path.includes("*"))) {
          report("DIRECT_HERO_STATUS_WRITE", node, target);
        }
      }
      if (callee.kind === "function" && node.type === "CallExpression") {
        visitFunction(callee.node, callee.closure, argumentValues);
      }
      return UNKNOWN;
    }
    if (["ArrowFunctionExpression", "FunctionExpression"].includes(node.type)) {
      const callable = functionValue(node, scope);
      visitFunction(node, scope);
      return callable;
    }
    if (node.type === "ArrayExpression") {
      return arrayValue(node.elements.map((item) => evaluate(
        item?.type === "SpreadElement" ? item.argument : item, scope,
      )));
    }
    if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          evaluate(property.argument, scope);
          continue;
        }
        if (property.computed) evaluate(property.key, scope);
        if (property.value) evaluate(property.value, scope);
      }
      return LOCAL;
    }
    if (node.type === "AwaitExpression" || node.type === "YieldExpression") return evaluate(node.argument, scope);
    return UNKNOWN;
  }

  function visitFunction(node, parentScope, argumentValues = null) {
    if (activeFunctions.has(node)) return;
    activeFunctions.add(node);
    const scope = new Scope(parentScope);
    try {
      if (node.id) scope.declare(node.id.name, functionValue(node, parentScope));
      for (let index = 0; index < (node.params || []).length; index += 1) {
        bindPattern(node.params[index], argumentValues?.[index] || UNKNOWN, scope, true);
      }
      if (node.body.type === "BlockStatement") visitBlock(node.body, scope);
      else evaluate(node.body, scope);
    } finally {
      activeFunctions.delete(node);
    }
  }

  function visitBlock(block, parentScope) {
    const scope = new Scope(parentScope);
    predeclareStatements(block.body, scope);
    for (const statement of block.body) visit(statement, scope);
  }

  function visit(node, scope) {
    if (!node) return;
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
      case "ReturnStatement": case "ThrowStatement": evaluate(node.argument, scope); break;
      case "IfStatement":
        evaluate(node.test, scope); visit(node.consequent, scope); visit(node.alternate, scope); break;
      case "WhileStatement": case "DoWhileStatement":
        evaluate(node.test, scope); visit(node.body, scope); break;
      case "ForStatement":
        if (node.init?.type === "VariableDeclaration") visit(node.init, scope); else evaluate(node.init, scope);
        evaluate(node.test, scope); evaluate(node.update, scope); visit(node.body, scope); break;
      case "ForInStatement": case "ForOfStatement":
        if (node.left?.type === "VariableDeclaration") visit(node.left, scope); else evaluate(node.left, scope);
        evaluate(node.right, scope); visit(node.body, scope); break;
      case "TryStatement":
        visit(node.block, scope);
        if (node.handler) {
          const catchScope = new Scope(scope);
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

  visit(ast, new Scope());
  return violations;
}
