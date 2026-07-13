#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectDir, relativePath), "utf8"));
}

const baseline = read("tests/fixtures/current-4f-baseline.json");
assert.equal(baseline.fixture_metadata.kind, "user-provided-baseline");
assert.equal(baseline.fixture_metadata.live_capture, false);
assert.equal(baseline.baseline.floor_display, "4F");
assert.deepEqual(baseline.baseline.hero.loc, { x: 8, y: 3 });
assert.equal(Object.hasOwn(baseline.baseline, "floor_id"), false,
  "The unknown engine floorId must not be guessed");
assert.equal(Object.hasOwn(baseline.baseline, "blocks"), false,
  "The user baseline must not pretend to contain a map");
assert.equal(baseline.history_consistency.rollback_slot, 8);
assert.equal(baseline.history_consistency.rollback_is_protected, true);

const synthetic = read("tests/fixtures/current-4f-synthetic-blocks.json");
assert.equal(synthetic.fixture_metadata.synthetic, true);
assert.equal(synthetic.fixture_metadata.live_capture, false);
assert.match(synthetic.fake_runtime.floor_id, /^synthetic-/u);
assert.equal(synthetic.fake_runtime.width, 11);
assert.equal(synthetic.fake_runtime.height, 11);
assert.equal(
  synthetic.fake_runtime.blocks.filter((block) => block.disable !== true).length,
  synthetic.expected_visible_block_count,
);
for (const block of synthetic.fake_runtime.blocks) {
  assert.match(block.id, /^synthetic/u, "All invented block ids must remain obvious");
}

const responses = read("tests/fixtures/protocol-responses.json");
assert.equal(responses.fixture_metadata.synthetic, true);
assert.match(responses.execute.action_id, /^AUTO-[A-F0-9]{16}$/u);

const observation = read("tests/fixtures/synthetic-observation.json");
assert.equal(observation.fixture_metadata.synthetic, true);
assert.match(observation.observation.floor_id, /^synthetic-/u);
assert.equal(observation.observation.dimensions.width, 11);
assert.equal(observation.observation.dimensions.height, 11);

for (const schemaName of [
  "observation.schema.json",
  "cycle-request.schema.json",
  "cycle-response.schema.json",
]) {
  const schema = read(`protocol/${schemaName}`);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
}

console.log("Fixture and schema provenance: PASS (7 JSON files)");
