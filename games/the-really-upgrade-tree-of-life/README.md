# The Really Upgrade Tree of Life

Target URL:

- https://the-really-upgrade-tree-of-life.g8hh.com.cn/

Script goals:

- Observe visible upgrade buttons and identify which ones are currently buyable.
- Provide a small in-page control panel for pausing, scanning, enabling purchase clicks,
  and toggling compost automation.
- Automate safe visible upgrade and compost actions before adding reset, challenge, or
  prestige logic.
- Surface reset/prestige opportunities as hints without clicking them.

Enabled automation features:

- Scan visible upgrade-like buttons.
- Ignore bought and disabled upgrade buttons.
- Ignore tab, option, import/export/save, wipe, reset, respec, challenge, and prestige-like controls.
- Optional buy mode for visible safe upgrades.
- Optional compost mode for visible `compost-button` controls.
- Reset hint display for visible `layer-reset-button` and sacred reset controls.
- Inline reset ratio hints under visible reset buttons.
- Manual tick button and browser console API via `window.__trutolHelper`.

Known risks or limits:

- The script relies on the game's current button classes, especially
  `o-primary-btn--disabled`, `o-primary-btn--bought`, and `upgrade-*`.
- It only sees the current tab/subtab. Hidden upgrades on other tabs are not clicked.
- Compost automation only acts on visible compost buttons.
- Reset, challenge, and prestige automation is intentionally hint-only for now.
- Reset ratio hints are approximate and are calculated from visible game notation,
  including suffix notation and scientific notation such as `1e303`, `1E303`,
  and `1e3,003`.
- A game update can change DOM classes or text and require selector updates.

Manual controls:

- Panel `Power` switch: pause or resume helper ticks.
- Panel `Mode` segmented control: scan-only mode versus clicking visible safe upgrades.
- Panel `Compost` switch: allow or block visible compost button clicks in buy mode.
- Panel `Tick Now`: run one immediate scan/click pass.
- Console:

```js
window.__trutolHelper.getConfig()
window.__trutolHelper.setConfig({ scanOnly: false, autoCompost: true })
window.__trutolHelper.scan()
window.__trutolHelper.resetHints()
window.__trutolHelper.tick()
```
