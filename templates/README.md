# Templates

Copy or adapt template snippets when starting a new script.

Example:

```text
games/
  example-game/
    userscript.config.json
    src/
      config.js
      main.js
```

Then update `userscript.config.json` metadata:

- `name`
- `description`
- `match`
- `grant`

Build the final userscript into `dist/`:

```bash
node scripts/build-userscript.js example-game
```
