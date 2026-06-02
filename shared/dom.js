function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function hasClassStartingWith(element, prefix) {
  return Array.from(element.classList).some((className) => className.startsWith(prefix));
}

function removeInactiveHintNodes(className, activeHints) {
  for (const node of document.querySelectorAll(`.${className}`)) {
    if (!activeHints.has(node)) {
      node.remove();
    }
  }
}
