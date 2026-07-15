#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectDir, relativePath), "utf8"));
}

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
assert.equal(observation.observation.protocol, 2);

const topologies = read("tests/fixtures/runtime-topologies-v2.json");
assert.equal(topologies.fixture_metadata.synthetic, true);
assert.deepEqual(topologies.cases.map((entry) => [
  entry.dimensions.width, entry.dimensions.height,
]), [[11, 11], [13, 13], [7, 19], [5, 4]]);
assert.ok(topologies.cases.at(-1).valid_cells.length < 20);

const heroShapes = read("tests/fixtures/runtime-hero-shapes-v2.json");
assert.equal(heroShapes.protocol, 2);
const liveTools = heroShapes.cases.find(
  (entry) => entry.name === "h5mota-24-live-tools-layout",
);
assert.deepEqual(liveTools.hero.items.tools, {
  yellowKey: 1, blueKey: 1, redKey: 1,
});
assert.deepEqual(liveTools.expected_keys, { yellow: 1, blue: 1, red: 1 });
const zeroOmission = heroShapes.cases.find(
  (entry) => entry.name === "h5mota-24-canonical-tools-zero-omission",
);
assert.deepEqual(zeroOmission.hero.items.tools, { blueKey: 1, redKey: 1 });
assert.deepEqual(zeroOmission.expected_keys, { yellow: 0, blue: 1, red: 1 });

for (const schemaName of [
  "observation.schema.json",
  "cycle-request.schema.json",
  "cycle-response.schema.json",
]) {
  const schema = read(`protocol/${schemaName}`);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
}

console.log("Fixture and schema provenance: PASS (8 active JSON fixtures; v0.1 handoff archived)");
