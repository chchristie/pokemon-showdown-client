'use strict';
/**
 * Pokémon state edits (docs/analysis/plan.md, Phase 2b-1): the form that replaces the field form.
 * - opened from a team icon in the sidebar, or from the action menu's "Edit Pokémon" button
 * - HP (amount and percent), status with its counters, PP, boosts, Terastallization, Send out
 * - Save rebuilds the position; the battle window, the request and the Lines tooltip follow
 * - Cancel goes back to the field form
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	SMOKE_TEAM, step, checkServers, openAnalysisPage, clickButton, waitFor, waitForDecision, startAnalysisFromTeams,
	selectLeads, hoverTooltip, dumpFailure,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

function editorState(page) {
	return page.evaluate(() => {
		const editor = document.querySelector('.analysis-field-editor');
		if (!editor) return null;
		const values = {};
		for (const input of editor.querySelectorAll('[data-pokemon-field]')) values[input.dataset.pokemonField] = input.value;
		const boosts = {};
		for (const select of editor.querySelectorAll('[data-pokemon-boost]')) boosts[select.dataset.pokemonBoost] = select.value;
		const heading = [...editor.querySelectorAll('.analysis-field-actions button')];
		return {
			title: editor.querySelector('.analysis-field-heading strong').textContent,
			values,
			boosts,
			pressed: [...editor.querySelectorAll('.analysis-field-button.selected')].map(button => button.dataset.fieldEffect),
			save: !heading.find(button => button.textContent === 'Save')?.disabled,
		};
	});
}

function setField(page, label, value) {
	return page.evaluate((fieldLabel, text) => {
		const input = document.querySelector(`[data-pokemon-field="${fieldLabel}"]`);
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, label, value);
}

function setBoost(page, stat, value) {
	return page.evaluate((boostStat, boost) => {
		const select = document.querySelector(`[data-pokemon-boost="${boostStat}"]`);
		select.value = boost;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	}, stat, value);
}

function clickEffect(page, effect) {
	return page.evaluate(id => document.querySelector(`[data-field-effect="${id}"]`).click(), effect);
}

async function clickEditorButton(page, text) {
	// the form's buttons are disabled while a save is in flight
	await waitFor(page, label => {
		const button = [...document.querySelectorAll('.analysis-field-actions button')].find(entry => entry.textContent === label);
		return !!button && !button.disabled;
	}, `the ${text} button`, 30000, text);
	await page.evaluate(label => [...document.querySelectorAll('.analysis-field-actions button')]
		.find(button => button.textContent === label).click(), text);
}

/**
 * Clicks a team icon in the battle sidebar, which opens that Pokémon's edit form. The icons are rewritten to
 * `analysispokemon|side|index` by the page (upgradeBattleTooltips), where index is the team's current order.
 */
function clickTeamIcon(page, side, teamIndex) {
	return page.evaluate((sideNumber, index) => {
		const icon = document.querySelector(`.battle .picon[data-tooltip="analysispokemon|${sideNumber}|${index}"]`);
		if (!icon) throw new Error(`no sidebar icon for analysispokemon|${sideNumber}|${index}`);
		icon.click();
	}, side, teamIndex);
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

		// after team preview the team is in request order, with the active Pokémon first
		await clickTeamIcon(page, 0, 0); // p1's Rotom-Wash, the active one
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'Pokémon form');
		let form = await editorState(page);
		expect(form.title === 'Edit Rotom (Team 1)', `unexpected form title: ${form.title}`);
		expect(!form.save, 'Save should start disabled');
		expect(Object.keys(form.boosts).length === 7, 'an active Pokémon should have all 7 boost dropdowns');
		step('a sidebar team icon opens that Pokémon\'s form');

		await setField(page, 'HP percent', '50');
		form = await editorState(page);
		const halfHP = Math.round(Number(form.values.HP));
		expect(halfHP > 0 && form.save, `editing the percent should set HP: ${JSON.stringify(form.values)}`);
		await clickEffect(page, 'status:brn');
		await setBoost(page, 'spe', '2');
		await setField(page, 'Hydro Pump PP', '3');
		await clickEditorButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.battle-log')?.textContent || '').includes('Analysis edits:'), 'edit log line');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'form after saving');
		form = await editorState(page);
		expect(form.values.HP === `${halfHP}` && form.boosts.spe === '2' && !form.save,
			`the saved state should be shown and clean: ${JSON.stringify(form)}`);
		expect(form.pressed.includes('status:brn'), 'the burn should still be selected');
		step('HP, status, boosts and PP save and come back from the server');

		// the renderer only tracks PP for moves it saw used, so this comes from the snapshot
		const iconTooltip = await hoverTooltip(page, '.battle .picon[data-tooltip="analysispokemon|0|0"]', {
			until: text => text.includes('Hydro Pump'),
		});
		expect(iconTooltip?.text.includes('Hydro Pump (3/8)'),
			`the team icon tooltip should show the edited PP: ${iconTooltip?.text.slice(0, 160)}`);
		step('the Pokémon tooltip shows the edited PP');

		const health = await page.evaluate(() => document.querySelector('.battle .rstatbar .hptext')?.textContent || '');
		expect(health === '50%', `the battle window should show the edited HP, got "${health}"`);
		const statuses = await page.evaluate(() => [...document.querySelectorAll('.battle .rstatbar .status')]
			.map(element => element.textContent).join(' '));
		expect(/BRN/i.test(statuses), `the battle window should show the burn, got "${statuses}"`);
		step('the battle window shows the edited HP and status');

		// a second save must not undo the first one's boost
		await setBoost(page, 'atk', '1');
		await clickEditorButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.analysis-node-tree')?.textContent || '').includes('Atk (+1)'),
			'the second boost save');
		await waitForDecision(page);
		form = await editorState(page);
		expect(form.boosts.atk === '1' && form.boosts.spe === '2',
			`both boosts should survive separate saves: ${JSON.stringify(form.boosts)}`);
		step('a later save keeps the boosts an earlier one set');

		await page.evaluate(() => document.querySelector('.battle-controls .analysis-choice-selectable').click());
		await waitFor(page, () => !!document.querySelector('.movemenu button'), 'action menu');
		const pp = await page.evaluate(() => [...document.querySelectorAll('.movemenu button')]
			.find(button => button.textContent.includes('Hydro Pump'))?.textContent || '');
		expect(pp.includes('3/8'), `the move button should show the edited PP: ${pp}`);
		await clickButton(page, 'Edit Pokémon');
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'form from the action menu');
		form = await editorState(page);
		expect(form.title === 'Edit Rotom (Team 1)', `"Edit Pokémon" should open the acting Pokémon: ${form.title}`);
		step('the action menu\'s Edit Pokémon button opens the form for that Pokémon');

		// a benched Pokémon: no boosts, but it can be sent out
		await clickTeamIcon(page, 0, 1); // p1's Garchomp, on the bench
		await waitFor(page, () => document.querySelector('.analysis-field-heading strong').textContent.includes('Garchomp'), 'Garchomp form');
		form = await editorState(page);
		expect(!Object.keys(form.boosts).length, 'a benched Pokémon should have no boost dropdowns');
		await clickEffect(page, 'active:0');
		await clickEditorButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.battle-log')?.textContent || '').includes('Active (Slot 1)') ||
			(document.querySelector('.analysis-node-tree')?.textContent || '').includes('Active (Slot 1)'), 'the switch edit');
		await waitForDecision(page);
		const active = await page.evaluate(() => document.querySelector('.battle-controls .analysis-choice-summary')?.textContent || '');
		expect(/Garchomp/.test(await page.evaluate(() => document.querySelector('.battle .rstatbar strong')?.textContent || '')) ||
			active.includes('Garchomp'), 'Garchomp should now be active');
		step('Send out makes a benched Pokémon active');

		// the team icons follow the new order, and edits still find the Pokémon they were made for
		const icons = await page.evaluate(() => [...document.querySelectorAll('.battle .picon[data-tooltip^="analysispokemon|0|"]')]
			.map(icon => ({ tooltip: icon.dataset.tooltip, label: icon.getAttribute('aria-label') || '' })));
		const rotomIcon = icons.find(icon => icon.label.includes('Rotom'));
		expect(!!rotomIcon, `no Rotom icon after the swap: ${JSON.stringify(icons)}`);
		await page.evaluate(tooltip => document.querySelector(`.battle .picon[data-tooltip="${tooltip}"]`).click(),
			rotomIcon.tooltip);
		await waitFor(page, () => (document.querySelector('.analysis-field-heading strong')?.textContent || '').includes('Rotom'),
			'Rotom form from its icon after the swap');
		await setField(page, 'HP percent', '25');
		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		form = await editorState(page);
		expect(form.title.includes('Rotom') && Number(form.values['HP percent']) === 25,
			`the edit should have applied to Rotom: ${JSON.stringify(form)}`);
		step('after a swap, the icons and edits still point at the right Pokémon');

		await page.evaluate(() => document.querySelector('.battle-controls .analysis-choice-selectable').click());
		await waitFor(page, () => !!document.querySelector('.movemenu button'), 'action menu for the swapped-in Pokémon');
		await page.evaluate(() => document.querySelectorAll('.movemenu button')[0].click());
		await waitFor(page, () => !document.querySelector('.movemenu'), 'the chosen action');
		await clickTeamIcon(page, 0, 1); // the benched Kingambit... whichever is at index 1 now
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'form for the benched Pokémon');
		await clickEffect(page, 'active:0');
		await clickEditorButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.battle-controls')?.textContent || '')
			.includes('No action selected'), 'the slot\'s action to be cleared');
		step('replacing a slot\'s Pokémon clears the action chosen for it');

		const tooltip = await page.evaluate(() => {
			const edits = document.querySelectorAll('.analysis-node-entry')[1].querySelector('.analysis-node-edits');
			const teams = [...edits.querySelectorAll('.analysis-node-edits-teams > div')];
			return [...teams[0].querySelectorAll('span')].map(span => span.textContent);
		});
		expect(tooltip.some(line => line.includes('Rotom: HP')) && tooltip.some(line => line.includes('Status (Burn)')) &&
			tooltip.some(line => line.includes('Garchomp: Active (Slot 1)')),
		`the Lines tooltip should list the Pokémon edits: ${JSON.stringify(tooltip)}`);
		step('the Lines tooltip lists the Pokémon edits under its team');

		await clickEditorButton(page, 'Cancel');
		await waitFor(page, () => !!document.querySelector('[data-field-effect="weather:raindance"]'), 'back to the field form');
		step('Cancel returns to the field form');

		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log('PASS');
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
		await dumpFailure(page, 'pokemon-edits-failure');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main().catch(error => {
	console.log(`FAIL: ${error.message}`);
	process.exitCode = 1;
});
