'use strict';
/**
 * Import Replay (docs/analysis/replay-import-audit.md): a tab built by reconstructing a replay, one
 * absolute position per turn.
 * - a replay log pasted as a file opens the onboarding pass, not the battle
 * - onboarding shows each side's reconstructed team, and Skip accepts the inferences as they stand
 * - the replay becomes the main line in Lines, one node per turn
 * - a format this server doesn't have is refused rather than silently substituted
 * - a chosen file can be removed again, so the URL field is usable after one is picked by mistake
 * - an error raised in one start panel does not follow the user into another
 * - a bring-four VGC replay asks which Pokémon were brought, locking in the ones it showed
 * - a node plays the replay's own history in front of the reconstruction, and a turn played on from one
 *   continues the replay's numbering instead of restarting at turn 1
 *
 * The log is supplied through the file input rather than fetched, so the suite doesn't depend on
 * replay.pokemonshowdown.com being reachable.
 * Usage and prerequisites: see README.md in this folder.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
	step, checkServers, openAnalysisPage, clickButton, chooseMove, hoverTooltip, waitFor, waitForDecision,
	linesText, dumpFailure,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

/**
 * A tiny hand-written replay: two turns of gen 9 OU, enough to exercise team inference, the per-turn
 * snapshots and the onboarding pass without depending on a network fetch.
 */
const REPLAY_LOG = [
	'|player|p1|Alice|1|', '|player|p2|Bob|2|', '|gametype|singles', '|gen|9', '|tier|[Gen 9] OU',
	'|clearpoke',
	// Six a side, as a real replay has: a short roster hid an ordering bug where the turn-1 edits were
	// applied before Team Preview was answered, leaving a Pokémon active outside `side.slotConditions`.
	'|poke|p1|Pikachu, M|', '|poke|p1|Bulbasaur, F|', '|poke|p1|Charmander, M|',
	'|poke|p1|Squirtle, F|', '|poke|p1|Eevee, M|', '|poke|p1|Snorlax, F|',
	'|poke|p2|Charmander, M|', '|poke|p2|Squirtle, F|', '|poke|p2|Bulbasaur, M|',
	'|poke|p2|Pidgey, F|', '|poke|p2|Rattata, M|', '|poke|p2|Meowth, F|',
	'|teampreview',
	'|teamsize|p1|6', '|teamsize|p2|6', '|start',
	// Both leads are deliberately the **last** roster entry, not the first. A lead that happens to be
	// roster slot 0 makes the turn-1 `active` edit a no-op and hides ordering bugs in the rebuild.
	'|switch|p1a: Snorlax|Snorlax, F|100/100', '|switch|p2a: Meowth|Meowth, F|100/100',
	'|turn|1',
	'|move|p1a: Snorlax|Body Slam|p2a: Meowth', '|-damage|p2a: Meowth|62/100',
	'|move|p2a: Meowth|Scratch|p1a: Snorlax', '|-damage|p1a: Snorlax|81/100',
	'|upkeep', '|turn|2',
	'|move|p1a: Snorlax|Body Slam|p2a: Meowth', '|-damage|p2a: Meowth|40/100',
	'|upkeep', '|turn|3',
	// The game is decided on turn 3, after its node was taken: the end position needs a node of its own,
	// and it leaves p2 with nothing on the field, which only works if `null` can empty an active slot.
	'|move|p1a: Snorlax|Body Slam|p2a: Meowth', '|-damage|p2a: Meowth|0 fnt', '|faint|p2a: Meowth',
	'|win|Alice',
].join('\n');

/**
 * A bring-four VGC replay: six on the roster, `|teamsize|` of 4, and only three of p1's ever on the field.
 * That is the case the brought-Pokémon step exists for — a Pokémon brought but never sent out looks exactly
 * like one left behind, so the fourth slot is the user's to choose.
 */
const VGC_REPLAY_LOG = [
	'|player|p1|Alice|1|', '|player|p2|Bob|2|', '|gametype|doubles', '|gen|9',
	'|tier|[Gen 9] VGC 2025 Reg I',
	'|clearpoke',
	'|poke|p1|Incineroar, M|', '|poke|p1|Rillaboom, M|', '|poke|p1|Amoonguss, F|',
	'|poke|p1|Dragonite, M|', '|poke|p1|Urshifu-Rapid-Strike, M|', '|poke|p1|Raging Bolt|',
	'|poke|p2|Miraidon|', '|poke|p2|Flutter Mane|', '|poke|p2|Chien-Pao|',
	'|poke|p2|Farigiraf, F|', '|poke|p2|Ursaluna, M|', '|poke|p2|Rillaboom, F|',
	// Four brought out of six, which is what makes the step appear at all.
	'|teamsize|p1|4', '|teamsize|p2|4',
	'|teampreview|4', '|start',
	'|switch|p1a: Incineroar|Incineroar, M|100/100', '|switch|p1b: Amoonguss|Amoonguss, F|100/100',
	'|switch|p2a: Miraidon|Miraidon|100/100', '|switch|p2b: Flutter Mane|Flutter Mane|100/100',
	'|turn|1',
	'|move|p2a: Miraidon|Electro Drift|p1a: Incineroar', '|-damage|p1a: Incineroar|48/100',
	'|move|p1a: Incineroar|Fake Out|p2a: Miraidon', '|-damage|p2a: Miraidon|94/100',
	'|upkeep', '|turn|2',
	// A third p1 Pokémon appears, leaving exactly one brought slot unaccounted for.
	'|switch|p1a: Dragonite|Dragonite, M|100/100',
	'|move|p2b: Flutter Mane|Moonblast|p1b: Amoonguss', '|-damage|p1b: Amoonguss|61/100',
	'|upkeep', '|turn|3',
].join('\n');

/** Drives the file input directly, which is what a user choosing a `.log` does. */
async function importReplay(page, log) {
	const file = path.join(os.tmpdir(), `analysis-replay-test-${Date.now()}.log`);
	fs.writeFileSync(file, log);
	try {
		await clickButton(page, 'Import Replay');
		const input = await page.waitForSelector('.analysis-form input[type="file"]', { timeout: 20000 });
		await input.uploadFile(file);
		// Reading the file is async, so wait for the form to say it has one before submitting.
		await waitFor(page, () => /Loaded /.test(
			document.querySelector('.analysis-form')?.textContent || ''
		), 'the replay file to load');
		await clickButton(page, 'Open Replay Analysis');
	} finally {
		fs.rmSync(file, { force: true });
	}
}

/**
 * The file input is an alternative to the URL field, and the file wins wherever both are given — so a file
 * chosen by mistake used to leave the URL field dead with no way back short of reloading the page. This
 * also covers the error not outliving the panel that raised it.
 */
async function removableFileSteps(page) {
	const file = path.join(os.tmpdir(), `analysis-replay-removable-${Date.now()}.log`);
	// a log with no turns, so Open raises a real error to check the clearing against
	fs.writeFileSync(file, ['|player|p1|Alice|1|', '|player|p2|Bob|2|', '|gametype|singles', '|gen|9'].join('\n'));
	try {
		await clickButton(page, 'Import Replay');
		const input = await page.waitForSelector('.analysis-form input[type="file"]', { timeout: 20000 });
		await input.uploadFile(file);
		await waitFor(page, () => /Loaded /.test(
			document.querySelector('.analysis-form')?.textContent || ''
		), 'the replay file to load');

		await clickButton(page, 'Open Replay Analysis');
		await waitFor(page, () => /no turns to analyse/.test(
			document.querySelector('.analysis-form .message-error')?.textContent || ''
		), 'the no-turns error');
		step('a replay with no turns is refused with an error');

		// Leaving for another panel and coming back must not carry the error along
		await clickButton(page, 'Import Analysis');
		const carried = await page.evaluate(() =>
			document.querySelector('.analysis-form .message-error')?.textContent || '');
		expect(!/no turns to analyse/.test(carried),
			`the replay error followed the user into Import Analysis: ${carried}`);
		step('an error does not outlive the panel that raised it');

		await clickButton(page, 'Import Replay');
		await waitFor(page, () => /Loaded /.test(
			document.querySelector('.analysis-form')?.textContent || ''
		), 'the chosen file to still be there');
		await clickButton(page, 'Remove');
		const cleared = await page.evaluate(() => ({
			note: document.querySelector('.analysis-form')?.textContent || '',
			// the input itself must be cleared too, or the same file could never be chosen again
			value: document.querySelector('.analysis-form input[type="file"]')?.value || '',
		}));
		expect(!/Loaded /.test(cleared.note), `Remove left the file loaded: ${cleared.note.slice(0, 120)}`);
		expect(!cleared.value, `Remove left the input populated: ${cleared.value}`);
		step('a chosen replay file can be removed, freeing the URL field');
	} finally {
		fs.rmSync(file, { force: true });
	}
	// back to a clean form for the suite proper
	await clickButton(page, 'Cancel');
}

function teambuilderText(page) {
	return page.evaluate(() =>
		document.querySelector('.analysis-teambuilder')?.textContent.replace(/\s+/g, ' ') || '');
}

/**
 * The species actually loaded in the editor. Checked instead of the heading, which is driven by the side
 * prop and so stayed correct even when the editor itself was still showing the other team.
 */
function editorRoster(page) {
	return page.evaluate(() => [...document.querySelectorAll(
		'.analysis-teambuilder .set-form input.set-field[data-focus$="-pokemon"]'
	)].map(input => input.value).filter(Boolean).join(','));
}

/** Clicks one roster entry in a side's Team Preview menu, without submitting. */
async function pickPreviewPokemon(page, sideIndex, rosterIndex) {
	await page.evaluate((side, index) => {
		const menu = document.querySelectorAll('.switchcontrols .switchmenu')[side];
		menu.querySelectorAll('button')[index].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
	}, sideIndex, rosterIndex);
	await new Promise(resolve => setTimeout(resolve, 200));
}

/** Opens the first node in Lines for a given turn, which for a replay is the imported one. */
async function selectTurnNode(page, turn) {
	await page.evaluate(n => {
		const button = [...document.querySelectorAll('.analysis-node-button')]
			.find(entry => new RegExp(`^\\s*Turn ${n}\\b`).test(entry.textContent));
		if (!button) throw new Error(`no Turn ${n} node`);
		button.click();
	}, turn);
	await new Promise(resolve => setTimeout(resolve, 400));
}

/** Plays a turn with each side's first move, the shortest way to get one simulated turn on the board. */
async function submitDefaultChoices(page) {
	await chooseMove(page, 0, 0);
	await chooseMove(page, 1, 0);
	await clickButton(page, 'Submit Choices');
}

/** The Team Preview roster as rendered, per side: the button labels in order. */
function previewRoster(page, sideIndex) {
	return page.evaluate(side => [...document.querySelectorAll('.switchcontrols .switchmenu')[side]
		.querySelectorAll('button')].map(button => button.textContent.replace(/\s+/g, ' ').trim()), sideIndex);
}

/**
 * A bring-four replay has to ask which Pokémon were brought, because a Pokémon brought but never sent out
 * is indistinguishable from one left behind. The ones the replay showed are locked in.
 */
async function vgcPreviewStep(errors) {
	const { browser, page, errors: pageErrors } = await openAnalysisPage([]);
	try {
		await importReplay(page, VGC_REPLAY_LOG);
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder'), 'the onboarding teambuilder');

		await clickButton(page, 'Save and Continue');
		await waitFor(page, () => document.body.textContent.includes('Choose Pokémon'),
			'the brought-Pokémon step');
		step('a bring-four replay routes Save and Continue through the brought-Pokémon step');

		// Same reason as during onboarding: the import isn't a line to browse until it has been finished.
		const stepNodes = await page.evaluate(() =>
			[...document.querySelectorAll('.analysis-node-button')].map(button => button.disabled));
		expect(stepNodes.length > 0 && stepNodes.every(Boolean),
			`every node should be unselectable during the step, got: ${JSON.stringify(stepNodes)}`);
		step('the Lines panel stays locked through the brought-Pokémon step');

		// p1 showed Incineroar, Amoonguss and Dragonite; the fourth slot is the user's to choose.
		const p1Roster = await previewRoster(page, 0);
		const seen = p1Roster.filter(name => /\(seen\)/.test(name));
		expect(seen.length === 3, `expected three seen Pokémon, got: ${JSON.stringify(p1Roster)}`);
		expect(seen.every(name => /Incineroar|Amoonguss|Dragonite/.test(name)),
			`expected the Pokémon the replay showed, got: ${JSON.stringify(seen)}`);
		const counts = await page.evaluate(() => [...document.querySelectorAll('.analysis-switch-count')]
			.map(node => node.textContent.replace(/\s+/g, ' ').trim()));
		expect(/3\/4/.test(counts[0]), `expected three of four chosen for p1, got: ${counts[0]}`);
		expect(/2\/4/.test(counts[1]), `expected two of four chosen for p2, got: ${counts[1]}`);
		step('the Pokémon the replay showed are locked in, and the rest are still to choose');

		// Incomplete picks can't start the analysis: p2 is still two short.
		const startDisabled = await page.evaluate(() => [...document.querySelectorAll('button')]
			.find(button => button.textContent.includes('Start Analysis'))?.disabled);
		expect(startDisabled === true, 'expected Start Analysis to be disabled until both sides are full');
		step('Start Analysis waits for both sides to be complete');

		/*
		 * Pick the **last** roster entry for the open slot rather than the first, which is what the
		 * roster-order default would have taken (Rillaboom, slot 1). Choosing Raging Bolt is what makes the
		 * assertion below able to fail if the picks were ignored.
		 */
		await pickPreviewPokemon(page, 0, 5);
		await pickPreviewPokemon(page, 1, 5);
		await pickPreviewPokemon(page, 1, 4);
		await clickButton(page, 'Start Analysis');
		await waitFor(page, () => !document.body.textContent.includes('Choose Pokémon'), 'the analysis');
		await waitForDecision(page);

		const state = await page.evaluate(() => ({
			error: document.querySelector('.message-error')?.textContent || '',
			roster: [...document.querySelectorAll(
				'.battle .trainer-near .picon[data-tooltip^="analysispokemon|0|"]'
			)].map(icon => icon.getAttribute('aria-label') || '').join(', '),
		}));
		expect(!state.error, `expected no error after the step, got: ${state.error}`);
		// Four brought, not the whole roster of six.
		expect(state.roster.split(', ').length === 4, `expected a team of four, got: ${state.roster}`);
		// The chosen fourth Pokémon has to be the one on the team, not the roster-order default.
		expect(/Raging Bolt/.test(state.roster),
			`expected the chosen Raging Bolt on p1's team, got: ${state.roster}`);
		expect(!/Rillaboom/.test(state.roster),
			`expected the roster-order default to have been overridden, got: ${state.roster}`);
		step("the chosen Pokémon are the ones brought, not the roster-order default");

		if (pageErrors.length) errors.push(...pageErrors);
	} catch (error) {
		await dumpFailure(page, 'replay-vgc');
		throw error;
	} finally {
		await browser.close();
	}
}

async function main() {
	await checkServers();
	const { browser, page, errors } = await openAnalysisPage([]);
	try {
		await removableFileSteps(page);
		await importReplay(page, REPLAY_LOG);

		// Onboarding first: the reconstruction is shown for team 1 before any battle is.
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder'), 'the onboarding teambuilder');
		let text = await teambuilderText(page);
		expect(/Reconstructed Team 1/.test(text), `expected team 1's reconstruction, got: ${text.slice(0, 200)}`);
		expect(/inferred from the replay log/.test(text), 'expected the explanatory note');
		// The roster lives in the editor's input *values*, not its text — checking the panel's textContent
		// was really checking the inference list, which is now folded away.
		await waitFor(page, () => [...document.querySelectorAll(
			'.analysis-teambuilder .set-form input.set-field[data-focus$="-pokemon"]'
		)].some(input => /Pikachu/.test(input.value)), "team 1's reconstructed roster");
		step('importing a replay opens the onboarding pass on team 1');

		/*
		 * What the replay couldn't determine is a per-Pokémon list that grows with the roster, so it is
		 * folded away behind a button rather than filling the panel on arrival.
		 */
		const hidden = await page.evaluate(() => ({
			items: document.querySelectorAll('.analysis-teambuilder-problems li').length,
			button: [...document.querySelectorAll('.analysis-teambuilder button')]
				.find(entry => /Show more details/.test(entry.textContent))?.textContent.trim() || '',
		}));
		expect(!hidden.items, `the inference list should start hidden, saw ${hidden.items} entries`);
		expect(/^Show more details \(\d+\)$/.test(hidden.button),
			`expected a "Show more details" button with a count, got: ${hidden.button}`);
		await clickButton(page, 'Show more details');
		const shown = await page.evaluate(() =>
			[...document.querySelectorAll('.analysis-teambuilder-problems li')].map(li => li.textContent.trim()));
		expect(shown.length > 0, 'expected the inference list once it is asked for');
		// "Snorlax (1): ability not revealed, guessed." — the species and which team it is on, not a
		// roster position the reader has no use for.
		for (const line of shown) {
			expect(/^[^:]+ \([12]\): .+/.test(line), `expected "Species (team): reason", got: ${line}`);
		}
		step('the inferences are folded away, and name the Pokémon and its team');

		/*
		 * Lines is not browsable until the import has been finished. Selecting a node closed the
		 * teambuilder while leaving the tab mid-onboarding, so reopening it came back in onboarding mode
		 * on a tab that was already past it (user report, 2026-09-19).
		 */
		const nodeButtons = await page.evaluate(() =>
			[...document.querySelectorAll('.analysis-node-button')].map(button => button.disabled));
		expect(nodeButtons.length > 0, 'expected the replay line to be listed during onboarding');
		expect(nodeButtons.every(Boolean),
			`every node should be unselectable during onboarding, got: ${JSON.stringify(nodeButtons)}`);
		step('the Lines panel is locked while the import is still being completed');

		// The two teams are reachable from each other, in both directions, without leaving onboarding.
		const team1Roster = await editorRoster(page);
		expect(/Pikachu/.test(team1Roster), `expected team 1 in the editor, got: ${team1Roster}`);
		await clickButton(page, 'Team 2');
		await waitFor(page, () => /Reconstructed Team 2/.test(
			document.querySelector('.analysis-teambuilder')?.textContent || ''
		), "team 2's reconstruction");
		// The editor unpacks its team once on mount, so without a remount it keeps showing the other side
		// while the heading changes — and then reports an empty team on the next save.
		await waitFor(page, () => [...document.querySelectorAll(
			'.analysis-teambuilder .set-form input.set-field[data-focus$="-pokemon"]'
		)].some(input => /Meowth|Pidgey|Rattata/.test(input.value)), "team 2's roster in the editor");
		const team2Roster = await editorRoster(page);
		expect(team2Roster !== team1Roster, `expected a different roster, still: ${team2Roster}`);
		step('the Team 1 / Team 2 buttons switch the editor, not just the heading');

		await clickButton(page, 'Team 1');
		await waitFor(page, () => /Reconstructed Team 1/.test(
			document.querySelector('.analysis-teambuilder')?.textContent || ''
		), 'team 1 again');
		await waitFor(page, () => [...document.querySelectorAll(
			'.analysis-teambuilder .set-form input.set-field[data-focus$="-pokemon"]'
		)].some(input => /Pikachu/.test(input.value)), "team 1's roster again");
		// Switching back used to leave the editor detached, so the next save saw no sets at all.
		const backRoster = await editorRoster(page);
		expect(backRoster === team1Roster, `expected team 1 back, got: ${backRoster}`);
		expect(!(await teambuilderText(page)).includes('needs at least one'),
			'switching back should not report an empty team');
		step('switching back restores team 1 and leaves the editor usable');

		// Skip accepts the inferences and drops straight into the analysis.
		await clickButton(page, 'Skip');
		await waitFor(page, () => !document.querySelector('.analysis-teambuilder'), 'the battle');
		step('Skip leaves onboarding without saving');

		// The replay is the main line: one node per turn, and no Team Preview node (the tab is sandboxed).
		const lines = await linesText(page);
		expect(/Turn 1/.test(lines) && /Turn 2/.test(lines), `expected a turn per node, got: ${lines.slice(0, 200)}`);
		expect(!/Team Preview/.test(lines), `expected no Team Preview node, got: ${lines.slice(0, 200)}`);
		step('the replay becomes the main line in Lines, one node per turn');

		// The position has to actually rebuild: the ordering bug above surfaced as a 400 from the server,
		// which showed as an error panel and no battle at all.
		const state = await page.evaluate(() => ({
			error: document.querySelector('.message-error')?.textContent || '',
			controls: document.querySelector('.battle-controls')?.textContent.replace(/\s+/g, ' ') || '',
		}));
		expect(!state.error, `expected no error after Skip, got: ${state.error}`);
		expect(/Submit Choices/.test(state.controls), `expected a real decision point, got: ${state.controls.slice(0, 200)}`);
		// An imported tab is sandboxed, but it is not a Set Up Position tab: there are no placeholders.
		expect(!/placeholder/i.test(state.controls), `unexpected Set Up Position intro: ${state.controls.slice(0, 200)}`);
		step('the reconstructed position opens at a real decision point');

		/*
		 * Log splicing (audit Q6). A reconstruction is a fresh battle at turn 1, so every node used to open
		 * on the same made-up Team Preview and render as "Turn 1" whatever turn it really was. The renderer
		 * now plays the replay's own history up to the node's turn and the reconstruction behind it.
		 */
		await selectTurnNode(page, 3);
		await waitForDecision(page);
		const spliced = await page.evaluate(() => ({
			log: (document.querySelector('.battle-log')?.textContent || '').replace(/\s+/g, ' '),
			trainers: [...document.querySelectorAll('.battle .trainer')]
				.map(node => node.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
			// each Pokémon exactly once: a spliced `switch` that is read as a switch rather than as a
			// statement of where a Pokémon is adds a second copy of it to the side
			icons: [...document.querySelectorAll('.battle .trainer-near .picon')]
				.map(icon => icon.getAttribute('aria-label') || '').filter(Boolean),
		}));
		expect(/Turn 1/.test(spliced.log) && /Turn 2/.test(spliced.log) && /Turn 3/.test(spliced.log),
			`expected the replay's own turns in the log, got: ${spliced.log.slice(-300)}`);
		// Turns 1 and 2 of the replay both happened, and only real history can show them twice.
		expect((spliced.log.match(/Body Slam/g) || []).length >= 2,
			`expected the earlier turns to have been played, got: ${spliced.log.slice(-300)}`);
		// The reconstruction's players are "Analysis 1" and "Analysis 2"; the replay's are the real ones.
		expect(/Alice/.test(spliced.trainers) && /Bob/.test(spliced.trainers),
			`expected the replay's own players, got: ${spliced.trainers}`);
		expect(new Set(spliced.icons).size === spliced.icons.length,
			`expected each Pokémon once on the rendered team, got: ${spliced.icons.join(', ')}`);
		// The reconstruction is how the position came to exist, not something that happens on this turn:
		// it is applied without a word, so the log reads as the replay it came from.
		expect(!/Analysis edits:/.test(spliced.log),
			`the reconstruction should not narrate itself, got: ${spliced.log.slice(-300)}`);
		step("a replay node plays the replay's real history in front of the reconstructed position");

		/*
		 * PP the replay watched being spent. Snorlax has used Body Slam on turns 1 and 2, so at turn 3 it is
		 * two down from its maximum — every move used to come back full, because the client worked out the
		 * remaining PP itself and the server's clamp quietly rounded the overestimate back up (user report).
		 */
		const ppTooltip = await hoverTooltip(page, '.battle .picon[data-tooltip="analysispokemon|0|0"]', {
			until: text => /Body Slam/.test(text),
		});
		expect(/Body Slam[^]*?22\s*\/\s*24/.test(ppTooltip?.text || ''),
			`expected Body Slam at 22/24 after two uses, got: ${(ppTooltip?.text || '').slice(0, 200)}`);
		step('PP spent in the replay carries into the reconstructed position');

		/*
		 * Lines reads properly before anything is clicked. Both of these used to be filled in only when a
		 * node was selected, so an imported replay opened as a column of "No action selected" (user report,
		 * 2026-09-19) — even though the replay says outright what both sides did.
		 */
		const turnNodeText = await page.evaluate(n => {
			const button = [...document.querySelectorAll('.analysis-node-button')]
				.find(entry => new RegExp(`^\\s*Turn ${n}\\b`).test(entry.textContent));
			return button ? button.textContent.replace(/\s+/g, ' ').trim() : '';
		}, 1);
		// Both sides act on turn 1 of the fixture, so both are inferable. A slot the log leaves open — the
		// fixture's turn 2, where p2 never moves — is still allowed to read "No action selected".
		expect(/Body Slam/.test(turnNodeText) && /Scratch/.test(turnNodeText),
			`expected both sides' actions on the Turn 1 node, got: ${turnNodeText}`);
		expect(!/No action selected/.test(turnNodeText),
			`turn 1 says what both sides did, so neither slot should be blank: ${turnNodeText}`);
		const outcome = await page.evaluate(() => {
			const button = [...document.querySelectorAll('.analysis-node-button')]
				.find(entry => /^\s*Turn 2\b/.test(entry.textContent));
			const tooltip = button?.nextElementSibling;
			return tooltip?.classList.contains('analysis-node-tooltip') ?
				tooltip.textContent.replace(/\s+/g, ' ') : '';
		});
		expect(/Turn 2 → Turn 3/.test(outcome), `expected an outcome tooltip on a replay node, got: ${outcome}`);
		expect(/Body Slam/.test(outcome), `expected the turn's events in the tooltip, got: ${outcome}`);
		step('replay nodes carry the actions and the outcome the replay shows, without being selected');

		/*
		 * And they are real drafted choices, not a label. Selecting the node used to blank the Lines table
		 * back to "No action selected" and leave the Action Summary empty (user report, 2026-09-19),
		 * because nothing was ever stored on the node for the draft to be rebuilt from.
		 */
		await selectTurnNode(page, 1);
		await waitForDecision(page);
		const selected = await page.evaluate(() => ({
			summary: document.querySelector('.analysis-action-summary')?.textContent.replace(/\s+/g, ' ') || '',
			node: [...document.querySelectorAll('.analysis-node-button')]
				.find(entry => /^\s*Turn 1\b/.test(entry.textContent))?.textContent.replace(/\s+/g, ' ') || '',
		}));
		expect(/Body Slam/.test(selected.summary) && /Scratch/.test(selected.summary),
			`expected the replay's actions in the Action Summary, got: ${selected.summary}`);
		expect(!/No action selected/.test(selected.summary),
			`both sides acted on turn 1, so neither slot should be blank: ${selected.summary}`);
		expect(/Body Slam/.test(selected.node) && !/No action selected/.test(selected.node),
			`selecting the node should not blank its Lines entry, got: ${selected.node}`);
		step("a replay node's actions are real choices: they fill the Action Summary and survive selection");

		/*
		 * And a turn played on from there continues it, rather than restarting the numbering at the
		 * reconstruction's own turn 1. This is also the only check that a replay node's **own** choices are
		 * replayed: they used to be dropped along with the inferred ones, so the child rebuilt at its
		 * parent's position and the battle never left the reconstructed turn.
		 *
		 * The reconstruction's Meowth has no EVs, so Body Slam knocks it out here and the turn ends in a
		 * faint replacement. That is the useful path to take: replacements are streamed into the live
		 * renderer (`continuePlayback`) instead of rebuilding it, which is the other place the replay's
		 * turn numbering has to be applied.
		 */
		await selectTurnNode(page, 2);
		await waitForDecision(page);
		const beforeTurn = await page.evaluate(() =>
			(document.querySelector('.battle-log')?.textContent || '').replace(/\s+/g, ' '));
		expect(/Turn 2/.test(beforeTurn) && !/Turn 3/.test(beforeTurn),
			`expected the turn-2 node to stop at turn 2, got: ${beforeTurn.slice(-200)}`);
		await submitDefaultChoices(page);
		// The controls still say "Submit Choices" for a moment after the click, so waitForDecision would
		// return on the state *before* the turn and leave the replacement prompt undriven. Wait for the
		// turn to actually start first.
		await waitFor(page, () => {
			const text = document.querySelector('.battle-controls')?.textContent || '';
			return /Choose replacement/.test(text) ||
				[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Skip Turn');
		}, 'the submitted turn to start playing');
		await waitForDecision(page);
		await waitFor(page, () => /Turn 3/.test(document.querySelector('.battle-log')?.textContent || ''),
			'the simulated turn to land as turn 3');
		step('a turn simulated from a replay node continues the replay rather than restarting it');

		/*
		 * That turn forked a **sibling** of the Turn 2 node, because the imported one already had a child,
		 * and the sibling now has a child of its own — so Lines should offer its outcome on hover.
		 *
		 * It did not (user report, 2026-09-19). The outcome is read out of the log the server just
		 * returned, which for a position rebuilt from a replay node calls that node's turn `|turn|1`, so
		 * looking it up as `node.turn` found nothing and stored `[]`. An empty array is truthy, so the
		 * tooltip still opened for the node's edits with the outcome section blank — which is why this
		 * checks the events and not merely that a tooltip exists.
		 */
		const siblingOutcome = await page.evaluate(() => {
			const buttons = [...document.querySelectorAll('.analysis-node-button')]
				.filter(entry => /^\s*Turn 2\b/.test(entry.textContent));
			// the imported node comes first; the fork is the later one
			const tooltip = buttons[buttons.length - 1]?.nextElementSibling;
			return tooltip?.classList.contains('analysis-node-tooltip') ?
				tooltip.textContent.replace(/\s+/g, ' ') : '';
		});
		expect(/Turn 2 → Turn 3/.test(siblingOutcome),
			`expected an outcome tooltip on the forked node, got: ${siblingOutcome}`);
		expect(/Body Slam/.test(siblingOutcome),
			`expected the forked turn's events in its tooltip, got: ${siblingOutcome}`);
		step('a turn played off a replay node carries its outcome into Lines');

		/*
		 * The end of the game is its own node. A replay's last `|turn|` is the *start* of the turn that
		 * decided it, so without this the result had nowhere to live.
		 */
		expect(/Game Over/.test(lines), `expected a Game Over node, got: ${lines.slice(0, 300)}`);
		expect(/Alice won/.test(lines), `expected the winner in Lines, got: ${lines.slice(0, 300)}`);
		await page.evaluate(() => [...document.querySelectorAll('.analysis-node-button')]
			.find(button => button.textContent.includes('Game Over')).click());
		await waitFor(page, () => /Alice won the battle/.test(
			document.querySelector('.battle-controls')?.textContent || ''
		), 'the end-of-game controls');
		const over = await page.evaluate(() => ({
			controls: document.querySelector('.battle-controls')?.textContent.replace(/\s+/g, ' ') || '',
			fieldEditor: !!document.querySelector('.analysis-field-editor'),
			buttons: Object.fromEntries([...document.querySelectorAll('.analysis-choice-controls button')]
				.map(button => [button.textContent.trim(), button.disabled])),
			error: document.querySelector('.message-error')?.textContent || '',
		}));
		expect(!over.error, `expected no error on the end node, got: ${over.error}`);
		// nothing is left to choose, so the action and edit controls go entirely
		expect(!/Submit Choices|Simulate/.test(over.controls), `unexpected action controls: ${over.controls}`);
		expect(!over.fieldEditor, 'the field editor should be hidden once the game is over');
		// but the turn controls stay, so you can walk back into the game
		expect(over.buttons['Next Turn'] === true, `Next Turn should be greyed out: ${JSON.stringify(over.buttons)}`);
		expect(over.buttons['Prev Turn'] === false, `Prev Turn should work: ${JSON.stringify(over.buttons)}`);
		expect(over.buttons['Replay from Start'] === false,
			`Replay from Start should work: ${JSON.stringify(over.buttons)}`);
		step('the end of the game is a node with the turn controls and nothing to choose');

	} catch (error) {
		await dumpFailure(page, 'replay');
		throw error;
	} finally {
		await browser.close();
	}

	await vgcPreviewStep(errors);
	if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
	console.log('PASS');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
