# The Really Upgrade Tree of Life

Target URL:

- https://the-really-upgrade-tree-of-life.g8hh.com.cn/

Install URL:

- https://raw.githubusercontent.com/qingpu1996/userscripts/main/dist/the-really-upgrade-tree-of-life.user.js

Source layout:

- `userscript.config.json`: userscript metadata, source order, and dist output.
- `src/`: game-specific source files.
- `../../shared/`: shared helpers bundled by the build script.
- `../../dist/the-really-upgrade-tree-of-life.user.js`: generated Tampermonkey script.

Build:

```bash
node scripts/build-userscript.js the-really-upgrade-tree-of-life
```

Tampermonkey verification:

- After pasting or updating the generated script, make sure both Tampermonkey's
  site/global switch and the individual `The Really Upgrade Tree of Life Helper`
  script row switch are enabled.
- Refresh the game tab after enabling the script. If the helper panel is missing,
  first check the script row switch before debugging the source code.

Script goals:

- Observe visible upgrade buttons and identify which ones are currently buyable.
- Provide a small in-page control panel for pausing, scanning, enabling purchase clicks,
  toggling compost automation, and collapsing the panel when screen space is tight.
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
- Inline leaf time-to-next-purchase hint inside the visible leaf layer frame.
- Collapsible Chinese control panel.
- Configurable speed modes with a fast purchase loop separated from the slower
  status, panel, and inline-hint refresh loop.
- Per-resource spend protection for automated purchases. Leaves, Seeds, and
  Fruits are allowed by default; Entropy and later resources are protected by
  default until enabled in the panel.
- Manual run button and browser console API via `window.__trutolHelper`.

Known risks or limits:

- The script relies on the game's current button classes, especially
  `o-primary-btn--disabled`, `o-primary-btn--bought`, and `upgrade-*`.
- It only sees the current tab/subtab. Hidden upgrades on other tabs are not clicked.
- Compost automation only acts on visible compost buttons.
- Reset, challenge, and prestige automation is intentionally hint-only for now.
- Reset ratio hints are approximate and are calculated from visible game notation,
  including suffix notation and scientific notation such as `1e303`, `1E303`,
  and `1e3,003`.
- Leaf time hints are approximate and use the visible leaf layer amount,
  visible per-second leaf production, and visible unbought leaf-cost upgrades
  only. Estimates longer than seven days are shown as greater than one week.
- Burst speed mode runs purchase scans every 50ms. It is intended for early
  fast-growth phases and still avoids reset, challenge, and prestige actions.
- Automated purchase only clicks visible buttons and respects the panel's spend
  resource toggles. Buttons that would spend a protected resource are skipped.
- A game update can change DOM classes or text and require selector updates.

Manual controls:

- Panel `开关` switch: pause or resume helper ticks.
- Panel `模式` segmented control: scan-only mode versus clicking visible safe upgrades.
- Panel `速度` segmented control: `稳健` uses 750ms purchase/status ticks, `快速`
  uses 250ms purchase and 500ms status ticks, and `爆发` uses 50ms purchase and
  500ms status ticks.
- Panel `花费` toggles: choose which resources the helper may spend while buying
  visible upgrades or compost actions.
- Panel `堆肥` switch: allow or block visible compost button clicks in buy mode.
- Panel `立即执行`: run one immediate scan/click pass.
- Panel `收起` / `展开`: collapse or restore the helper panel.
- Console:

```js
window.__trutolHelper.getConfig()
window.__trutolHelper.setConfig({ scanOnly: false, autoCompost: true, speedMode: "burst" })
window.__trutolHelper.timings()
window.__trutolHelper.spendResources()
window.__trutolHelper.scan()
window.__trutolHelper.leafTimeHint()
window.__trutolHelper.resetHints()
window.__trutolHelper.purchaseTick()
window.__trutolHelper.statusTick()
window.__trutolHelper.tick()
```
