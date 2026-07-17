const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { loadRuntime, projectDir } = require("./helpers/runtime");

const lab = loadRuntime();
const runtimeDir = path.join(projectDir, "rust/shadow-runtime");
const MAX_RUNTIME_BODY_BYTES = 9 * 1024 * 1024;

function requestImplementation(request) {
  const endpoint = new URL(request.url);
  const clientRequest = http.request({
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: endpoint.pathname,
    method: request.method,
    headers: request.headers,
    timeout: request.timeout,
  }, (response) => {
    let responseText = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { responseText += chunk; });
    response.on("end", () => request.onload({ status: response.statusCode, responseText }));
  });
  clientRequest.on("error", request.onerror);
  clientRequest.on("timeout", () => {
    clientRequest.destroy();
    request.ontimeout();
  });
  clientRequest.end(request.data);
}

function rawRequest(port, { method, path: requestPath = "/cycle", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
    }, (response) => {
      let responseText = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseText += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        responseText,
      }));
    });
    request.on("error", reject);
    if (body === undefined) request.end();
    else request.end(body);
  });
}

function cycleHeaders(body, { origin, contentType = "application/json", motaLab = "1" } = {}) {
  const headers = {
    "Content-Length": Buffer.byteLength(body),
  };
  if (contentType !== null) headers["Content-Type"] = contentType;
  if (motaLab !== null) headers["X-Mota-Lab"] = motaLab;
  if (origin !== undefined) headers.Origin = origin;
  return headers;
}

function largeContractRequest() {
  const request = JSON.parse(fs.readFileSync(
    path.join(projectDir, "tests/fixtures/shadow-cycle-request.json"), "utf8",
  ));
  const hash = `sha256:${"b".repeat(64)}`;
  request.observation.engine_model = {
    protocol: 1,
    catalog_hash: hash,
    model_hash: hash,
    floors: [],
    blocks: [],
    items: Array.from({ length: 280 }, (_, index) => ({
      id: `synthetic-item-${index}`,
      cls: "tools",
      name: null,
      text: "x".repeat(4096),
      item_effect: null,
      item_effect_tip: null,
      use_item_event: null,
      complex: false,
    })),
    enemies: [],
    values: {},
    inventory: { classes: {}, key_slots: {} },
  };
  return request;
}

async function startRuntime() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "mota-shadow-target-"));
  const child = childProcess.spawn("cargo", ["run", "--quiet", "--locked", "--", "--port", "0"], {
    cwd: runtimeDir,
    env: Object.assign({}, process.env, { CARGO_TARGET_DIR: target }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`shadow runtime did not become ready: ${stderr}`)), 30000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`shadow runtime exited early (${code}): ${stderr}`));
      }
    });
  });
  return {
    port: Number(String(ready.address).split(":").at(-1)),
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      fs.rmSync(target, { recursive: true, force: true });
    },
  };
}

test("Rust Stage2B shadow runtime returns current-floor candidates without executable fields", async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const fixture = JSON.parse(fs.readFileSync(
    path.join(projectDir, "tests/fixtures/shadow-cycle-request.json"), "utf8",
  ));
  const client = lab.createLocalhostClient(requestImplementation, {
    cycleEndpoint: `http://127.0.0.1:${runtime.port}/cycle`,
  });

  const response = await client.postCycle(fixture);

  assert.equal(response.status, "idle");
  assert.deepEqual(JSON.parse(JSON.stringify(response.shadow)), {
    mode: "read_only",
    reason: "Stage3 Rust shadow runtime analyzed bounded global routes; execution remains disabled.",
    cycle: 1,
    analysis: {
      scope: "current_floor_immediate",
      reachable_cell_count: 1,
      candidate_limit: 256,
      total_candidate_count: 4,
      truncated: false,
      global: {
        scope: "global_terminal_route", proof: "unsupported", reason: "solver_model_missing",
        truncated: false, explored_states: 0, blockers: [], route: null, first_suggestion: null,
      },
      candidates: [
        {
          candidate_id: "synthetic-floor-4:door:8,2:9002:syntheticRedDoor",
          kind: "door", block_id: "syntheticRedDoor", numeric_id: 9002,
          x: 8, y: 2, distance: 1, feasibility: "missing_key", hp_loss: 0,
          key_cost: { yellow: 0, blue: 0, red: 1 },
        },
        {
          candidate_id: "synthetic-floor-4:stair:7,3:9005:syntheticUpFloor",
          kind: "stair", block_id: "syntheticUpFloor", numeric_id: 9005,
          x: 7, y: 3, distance: 1, feasibility: "known_feasible", hp_loss: 0,
          key_cost: { yellow: 0, blue: 0, red: 0 },
        },
        {
          candidate_id: "synthetic-floor-4:enemy:9,3:9003:syntheticEnemy",
          kind: "enemy", block_id: "syntheticEnemy", numeric_id: 9003,
          x: 9, y: 3, distance: 1, feasibility: "known_feasible", hp_loss: 24,
          key_cost: { yellow: 0, blue: 0, red: 0 },
        },
        {
          candidate_id: "synthetic-floor-4:resource:8,4:9004:syntheticRedPotion",
          kind: "resource", block_id: "syntheticRedPotion", numeric_id: 9004,
          x: 8, y: 4, distance: 1, feasibility: "known_feasible", hp_loss: 0,
          key_cost: { yellow: 0, blue: 0, red: 0 },
        },
      ],
    },
    observation: {
      session_id: "SESSION-SYNTHETIC-0001",
      floor_id: "synthetic-floor-4",
      map_instance_id: "map:synthetic-floor-4:topology-a",
    },
  });
  for (const field of ["action_id", "action_kind", "operations", "guard", "expected_delta"]) {
    assert.equal(Object.hasOwn(response.shadow, field), false, `${field} must not be a shadow field`);
    assert.equal(Object.hasOwn(response, field), false, `${field} must not be present`);
  }
  assert.equal(client.isConnected(), true);
});

test("Rust shadow runtime accepts the direct-mount CORS preflight and CORS POST", async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const origin = "https://h5mota.com";
  const preflight = await rawRequest(runtime.port, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, x-mota-lab",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.responseText, "");
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.equal(preflight.headers["access-control-allow-methods"], "POST");
  assert.match(preflight.headers["access-control-allow-headers"], /content-type/i);
  assert.match(preflight.headers["access-control-allow-headers"], /x-mota-lab/i);
  assert.match(preflight.headers.vary, /origin/i);

  const fixture = fs.readFileSync(
    path.join(projectDir, "tests/fixtures/shadow-cycle-request.json"), "utf8",
  );
  const post = await rawRequest(runtime.port, {
    method: "POST",
    headers: cycleHeaders(fixture, { origin }),
    body: fixture,
  });
  assert.equal(post.status, 200);
  assert.equal(post.headers["access-control-allow-origin"], origin);
  assert.match(post.headers.vary, /origin/i);
  assert.equal(JSON.parse(post.responseText).status, "idle");

  const rejectedPreflight = await rawRequest(runtime.port, {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.invalid",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, x-mota-lab",
    },
  });
  assert.equal(rejectedPreflight.status, 403);
  assert.equal(rejectedPreflight.headers["access-control-allow-origin"], undefined);

  const rejectedMethod = await rawRequest(runtime.port, {
    method: "GET",
    headers: { Origin: origin },
  });
  assert.equal(rejectedMethod.status, 405);
  assert.equal(rejectedMethod.headers["access-control-allow-origin"], origin);
  assert.match(rejectedMethod.headers.vary, /origin/i);
});

test("Rust shadow runtime rejects invalid actual POSTs before they advance the shadow cycle", async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const fixture = fs.readFileSync(
    path.join(projectDir, "tests/fixtures/shadow-cycle-request.json"), "utf8",
  );
  const allowedOrigin = "https://h5mota.com";

  const wrongOrigin = await rawRequest(runtime.port, {
    method: "POST",
    headers: cycleHeaders(fixture, { origin: "https://example.invalid" }),
    body: fixture,
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers["access-control-allow-origin"], undefined);
  assert.equal(JSON.parse(wrongOrigin.responseText).error_code, "CORS_ORIGIN_REJECTED");

  for (const [label, options, errorCode] of [
    ["missing custom header", { motaLab: null }, "MISSING_MOTA_LAB_HEADER"],
    ["wrong custom header", { motaLab: "0" }, "MISSING_MOTA_LAB_HEADER"],
    ["missing media type", { contentType: null }, "INVALID_CONTENT_TYPE"],
    ["wrong media type", { contentType: "text/plain" }, "INVALID_CONTENT_TYPE"],
  ]) {
    const rejected = await rawRequest(runtime.port, {
      method: "POST",
      headers: cycleHeaders(fixture, { origin: allowedOrigin, ...options }),
      body: fixture,
    });
    assert.equal(rejected.status, 400, label);
    assert.equal(rejected.headers["access-control-allow-origin"], allowedOrigin, label);
    assert.match(rejected.headers.vary, /origin/i, label);
    assert.equal(JSON.parse(rejected.responseText).error_code, errorCode, label);
  }

  const malformedJson = await rawRequest(runtime.port, {
    method: "POST",
    headers: cycleHeaders("{", { origin: allowedOrigin }),
    body: "{",
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.headers["access-control-allow-origin"], allowedOrigin);
  assert.match(malformedJson.headers.vary, /origin/i);
  assert.equal(JSON.parse(malformedJson.responseText).error_code, "INVALID_JSON");

  const accepted = await rawRequest(runtime.port, {
    method: "POST",
    headers: cycleHeaders(fixture, { origin: allowedOrigin, contentType: "application/json; charset=utf-8" }),
    body: fixture,
  });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.responseText).shadow.cycle, 1);

  const gmCompatible = await rawRequest(runtime.port, {
    method: "POST",
    headers: cycleHeaders(fixture),
    body: fixture,
  });
  assert.equal(gmCompatible.status, 200);
  assert.equal(gmCompatible.headers["access-control-allow-origin"], undefined);
  assert.equal(JSON.parse(gmCompatible.responseText).shadow.cycle, 2);
});

test("Rust shadow runtime accepts bounded multi-megabyte contract requests and rejects larger bodies", async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const largeRequest = largeContractRequest();
  const wireRequest = JSON.stringify(largeRequest);
  const size = Buffer.byteLength(wireRequest);
  assert.ok(size > 1024 * 1024, `fixture must exceed 1 MiB; received ${size}`);
  assert.ok(size < MAX_RUNTIME_BODY_BYTES, `fixture must fit new runtime bound; received ${size}`);

  const accepted = await rawRequest(runtime.port, {
    method: "POST",
    headers: cycleHeaders(wireRequest),
    body: wireRequest,
  });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.responseText).status, "idle");
  assert.equal(JSON.parse(accepted.responseText).shadow.mode, "read_only");

  const rejected = await rawRequest(runtime.port, {
    method: "POST",
    headers: {
      Origin: "https://h5mota.com",
      "Content-Type": "application/json",
      "X-Mota-Lab": "1",
      "Content-Length": MAX_RUNTIME_BODY_BYTES + 1,
    },
  });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.headers["access-control-allow-origin"], "https://h5mota.com");
  assert.match(rejected.headers.vary, /origin/i);
  assert.equal(JSON.parse(rejected.responseText).error_code, "REQUEST_BODY_TOO_LARGE");
});
