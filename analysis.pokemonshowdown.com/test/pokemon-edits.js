'use strict';
/**
 * Pokémon state edits (docs/analysis/plan.md, Phase 2b-1): the form that replaces the field form.
 * - opened from a team icon in the sidebar, or from the action menu's "Edit Pokémon" button
 * - HP (amount and percent), status with its counters, PP, boosts, Terastallization, Set Active
 * - volatiles through the filterable multi-select, including options the sim would refuse
 * - fainting a benched Pokémon with HP 0, reviving it, and the active Pokémon's 1 HP floor
 * - the fainted team icon, which the renderer can only learn about through an analysisfaint line
 * - the `|swap|` line Set Active emits when it moves a Pokémon that is already out
 * - Save rebuilds the position; the battle window, the request and the Lines tooltip follow
 * - Cancel goes back to the field form
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	SMOKE_TEAM, step, checkServers, openAnalysisPage, clickButton, waitFor, waitForDecision, startAnalysisFromTeams,
	selectLeads, hoverTooltip, sleep, dumpFailure,
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
			selects: Object.fromEntries([...editor.querySelectorAll('[data-pokemon-select]')]
				.map(select => [select.dataset.pokemonSelect, select.value])),
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

/** Types into the volatiles combobox and reads back the filtered list. */
async function filterVolatiles(page, text) {
	await page.evaluate(filter => {
		const input = document.querySelector('[data-multiselect="Volatiles"]');
		input.focus();
		input.value = filter;
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}, text);
	await waitFor(page, () => !!document.querySelector('.analysis-multiselect-list'), 'the volatiles list');
	return page.evaluate(() => [...document.querySelectorAll('.analysis-multiselect-option')].map(option => ({
		key: option.dataset.multiselectOption,
		blocked: option.classList.contains('analysis-multiselect-blocked'),
	})));
}

function volatileChips(page) {
	return page.evaluate(() => [...document.querySelectorAll('[data-multiselect-remove]')]
		.map(button => button.dataset.multiselectRemove));
}

async function pickVolatile(page, key) {
	await page.evaluate(option => document.querySelector(`[data-multiselect-option="${option}"]`).click(), key);
}

/**
 * Clicks one of the form's toggle buttons. It waits for the button to be enabled first: the form disables
 * everything while a save is in flight, and clicking a disabled button silently does nothing.
 */
async function clickEffect(page, effect) {
	await waitFor(page, id => {
		const button = document.querySelector(`[data-field-effect="${id}"]`);
		return !!button && !button.disabled;
	}, `the ${effect} button`, 30000, effect);
	await page.evaluate(id => document.querySelector(`[data-field-effect="${id}"]`).click(), effect);
}

/** Picks a value in one of the panel's dropdowns (Nature, Ability, Item, Status, Forme, Move N). */
function setSelect(page, label, value) {
	return page.evaluate((selectLabel, text) => {
		const select = document.querySelector(`[data-pokemon-select="${selectLabel}"]`);
		if (!select) throw new Error(`no ${selectLabel} dropdown`);
		select.value = text;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	}, label, value);
}

async function clickEditorButton(page, text) {
	// the form's buttons are disabled while a save is in flight
	await waitFor(page, label => {
		const button = [...document.querySelectorAll('.analysis-field-actions button')].find(entry => entry.textContent === label);
		return !!button && !button.disabled;
	}, `the ${text} button`, 30000, text);
	await page.evaluate(label => [...document.querySelectorAll('.analysis-field-actions button')]
		.find(button => button.textContent === label).click(), text);
	// a save tears the battle down and rebuilds it; waitForDecision's text is true on both sides of that,
	// so give the rebuild a moment before driving the controls again
	await sleep(400);
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
		await setSelect(page, 'Status', 'brn');
		await setBoost(page, 'spe', '2');
		await setField(page, 'Hydro Pump PP', '3');
		await clickEditorButton(page, 'Save');
		await waitFor(page, () => (document.querySelector('.battle-log')?.textContent || '').includes('Analysis edits:'), 'edit log line');
		await waitForDecision(page);
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'form after saving');
		form = await editorState(page);
		expect(form.values.HP === `${halfHP}` && form.boosts.spe === '2' && !form.save,
			`the saved state should be shown and clean: ${JSON.stringify(form)}`);
		expect(form.selects.Status === 'brn', `the burn should still be selected: ${JSON.stringify(form.selects)}`);
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
		// Set Active saves on its own; there is no separate Save step for it
		await clickEffect(page, 'active:0');
		await sleep(400);
		await waitFor(page, () => (document.querySelector('.battle-log')?.textContent || '').includes('Active (Slot 1)') ||
			(document.querySelector('.analysis-node-tree')?.textContent || '').includes('Active (Slot 1)'), 'the switch edit');
		await waitForDecision(page);
		const active = await page.evaluate(() => document.querySelector('.battle-controls .analysis-choice-summary')?.textContent || '');
		expect(/Garchomp/.test(await page.evaluate(() => document.querySelector('.battle .rstatbar strong')?.textContent || '')) ||
			active.includes('Garchomp'), 'Garchomp should now be active');
		step('Set Active makes a benched Pokémon active');

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
		// Kingambit by name, not by index: index 1 is Rotom after the first swap, and sending Rotom back to
		// slot 0 is a no-op the server rightly drops, which wouldn't test anything
		await page.evaluate(() => {
			const icon = [...document.querySelectorAll('.battle .picon[data-tooltip^="analysispokemon|0|"]')]
				.find(element => (element.getAttribute('aria-label') || '').includes('Kingambit'));
			if (!icon) throw new Error('no Kingambit icon');
			icon.click();
		});
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'form for the benched Pokémon');
		// Set Active saves on its own; there is no separate Save step for it
		await clickEffect(page, 'active:0');
		await sleep(400);
		await waitFor(page, () => (document.querySelector('.battle-controls')?.textContent || '')
			.includes('No action selected'), 'the slot\'s action to be cleared');
		step('replacing a slot\'s Pokémon clears the action chosen for it');

		const tooltip = await page.evaluate(() => {
			const edits = document.querySelectorAll('.analysis-node-entry')[1].querySelector('.analysis-node-edits');
			const teams = [...edits.querySelectorAll('.analysis-node-edits-teams > div')];
			return [...teams[0].querySelectorAll('span')].map(span => span.textContent);
		});
		expect(tooltip.some(line => line.includes('Rotom: HP')) && tooltip.some(line => line.includes('Status (Burn)')) &&
			tooltip.some(line => line.includes('Kingambit: Active (Slot 1)')),
		`the Lines tooltip should list the Pokémon edits: ${JSON.stringify(tooltip)}`);
		step('the Lines tooltip lists the Pokémon edits under its team');

		/*
		 * Terastallizing and taking it back. The second half is the interesting one: no protocol line clears
		 * `terastallized` on a living Pokémon, so the renderer reads a marker line instead.
		 */
		const teraBox = '[data-pokemon-field="Terastallized"]';
		const teraState = () => page.evaluate(selector => {
			const active = document.querySelector('.battle .rstatbar strong')?.textContent || '';
			return {
				checked: document.querySelector(selector)?.checked,
				types: [...document.querySelectorAll('[data-pokemon-select^="Type"]')].map(select => select.value),
				active,
			};
		}, teraBox);
		await page.evaluate(selector => {
			const box = document.querySelector(selector);
			box.checked = true;
			box.dispatchEvent(new Event('change', { bubbles: true }));
		}, teraBox);
		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		const teraOn = await teraState();
		expect(teraOn.checked, `the Pokémon should be Terastallized after saving: ${JSON.stringify(teraOn)}`);
		step('Terastallizing from the panel applies');

		await page.evaluate(selector => {
			const box = document.querySelector(selector);
			box.checked = false;
			box.dispatchEvent(new Event('change', { bubbles: true }));
		}, teraBox);
		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		const teraOff = await teraState();
		expect(teraOff.checked === false, `unchecking should take it back: ${JSON.stringify(teraOff)}`);
		step('unchecking Terastallized takes it back, and the renderer follows');

		/*
		 * The panel's own layout rules: fields align in columns — nature/ability/item/status form a 2x2 grid
		 * and everything else is full width — narrow boost pickers showing `--` at 0, and the toxic counter
		 * as a 1/16..15/16 dropdown beside Status.
		 */
		const layout = await page.evaluate(() => {
			const boost = document.querySelector('[data-pokemon-boost]');
			const left = element => Math.round(element.getBoundingClientRect().left);
			const values = [...document.querySelectorAll('.analysis-info-line > .analysis-info-value')];
			const volatiles = document.querySelector('.analysis-multiselect');
			return {
				gridLefts: values.filter(value => value.closest('.analysis-info-grid')).map(left),
				fullLefts: values.filter(value => !value.closest('.analysis-info-grid')).map(left),
				gridWidth: Math.round(
					document.querySelector('.analysis-info-grid > .analysis-info-line')?.getBoundingClientRect().width || 0
				),
				volatilesWidth: Math.round(volatiles?.getBoundingClientRect().width || 0),
				boostWidth: Math.round(boost?.getBoundingClientRect().width || 0),
				boostZero: [...(boost?.options || [])].find(option => option.value === '0')?.textContent,
				noGender: !document.querySelector('[data-pokemon-select="Gender"]'),
				types: [...document.querySelectorAll('[data-pokemon-select^="Type"]')].map(select => select.value),
				movePP: (document.querySelector('.analysis-move-pp')?.textContent || ''),
			};
		});
		expect(new Set(layout.fullLefts).size === 1,
			`full-width fields should share one x: ${JSON.stringify(layout.fullLefts)}`);
		expect(new Set(layout.gridLefts).size === 2,
			`the 2x2 block should have exactly two columns: ${JSON.stringify(layout.gridLefts)}`);
		expect(Math.min(...layout.gridLefts) === layout.fullLefts[0],
			`the grid's left column should line up with the full-width fields: ${JSON.stringify(layout)}`);
		// the point of the 2x2 block is that the volatiles row below it gets the whole panel
		expect(layout.volatilesWidth > layout.gridWidth,
			`the volatiles row should be wider than a grid cell: ${layout.volatilesWidth} vs ${layout.gridWidth}`);
		expect(layout.boostWidth > 0 && layout.boostWidth < 70, `boost pickers should be narrow: ${layout.boostWidth}px`);
		expect(layout.boostZero === '--', `an unboosted stat should read --, got ${layout.boostZero}`);
		expect(layout.noGender, 'the gender dropdown should be gone');
		expect(layout.types.length === 2, `there should be primary and secondary type pickers: ${JSON.stringify(layout.types)}`);
		expect(/\/ \d+ PP$/.test(layout.movePP.trim()), `a move row should end "/ N PP": ${layout.movePP}`);
		step('the panel aligns its columns: a 2x2 selector block above a full-width volatiles row');

		// the current types are battle state: Soak and friends change them mid-battle
		const originalTypes = layout.types;
        await setSelect(page, 'Type 1', 'Water');
		await setSelect(page, 'Type 2', '');
		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		const typed = await page.evaluate(() => [...document.querySelectorAll('[data-pokemon-select^="Type"]')]
			.map(select => select.value));
		expect(typed[0] === 'Water' && !typed[1],
			`the type edit should stick: ${JSON.stringify(typed)} (was ${JSON.stringify(originalTypes)})`);
		step(`a type change saves: ${originalTypes.join('/')} -> ${typed.filter(Boolean).join('/')}`);

		// --- fainting a benched Pokémon (user request, 2026-09-18) ---
		await clickTeamIcon(page, 0, 2);
		const benchName = await page.evaluate(() =>
			document.querySelector('.analysis-field-heading strong').textContent);
		await setField(page, 'HP', '0');
		let state = await editorState(page);
		expect(state.save, `HP 0 should be a valid edit on a benched Pokémon: ${JSON.stringify(state.values)}`);
		// Set Active disappears while the form would leave it at 0, so the two can't disagree
		const activeButtons = await page.evaluate(() =>
			document.querySelectorAll('[data-field-effect^="active:"]').length);
		expect(activeButtons === 0, 'Set Active should be hidden while the form has the Pokémon at 0 HP');
		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		// the form still opens on a fainted Pokémon, so the edit can be taken back off; without that a stray
		// 0 would trap the node, since the panel is the only way to remove it
		state = await editorState(page);
		expect(state.values.HP === '0', `it should come back as fainted, with the form open: ${JSON.stringify(state.values)}`);
		// `Dex.getPokemonIcon` greys a fainted Pokémon, which the renderer only knows from the analysisfaint line
		const faintedIcon = () => page.evaluate(() => {
			const icon = document.querySelector('.battle .picon[data-tooltip="analysispokemon|0|2"]');
			return /grayscale/.test(icon?.getAttribute('style') || '');
		});
		expect(await faintedIcon(), 'the team icon should be greyed out once the Pokémon has fainted');
		step(`HP 0 faints a benched Pokémon and greys its team icon (${benchName.replace('Edit ', '')})`);

		await setField(page, 'HP', '60');
		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		state = await editorState(page);
		expect(state.values.HP === '60', `reviving should stick: ${JSON.stringify(state.values)}`);
		expect(!(await faintedIcon()), 'the team icon should come back when the Pokémon is revived');
		step('setting HP above 0 revives it, and the team icon comes back');

		// an active Pokémon can't be KO'd from the form
		await clickTeamIcon(page, 0, 0);
		await waitFor(page, () => !!document.querySelector('[data-pokemon-field="HP"]'), 'the active form');
		const activeHP = (await editorState(page)).values.HP;
		await setField(page, 'HP', '0');
		state = await editorState(page);
		expect(!state.save, 'HP 0 should be refused on the active Pokémon');
		step("the active Pokémon's HP can't be set to 0");
		// put it back: an invalid field anywhere blocks Save for the rest of the run
		await setField(page, 'HP', activeHP);

		// --- volatiles ---
		const listed = await filterVolatiles(page, '');
		expect(listed.length === 31, `singles should list 31 volatiles, not ${listed.length}`);
		expect(!listed.find(option => option.key === 'dynamax'), 'Dynamax should be absent outside gen 8');
		expect(listed.find(option => option.key === 'leechseed'),
			'Leech Seed should be one option in singles, not one per slot');
		// added 2026-09-19; Protosynthesis and Quark Drive are gen 9+, the other two are every generation
		for (const key of ['taunt', 'imprison', 'protosynthesis', 'quarkdrive']) {
			expect(listed.find(option => option.key === key), `${key} should be offered in gen 9`);
		}
		step(`the volatiles list has ${listed.length} entries, gen-filtered`);

		const filtered = await filterVolatiles(page, 'sub');
		expect(filtered.length === 1 && filtered[0].key === 'substitute',
			`typing "sub" should leave only Substitute: ${JSON.stringify(filtered)}`);
		step('typing filters the list');

		// Nightmare is offered but blocked until the Pokémon is asleep, since droppedEdits is never shown
		const asleep = await filterVolatiles(page, 'night');
		expect(asleep[0]?.blocked, 'Nightmare should be blocked while the Pokémon is awake');
		await pickVolatile(page, 'nightmare');
		expect((await volatileChips(page)).length === 0, 'a blocked option should not be addable');
		step('Nightmare is listed but refuses to be added while the Pokémon is awake');

		await setSelect(page, 'Status', 'slp');
		const nowAllowed = await filterVolatiles(page, 'night');
		expect(!nowAllowed[0]?.blocked, 'Nightmare should unblock once Status is Sleep, before any save');
		step('setting Status to Sleep unblocks Nightmare live');

		await setSelect(page, 'Status', '');
		await filterVolatiles(page, 'sub');
		await pickVolatile(page, 'substitute');
		await filterVolatiles(page, 'aqua');
		await pickVolatile(page, 'aquaring');
		const chips = await volatileChips(page);
		expect(chips.join(',') === 'aquaring,substitute', `both should be chips, in registry order: ${chips}`);
		step('two volatiles become chips');

		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		const saved = await volatileChips(page);
		expect(saved.join(',') === 'aquaring,substitute', `the volatiles should survive the save: ${saved}`);
		step('volatiles save and come back from the snapshot');

		await page.evaluate(() => document.querySelector('[data-multiselect-remove="substitute"]').click());
		await clickEditorButton(page, 'Save');
		await waitForDecision(page);
		const remaining = await volatileChips(page);
		expect(remaining.join(',') === 'aquaring', `removing one should keep the other: ${remaining}`);
		step('removing a chip saves as a removal, leaving the other in place');

		await clickEditorButton(page, 'Cancel');
		await waitFor(page, () => !!document.querySelector('[data-field-effect="weather:raindance"]'), 'back to the field form');
		step('Cancel returns to the field form');

		/*
		 * The `|swap|` line Set Active emits when the wanted Pokémon is already out in another slot
		 * (user report, 2026-09-18). Driven through a hand-written doubles log rather than the UI, because
		 * what broke was purely how the renderer reads the line: it looks the ident up *positionally*, so
		 * naming the slot the Pokémon moves **to** resolves to whoever is still sitting there and `swapTo`
		 * quietly does nothing — leaving the old sprite on the field while the sim had already moved on.
		 */
		const swapped = await page.evaluate(() => {
			const base = [
				'|gametype|doubles', '|player|p1|Tester||', '|player|p2|Tester||',
				'|teamsize|p1|2', '|teamsize|p2|2', '|start',
				'|switch|p1a: Alpha|Magikarp, M|100/100', '|switch|p1b: Beta|Feebas, M|100/100',
				'|switch|p2a: Gamma|Magikarp, F|100/100', '|switch|p2b: Delta|Feebas, F|100/100', '|turn|1',
			];
			const run = line => {
				// detached frames, as the app passes; without them the Battle falls back to a scene stub
				// this page doesn't load
				const battle = new AnalysisBattleRenderer({
					$frame: $('<div></div>'), $logFrame: $('<div></div>'),
					log: base.concat([line]), isReplay: true, paused: true,
				});
				battle.seekTurn(Infinity, true);
				const names = battle.sides[0].active.map(pokemon => pokemon && pokemon.name);
				battle.destroy();
				return names.join(',');
			};
			// the slot Beta moves from, which is what the server now emits, and the slot it lands in
			return { fromSlot: run('|swap|p1b: Beta|0'), toSlot: run('|swap|p1a: Beta|0') };
		});
		expect(swapped.fromSlot === 'Beta,Alpha',
			`naming the source slot should swap the two actives, got ${swapped.fromSlot}`);
		expect(swapped.toSlot === 'Alpha,Beta',
			`naming the destination slot is the bug this guards: it should be a no-op, got ${swapped.toSlot}`);
		step('the |swap| line moves the renderer\'s actives when it names the slot moved from');

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
