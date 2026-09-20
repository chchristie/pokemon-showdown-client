'use strict';
/**
 * Set Up Position (docs/analysis/plan.md, Phase 4): a tab that opens at Turn 1 on placeholder Pokémon
 * instead of at Team Preview on two real teams.
 * - no teams are chosen, and the server's placeholder team is never validated
 * - Lines starts at Turn 1; the Team Preview node that answered it is hidden
 * - the placeholders are active, have no moves, and can only Struggle
 * - clicking a placeholder's sprite opens the teambuilder focused on that Pokémon's species, rather than
 *   its action menu, and stops doing so once it has been built into a real Pokémon
 * - the placeholders are nicknamed "Placeholder", and replacing one's species drops that nickname
 * - the Pokémon panel offers four move rows, so a Pokémon that starts with none can be given a full set
 * - doubles puts two placeholders on each side, both out
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	step, checkServers, openAnalysisPage, waitFor, waitForDecision, startSetUpPosition,
	linesText, battleControlsText, sleep, dumpFailure,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

/** The battle sprite (not the sidebar icon) for side `side`'s Pokémon at team order `index`. */
function clickActiveSprite(page, side, index) {
	return page.evaluate((sideNumber, teamIndex) => {
		const sprite = [...document.querySelectorAll(
			`.battle [data-tooltip="analysispokemon|${sideNumber}|${teamIndex}"]`
		)].find(element => !element.classList.contains('picon'));
		if (!sprite) throw new Error(`no battle sprite for analysispokemon|${sideNumber}|${teamIndex}`);
		sprite.click();
	}, side, index);
}

function panelOpen(page) {
	return page.evaluate(() => !!document.querySelector('[data-pokemon-field="HP"]'));
}

function moveMenuOpen(page) {
	return page.evaluate(() => !!document.querySelector('.movemenu button'));
}

function moveRowCount(page) {
	return page.evaluate(() => document.querySelectorAll('.analysis-move-row').length);
}

function setSelect(page, label, value) {
	return page.evaluate((selectLabel, text) => {
		const select = document.querySelector(`[data-pokemon-select="${selectLabel}"]`);
		if (!select) throw new Error(`no ${selectLabel} dropdown`);
		select.value = text;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	}, label, value);
}

/** Clicks a team icon in the battle sidebar, which opens that Pokémon's state panel. */
function clickTeamIcon(page, side, teamIndex) {
	return page.evaluate((sideNumber, index) => {
		const icon = document.querySelector(`.battle .picon[data-tooltip="analysispokemon|${sideNumber}|${index}"]`);
		if (!icon) throw new Error(`no sidebar icon for analysispokemon|${sideNumber}|${index}`);
		icon.click();
	}, side, teamIndex);
}

async function clickTeambuilderButton(page, text) {
	await waitFor(page, label => {
		const button = [...document.querySelectorAll('.analysis-teambuilder-heading button')]
			.find(entry => entry.textContent === label);
		return !!button && !button.disabled;
	}, `the teambuilder's ${text} button`, 30000, text);
	await page.evaluate(label => [...document.querySelectorAll('.analysis-teambuilder-heading button')]
		.find(button => button.textContent === label).click(), text);
	await sleep(400);
}

async function clickEditorButton(page, text) {
	await waitFor(page, label => {
		const button = [...document.querySelectorAll('.analysis-field-actions button')]
			.find(entry => entry.textContent === label);
		return !!button && !button.disabled;
	}, `the ${text} button`, 30000, text);
	await page.evaluate(label => [...document.querySelectorAll('.analysis-field-actions button')]
		.find(button => button.textContent === label).click(), text);
	// a save tears the battle down and rebuilds it
	await sleep(400);
}

async function main() {
	await checkServers();
	// deliberately no teams in localStorage: Set Up Position must not need any
	const { browser, page, errors } = await openAnalysisPage([]);
	try {
		await startSetUpPosition(page, 'gen9ou');
		await waitFor(page, () => (document.querySelector('.battle-controls')?.textContent || '')
			.includes('Click on a placeholder'), 'the opening instruction');
		const intro = await battleControlsText(page);
		expect(intro.includes('Click on a placeholder Pokémon to replace it'), `unexpected intro: ${intro}`);
		// nothing else: a field of placeholders has no turn worth playing yet
		expect(!intro.includes('Submit Choices') && !intro.includes('Replay from Start'),
			`the turn controls should be hidden until the teambuilder has been opened: ${intro}`);
		expect(!(await page.evaluate(() => !!document.querySelector('.analysis-field-editor'))),
			'the field editor should be hidden until the teambuilder has been opened');
		step('Set Up Position starts with no teams chosen, showing only the opening instruction');

		const lines = await linesText(page);
		expect(lines.includes('Turn 1'), `Lines should start at Turn 1, got: ${lines}`);
		expect(!lines.includes('Team Preview'), `the Team Preview node should be hidden, got: ${lines}`);
		step('Lines starts at Turn 1, with the Team Preview node hidden');

		const placeholders = await page.evaluate(() => {
			const sprites = [...document.querySelectorAll('.battle [data-tooltip^="analysispokemon|"]')]
				.filter(element => !element.classList.contains('picon'));
			return sprites.map(element => element.dataset.tooltip);
		});
		expect(placeholders.length === 2,
			`singles should put one placeholder on each side, got ${JSON.stringify(placeholders)}`);
		step('both sides lead with a placeholder');

		await clickActiveSprite(page, 0, 0);
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'), 'the teambuilder');
		expect(!(await moveMenuOpen(page)), 'a placeholder sprite should not open the action menu');
		// the same view as clicking the trainer sprite and then that Pokémon's species
		await waitFor(page, () => !!document.querySelector('.team-focus-editor'), 'the focused species form');
		const focused = await page.evaluate(() => ({
			active: document.activeElement?.getAttribute('data-focus') || '',
			box: document.querySelector('.team-focus-editor')?.getBoundingClientRect().height || 0,
		}));
		expect(focused.active === 'set-0-pokemon',
			`the placeholder's species field should be focused, got "${focused.active}"`);
		expect(focused.box > 0, 'the focused species form should have a real height');
		step('clicking a placeholder opens the teambuilder focused on its species');

		await clickTeambuilderButton(page, 'Cancel');
		await waitFor(page, () => !document.querySelector('.analysis-teambuilder'), 'the teambuilder to close');
		await waitForDecision(page);
		const afterIntro = await battleControlsText(page);
		expect(!afterIntro.includes('Click on a placeholder'),
			`the opening instruction should be gone once the teambuilder has been opened: ${afterIntro}`);
		expect(afterIntro.includes('Submit Choices'), `the turn controls should be back: ${afterIntro}`);
		step('Cancel returns to the battle, and the instruction gives way to the normal controls');

		// on the first node there is no earlier turn to reach, and the Team Preview node is hidden
		const disabled = await page.evaluate(() => Object.fromEntries(
			[...document.querySelectorAll('.analysis-choice-controls button')]
				.filter(button => ['Replay from Start', 'Replay Prev Turn', 'Prev Turn']
					.includes(button.textContent.trim()))
				.map(button => [button.textContent.trim(), button.disabled])));
		expect(disabled['Replay from Start'] === true && disabled['Replay Prev Turn'] === true &&
			disabled['Prev Turn'] === true, `turn-1 replay controls should be disabled: ${JSON.stringify(disabled)}`);
		step('Replay from Start, Replay Prev Turn and Prev Turn are disabled on the turn-1 node');

		// the sidebar icon still opens the Pokémon panel, which is where its battle state is edited
		await clickTeamIcon(page, 0, 0);
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'the Pokémon panel');
		expect(await moveRowCount(page) === 4,
			`the panel should offer four move rows for a moveless Pokémon, got ${await moveRowCount(page)}`);
		step('the Pokémon panel offers four move rows, so a placeholder can be given a full set');

		// take whatever the dropdown offers: the legal moves depend on the placeholder species
		const chosen = await page.evaluate(() => {
			const options = [...document.querySelector('[data-pokemon-select="Move 1"]').options]
				.map(option => option.value).filter(Boolean);
			return options.slice(0, 2);
		});
		expect(chosen.length === 2, `the move dropdown should offer the species' moves, got ${JSON.stringify(chosen)}`);
		await setSelect(page, 'Move 1', chosen[0]);
		await setSelect(page, 'Move 2', chosen[1]);
		await clickEditorButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.battle-log')?.textContent || '')
			.includes('Analysis edits:'), 'the edit log line');
		const summary = await linesText(page);
		for (const move of chosen) {
			expect(summary.includes(move), `the Lines summary should list ${move}, got: ${summary}`);
		}
		step('a placeholder can be built through the panel');

		// it is a real Pokémon now, so its sprite goes back to choosing an action
		await clickEditorButton(page, 'Cancel');
		await waitFor(page, () => !document.querySelector('[data-pokemon-field="HP"]'), 'the panel to close');
		await clickActiveSprite(page, 0, 0);
		await waitFor(page, () => !!document.querySelector('.movemenu button'), 'the action menu');
		expect(!(await panelOpen(page)), 'an edited Pokémon should open the action menu, not the panel');
		const moves = await page.evaluate(() => [...document.querySelectorAll('.movemenu button')]
			.map(button => button.textContent.trim()).join(','));
		for (const move of chosen) {
			expect(moves.includes(move), `the saved move ${move} should be choosable, got: ${moves}`);
		}
		step('an edited placeholder behaves like any other Pokémon again');

		// the action menu is still open for p1, and clicking the opponent's placeholder should take the
		// teambuilder rather than switching to that placeholder's own action selection
		expect(await moveMenuOpen(page), 'the action menu should still be open for this step');
		await clickActiveSprite(page, 1, 0);
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder .teameditor'),
			'the opponent teambuilder');
		const opponentSide = await page.evaluate(() =>
			document.querySelector('.analysis-teambuilder-heading strong')?.textContent || '');
		expect(opponentSide === 'Edit Team 2', `it should open Team 2's teambuilder, got "${opponentSide}"`);
		step("a placeholder clicked from another Pokémon's action menu opens its teambuilder");

		/*
		 * Replacing a placeholder renames it. "Placeholder" is a real nickname, and upstream's editor keeps
		 * real nicknames across a species change (it only drops one equal to the old species), so without
		 * the fork's own rule this leaves a Garchomp still called Placeholder.
		 * `lstatbar` is the far side's active Pokémon, i.e. Team 2's.
		 */
		const farName = () => page.evaluate(() =>
			document.querySelector('.battle .lstatbar strong')?.textContent?.trim() || '');
		const placeholderSet = await page.evaluate(() => window.editor?.sets?.[0]?.name || '');
		expect(placeholderSet === 'Placeholder',
			`a singles placeholder should be nicknamed Placeholder, got "${placeholderSet}"`);
		expect(await farName() === 'Placeholder',
			`the field should show the nickname, got "${await farName()}"`);
		// drive the editor's own changeSpecies, which is the upstream path that decides about the nickname
		await page.evaluate(() => {
			const editor = window.editor;
			editor.changeSpecies(editor.sets[0], 'Garchomp');
			editor.save();
			editor.update();
		});
		await clickTeambuilderButton(page, 'Save');
		await waitFor(page, () => !document.querySelector('.analysis-teambuilder'), 'the teambuilder to close');
		await waitForDecision(page);
		const replaced = await farName();
		expect(replaced === 'Garchomp',
			`replacing a placeholder should leave a Garchomp called Garchomp, got "${replaced}"`);
		step('replacing a placeholder drops the Placeholder nickname');

		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);

		// doubles: two placeholders a side, both out
		await page.evaluate(() => window.location.reload());
		await page.waitForNavigation({ waitUntil: 'networkidle2' });
		await startSetUpPosition(page, 'gen9doublesou');
		await waitFor(page, () => (document.querySelector('.battle-controls')?.textContent || '')
			.includes('Click on a placeholder'), 'the opening instruction in doubles');
		// four distinct sprites: identical species on a side used to collapse into one in the renderer
		const doubles = await page.evaluate(() =>
			[...document.querySelectorAll('.battle [data-tooltip^="analysispokemon|"]')]
				.filter(element => !element.classList.contains('picon'))
				.map(element => element.dataset.tooltip));
		expect(doubles.length === 4,
			`doubles should put two placeholders on each side of the field, got ${JSON.stringify(doubles)}`);
		expect(new Set(doubles).size === 4, `each placeholder should be its own sprite, got ${JSON.stringify(doubles)}`);
		step('doubles starts with two placeholders active on each side');

		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log('PASS');
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
		await dumpFailure(page, 'setup-failure');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main().catch(error => {
	console.log(`FAIL: ${error.message}`);
	process.exitCode = 1;
});
