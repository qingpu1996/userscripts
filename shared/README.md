# Shared Helpers

Put reusable userscript helpers here.

Current helpers:

- `storage.js`: `GM_getValue` / `GM_setValue` wrappers with localStorage fallback.
- `dom.js`: text normalization, visibility checks, class-prefix checks, and hint cleanup.
- `large-number.js`: suffix/scientific notation parsing plus log10 ratio and duration helpers.

Game scripts should include helpers through `scripts/build-userscript.js`.
Do not edit generated files in `dist/` directly.
