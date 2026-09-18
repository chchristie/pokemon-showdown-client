'use strict';
/**
 * Team and set edits (docs/analysis/plan.md, Phase 3): the teambuilder that replaces the left column.
 * - opened by clicking a side's trainer sprite
 * - the embedded play-client TeamEditor loads without the PS app (see analysis-ps-shims.tsx)
 * - a set edit keeps the Pokémon's team slot, so its state edits still apply
 * - adding a Pokémon resyncs the rendered roster
 * - Cancel restores the battle
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	SMOKE_TEAM, step, checkServers, openAnalysisPage, waitFor, waitForDecision, startAnalysisFromTeams,
	selectLeads, chooseMove, dumpFailure,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

/** Clicks a side's trainer sprite in the battle window, which opens that team's builder. */
function clickTrainer(page, side) {
	return page.evaluate(sideClass => {
		const sprite = document.querySelector(`.battle .trainer-${sideClass} .trainersprite`);
		if (!sprite) throw new Error(`no ${sideClass} trainer sprite`);
		sprite.click();
	}, side === 'p1' ? 'near' : 'far');
}

async function clickTeambuilderButton(page, text) {
	await waitFor(page, label => {
		const button = [...document.querySelectorAll('.analysis-teambuilder-heading button')]
			.find(entry => entry.textContent === label);
		return !!button && !button.disabled;
	}, `the teambuilder's ${text} button`, 30000, text);
	await page.evaluate(label => [...document.querySelectorAll('.analysis-teambuilder-heading button')]
		.find(button => button.textContent === label).click(), text);
}

/** The species the embedded editor is showing, in its set list order. */
function editorSpecies(page) {
	return page.evaluate(() => (window.editor?.sets || []).map(set => set.species || set.name));
}

/** Edits the live TeamEditor state directly, then saves it the way the editor does. */
function editSet(page, index, changes) {
	return page.evaluate((setIndex, patch) => {
		const editor = window.editor;
		Object.assign(editor.sets[setIndex], patch);
		editor.save();
		editor.update();
	}, index, changes);
}

function addSet(page, set) {
	return page.evaluate(newSet => {
		const editor = window.editor;
		editor.sets.push(newSet);
		editor.save();
		editor.update();
	}, set);
}

async function main() {
	await checkServers();
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Builder A', packed: SMOKE_TEAM },
		{ format: 'gen9ou', name: 'Builder B', packed: SMOKE_TEAM },
	]);
	try {
		await startAnalysisFromTeams(page, 'gen9ou');

		/*
		 * Team Preview: the team here is the one the battle is built from, so it replaces the tab's
		 * starting team rather than being applied as an edit layer, and it IS validated.
		 */
		await waitFor(page, () => !!document.querySelector('.battle .trainer-near .trainersprite'), 'team preview');
		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder at preview');
		step('the trainer sprite opens the teambuilder at Team Preview');

		// an illegal team is refused, and the panel stays open with the validator's problems
		await editSet(page, 0, { species: 'Mewtwo', name: 'Mewtwo', ability: 'Pressure', moves: ['Psystrike'] });
		await clickTeambuilderButton(page, 'Save');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder-problems'), 'the validation problems');
		const refused = await page.evaluate(() => ({
			stillOpen: !!document.querySelector('.analysis-teambuilder .teameditor'),
			problems: [...document.querySelectorAll('.analysis-teambuilder-problems li')].map(li => li.textContent),
			species: (window.editor?.sets || []).map(set => set.species),
		}));
		expect(refused.stillOpen, 'the teambuilder should stay open so the team can be fixed');
		expect(refused.problems.length > 0, 'the validator problems should be listed');
		expect(refused.problems.some(problem => /Mewtwo/.test(problem)),
			`the problems should name the illegal Pokémon: ${JSON.stringify(refused.problems)}`);
		expect(refused.species.includes('Mewtwo'), 'the rejected team should still be in the editor to fix');
		step(`an illegal team is refused and listed: ${refused.problems[0]}`);
		// that rejection is the point of the step, so don't let the harness report its 400 as a failure
		const expected = errors.findIndex(entry => entry.includes('http 400') && entry.includes('/analysis/start'));
		expect(expected >= 0, `the refused save should have produced a 400: ${errors.join('; ')}`);
		errors.splice(expected, 1);

		// fixing it and saving again works, and the new team is what the battle is built from
		await editSet(page, 0, { species: 'Dragapult', name: 'Dragapult', ability: 'Infiltrator', moves: ['Dragon Darts'] });
		await clickTeambuilderButton(page, 'Save');
		await waitFor(page, () => !document.querySelector('.analysis-teambuilder'), 'the teambuilder to close');
		const applied = await page.evaluate(() => ({
			problems: !!document.querySelector('.analysis-teambuilder-problems'),
			preview: (document.querySelector('.battle-controls')?.textContent || '').length > 0,
			log: (document.querySelector('.battle-log')?.textContent || ''),
		}));
		expect(!applied.problems, 'the problems should clear once the team is legal');
		expect(/Dragapult/.test(applied.log), `the battle should be built from the new team: ${applied.log.slice(0, 200)}`);
		step('a legal team saves at Team Preview and rebuilds the battle from it');

		await selectLeads(page, 1, 2); // p1 Rotom-Wash, p2 Kingambit
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form');

		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder');
		// the editor only renders at all if the shimmed globals and search tables loaded
		const loaded = await page.evaluate(() => ({
			psmodel: typeof PSModel === 'function',
			editor: typeof TeamEditor === 'function',
			search: typeof DexSearch === 'function',
			ps: typeof window.PS,
			sets: (window.editor?.sets || []).length,
		}));
		expect(loaded.psmodel && loaded.editor && loaded.search,
			`the teambuilder's globals should be shimmed in: ${JSON.stringify(loaded)}`);
		expect(loaded.ps === 'undefined', 'PS should stay undefined, so the client app never boots');
		expect(loaded.sets === 3, `the editor should show the side's 3 Pokémon, got ${loaded.sets}`);
		step('a trainer sprite opens that team in the embedded teambuilder');

		// the builder takes the battle window's place, but the log beside it stays
		const layout = await page.evaluate(() => {
			const frame = document.querySelector('.analysis-teambuilder-frame');
			const battle = document.querySelector('.battle');
			const log = document.querySelector('.battle-log');
			return {
				frameWidth: frame?.style.width,
				// the battle is hidden, so its box is 0x0; its declared width is what the builder matches
				battleWidth: battle?.style.width,
				battleShown: !!battle && !battle.hidden,
				controls: !!document.querySelector('.battle-controls'),
				logShown: !!log && log.getBoundingClientRect().width > 0,
				logText: (log?.textContent || '').includes('Battle started'),
			};
		});
		expect(!layout.battleShown && !layout.controls, 'the battle window and controls should be hidden');
		expect(layout.logShown && layout.logText, 'the battle log should stay visible, with its contents');
		expect(layout.frameWidth === layout.battleWidth,
			`the builder should be exactly the battle window's width: ${layout.frameWidth} vs ${layout.battleWidth}`);
		step('the teambuilder replaces the battle and controls, keeping the log');

		/*
		 * Every per-Pokémon control swaps the set list for the editor's focused view, which is
		 * `position: absolute` with `top`/`bottom: 0` and so fills the nearest positioned ancestor. If that
		 * ancestor has no height the panel goes blank with no error, so measure the boxes rather than just
		 * checking the markup exists.
		 */
		const unfocused = await page.evaluate(() => {
			const list = document.querySelector('.set-list')?.getBoundingClientRect();
			return { width: Math.round(list?.width || 0), height: Math.round(list?.height || 0) };
		});
		expect(unfocused.height > 100, `the set list should have a real height: ${JSON.stringify(unfocused)}`);

		/*
		 * The page also loads client.css, whose `.tabbar` is the old client's room tab bar, pinned to the
		 * bottom of the room. The new-client teambuilder expects its tab bar in flow at the top, so check
		 * it sits at the top of the editor rather than at the bottom of the page.
		 */
		const tabbar = await page.evaluate(() => {
			const bar = document.querySelector('.analysis-teambuilder .tabbar');
			const editor = document.querySelector('.analysis-teambuilder-editor');
			if (!bar || !editor) return null;
			return {
				position: getComputedStyle(bar).position,
				offset: Math.round(bar.getBoundingClientRect().top - editor.getBoundingClientRect().top),
			};
		});
		expect(tabbar && tabbar.position === 'static',
			`the tab bar should be in flow, not absolutely positioned: ${JSON.stringify(tabbar)}`);
		expect(tabbar.offset < 40, `the tab bar should sit at the top of the editor, got ${tabbar.offset}px down`);
		for (const [label, selector] of [
			['species', '[data-focus="set-0-pokemon"]'],
			['a move', '[data-focus="set-0-move-0"]'],
			['the item', '[data-focus="set-0-item"]'],
			['the ability', '[data-focus="set-0-ability"]'],
			['details', 'button[value="set-0-details"]'],
			['stats', 'button[name="stats"]'],
			['Add Pokémon', 'button[name="addpokemon"]'],
		]) {
			const present = await page.evaluate(sel => !!document.querySelector(sel), selector);
			expect(present, `the editor should have a ${label} control (${selector})`);
			await page.click(selector);
			await waitFor(page, () => !!document.querySelector('.team-focus-editor'), `the ${label} form`);
			const focused = await page.evaluate(() => {
				const box = document.querySelector('.team-focus-editor')?.getBoundingClientRect();
				return { height: Math.round(box?.height || 0) };
			});
			expect(focused.height > 100, `clicking ${label} should open a form with a real height, got ${focused.height}`);
			await page.keyboard.press('Escape');
		}
		step('every per-Pokémon control opens a form that actually has a box');

		await clickTeambuilderButton(page, 'Cancel');
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form after Cancel');
		const battleBack = await page.evaluate(() => !!document.querySelector('.battle .trainersprite'));
		expect(battleBack, 'Cancel should bring the battle back');
		step('Cancel restores the battle and its controls');

		// a set edit on the active Pokémon: it should keep its slot and show up in the request
		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder again');
		const species = await editorSpecies(page);
		const rotom = species.findIndex(name => name.startsWith('Rotom'));
		expect(rotom >= 0, `the editor should list Rotom-Wash: ${JSON.stringify(species)}`);
		await editSet(page, rotom, { item: 'Choice Specs' });
		await clickTeambuilderButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.battle-log')?.textContent || '').includes('Analysis edits:'),
			'the edit log line');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form after Save');
		step('a set edit saves and closes the teambuilder');

		const itemApplied = await page.evaluate(() => {
			const node = [...document.querySelectorAll('.analysis-node-entry')]
				.map(entry => entry.querySelector('.analysis-node-edits'))
				.filter(Boolean).pop();
			return node ? [...node.querySelectorAll('span')].map(span => span.textContent) : [];
		});
		expect(itemApplied.some(line => line.includes('Choice Specs')),
			`the Lines tooltip should list the set change: ${JSON.stringify(itemApplied)}`);
		step('the Lines tooltip lists the set change');

		// a side always needs a Pokémon, so an empty team is refused the same way an illegal one is
		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder for the empty save');
		const iconsBefore = await page.evaluate(() => document.querySelectorAll(
			'.battle .trainer-near .picon[data-tooltip^="analysispokemon|0|"]'
		).length);
		await page.evaluate(() => {
			window.editor.sets.length = 0;
			window.editor.save();
			window.editor.update();
		});
		await clickTeambuilderButton(page, 'Save');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder-problems'), 'the empty-team problem');
		const emptied = await page.evaluate(() => ({
			stillOpen: !!document.querySelector('.analysis-teambuilder .teameditor'),
			problems: [...document.querySelectorAll('.analysis-teambuilder-problems li')].map(li => li.textContent),
		}));
		expect(emptied.stillOpen, 'the teambuilder should stay open after refusing an empty team');
		expect(emptied.problems.some(problem => /at least one Pok/.test(problem)),
			`the problem should say the team needs a Pokémon: ${JSON.stringify(emptied.problems)}`);
		step(`an empty team is refused: ${emptied.problems.find(problem => /at least one Pok/.test(problem))}`);

		// Cancel discards it, and the roster is untouched
		await clickTeambuilderButton(page, 'Cancel');
		await waitFor(page, () => !document.querySelector('.analysis-teambuilder'), 'the teambuilder to close');
		const iconsAfter = await page.evaluate(() => document.querySelectorAll(
			'.battle .trainer-near .picon[data-tooltip^="analysispokemon|0|"]'
		).length);
		expect(iconsAfter === iconsBefore,
			`the roster should be untouched: ${iconsBefore} before, ${iconsAfter} after`);
		step('the refused empty team leaves the roster alone');

		// adding a Pokémon changes the roster, which needs the rendered team rebuilt
		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder for the add');
		await addSet(page, {
			name: 'Dragonite', species: 'Dragonite', item: 'Heavy-Duty Boots', ability: 'Multiscale',
			moves: ['Extreme Speed'], nature: 'Adamant', gender: 'M',
			evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: {}, level: 100,
		});
		await clickTeambuilderButton(page, 'Save');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form after the add');
		const icons = await page.evaluate(() => document.querySelectorAll(
			'.battle .trainer-near .picon[data-tooltip^="analysispokemon|0|"]'
		).length);
		expect(icons === 4, `the rendered sidebar should show 4 Pokémon after the add, got ${icons}`);
		step('adding a Pokémon resyncs the rendered roster');

		/*
		 * A chosen action can name something the team edit moved: `move N` names a move by slot and
		 * `switch N` a position in the roster. Both should be dropped, and other slots left alone.
		 */
		await chooseMove(page, 0, 0); // p1 Rotom-Wash's first move, Hydro Pump
		await waitForDecision(page);
		const chosenBefore = await page.evaluate(() =>
			document.querySelector('.analysis-choice-summary-wrap')?.textContent || '');
		expect(/Hydro Pump/.test(chosenBefore), `the move should be chosen first: ${chosenBefore}`);

		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder for moves');
		const rosterNow = await editorSpecies(page);
		const active = rosterNow.findIndex(name => name.startsWith('Rotom'));
		await editSet(page, active, { moves: ['Thunderbolt', 'Volt Switch', 'Will-O-Wisp', 'Protect'] });
		await clickTeambuilderButton(page, 'Save');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form after the move change');
		const chosenAfter = await page.evaluate(() =>
			document.querySelector('.analysis-choice-summary-wrap')?.textContent || '');
		expect(!/Hydro Pump/.test(chosenAfter),
			`the action naming the replaced move should be dropped: ${chosenAfter}`);
		step('changing a move drops the action that had chosen it');

		// removing the Pokémon that is on the field sends out the next one in its place
		const activeBefore = await page.evaluate(() =>
			document.querySelector('.battle .trainer-near .picon')?.getAttribute('aria-label') ||
			document.querySelector('.battle .statbar strong')?.textContent || '');
		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder for the delete');
		await page.evaluate(() => {
			const editor = window.editor;
			// after team preview the active Pokémon is first in the roster
			editor.sets.splice(0, 1);
			editor.save();
			editor.update();
		});
		await clickTeambuilderButton(page, 'Save');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form after the delete');
		const afterDelete = await page.evaluate(() => ({
			icons: document.querySelectorAll('.battle .trainer-near .picon[data-tooltip^="analysispokemon|0|"]').length,
			active: document.querySelector('.battle .statbar strong')?.textContent || '',
		}));
		expect(afterDelete.icons === 3, `the sidebar should be back to 3 Pokémon, got ${afterDelete.icons}`);
		expect(afterDelete.active && afterDelete.active !== activeBefore,
			`a replacement should be on the field, got "${afterDelete.active}"`);
		step('removing the Pokémon on the field sends out a replacement');

		// the builder shows one node's roster, so moving to another node closes it
		await clickTrainer(page, 'p1');
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'teambuilder before navigating');
		await page.evaluate(() => {
			const buttons = [...document.querySelectorAll('.analysis-node-button')];
			(buttons[buttons.length - 2] || buttons[0]).click();
		});
		await waitFor(page, () => !document.querySelector('.analysis-teambuilder'), 'the teambuilder to close');
		const restored = await page.evaluate(() => ({
			battle: !!document.querySelector('.battle:not([hidden])'),
			controls: !!document.querySelector('.battle-controls'),
		}));
		expect(restored.battle && restored.controls, 'navigating should restore the battle and its controls');
		step('selecting another node closes the teambuilder');

		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log('PASS');
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
		await dumpFailure(page, 'teambuilder-failure');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main().catch(error => {
	console.log(`FAIL: ${error.message}`);
	process.exitCode = 1;
});
