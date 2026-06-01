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
