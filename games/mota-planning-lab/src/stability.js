MotaLab.waitForStability = async function waitForStability({
  adapter,
  observe,
  finalizeObservation = observe,
  preFingerprint,
  pollMs = 100,
  stablePolls = 2,
  timeoutMs = 30000,
  now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  const startedAt = now();
  let lastFingerprint = null;
  let consecutive = 0;
  let latestObservation = null;

  while (now() - startedAt <= timeoutMs) {
    latestObservation = observe();
    const fingerprint = MotaLab.fingerprintRuntimeObservation(latestObservation);
    if (!latestObservation.busy && fingerprint !== preFingerprint) {
      consecutive = fingerprint === lastFingerprint ? consecutive + 1 : 1;
      lastFingerprint = fingerprint;
      if (consecutive >= stablePolls) {
        const finalObservation = finalizeObservation === observe
          ? latestObservation : finalizeObservation();
        const finalRuntimeFingerprint = MotaLab.fingerprintRuntimeObservation(finalObservation);
        if (!finalObservation.busy && finalRuntimeFingerprint === fingerprint) {
          return {
            observation: finalObservation,
            fingerprint: MotaLab.fingerprintObservation(finalObservation),
            runtime_fingerprint: finalRuntimeFingerprint,
            polls: consecutive,
          };
        }
        latestObservation = finalObservation;
        consecutive = 0;
        lastFingerprint = finalRuntimeFingerprint;
      }
    } else {
      consecutive = 0;
      lastFingerprint = fingerprint;
    }
    await sleep(pollMs);
  }

  const busy = adapter.readBusy();
  if (busy.event_active || busy.lock_control) {
    throw MotaLab.createPauseError(
      "UNSUPPORTED_INTERACTION",
      "INTERACTION_STABILITY_TIMEOUT",
      { busy, observation: latestObservation },
    );
  }
  throw MotaLab.createPauseError(
    "ENGINE_API_INCOMPATIBLE",
    "STABILITY_TIMEOUT",
    { busy, observation: latestObservation },
  );
};
