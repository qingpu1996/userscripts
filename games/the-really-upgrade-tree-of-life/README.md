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
- A game update can change DOM classes or text and require selector updates.

Manual controls:

- Panel `开关` switch: pause or resume helper ticks.
- Panel `模式` segmented control: scan-only mode versus clicking visible safe upgrades.
- Panel `堆肥` switch: allow or block visible compost button clicks in buy mode.
- Panel `立即执行`: run one immediate scan/click pass.
- Panel `收起` / `展开`: collapse or restore the helper panel.
- Console:

```js
window.__trutolHelper.getConfig()
window.__trutolHelper.setConfig({ scanOnly: false, autoCompost: true, panelCollapsed: false })
window.__trutolHelper.scan()
window.__trutolHelper.leafTimeHint()
window.__trutolHelper.resetHints()
window.__trutolHelper.tick()
```
