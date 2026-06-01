# Userscripts

This folder is for Tampermonkey / Violentmonkey scripts for browser incremental games.

Recommended layout:

```text
userscripts/
  shared/      Shared helpers and reusable snippets.
  games/       One folder per game.
  templates/   Starter .user.js files.
```

Start simple:

```text
games/
  game-name/
    README.md
    game-name.user.js
```

When a script gets large, split its source:

```text
games/
  game-name/
    README.md
    src/
      main.js
      selectors.js
      state.js
      strategy.js
      ui.js
      storage.js
    dist/
      game-name.user.js
```

Keep the final script that Tampermonkey installs in `dist/` or directly as
`game-name.user.js` for small projects.

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
3. Make the script and README changes on that branch.
4. Let the user test or review the feature in the browser.
5. After the user confirms the feature is complete, commit the branch.
6. Merge the confirmed branch back into `main`.
7. Keep `main` clean after the merge.

Typical commands:

```bash
git switch main
git switch -c feature/<game-name>/v<version>
git status
git add .
git commit -m "Update <game-name> helper to v<version>"
git switch main
git merge --no-ff feature/<game-name>/v<version>
```

Do not merge unfinished automation behavior into the stable branch. Reset,
prestige, import/export, and destructive actions should stay hint-only unless the
game README explicitly documents that automation and the user has confirmed it.
