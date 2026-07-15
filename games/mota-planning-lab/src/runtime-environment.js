MotaLab.createRuntimeEnvironment = function createRuntimeEnvironment(
  scope = globalThis,
  explicitMode = MotaLab.RUNTIME_MODE,
) {
  const unavailable = (missing) => {
    const error = () => MotaLab.createPauseError(
      "ENGINE_API_INCOMPATIBLE", "USERSCRIPT_API_UNAVAILABLE", { missing: missing.slice() },
    );
    return Object.freeze({
      mode: "userscript", available: false, detail_code: "USERSCRIPT_API_UNAVAILABLE",
      missing: Object.freeze(missing.slice()), storage: MotaLab.createMemoryStorage(),
      request() { throw error(); }, registerMenu: null, assertAvailable() { throw error(); },
    });
  };
  if (!["userscript", "direct-mount"].includes(explicitMode)) {
    throw new TypeError(`Invalid explicit runtime mode: ${String(explicitMode)}`);
  }
  if (explicitMode === "userscript") {
    const required = ["GM_xmlhttpRequest"];
    const missing = required.filter((name) => typeof scope[name] !== "function");
    if (missing.length) return unavailable(missing);
    return Object.freeze({
      mode: "userscript", available: true, detail_code: null,
      storage: MotaLab.createMemoryStorage(),
      request(options) { return scope.GM_xmlhttpRequest(options); },
      registerMenu: typeof scope.GM_registerMenuCommand === "function"
        ? scope.GM_registerMenuCommand : null,
      assertAvailable() { return true; },
    });
  }
  const directRequest = (options) => {
    const controller = new AbortController();
    const timer = scope.setTimeout(() => controller.abort(), options.timeout);
    scope.fetch(options.url, {
      method: options.method, headers: options.headers, body: options.data,
      signal: controller.signal, credentials: "omit", mode: "cors",
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
    storage: MotaLab.createMemoryStorage(),
    request: directRequest,
    registerMenu: null, assertAvailable() { return true; },
  });
};
