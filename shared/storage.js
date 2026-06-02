function gmGetValue(key, fallback) {
  if (typeof GM_getValue === "function") {
    return GM_getValue(key, fallback);
  }

  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function gmSetValue(key, value) {
  if (typeof GM_setValue === "function") {
    GM_setValue(key, value);
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}
