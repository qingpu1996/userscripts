# Userscripts

This folder is for Tampermonkey / Violentmonkey scripts for browser incremental games.

Recommended layout:

```text
userscripts/
  shared/      Shared helpers bundled into game scripts.
  games/       One source folder per game.
  dist/        Generated single-file userscripts for installation.
  scripts/     Build tools.
  templates/   Starter snippets.
```

Use game source folders for development:

```text
games/
  game-name/
    README.md
    userscript.config.json
    src/
      config.js
      main.js
      selectors.js
      strategy.js
      ui.js
```

Generated installable scripts are written to root `dist/`:

```text
dist/
  game-name.user.js
```

Do not edit `dist/*.user.js` directly. Change `shared/` or
`games/<game-name>/src/`, then rebuild.

Build one game:

```bash
node scripts/build-userscript.js <game-name>
```

Build all configured games:

```bash
node scripts/build-userscript.js
```

## Git Workflow

Use `main` as the stable branch for scripts that are ready to keep. If the
repository is later renamed to use `master`, treat `master` as the stable branch
in the same workflow.

New game scripts and feature changes should be developed on a game-specific
branch instead of directly on the stable branch. Branch names should include the
game slug and the target script version:

```text
game/<game-name>/v<version>
feature/<game-name>/v<version>
fix/<game-name>/v<version>
```

Examples:

```text
game/the-really-upgrade-tree-of-life/v0.1.0
feature/the-really-upgrade-tree-of-life/v0.5.0
fix/the-really-upgrade-tree-of-life/v0.5.1
```

Recommended flow:

1. Start from the stable branch and update it.
2. Create a versioned branch for the game or feature.
3. Change `shared/` helpers or `games/<game-name>/src/` source files.
4. Run `node scripts/build-userscript.js <game-name>` to refresh `dist/`.
5. Verify the generated script in the browser or Tampermonkey.
6. After the user confirms the feature is complete, commit source and `dist/`.
7. Merge the confirmed branch back into `main`.
8. Keep `main` clean after the merge.

Typical commands:

```bash
git switch main
git switch -c feature/<game-name>/v<version>
node scripts/build-userscript.js <game-name>
git status
git add .
git commit -m "feat: 更新 <game-name> 到 v<version>"
git switch main
git merge --no-ff feature/<game-name>/v<version>
git push
```

Do not merge unfinished automation behavior into the stable branch. Reset,
prestige, import/export, and destructive actions should stay hint-only unless the
game README explicitly documents that automation and the user has confirmed it.

## Tampermonkey Verification

When testing a generated script in Tampermonkey, verify both enable switches:

1. The Tampermonkey extension/global switch is enabled for the current site.
2. The individual script row switch is enabled. Do not confuse the global
   "enabled" status with the script-specific switch.
3. Refresh the game tab after saving or re-enabling the script so Tampermonkey
   injects the latest code.
4. Confirm the helper actually injected, for example by checking the in-page
   panel, inline hints, or `window.__trutolHelper`.
