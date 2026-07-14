# Engine model performance QA — 2026-07-15

## Outcome

The browser hot path now separates the cached cross-floor engine catalog from the live current-floor snapshot. A full decision observation refreshes the current map, blocks, hero inventory and model hash without rescanning all 27 floors. Pre-action guard reads and stability polls use a current-floor-only snapshot; the settled result performs one complete observation before delta validation and journaling.

No browser, game, save, knowledge directory, or running `127.0.0.1:18724` service was operated during this development run.

## Timing evidence

Baseline measured before this change on the real 27-floor page:

- one complete observation: about `1783 ms`
- decision to completed: `16–21 s`
- completed ACK to next decision: about `7.2 s`

Repeatable 27-floor / 13×13 fixture from the final full QA run:

| Path | Before-equivalent cold | After warm |
| --- | ---: | ---: |
| browser full observation | `85.405 ms` | `0.768 ms` |
| browser stability snapshot | `85.405 ms` | `0.155 ms` |
| Python authority derivation, 27 floors | `3.192 ms` | `0.000135 ms` cache hit |

The fixture reduction is `99.1%` for warm full observation and `99.8%` for a stability poll. The executor fixture confirms three lightweight reads (pre-action plus two stable polls) and exactly one final complete read.

Real-page targets after hot injection remain to be measured by the main session because this development task explicitly prohibited operating the live page. With two unchanged `100 ms` stability polls, processing overhead is expected to be comfortably below the `<4 s` one-step and `<2 s` ACK-to-decision targets; long game movement animation is intentionally excluded.

## Freshness and invalidation

- Every decision request still starts from a complete observation.
- Every warm complete observation rebuilds the current floor map/blocks/change-floor metadata and complete inventory from the live runtime.
- Stable polling reads current floor, hero, keys, current blocks, enemy facts and busy state; it does not serialize the cross-floor catalog.
- Stable completion is accepted only when the final complete observation has the same runtime fingerprint as the last lightweight poll.
- Catalog cache invalidates automatically when runtime/catalog collections or their entries are replaced, added or removed.
- In-place catalog edits can explicitly call `adapter.invalidateEngineModelCache()`.
- Python authority cache is bounded to 16 entries and keyed by `model_hash`, floor and hero fields; a changed model hash derives fresh authority immediately.

## Functional result

- Atomic action APIs, guard checks and expected-delta validation are unchanged.
- Pending/completed/ACK/restart behavior passes the existing end-to-end integration flow.
- Current-floor block removal and key inventory changes update the warm `model_hash`.
- Automatic and explicit catalog invalidation both refresh `catalog_hash`.
- Production source and both generated artifacts pass mutation/API integrity checks.

## Commands

```sh
node --test games/mota-planning-lab/tests/js/engine-model-performance.test.js \
  games/mota-planning-lab/tests/js/executor-stability.test.js

PYTHONPATH=games/mota-planning-lab/service:games/mota-planning-lab/tests/python:/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  /opt/homebrew/bin/python3.12 -m unittest discover \
  -s games/mota-planning-lab/tests/python -p 'test_functional_engine_model.py' -v

MOTA_LAB_PYTHON=/opt/homebrew/bin/python3.12 \
MOTA_LAB_PYTHONPATH=/opt/homebrew/lib/python3.12/site-packages:/Users/nihplod/Library/Python/3.9/lib/python/site-packages \
  ./games/mota-planning-lab/scripts/run-offline-qa.sh
```

Final result: `Mota Planning Lab offline QA: PASS`.

## Build hashes

- `dist/mota-planning-lab.user.js`: `42acd2a4aa3b3e403ff2742941bb13c715db57ae1a2710a07f91359713e027a0`
- `dist/mota-planning-lab.direct-mount.js`: `02daae5f8324998a2308514c22b15bd21d9f7cdc22ae90c289311c8d33adf0c3`
