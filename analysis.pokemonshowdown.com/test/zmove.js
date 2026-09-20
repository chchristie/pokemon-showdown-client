'use strict';
/**
 * Z-moves in the action menu, plus the one thing that has to be true before any of it makes sense: a team
 * built on a Mega forme starts the battle **unevolved**.
 *
 * A gen 7 team is what exercises both. The teambuilder stores Mega Charizard X as `Charizard-Mega-X`, but
 * a battle starts from Charizard holding a Charizardite X — so if the tool hands the sim the team as
 * typed, turn 1 opens with a Mega on the field and no Mega Evolution to choose.
 *
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	step, checkServers, openAnalysisPage, clickButton, waitFor, waitForDecision, startAnalysisFromTeams,
	selectLeads, openActionMenu, hoverTooltip, calcLineCount, dumpFailure,
} = require('./lib');

/** Charizard is stored as its Mega forme, as the teambuilder stores it. Tapu Koko holds the crystal. */
const GEN7_TEAM = 'Charizard-Mega-X||CharizarditeX|ToughClaws|DragonDance,FlareBlitz,DragonClaw,Roost|' +
	'Jolly|,252,,,4,252|||||]' +
	'Tapu Koko||ElectriumZ|ElectricSurge|Thunderbolt,DazzlingGleam,VoltSwitch,Roost|Timid|,,,252,4,252|||||]' +
	'Landorus-Therian||Leftovers|Intimidate|Earthquake,Uturn,StealthRock,KnockOff|Jolly|252,,4,,,252|||||';

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

const hasCalc = text => text.includes(' vs. ') && text.includes('%');

const moveMenu = page => page.evaluate(() => [...document.querySelectorAll('.movemenu button')].map(button => ({
	text: button.textContent.trim(), disabled: button.disabled,
})));

const transformOptions = page => page.evaluate(() =>
	[...document.querySelectorAll('.megaevo-box label')].map(label => label.textContent.trim()));

/** Ticks a move menu checkbox by its label text. */
const toggleTransform = (page, label) => page.evaluate(text => {
	const option = [...document.querySelectorAll('.megaevo-box label')].find(entry => entry.textContent.includes(text));
	if (!option) throw new Error(`no "${text}" checkbox in the move menu`);
	option.querySelector('input').click();
}, label);

async function megaStartsUnevolved(page) {
	const log = await page.evaluate(() =>
		[...document.querySelectorAll('.battle-log .inner div')].map(div => div.textContent).join('\n'));
	expect(log.includes('Charizard'), 'Charizard should have been sent out');
	expect(!log.includes('Charizard-Mega-X') && !log.includes('Mega Charizard'),
		`Charizard started the battle already Mega Evolved:\n${log}`);

	await openActionMenu(page, 0);
	const options = await transformOptions(page);
	expect(options.includes('Mega Evolution'),
		`the Mega it has not used yet should be on offer, got ${JSON.stringify(options)}`);
	expect(!options.some(option => option.includes('Z-Power')), 'a Charizardite is not a Z-crystal');
	step('a team built on a Mega forme starts unevolved, with Mega Evolution still to choose');

	// `openActionMenu` treats an open menu as done, so the other side's has to be reached from closed
	await clickButton(page, 'Cancel');
	await waitFor(page, () => !document.querySelector('.movemenu'), 'the action menu to close');
}

async function zMoves(page) {
	await openActionMenu(page, 1); // Tapu Koko
	const options = await transformOptions(page);
	expect(options.includes('Z-Power'), `expected a Z-Power checkbox, got ${JSON.stringify(options)}`);
	expect(!options.includes('Mega Evolution'), 'Tapu Koko holds no Mega Stone');
	step('the Z-crystal holder gets a Z-Power checkbox, and nothing else does');

	const base = await moveMenu(page);
	expect(base.map(button => button.text.split('\n')[0]).join(',').startsWith('Thunderbolt'),
		`unexpected move menu: ${JSON.stringify(base)}`);

	await toggleTransform(page, 'Z-Power');
	await waitFor(page, () => [...document.querySelectorAll('.movemenu button')]
		.some(button => button.textContent.includes('Gigavolt Havoc')), 'the Z-move buttons');
	const powered = await moveMenu(page);
	expect(powered.length === 4, `expected 4 move buttons, got ${powered.length}`);
	// Electrium Z powers up the two Electric moves; Dazzling Gleam and Roost get blank, disabled buttons
	expect(powered[0].text.includes('Gigavolt Havoc') && powered[2].text.includes('Gigavolt Havoc'),
		`expected Gigavolt Havoc in slots 1 and 3, got ${JSON.stringify(powered)}`);
	expect(powered[1].disabled && powered[3].disabled && !powered[1].text && !powered[3].text,
		`moves with no Z version should be blank and disabled, got ${JSON.stringify(powered)}`);
	step('Z-Power replaces the move menu with the Z-moves, blanking the moves that have none');

	const tooltip = await hoverTooltip(page, '.movemenu button', {
		text: 'Gigavolt Havoc', until: text => text.includes('Gigavolt Havoc') && hasCalc(text),
	});
	expect(tooltip, 'the Z-move button never showed its own tooltip with a calc');
	expect(calcLineCount(tooltip.html) === 1, `expected 1 calc line, got ${calcLineCount(tooltip.html)}`);
	// the calc names the move it actually ran, with the Z-move's base power rather than Thunderbolt's
	expect(/Gigavolt Havoc \(175 BP\) vs\. .*: \d+-\d+ \(/.test(tooltip.text),
		`calc is not the Z-move's: ${tooltip.text}`);
	step('hovering a Z-move shows the Z-move\'s tooltip and the Z-move\'s damage');

	await page.evaluate(() => [...document.querySelectorAll('.movemenu button')]
		.find(button => button.textContent.includes('Gigavolt Havoc')).click());
	await waitFor(page, () => !document.querySelector('.movemenu'), 'move menu to close');
	const summary = await page.evaluate(() => document.querySelector('.analysis-choice-summary.has-tooltip')?.textContent || '');
	expect(summary.includes('Gigavolt Havoc'), `the chosen action should name the Z-move, got "${summary}"`);
	const cell = await hoverTooltip(page, '.analysis-choice-summary.has-tooltip', { until: hasCalc });
	expect(cell && cell.text.includes('Gigavolt Havoc'),
		`the summary cell calc should use the Z-move, got "${cell && cell.text}"`);
	step('the chosen Z-move is named in the summary, and its calc follows');

	// the whole point: the choice line the menu builds has to be one the sim runs as a Z-move
	await openActionMenu(page, 0);
	await page.evaluate(() => document.querySelectorAll('.movemenu button')[0].click());
	await clickButton(page, 'Submit Choices');
	await waitFor(page, () => {
		const log = [...document.querySelectorAll('.battle-log .inner div')].map(div => div.textContent).join('\n');
		return log.includes('Gigavolt Havoc');
	}, 'the Z-move to be used', 60000);
	step('submitting plays the turn with the Z-move');
}

async function main() {
	await checkServers();
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen7ou', name: 'Gen 7 A', packed: GEN7_TEAM },
		{ format: 'gen7ou', name: 'Gen 7 B', packed: GEN7_TEAM },
	]);
	try {
		await startAnalysisFromTeams(page, 'gen7ou');
		await selectLeads(page, 0, 1); // p1 Charizard, p2 Tapu Koko
		await waitForDecision(page);
		await megaStartsUnevolved(page);
		await zMoves(page);
		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log('PASS');
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
		await dumpFailure(page, 'zmove-failure');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

void main();
