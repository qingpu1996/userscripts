MotaLab.createRuntimeEnvironment = function createRuntimeEnvironment(
  scope = globalThis,
  explicitMode = MotaLab.RUNTIME_MODE,
) {
  function evidenceText(raw) {
    try {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      return typeof text === "string" ? text : `[${typeof raw}]`;
    } catch (_) {
      return `[unserializable:${typeof raw}]`;
    }
  }

  function storageFailure(key, reason = "storage-unstable") {
    return {
      status: "storage_unstable",
      key,
      raw_length: 0,
      content_hash: `sha256:${MotaLab.sha256(reason)}`,
    };
  }

  function inspectRaw(key, raw, { nullishMeansAbsent = false } = {}) {
    if (nullishMeansAbsent && (raw === null || raw === undefined)) {
      return { status: "absent", key };
    }
    const rawText = evidenceText(raw);
    const evidence = {
      key,
      raw_length: rawText.length,
      content_hash: `sha256:${MotaLab.sha256(rawText)}`,
    };
    if (typeof raw !== "string") {
      try {
        return Object.assign({ status: "parsed", value: JSON.parse(rawText) }, evidence);
      } catch (_) {
        return Object.assign({ status: "wrong_shape" }, evidence);
      }
    }
    try {
      return Object.assign({ status: "parsed", value: JSON.parse(raw) }, evidence);
    } catch (_) {
      return Object.assign({ status: "parse_failed" }, evidence);
    }
  }

  function stableValueSignature(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "number" && Object.is(value, -0)) return "number:-0";
    if (["string", "number", "boolean"].includes(typeof value)) {
      return `${typeof value}:${String(value)}`;
    }
    try { return `${typeof value}:canonical:${MotaLab.canonicalize(value)}`; }
    catch (_) { return `${typeof value}:${evidenceText(value)}`; }
  }

  function journalStorageError(operation, details = {}) {
    return MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      "JOURNAL_STORAGE_UNSTABLE",
      Object.assign({ operation }, details),
    );
  }

  function assertCanonicalInspection(inspected, expected, operation) {
    if (!inspected || inspected.status !== "parsed") {
      throw journalStorageError(operation, {
        observed_status: inspected && inspected.status ? inspected.status : "missing",
      });
    }
    let actualCanonical;
    let expectedCanonical;
    try {
      actualCanonical = MotaLab.canonicalize(inspected.value);
      expectedCanonical = MotaLab.canonicalize(expected);
    } catch (_) {
      throw journalStorageError(operation, { reason: "canonicalization-failed" });
    }
    if (actualCanonical !== expectedCanonical) {
      throw journalStorageError(operation, {
        reason: "readback-mismatch",
        expected_hash: `sha256:${MotaLab.sha256(expectedCanonical)}`,
        actual_hash: `sha256:${MotaLab.sha256(actualCanonical)}`,
      });
    }
    return `sha256:${MotaLab.sha256(expectedCanonical)}`;
  }

  function unavailableUserscript(missing) {
    const detailCode = "USERSCRIPT_API_UNAVAILABLE";
    const error = () => MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE",
      detailCode,
      { missing: missing.slice() },
    );
    const blockedStorage = Object.freeze({
      inspect(key) { return storageFailure(key, detailCode); },
      get(_key, fallback) { return fallback; },
      set() { throw error(); },
      delete() { throw error(); },
    });
    return Object.freeze({
      mode: "userscript",
      available: false,
      detail_code: detailCode,
      missing: Object.freeze(missing.slice()),
      storage: blockedStorage,
      request() { throw error(); },
      registerMenu: null,
      assertAvailable() { throw error(); },
    });
  }

  if (!['userscript', 'direct-mount'].includes(explicitMode)) {
    throw new TypeError(`Invalid explicit runtime mode: ${String(explicitMode)}`);
  }

  if (explicitMode === "userscript") {
    const required = [
      "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues",
      "GM_xmlhttpRequest",
    ];
    const missing = required.filter((name) => typeof scope[name] !== "function");
    if (missing.length > 0) return unavailableUserscript(missing);
    let probeSequence = 0;
    const storage = {
      inspect(key) {
        let firstList;
        let secondList;
        let first;
        let second;
        const tokenBase = `${key}:${Date.now()}:${probeSequence += 1}`;
        const firstDefault = { __mota_lab_absent_probe__: `${tokenBase}:A` };
        const secondDefault = { __mota_lab_absent_probe__: `${tokenBase}:B` };
        try {
          firstList = scope.GM_listValues();
          first = scope.GM_getValue(key, firstDefault);
          second = scope.GM_getValue(key, secondDefault);
          secondList = scope.GM_listValues();
        } catch (_) {
          return storageFailure(key, "GM-storage-call-failed");
        }
        if (!Array.isArray(firstList) || !Array.isArray(secondList)
          || firstList.some((item) => typeof item !== "string")
          || secondList.some((item) => typeof item !== "string")) {
          return storageFailure(key, "GM_listValues-invalid");
        }
        const normalizedFirstList = JSON.stringify([...new Set(firstList)].sort());
        const normalizedSecondList = JSON.stringify([...new Set(secondList)].sort());
        if (normalizedFirstList !== normalizedSecondList) {
          return storageFailure(key, "GM_listValues-changed");
        }
        const firstIsDefault = stableValueSignature(first) === stableValueSignature(firstDefault);
        const secondIsDefault = stableValueSignature(second) === stableValueSignature(secondDefault);
        if (firstIsDefault && secondIsDefault) return { status: "absent", key };
        if (firstIsDefault !== secondIsDefault
          || stableValueSignature(first) !== stableValueSignature(second)) {
          return storageFailure(key, "GM_getValue-changed");
        }
        // The two value probes are authoritative.  GM_listValues is used as a
        // stability signal only because some managers can return a stale list.
        return inspectRaw(key, first);
      },
      get(key, fallback) {
        const inspected = this.inspect(key);
        return inspected.status === "parsed" ? inspected.value : fallback;
      },
      set(key, value) {
        try { scope.GM_setValue(key, value); }
        catch (_) { throw journalStorageError("GM_setValue", { reason: "write-threw" }); }
        const first = this.inspect(key);
        const hash = assertCanonicalInspection(first, value, "GM_setValue-readback-1");
        const second = this.inspect(key);
        assertCanonicalInspection(second, value, "GM_setValue-readback-2");
        return Object.freeze({ verified: true, key, canonical_hash: hash });
      },
      delete(key) {
        try { scope.GM_deleteValue(key); }
        catch (_) { throw journalStorageError("GM_deleteValue", { reason: "delete-threw" }); }
        const first = this.inspect(key);
        const second = this.inspect(key);
        if (first.status !== "absent" || second.status !== "absent") {
          throw journalStorageError("GM_deleteValue-readback", {
            first_status: first.status, second_status: second.status,
          });
        }
        return Object.freeze({ verified: true, key, absent: true });
      },
    };
    const request = (options) => {
      try { return scope.GM_xmlhttpRequest(options); }
      catch (_) {
        throw MotaLab.createPauseError(
          "ENGINE_API_INCOMPATIBLE", "USERSCRIPT_API_UNAVAILABLE",
          { api: "GM_xmlhttpRequest", failure: "throw" },
        );
      }
    };
    return Object.freeze({
      mode: "userscript",
      available: true,
      detail_code: null,
      storage,
      request,
      registerMenu: typeof scope.GM_registerMenuCommand === "function"
        ? scope.GM_registerMenuCommand : null,
      assertAvailable() { return true; },
    });
  }

  const directKey = "mota-planning-lab:direct-mount:journal:v2";
  const directSlotKeys = Object.freeze([
    "mota-planning-lab:direct-mount:journal:v2:slot:a",
    "mota-planning-lab:direct-mount:journal:v2:slot:b",
  ]);
  const directLegacyKey = "mota-planning-lab:direct-mount:journal:v1";
  function directPhysicalKey(key) {
    if (key === MotaLab.JOURNAL_KEY) return directKey;
    const slotIndex = MotaLab.JOURNAL_SLOT_KEYS.indexOf(key);
    if (slotIndex >= 0) return directSlotKeys[slotIndex];
    if (MotaLab.LEGACY_JOURNAL_KEYS.includes(key)) return directLegacyKey;
    return null;
  }
  const storage = {
    subscribeChanges(callback) {
      if (typeof scope.addEventListener !== "function") return () => {};
      const physical = new Set(directSlotKeys);
      const listener = (event) => {
        if (event && physical.has(event.key)) callback({ key: event.key, remote: true });
      };
      scope.addEventListener("storage", listener);
      return () => {
        if (typeof scope.removeEventListener === "function") {
          scope.removeEventListener("storage", listener);
        }
      };
    },
    inspect(key) {
      const physicalKey = directPhysicalKey(key);
      if (physicalKey === null) return { status: "absent", key };
      if (!scope.localStorage) return storageFailure(key, "localStorage-unavailable");
      let raw;
      try { raw = scope.localStorage.getItem(physicalKey); }
      catch (_) { return storageFailure(key, "localStorage-read-failed"); }
      return inspectRaw(key, raw, { nullishMeansAbsent: true });
    },
    get(key, fallback) {
      const inspected = this.inspect(key);
      return inspected.status === "parsed" ? inspected.value : fallback;
    },
    set(key, value) {
      const physicalKey = directPhysicalKey(key);
      if (physicalKey === null || MotaLab.LEGACY_JOURNAL_KEYS.includes(key)) {
        throw new TypeError("Direct mount storage namespace violation");
      }
      if (!scope.localStorage) throw journalStorageError("localStorage.setItem", { reason: "unavailable" });
      let encoded;
      try {
        encoded = JSON.stringify(value);
        scope.localStorage.setItem(physicalKey, encoded);
      } catch (_) {
        throw journalStorageError("localStorage.setItem", { reason: "write-threw" });
      }
      let first;
      let second;
      try {
        first = scope.localStorage.getItem(physicalKey);
        second = scope.localStorage.getItem(physicalKey);
      } catch (_) {
        throw journalStorageError("localStorage.setItem-readback", { reason: "read-threw" });
      }
      if (first !== encoded || second !== encoded) {
        throw journalStorageError("localStorage.setItem-readback", {
          reason: first !== second ? "readback-changed" : "readback-mismatch",
        });
      }
      return Object.freeze({
        verified: true,
        key,
        canonical_hash: `sha256:${MotaLab.sha256(MotaLab.canonicalize(value))}`,
      });
    },
    delete(key) {
      const physicalKey = directPhysicalKey(key);
      if (physicalKey === null || MotaLab.LEGACY_JOURNAL_KEYS.includes(key)) {
        throw new TypeError("Direct mount storage namespace violation");
      }
      if (!scope.localStorage || typeof scope.localStorage.removeItem !== "function") {
        throw journalStorageError("localStorage.removeItem", { reason: "unavailable" });
      }
      try { scope.localStorage.removeItem(physicalKey); }
      catch (_) { throw journalStorageError("localStorage.removeItem", { reason: "delete-threw" }); }
      let first;
      let second;
      try {
        first = scope.localStorage.getItem(physicalKey);
        second = scope.localStorage.getItem(physicalKey);
      } catch (_) {
        throw journalStorageError("localStorage.removeItem-readback", { reason: "read-threw" });
      }
      if (first !== null || second !== null) {
        throw journalStorageError("localStorage.removeItem-readback", {
          reason: first !== second ? "readback-changed" : "still-present",
        });
      }
      return Object.freeze({ verified: true, key, absent: true });
    },
  };
  const request = (options) => {
    const controller = new AbortController();
    const timer = scope.setTimeout(() => controller.abort(), options.timeout);
    scope.fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.data,
      signal: controller.signal,
      credentials: "omit",
      mode: "cors",
    }).then(async (response) => {
      scope.clearTimeout(timer);
      options.onload({ status: response.status, responseText: await response.text() });
    }).catch((error) => {
      scope.clearTimeout(timer);
      if (error && error.name === "AbortError") options.ontimeout();
      else options.onerror(error);
    });
    return { abort: () => { controller.abort(); options.onabort(); } };
  };
  return Object.freeze({
    mode: "direct-mount", available: true, detail_code: null,
    storage, request, registerMenu: null, assertAvailable() { return true; },
  });
};
