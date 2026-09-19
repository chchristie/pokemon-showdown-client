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
npm run smoke            # core flow (smoke.js)
npm run calc             # damage calc tooltips (calc.js)
npm run turn-events      # turn outcome summaries from hand-written logs (turn-events.js)
npm run edits            # field state edit form (edits.js)
npm run pokemon-edits    # Pokémon state edit form (pokemon-edits.js)
npm run teambuilder      # embedded teambuilder (teambuilder.js)
npm run setup            # Set Up Position (setup.js)
```

Server-side edit logic (what gets written to the sim and which protocol lines are emitted) has its own mocha test in the server repo: `npx mocha --no-config --exit test/main.js test/tools/analysis/edits.js`.

- The output lists one `- step` line per passed step, then `PASS`, or `FAIL: <reason>`. Exit code 1 means failure.
- On failure, it prints the controls text, the Lines text and the recent battle log, and saves `output/<test>-failure.png`. A successful smoke run saves `output/smoke-final.png`. `output/` is gitignored.
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
3. **Summary cell and Cancel:** clicking a choice-summary cell opens that Pokémon's action menu; then Cancel.
4. **Manual turn 1:** Hydro Pump vs Kowtow Cleave, then Submit Choices. A Turn 2 node appears.
5. **Simulated turn 2:** Protect vs Swords Dance, 40 simulations, then Select Outcome. A Turn 3 node appears.
6. **Mid-turn replacement on turn 3:** Volt Switch vs Iron Head, then pick the Volt Switch replacement.
   - If rolls cause KOs, it also submits the end-of-turn faint replacements.
   - A Turn 4 node appears.
8. **Navigation:** click Turn 1 in Lines. The node is selected, its outcome tooltip shows to the left of the button inside the window, and later nodes are still there.

## What `calc.js` covers

Damage calc tooltips (docs/analysis/plan.md, Phase 1), with the same team as the smoke test:

1. **Singles (gen9ou), Rotom-Wash vs Kingambit:**
   - Hovering Hydro Pump shows exactly 1 calc line, with icons, `(1)`/`(2)` and no EVs.
   - Ticking the move menu's Terastallize checkbox switches the Hydro Pump hover calc to Tera Electric.
   - Hovering Protect (a status move) shows no calc lines.
   - After choosing Hydro Pump (with Tera), only p1's choice-summary cell has a tooltip, and it shows 1 line using Tera.
2. **Doubles (gen9doublesou), Garchomp + Rotom-Wash vs Kingambit + Rotom-Wash:**
   - Hovering Earthquake shows 3 lines (both foes plus the ally), including the Levitate zero-damage text.
   - Hovering Dragon Tail shows 2 lines (foes only).
   - After choosing Dragon Tail on one target, the summary cell shows 1 line.

## What `turn-events.js` covers

`getTurnEventSummary` (analysis-turn-events.tsx) runs on hand-written protocol logs inside the page. It needs no battle and no RNG, so it's deterministic. It checks the switch reason shown as "Switched to X (reason)":
- **No reason:** a chosen switch.
- **Move:** U-turn and other pivots, plus Dragon Tail drags.
- **Item:** Eject Button, Red Card.
- **Ability:** Emergency Exit.
- **Fainted:** a replacement after a faint, including a pivot user KO'd by Rocky Helmet.

Add a case here when changing how turn outcomes are summarized.

## What `edits.js` covers

The field state edit form (docs/analysis/plan.md, Phase 2a), gen9ou with the smoke team, Rotom-Wash vs Kingambit:

1. **Clean start:** Save/Cancel are disabled; gen 9 offers Snow but not Hail; uncommon effects (Magic Room, pledges) appear only after **Show more**, and G-Max/Mud Sport/primal weathers never do.
2. **Buttons:** Rain defaults to 5 turns; clicking it again clears it; Cancel restores the form.
3. **Unsaved changes** (Rain for 3 turns, Stealth Rock on p2, 2 Spikes on p1, Tailwind on p2 for 2 turns) survive opening and cancelling an action menu.
4. **Save:** the log shows `Analysis edits: …`, the form shows the saved state and is clean again, Turn 1's Lines tooltip lists `Rain (3 Turns)`, then Team 1 `Spikes (2 Layers)` and Team 2 `Tailwind (2 Turns)`, `Stealth Rock (On)`, and the battle window's field text shows `Rain (3 turns)` and `Tailwind (2 turns)` rather than the client's estimates.
5. **Calcs:** Hydro Pump's hover calc says "in Rain".
6. **Countdown:** after a turn (Protect vs Swords Dance), Turn 2's form shows Rain with 2 turns, and the battle window shows `Rain (2 turns)` and `Tailwind (1 turn)`.
7. **Playback:** Replay Prev Turn; once the edits have played, the battle window still shows `Rain (3 turns)` and `Tailwind (2 turns)` while the turn animates (the weather fade used to bring back the estimates).
8. **Navigation:** an unsaved Trick Room toggle is discarded when selecting Turn 1.
9. **Copy-on-edit:** saving Trick Room at Turn 1 (which has a continuation) creates a sibling branch whose tooltip lists the earlier edits plus Trick Room; the original Turn 1 and its Turn 2 are unchanged.

Selectors: effect buttons have `data-field-effect` (`weather:raindance`, `trickroom`, `p2:stealthrock`, `p1:spikes:2`), turns inputs `data-field-turns` (`weather`, `p1:reflect`, …).

## What `pokemon-edits.js` covers

The Pokémon state edit form (docs/analysis/plan.md, Phase 2b-1), gen9ou with the smoke team:

1. **Opening it:** clicking p1's first team icon in the sidebar opens that Pokémon's form, with Save disabled and all 7 boost dropdowns. The icons carry `analysispokemon|side|index` in the team's current order, which is not the order the icons are drawn in.
2. **Editing:** setting HP by percent fills in the HP box; burn, a Speed boost and a PP change save and come back from the server, leaving the form clean.
3. **Battle window:** it shows the edited HP (50%) and the burn; the move button shows the edited PP.
4. **Action menu:** its **Edit Pokémon** button opens the form for the Pokémon whose action was being chosen.
5. **Benched Pokémon:** no boost dropdowns, and **Send out** makes it active.
6. **Lines tooltip:** the Pokémon's edits are listed under its team.
7. **Cancel** goes back to the field form.

Regression checks from the first review: the Pokémon tooltip shows edited PP, a second save keeps the first save's boosts, and after a Set Active swap the icons and the stored edits still point at the Pokémon they were made for, with that slot's drafted action cleared.

Selectors: `data-pokemon-field` (HP, `HP percent`, `Hydro Pump PP`, `Toxic stage`, `Sleep turns`), `data-pokemon-boost` (`atk`…`evasion`), and `data-field-effect` for the buttons (`status:brn`, `active:0`, `terastallized`).

## What `setup.js` covers

Set Up Position (docs/analysis/plan.md, Phase 4). It is the one suite that starts with **no teams in
`localStorage`**, because the whole point is that it needs none:

1. **Starting:** Home → Set Up Position → a format → the button. The tab opens at Turn 1, and Lines shows no
   Team Preview node (it exists, hidden, to hold the seed and the auto-chosen `team` input).
2. **Placeholders:** one on each side of the field in singles, two each in doubles, all active.
3. **The sprite opens the teambuilder**, with that Pokémon's species field genuinely focused
   (`document.activeElement` is `[data-focus="set-0-pokemon"]`) and the focused form having a real height.
4. **The sidebar icon still opens the Pokémon panel**, which shows **four move rows** for a Pokémon with
   none. Giving it moves and saving is enough to make its sprite open the action menu instead, with the
   saved moves choosable.
5. **The other side's untouched placeholder** still opens its own (Team 2's) teambuilder.

It picks its moves out of the dropdown's own options rather than naming them: the legal moves depend on the
placeholder species, and setting a `<select>` to a value it doesn't offer silently leaves it empty.

## Writing or extending tests

`lib.js` has the reusable pieces. Use them from new scenario files (e.g. `calc.js`) or new steps in `smoke.js`:

- `checkServers()`: fails fast with instructions if the client or API isn't running.
- `openAnalysisPage(teams)`: launches Chrome with teams in `localStorage`, then returns `{ browser, page, errors }`. Each team is `{ format, name, packed }`. Add teams for every format the scenario starts.
- `startAnalysisFromTeams(page, format?)`: home page → New Analysis From Teams → pick the format → Start.
- `startSetUpPosition(page, format?)`: home page → Set Up Position → pick the format → Set Up Position. Needs no teams; the tab opens straight at Turn 1 on placeholder Pokémon.
- **Clicking and waiting:**
  - `clickButton(page, text)`: clicks by visible button text; retries until it's enabled.
  - `waitFor(page, fn, label)`: polls a function in the page.
- **Battle flow:**
  - `selectLeads(page, p1, p2)`: team preview. Pass a team index, or an array of indices for doubles.
  - `openActionMenu(page, side)` and `chooseMove(page, side, moveIndex)`: singles, first active slot.
  - `waitForDecision(page, readyText?)`: skips turn animations and submits faint replacements until the controls show `readyText`.
- **Tooltips:** `hoverTooltip(page, selector, { text, until })` hovers an element and returns the tooltip's `{ text, html }` once `until(text)` holds. `calcLineCount(html)` counts damage calc lines.
- **Debugging:** `dumpFailure(page, name)`.
- **Data:** `SMOKE_TEAM` (packed team).

**Gotchas learned the hard way:**
- **Random rolls change the flow.** Crits, misses and KOs vary between runs. Pick moves that can't KO where the flow must be predictable, and let `waitForDecision` absorb faints elsewhere.
- **Stale controls.** Right after Submit Choices, the controls still show the previous decision's text for a moment. Before calling `waitForDecision`, wait for proof that the request finished, e.g. the new Turn node appearing in Lines. The exception: if the turn can end in a faint, the new node only appears after replacements, so wait for the controls to change instead (see the Volt Switch step).
- **Clicks during turn animations are ignored** by the page. `openActionMenu` retries for this reason.
- **Team preview buttons react to `mouseup`**, not `click`. `clickButton` and `selectLeads` send both.
- **The Lines branch appears before the save finishes.** Copy-on-edit adds the sibling node immediately; wait for its edit summary before checking it.
- **Selectors use visible text and CSS classes** from `analysis.tsx` (`.battle-controls`, `.analysis-node-tree`, `.movemenu`, `data-tooltip="analysispokemon|…"`). If you rename buttons or classes, update `lib.js` and `smoke.js` in the same change.
