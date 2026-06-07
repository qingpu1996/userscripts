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
- Optional auto-reset controls for Seed, Fruit, and Entropy. They are off by
  default and can trigger by gain multiplier, fixed gain amount, or elapsed time
  since the last reset. A hybrid multiplier-or-time mode can trigger on either
  condition, whichever is reached first. Time-based triggers also require a
  configurable minimum gain multiplier, defaulting to `1`.
- The helper panel includes a global auto-reset switch for temporarily pausing
  all auto resets during challenges without changing each resource's saved
  thresholds.
- Persistent auto-reset controls in the helper panel, so reset settings can be
  changed even when the matching reset button is currently unavailable or hidden.
- Layer reset resources are recognized by the game's reset button classes
  (`layer-reset-button` with `upgrade-S`, `upgrade-F`, or `upgrade-E`), not by
  localized button wording.
- Inline leaf time-to-next-purchase hint inside the visible leaf layer frame.
- Collapsible Chinese control panel.
- Configurable speed modes with a fast purchase loop separated from the slower
  status, panel, and inline-hint refresh loop.
- Per-resource spend protection for automated purchases. Leaves, Seeds, and
  Fruits are allowed by default; Entropy and later resources are protected by
  default until enabled in the panel.
- Separate Cell Lab automation switch for visible Cell, Bacteria, Virus, and
  Beneficial Virus upgrades. It is off by default so stored Entropy is not spent
  just by opening a Cell Lab subtab.
- Background automation for safe upgrades and compost actions that have already
  been seen once in a rendered game panel. It reuses the button's own click
  handler and still respects the spend resource toggles.
- Background compost automation uses stable resource IDs and a dedicated
  compost budget so in-progress compost button text does not crowd out later
  compost attempts.
- Background automation keeps the last clickable Vue handler for learned
  compost actions, so an in-progress compost button does not overwrite the
  hidden-tab runner with a no-op state.
- Manual run button and browser console API via `window.__trutolHelper`.

Known risks or limits:

- The script relies on the game's current button classes, especially
  `o-primary-btn--disabled`, `o-primary-btn--bought`, and `upgrade-*`.
- Background automation only works after the relevant button has appeared once
  during the current page load. Fully unseen tabs still need to be visited once
  so the helper can learn their safe button handlers.
- Auto reset is intentionally limited to Seeds, Fruits, and Entropy. Other reset-like
  actions remain hint-only unless explicitly added later.
- Auto reset uses a short global duplicate-click cooldown, while each resource
  keeps its own elapsed-time baseline. A Fruit reset does not reset the Seed
  timer, and vice versa.
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
- Bacteria reset and Cell limit extension are intentionally blocked even when
  Cell Lab automation is enabled, because they behave like reset actions.
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
- Panel `细胞` switch: allow or block visible Cell Lab upgrade clicks in buy mode.
- Panel `后台` switch: allow or block learned background actions for hidden safe
  upgrades and compost buttons.
- Panel `立即执行`: run one immediate scan/click pass.
- Panel `收起` / `展开`: collapse or restore the helper panel.
- Panel `重置` controls: configure Seed, Fruit, and Entropy auto reset even when
  the matching reset button is unavailable. The switch enables that resource
  only; the mode chooses multiplier, fixed gain amount, elapsed-time, or
  multiplier-or-time hybrid triggering. Time and hybrid modes expose a minimum
  multiplier guard so elapsed-time fallback does not reset into a worse reward.
- Panel `重置` total switch: pause or resume all auto resets without changing
  individual resource settings.
- Inline reset controls: when a supported reset button is visible, the same
  resource controls appear below its reset hints with live status near the button.
- Console:

```js
window.__trutolHelper.getConfig()
window.__trutolHelper.setConfig({ scanOnly: false, autoCompost: true, speedMode: "burst" })
window.__trutolHelper.timings()
window.__trutolHelper.spendResources()
window.__trutolHelper.autoReset()
window.__trutolHelper.learnedActions()
window.__trutolHelper.learnedResets()
window.__trutolHelper.scan()
window.__trutolHelper.leafTimeHint()
window.__trutolHelper.resetHints()
window.__trutolHelper.purchaseTick()
window.__trutolHelper.statusTick()
window.__trutolHelper.tick()
```
