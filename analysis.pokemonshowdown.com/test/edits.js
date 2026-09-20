'use strict';
/**
 * Field state edits (docs/analysis/plan.md, Phase 2a): the field form below the decision controls.
 * - Save/Cancel stay disabled until something changes; Cancel restores the form
 * - unsaved changes survive opening an action menu, and are discarded when navigating to another node
 * - Save rebuilds the position: the log, the form, damage calcs, and the Lines tooltip reflect the edits
 * - turns remaining count down on the next turn, and the battle window shows the exact turns (not estimates),
 *   including during turn playback
 * - saving on a node that already has a continuation creates a sibling copy (copy-on-edit)
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	SMOKE_TEAM, step, checkServers, openAnalysisPage, clickButton, waitFor, waitForDecision, startAnalysisFromTeams,
	selectLeads, openActionMenu, chooseMove, hoverTooltip, dumpFailure, sleep,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

/** Form state: which effect buttons are pressed, the turns inputs' values, and whether Save/Cancel are enabled. */
function formState(page) {
	return page.evaluate(() => {
		const editor = document.querySelector('.analysis-field-editor');
		if (!editor) return null;
		const heading = [...editor.querySelectorAll('.analysis-field-actions button')];
		const turns = {};
		for (const input of editor.querySelectorAll('[data-field-turns]')) {
			if (!input.disabled) turns[input.dataset.fieldTurns] = input.value;
		}
		return {
			// "0" layer buttons are pressed whenever that hazard is off
			pressed: [...editor.querySelectorAll('.analysis-field-button.selected')].map(button => button.dataset.fieldEffect)
				.filter(effect => !effect.endsWith(':0')),
			turns,
			save: !heading.find(button => button.textContent === 'Save').disabled,
			cancel: !heading.find(button => button.textContent === 'Cancel').disabled,
			effects: [...editor.querySelectorAll('.analysis-field-button')].map(button => button.dataset.fieldEffect),
		};
	});
}

/** The battle window's field effect text, e.g. "Rain (3 turns) Foe's Tailwind (2 turns)". */
async function battleFieldText(page) {
	await sleep(300);
	return page.evaluate(() => [...document.querySelectorAll('.battle .weather')].map(element => element.textContent).join(' '));
}

function clickEffect(page, effect) {
	return page.evaluate(id => document.querySelector(`[data-field-effect="${id}"]`).click(), effect);
}

function setTurns(page, key, value) {
	return page.evaluate((fieldKey, turns) => {
		const input = document.querySelector(`[data-field-turns="${fieldKey}"]`);
		input.value = turns;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, key, value);
}

function clickEditorButton(page, text) {
	return page.evaluate(label => [...document.querySelectorAll('.analysis-field-actions button')]
		.find(button => button.textContent === label).click(), text);
}

function selectNode(page, index) {
	return page.evaluate(n => document.querySelectorAll('.analysis-node-button')[n].click(), index);
}

function nodeTooltips(page) {
	return page.evaluate(() => [...document.querySelectorAll('.analysis-node-entry')].map(entry => ({
		label: entry.querySelector('.analysis-node-button strong').textContent,
		current: entry.classList.contains('analysis-node-current'),
		branch: !!entry.closest('.analysis-node-branch'),
		tooltip: entry.querySelector('.analysis-node-tooltip')?.textContent || '',
	})));
}

async function main() {
	await checkServers();
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Edits A', packed: SMOKE_TEAM },
		{ format: 'gen9ou', name: 'Edits B', packed: SMOKE_TEAM },
	]);
	try {
		await startAnalysisFromTeams(page, 'gen9ou');
		await selectLeads(page, 1, 2); // p1 Rotom-Wash, p2 Kingambit
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form');

		let form = await formState(page);
		expect(!form.save && !form.cancel, 'Save/Cancel should start disabled');
		expect(form.effects.includes('weather:snowscape') && !form.effects.includes('weather:hail'),
			'gen 9 should offer Snow, not Hail');
		expect(!form.effects.includes('magicroom'), 'uncommon effects should be hidden until Show more');
		await clickEditorButton(page, 'Show more');
		form = await formState(page);
		expect(form.effects.includes('magicroom') && form.effects.includes('p1:firepledge'), 'Show more should reveal uncommon effects');
		expect(!form.effects.some(effect => /gmax|mudsport|desolateland/.test(effect)), 'gen 9 should not offer G-Max/Mud Sport/primal');
		await clickEditorButton(page, 'Show less');
		step('form starts clean; Show more reveals uncommon effects for the format');

		await clickEffect(page, 'weather:raindance');
		form = await formState(page);
		expect(form.pressed.includes('weather:raindance') && form.turns.weather === '5', `Rain should default to 5 turns: ${JSON.stringify(form)}`);
		expect(form.save && form.cancel, 'Save/Cancel should enable after a change');
		await clickEffect(page, 'weather:raindance');
		form = await formState(page);
		expect(!form.pressed.includes('weather:raindance') && !form.save, 'reselecting Rain should clear it and leave nothing changed');
		await clickEffect(page, 'p2:stealthrock');
		await clickEditorButton(page, 'Cancel');
		form = await formState(page);
		expect(!form.pressed.length && !form.save && !form.cancel, 'Cancel should restore the form');
		step('reselecting clears an effect; Cancel restores the form');

		await clickEffect(page, 'weather:raindance');
		await setTurns(page, 'weather', '3');
		await clickEffect(page, 'p2:stealthrock');
		await clickEffect(page, 'p1:spikes:2');
		await clickEffect(page, 'p2:tailwind');
		await setTurns(page, 'p2:tailwind', '2');
		await page.evaluate(() => document.querySelector('.battle-controls .analysis-choice-selectable').click());
		await waitFor(page, () => !!document.querySelector('.movemenu button'), 'move menu');
		await clickButton(page, 'Cancel');
		await waitFor(page, () => !!document.querySelector('.analysis-field-editor'), 'field form after cancelling selection');
		form = await formState(page);
		expect(form.pressed.includes('p2:stealthrock') && form.turns.weather === '3', 'unsaved changes should survive the action menu');
		step('unsaved changes survive opening an action menu');

		await clickEditorButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.battle-log')?.textContent || '').includes('Analysis edits:'), 'edit log line');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('.analysis-field-button.selected'), 'form rebuilt from the edited snapshot');
		form = await formState(page);
		expect(['weather:raindance', 'p2:stealthrock', 'p1:spikes:2'].every(effect => form.pressed.includes(effect)),
			`form should show the saved state: ${JSON.stringify(form.pressed)}`);
		expect(form.turns.weather === '3' && !form.save && !form.cancel, `saved form should be clean: ${JSON.stringify(form)}`);
		let nodes = await nodeTooltips(page);
		const editsTooltip = await page.evaluate(() => {
			const edits = document.querySelectorAll('.analysis-node-entry')[1].querySelector('.analysis-node-edits');
			const lines = element => [...element.querySelectorAll(':scope > span')].map(span => span.textContent);
			const teams = [...edits.querySelectorAll('.analysis-node-edits-teams > div')];
			return { field: lines(edits), p1: lines(teams[0]), p2: lines(teams[1]) };
		});
		expect(JSON.stringify(editsTooltip) === JSON.stringify({
			field: ['Rain (3 Turns)'], p1: ['Spikes (2 Layers)'], p2: ['Tailwind (2 Turns)', 'Stealth Rock (On)'],
		}), `Lines tooltip should list field edits, then each team's: ${JSON.stringify(editsTooltip)}`);
		const fieldText = await battleFieldText(page);
		expect(fieldText.includes('Rain (3 turns)') && fieldText.includes('Tailwind (2 turns)'),
			`the battle window should show the edited turns, not estimates: ${fieldText}`);
		step('Save rebuilds the position; form, log, Lines tooltip, and battle window show the edits');

		await openActionMenu(page, 0);
		const hydroPump = await hoverTooltip(page, '.movemenu button', {
			text: 'Hydro Pump', until: text => text.includes(' vs. ') && text.includes('%'),
		});
		expect(hydroPump?.text.includes('in Rain'), `Hydro Pump calc should be boosted by the edited Rain: ${hydroPump?.text}`);
		await clickButton(page, 'Cancel');
		await waitFor(page, () => !document.querySelector('.movemenu'), 'selection to cancel');
		step('damage calcs use the edited field');

		await chooseMove(page, 0, 3); // Protect
		await chooseMove(page, 1, 3); // Swords Dance
		await clickButton(page, 'Submit Choices');
		await waitFor(page, () => /Turn 2/.test(document.querySelector('.analysis-node-tree')?.textContent || ''), 'Turn 2 node');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('[data-field-turns="weather"]:not(:disabled)'), 'turn 2 form');
		form = await formState(page);
		expect(form.turns.weather === '2' && form.pressed.includes('p2:stealthrock'), `turn 2 should show Rain with 2 turns: ${JSON.stringify(form)}`);
		const turn2FieldText = await battleFieldText(page);
		expect(turn2FieldText.includes('Rain (2 turns)') && turn2FieldText.includes('Tailwind (1 turn)'),
			`the battle window should count the edited turns down: ${turn2FieldText}`);
		step('turns remaining count down on the next turn, in the form and the battle window');

		// playback animates weather changes; the exact turns must survive the fade (analysis-battle.ts)
		await clickButton(page, 'Replay Prev Turn');
		await waitFor(page, () => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Skip Turn') &&
			(document.querySelector('.battle-log')?.textContent || '').includes('Analysis edits:'), 'replayed edits during playback');
		await sleep(1000);
		const playbackText = await battleFieldText(page);
		const stillPlaying = await page.evaluate(() => [...document.querySelectorAll('button')]
			.some(button => button.textContent.trim() === 'Skip Turn'));
		expect(stillPlaying, 'turn playback ended before the field text could be checked');
		expect(playbackText.includes('Rain (3 turns)') && playbackText.includes('Tailwind (2 turns)'),
			`the battle window should keep the edited turns during playback: ${playbackText}`);
		await clickButton(page, 'Skip Turn');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('[data-field-turns="weather"]:not(:disabled)'), 'turn 2 form after replay');
		step('the battle window keeps the edited turns while replaying the turn');

		await clickEffect(page, 'trickroom');
		await selectNode(page, 1); // Turn 1
		await waitFor(page, () => document.querySelector('.analysis-node-current strong')?.textContent === 'Turn 1', 'Turn 1 selected');
		await waitForDecision(page);
		await sleep(300);
		form = await formState(page);
		expect(!form.pressed.includes('trickroom') && !form.save, 'unsaved changes should be discarded when navigating');
		step('unsaved changes are discarded on navigation');

		await clickEffect(page, 'trickroom');
		await clickEditorButton(page, 'Save');
		// the branch appears as soon as Save is clicked; the summary once the server applied the edits
		await waitFor(page, () => document.querySelectorAll('.analysis-node-branch').length === 1, 'sibling branch for the copy');
		await waitFor(page, () => (document.querySelector('.analysis-node-current .analysis-node-tooltip')?.textContent || '')
			.includes('Trick Room'), 'edit summary on the copy');
		await waitForDecision(page);
		nodes = await nodeTooltips(page);
		const current = nodes.find(node => node.current);
		expect(current?.label === 'Turn 1' && current.branch, `the edited copy should be the current branch node: ${JSON.stringify(nodes)}`);
		expect(current.tooltip.includes('Trick Room (5 Turns)') && current.tooltip.includes('Rain (3 Turns)'),
			`the copy should keep the earlier edits and add Trick Room: ${current.tooltip}`);
		expect(!nodes.find(node => node.label === 'Turn 1' && !node.branch).tooltip.includes('Trick Room'),
			'the original Turn 1 should be unchanged');
		expect(nodes.some(node => node.label === 'Turn 2' && !node.branch), 'the original line should keep Turn 2');
		step('saving on a node with a continuation edits a sibling copy');

		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log('PASS');
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
		await dumpFailure(page, 'edits-failure');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main().catch(error => {
	console.log(`FAIL: ${error.message}`);
	process.exitCode = 1;
});
