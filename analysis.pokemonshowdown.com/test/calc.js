'use strict';
/**
 * Damage calc tooltips (docs/analysis/plan.md, Phase 1):
 * - move button hover: calc lines for all potential targets (foes for single-target, everything hit for spread)
 * - status moves: no calc lines
 * - choice-summary cell hover: calc lines only for the chosen targets; no tooltip without a chosen move
 * - the move menu's Terastallize checkbox (and a chosen move's tera modifier) picks the tera calc
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	SMOKE_TEAM, step, checkServers, openAnalysisPage, clickButton, waitFor, waitForDecision, startAnalysisFromTeams,
	selectLeads, openActionMenu, hoverTooltip, calcLineCount, dumpFailure, sleep,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

const hasCalc = text => text.includes(' vs. ') && text.includes('%');

async function openActionMenuFor(page, sideIndex, teamIndex) {
	const selector = `.battle [data-tooltip="analysispokemon|${sideIndex}|${teamIndex}"]:not(.picon)`;
	await waitFor(page, sel => !!document.querySelector(sel), `active Pokémon ${sideIndex}|${teamIndex}`, 30000, selector);
	const start = Date.now();
	while (!(await page.$('.movemenu button'))) {
		if (Date.now() - start > 30000) throw new Error(`could not open action menu for ${sideIndex}|${teamIndex}`);
		await page.evaluate(sel => document.querySelector(sel)?.click(), selector);
		await sleep(250);
	}
}

async function singles(page) {
	await startAnalysisFromTeams(page, 'gen9ou');
	await selectLeads(page, 1, 2); // p1 Rotom-Wash, p2 Kingambit
	await waitForDecision(page);

	await openActionMenu(page, 0);
	const hydroPump = await hoverTooltip(page, '.movemenu button', { text: 'Hydro Pump', until: hasCalc });
	expect(hydroPump, 'Hydro Pump tooltip never showed a damage calc');
	expect(calcLineCount(hydroPump.html) === 1, `expected 1 calc line for Hydro Pump, got ${calcLineCount(hydroPump.html)}`);
	expect(/Hydro Pump vs\. .*: \d+-\d+ \(/.test(hydroPump.text), `unexpected calc text: ${hydroPump.text}`);
	expect(hydroPump.text.includes('(1)') && hydroPump.text.includes('(2)'), 'calc text lacks team numbers');
	expect(!/252|EVs?/.test(hydroPump.text.split('Hydro Pump vs.')[0].slice(-40)), 'calc text still shows EVs');
	expect((hydroPump.html.match(/class="picon"/g) || []).length >= 2, 'calc line lacks Pokémon icons');
	step(`singles move hover: ${hydroPump.text.slice(hydroPump.text.lastIndexOf('Hydro Pump vs.') - 6).trim()}`);

	expect(!hydroPump.text.includes('Tera '), 'untoggled Hydro Pump calc should not be terastallized');
	await page.evaluate(() => [...document.querySelectorAll('.megaevo-box label')]
		.find(label => label.textContent.includes('Terastallize')).querySelector('input').click());
	const teraHydroPump = await hoverTooltip(page, '.movemenu button', {
		text: 'Hydro Pump', until: text => hasCalc(text) && text.includes('Tera Electric'),
	});
	expect(teraHydroPump, 'toggling Terastallize should switch the hover calc to Tera Electric');
	step('Terastallize checkbox switches the move hover calc');

	const protect = await hoverTooltip(page, '.movemenu button', { text: 'Protect', until: text => text.includes('Protect') });
	expect(protect && calcLineCount(protect.html) === 0, 'status move tooltip should have no calc lines');
	step('status move hover has no calc lines');

	await page.evaluate(() => [...document.querySelectorAll('.movemenu button')].find(b => b.textContent.includes('Hydro Pump')).click());
	await waitFor(page, () => !document.querySelector('.movemenu'), 'move menu to close');
	const cells = await page.$$('.analysis-choice-summary.has-tooltip');
	expect(cells.length === 1, `expected 1 summary cell with a tooltip (only p1 chose), got ${cells.length}`);
	const cell = await hoverTooltip(page, '.analysis-choice-summary.has-tooltip', { until: hasCalc });
	expect(cell && calcLineCount(cell.html) === 1, 'summary cell tooltip should show 1 calc line');
	expect(cell.text.includes('Tera Electric'), 'summary cell calc should use the chosen move\'s tera modifier');
	step('singles summary cell hover shows the chosen target only, with the chosen tera');
}

async function doubles(page) {
	await page.evaluate(() => document.querySelector('.home-li a').click());
	await waitFor(page, () => document.body.textContent.includes('New Analysis From Teams'), 'home page');
	await startAnalysisFromTeams(page, 'gen9doublesou');
	await selectLeads(page, [0, 1], [2, 1]); // p1 Garchomp + Rotom-Wash, p2 Kingambit + Rotom-Wash
	await waitForDecision(page);

	await openActionMenuFor(page, 0, 0); // Garchomp
	const earthquake = await hoverTooltip(page, '.movemenu button', { text: 'Earthquake', until: hasCalc });
	expect(earthquake, 'Earthquake tooltip never showed a damage calc');
	expect(calcLineCount(earthquake.html) === 3,
		`Earthquake (hits both foes and the ally) should show 3 lines, got ${calcLineCount(earthquake.html)}`);
	expect(earthquake.text.includes('0-0 (0 - 0%) -- possibly the worst move ever'),
		'Earthquake into Levitate Rotom-Wash should show the zero-damage text');
	step('doubles spread move hover: 3 lines incl. ally and immune target');

	const dragonTail = await hoverTooltip(page, '.movemenu button', { text: 'Dragon Tail', until: hasCalc });
	expect(dragonTail && calcLineCount(dragonTail.html) === 2,
		`Dragon Tail (single target) should show 2 foe lines, got ${dragonTail && calcLineCount(dragonTail.html)}`);
	step('doubles single-target move hover: foes only');

	await page.evaluate(() => [...document.querySelectorAll('.movemenu button')].find(b => b.textContent.includes('Dragon Tail')).click());
	await waitFor(page, () => document.body.textContent.includes('Choose target'), 'target selection');
	await page.evaluate(() => [...document.querySelectorAll('.switchmenu button')].find(b => !b.disabled).click());
	await waitFor(page, () => !!document.querySelector('.analysis-choice-summary.has-tooltip'), 'summary cell tooltip');
	const cell = await hoverTooltip(page, '.analysis-choice-summary.has-tooltip', { until: hasCalc });
	expect(cell && calcLineCount(cell.html) === 1, `summary cell for a targeted move should show 1 line, got ${cell && calcLineCount(cell.html)}`);
	step('doubles summary cell hover shows only the chosen target');
}

async function main() {
	await checkServers();
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Calc A', packed: SMOKE_TEAM },
		{ format: 'gen9ou', name: 'Calc B', packed: SMOKE_TEAM },
		{ format: 'gen9doublesou', name: 'Calc Doubles A', packed: SMOKE_TEAM },
		{ format: 'gen9doublesou', name: 'Calc Doubles B', packed: SMOKE_TEAM },
	]);
	try {
		await singles(page);
		await doubles(page);
		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log('PASS');
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
		await dumpFailure(page, 'calc-failure');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main().catch(error => {
	console.log(`FAIL: ${error.message}`);
	process.exitCode = 1;
});
