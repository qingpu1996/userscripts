MotaLab.createLocalhostClient = function createLocalhostClient(requestImplementation, options = {}) {
  if (typeof requestImplementation !== "function") {
    throw new TypeError("A request implementation is required");
  }
  const timeout = MotaLab.isFiniteInteger(options.timeoutMs) ? options.timeoutMs : 10000;
  const endpoint = options.cycleEndpoint || MotaLab.CYCLE_ENDPOINT;
  const endpointMatch = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/cycle$/u.exec(endpoint);
  if (!endpointMatch) {
    throw new TypeError("cycleEndpoint must be an explicit 127.0.0.1 HTTP /cycle URL");
  }
  const endpointPort = Number(endpointMatch[1]);
  if (endpointPort < 1 || endpointPort > 65535) {
    throw new TypeError("cycleEndpoint port must be between 1 and 65535");
  }
  let connected = false;

  function serviceError(detailCode, cause) {
    const error = new Error(detailCode);
    error.name = "MotaLabServiceError";
    error.detail_code = detailCode;
    error.cause = cause || null;
    return error;
  }

  function postCycle(payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      try {
        requestImplementation({
          method: "POST",
          url: endpoint,
          headers: {
            "Content-Type": "application/json",
            "X-Mota-Lab": "1",
          },
          data: JSON.stringify(payload),
          timeout,
          onload(response) {
            if (settled) return;
            if (!response || response.status !== 200) {
              connected = false;
              try {
                const parsedError = MotaLab.validateCycleResponse(JSON.parse(response.responseText));
                if (parsedError.status !== "error") throw new TypeError("Non-2xx response is not an error envelope");
                finish(reject, serviceError(parsedError.error_code, parsedError.reason));
              } catch (error) {
                finish(reject, serviceError("INVALID_RESPONSE", error.message));
              }
              return;
            }
            try {
              const parsed = JSON.parse(response.responseText);
              const validated = MotaLab.validateCycleResponse(parsed);
              connected = true;
              finish(resolve, validated);
            } catch (error) {
              connected = false;
              finish(reject, serviceError("INVALID_RESPONSE", error.message));
            }
          },
          onerror(error) {
            if (settled) return;
            connected = false;
            finish(reject, serviceError("CONNECTION_FAILED", error));
          },
          ontimeout() {
            if (settled) return;
            connected = false;
            finish(reject, serviceError("CONNECTION_TIMEOUT"));
          },
          onabort() {
            if (settled) return;
            connected = false;
            finish(reject, serviceError("CONNECTION_ABORTED"));
          },
        });
      } catch (error) {
        connected = false;
        finish(reject, serviceError("CONNECTION_FAILED", error.message));
      }
    });
  }

  return Object.freeze({ postCycle, isConnected: () => connected });
};
