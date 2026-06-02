# Games

Create one folder per game:

```text
games/
  game-name/
    README.md
    userscript.config.json
    src/
      config.js
      main.js
```

Use lowercase kebab-case for folder names, for example:

```text
antimatter-dimensions/
cookie-clicker/
kittens-game/
```

Each game folder should describe:

- target URL
- install URL in `dist/`
- script goals
- enabled automation features
- known risks or limits
- manual controls

The installable Tampermonkey file is generated into root `dist/`, not kept
inside the game source folder.
