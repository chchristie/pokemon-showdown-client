# Analysis browser tests

Headless-Chrome tests that drive the real analysis page the way a user would: clicking buttons, choosing moves, running simulations. Use them to check that UI or API changes didn't break the core flow. **Extend these instead of writing new ad-hoc test scripts.**

This folder belongs to the DigiPen fork and isn't part of upstream. It has its own `package.json`, so the client's upstream `package.json` stays untouched.

## Prerequisites

1. **Google Chrome or Chromium installed.** Common macOS and Linux paths are detected automatically. Otherwise, set `CHROME_PATH`.
2. **Dependencies installed** (one time):
   ```sh
   cd pokemon-showdown-client/analysis.pokemonshowdown.com/test
   npm install
   ```
3. **The analysis API and client running**, built from the code you want to test:
   ```sh
   cd pokemon-showdown
   node start-analysis     # builds both repos; API on :8002, client on :8081
   ```
   Re-run `start-analysis` after changing code. The tests use whatever is currently built and running.

## Running

```sh
cd pokemon-showdown-client/analysis.pokemonshowdown.com/test
npm run smoke            # or: node smoke.js
```

- The output lists one `- step` line per passed step, then `PASS`, or `FAIL: <reason>`. Exit code 1 means failure.
- On failure, it prints the controls text, the Lines text and the recent battle log, and saves `output/smoke-failure.png`. A successful run saves `output/smoke-final.png`. `output/` is gitignored.
- The test fails on page JavaScript errors and on HTTP 4xx/5xx responses. The expected `pokedex-mini*.js` 404s are ignored; the page falls back to the official copies.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANALYSIS_URL` | `http://localhost:8081/analysis.pokemonshowdown.com/` | Page to open |
| `ANALYSIS_API` | `localhost:8002` | API `host:port`, passed as `?~~host:port` |
| `CHROME_PATH` | auto-detected | Chrome/Chromium executable |
| `HEADFUL` | unset | `1` shows the browser window, for watching or debugging |

To test against a separately started API, e.g. `ANALYSIS_PORT=8092 node dist/tools/analysis-server.js` in `pokemon-showdown`, run `ANALYSIS_API=localhost:8092 npm run smoke`.

## What `smoke.js` covers

The test uses gen9ou with the same team on both sides: Garchomp, Rotom-Wash and Kingambit (moves listed in `lib.js`). Steps:

1. **Page load:** no scripts come from the official site (local assets).
2. **New Analysis From Teams**, then team preview: p1 leads Rotom-Wash, p2 leads Kingambit.
3. **Cancel:** open an action menu, then Cancel.
4. **Manual turn 1:** Hydro Pump vs Kowtow Cleave, then Submit Choices. A Turn 2 node appears.
5. **Simulated turn 2:** Protect vs Swords Dance, 40 simulations, then Select Outcome. A Turn 3 node appears.
6. **Mid-turn replacement on turn 3:** Volt Switch vs Iron Head, then pick the Volt Switch replacement.
   - If rolls cause KOs, it also submits the end-of-turn faint replacements.
   - A Turn 4 node appears.
7. **Navigation:** click Turn 1 in Lines. The node is selected, its outcome tooltip exists, and later nodes are still there.

## Writing or extending tests

`lib.js` has the reusable pieces. Use them from new scenario files (e.g. `calc.js`) or new steps in `smoke.js`:

- `checkServers()`: fails fast with instructions if the client or API isn't running.
- `openAnalysisPage(teams)`: launches Chrome with teams in `localStorage`, then returns `{ browser, page, errors }`.
- **Clicking and waiting:**
  - `clickButton(page, text)`: clicks by visible button text; retries until it's enabled.
  - `waitFor(page, fn, label)`: polls a function in the page.
- **Battle flow:**
  - `selectLeads(page, p1Index, p2Index)`: team preview.
  - `openActionMenu(page, side)` and `chooseMove(page, side, moveIndex)`: singles, first active slot.
  - `waitForDecision(page, readyText?)`: skips turn animations and submits faint replacements until the controls show `readyText`.
- **Debugging:** `dumpFailure(page, name)`.
- **Data:** `SMOKE_TEAM` (packed team).

**Gotchas learned the hard way:**
- **Random rolls change the flow.** Crits, misses and KOs vary between runs. Pick moves that can't KO where the flow must be predictable, and let `waitForDecision` absorb faints elsewhere.
- **Stale controls.** Right after Submit Choices, the controls still show the previous decision's text for a moment. Before calling `waitForDecision`, wait for proof that the request finished, e.g. the new Turn node appearing in Lines. The exception: if the turn can end in a faint, the new node only appears after replacements, so wait for the controls to change instead (see the Volt Switch step).
- **Clicks during turn animations are ignored** by the page. `openActionMenu` retries for this reason.
- **Team preview buttons react to `mouseup`**, not `click`. `clickButton` and `selectLeads` send both.
- **Selectors use visible text and CSS classes** from `analysis.tsx` (`.battle-controls`, `.analysis-node-tree`, `.movemenu`, `data-tooltip="analysispokemon|…"`). If you rename buttons or classes, update `lib.js` and `smoke.js` in the same change.
