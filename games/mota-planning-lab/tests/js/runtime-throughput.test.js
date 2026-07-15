const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { loadRuntime, makeObservation } = require("./helpers/runtime");

const lab = loadRuntime();

function percentile(values, ratio) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

function largeObservation() {
  const observation = makeObservation({
    blocks: Array.from({ length: 80 }, (_, index) => ({
      x: index % 10, y: Math.floor(index / 10), numeric_id: 100 + index,
      id: `item${index}`, cls: "items", trigger: "getItem", no_pass: true,
      damage: null, enemy: null,
    })),
  });
  observation.engine_model = {
    protocol: 1,
    catalog_hash: `sha256:${"a".repeat(64)}`,
    model_hash: `sha256:${"b".repeat(64)}`,
    floors: Array.from({ length: 27 }, (_, index) => ({
      floor_id: `MT${index}`, title: `${index}F`, width: 13, height: 13,
      topology: { kind: "rectangle" },
      map: Array.from({ length: 13 }, () => Array(13).fill(0)),
      blocks: [], change_floor: [], ratio: 1,
    })),
    blocks: Array.from({ length: 200 }, (_, index) => ({
      numeric_id: index, id: `block${index}`, cls: "items", trigger: "getItem", no_pass: true,
    })),
    items: Array.from({ length: 62 }, (_, index) => ({
      id: `item${index}`, cls: "items", name: "resource".repeat(64), complex: false,
    })),
    enemies: Array.from({ length: 66 }, (_, index) => ({
      id: `enemy${index}`, hp: 100, attack: 20, defense: 10,
      gold: 1, experience: 1, special: [],
    })),
    values: {},
    inventory: { classes: { tools: { yellowKey: 1, blueKey: 1 } }, key_slots: {} },
  };
  return observation;
}

test("journal 热路径只用内存、零持久写并满足时延预算", (t) => {
  const observation = largeObservation();
  const storage = lab.createMemoryStorage();
  const journal = lab.createJournal(storage);
  journal.establishSession({
    session_id: observation.session_id,
    mode: "new_game",
    baseline: lab.baselineSummary(observation),
  });
  const preFingerprint = lab.fingerprintObservation(observation);
  const preparedStarted = performance.now();
  journal.setPending({
    action_id: "AUTO-AAAAAAAAAAAAAAAA",
    pre_fingerprint: preFingerprint,
    pre_observation: observation,
    guard: { hp: observation.hero.hp },
    expected_delta: { hp: 1 },
    requires_non_position_change: true,
    phase: "prepared",
  });
  const preparedMs = performance.now() - preparedStarted;

  const snapshots = Array.from({ length: 101 }, () => {
    const started = performance.now();
    journal.snapshot();
    return performance.now() - started;
  });
  const completedStarted = performance.now();
  journal.markCompleted({
    action_id: "AUTO-AAAAAAAAAAAAAAAA",
    fingerprint: `sha256:${"c".repeat(64)}`,
    observation,
    completed_at: Date.now(),
  });
  const completedMs = performance.now() - completedStarted;

  const medianSnapshot = percentile(snapshots, 0.5);
  t.diagnostic(`persistent_writes=0 snapshot_p50=${medianSnapshot.toFixed(3)}ms prepared=${preparedMs.toFixed(3)}ms completed=${completedMs.toFixed(3)}ms`);
  assert.equal(journal.getDiagnostics().persistent_writes, 0);
  for (const key of lab.JOURNAL_SLOT_KEYS) assert.equal(storage.get(key, null), null);
  assert.ok(medianSnapshot <= 2, `snapshot=${medianSnapshot}`);
  assert.ok(preparedMs <= 50, `prepared=${preparedMs}`);
  assert.ok(completedMs <= 50, `completed=${completedMs}`);
  assert.equal(journal.snapshot().last_completed_action.observation, undefined);
});
