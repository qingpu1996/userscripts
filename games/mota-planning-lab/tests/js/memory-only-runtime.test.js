const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRuntime } = require("./helpers/runtime");
const lab = loadRuntime();

test("journal is process memory only and ignores hostile legacy storage", () => {
  let reads = 0; let writes = 0;
  const hostile = { inspect() { reads += 1; throw new Error("must not read"); },
    set() { writes += 1; throw new Error("must not write"); } };
  const first = lab.createJournal(hostile);
  first.establishSession({ session_id: "SESSION-MEMORY-ONE", mode: "new_game", baseline: { floor_id: "MT4" } });
  first.setPending({ action_id: "AUTO-OLD", phase: "executing" });
  assert.equal(first.snapshot().pending_action.action_id, "AUTO-OLD");
  const restarted = lab.createJournal(hostile);
  assert.equal(restarted.snapshot().session_id, null);
  assert.equal(restarted.snapshot().pending_action, null);
  assert.equal(restarted.actionState("AUTO-OLD"), null);
  assert.deepEqual({ reads, writes }, { reads: 0, writes: 0 });
  assert.equal(restarted.getDiagnostics().persistent_writes, 0);
});

test("runtime environment never touches GM storage or localStorage", () => {
  let storageCalls = 0;
  const scope = {
    GM_xmlhttpRequest() {}, GM_getValue() { storageCalls += 1; },
    GM_setValue() { storageCalls += 1; }, GM_deleteValue() { storageCalls += 1; },
    localStorage: { getItem() { storageCalls += 1; }, setItem() { storageCalls += 1; } },
  };
  const userscript = lab.createRuntimeEnvironment(scope, "userscript");
  userscript.storage.get("old", null);
  assert.equal(storageCalls, 0);
  const direct = lab.createRuntimeEnvironment(Object.assign(scope, {
    fetch() { return new Promise(() => {}); }, setTimeout() { return 1; }, clearTimeout() {},
  }), "direct-mount");
  direct.storage.get("old", null);
  assert.equal(storageCalls, 0);
});

test("same page keeps at-most-one in-flight identity in memory", () => {
  const journal = lab.createJournal();
  journal.setPending({ action_id: "AUTO-CURRENT", phase: "executing" });
  assert.equal(journal.actionState("AUTO-CURRENT"), "pending");
  journal.markCompletedAndAcknowledge({ action_id: "AUTO-CURRENT" }, "AUTO-CURRENT");
  assert.equal(journal.snapshot().pending_action, null);
  assert.equal(journal.actionState("AUTO-CURRENT"), "completed");
});
