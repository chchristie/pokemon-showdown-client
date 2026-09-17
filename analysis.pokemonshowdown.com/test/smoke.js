'use strict';
/**
 * Smoke test: the core analysis flow end to end in a real browser.
 * Usage and prerequisites: see README.md in this folder.
 */
const fs = require('fs');
const path = require('path');
const {
	SMOKE_TEAM, OUTPUT_DIR, step, checkServers, openAnalysisPage, clickButton, waitFor, linesText,
	waitForDecision, selectLeads, openActionMenu, chooseMove, dumpFailure,
} = require('./lib');

async function main() {
	await checkServers();
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Smoke A', packed: SMOKE_TEAM },
		{ format: 'gen9ou', name: 'Smoke B', packed: SMOKE_TEAM },
	]);
	try {
		const officialScripts = await page.evaluate(() => [...document.scripts]
			.filter(script => /^https?:\/\/play\.pokemonshowdown\.com\//.test(script.src) && !/pokedex-mini/.test(script.src)).length);
		if (officialScripts) throw new Error(`${officialScripts} scripts loaded from the official site instead of this build`);
		step('page loaded with local assets');

		await clickButton(page, 'New Analysis From Teams');
		await clickButton(page, 'Start Analysis');
		// p1 leads Rotom-Wash, p2 leads Kingambit
		await selectLeads(page, 1, 2);
		await waitForDecision(page);
		step('team preview submitted');

		await openActionMenu(page, 0);
		await clickButton(page, 'Cancel');
		await waitFor(page, () => !document.querySelector('.movemenu'), 'selection to cancel');
		step('action selection cancel works');

		await chooseMove(page, 0, 0); // Hydro Pump
		await chooseMove(page, 1, 0); // Kowtow Cleave
		await clickButton(page, 'Submit Choices');
		await waitFor(page, () => /Turn 2/.test(document.querySelector('.analysis-node-tree')?.textContent || ''), 'Turn 2 node');
		await waitForDecision(page);
		step('turn 1 submitted manually');

		await chooseMove(page, 0, 3); // Protect
		await chooseMove(page, 1, 3); // Swords Dance
		await page.evaluate(() => {
			const input = document.querySelector('.battle-controls input[type=number]');
			input.value = '40';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await clickButton(page, 'Simulate Possible Turns');
		await waitFor(page, () => document.body.textContent.includes('Simulation Outcomes'), 'simulation outcomes', 60000);
		await waitForDecision(page, 'Select Outcome');
		const outcomes = await page.evaluate(() => document.querySelectorAll('.analysis-simulation-outcome').length);
		if (!outcomes) throw new Error('simulation returned no outcome groups');
		await clickButton(page, 'Select Outcome');
		await waitFor(page, () => /Turn 3/.test(document.querySelector('.analysis-node-tree')?.textContent || ''), 'Turn 3 node');
		await waitForDecision(page);
		step(`simulated turn 2 (${outcomes} outcome group(s)) and selected an outcome`);

		await chooseMove(page, 0, 1); // Volt Switch
		await chooseMove(page, 1, 2); // Iron Head
		await clickButton(page, 'Submit Choices');
		await waitFor(page, () => /Choose Replacement/.test(document.body.textContent), 'Volt Switch replacement prompt', 40000);
		await page.evaluate(() => [...document.querySelectorAll('.switchmenu button')].find(button => !button.disabled).click());
		// the replacement prompt proves the turn request finished, so waitForDecision can't see stale controls;
		// it must run before waiting for Turn 4, which only appears after any faint replacements
		const faintReplacements = await waitForDecision(page);
		await waitFor(page, () => /Turn 4/.test(document.querySelector('.analysis-node-tree')?.textContent || ''), 'Turn 4 node');
		step(`mid-turn (Volt Switch) replacement submitted${faintReplacements ? ', plus end-of-turn faint replacements' : ''}`);

		await page.evaluate(() => [...document.querySelectorAll('.analysis-node-button')]
			.find(button => button.textContent.includes('Turn 1')).click());
		await waitFor(page, () => document.querySelector('.analysis-node-current strong')?.textContent === 'Turn 1', 'Turn 1 selected');
		await waitForDecision(page);
		const tooltip = await page.evaluate(() => document.querySelector('.analysis-node-tooltip')?.textContent || '');
		if (!tooltip.includes('Turn 1 → Turn 2')) throw new Error(`unexpected Turn 1 outcome tooltip: ${tooltip}`);
		if (!/Turn 4/.test(await linesText(page))) throw new Error('Lines lost later nodes after navigating back');
		step('navigated back to Turn 1 (outcome tooltip present, line intact)');

		fs.mkdirSync(OUTPUT_DIR, { recursive: true });
		await page.screenshot({ path: path.join(OUTPUT_DIR, 'smoke-final.png') }).catch(() => {});
		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log('PASS');
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
		await dumpFailure(page, 'smoke-failure');
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main().catch(error => {
	console.log(`FAIL: ${error.message}`);
	process.exitCode = 1;
});
