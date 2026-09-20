'use strict';
/**
 * Smoke test: the core analysis flow end to end in a real browser.
 * Usage and prerequisites: see README.md in this folder.
 */
const fs = require('fs');
const path = require('path');
const {
	SMOKE_TEAM, OUTPUT_DIR, step, checkServers, openAnalysisPage, clickButton, waitFor, linesText,
	waitForDecision, startAnalysisFromTeams, selectLeads, openActionMenu, chooseMove, dumpFailure,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

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

		/*
		 * The format menu's columns, before anything is started. The assertion is the *rule* — columns come
		 * out in ascending `column` order — rather than which format sits where, because the format list is
		 * the fork's and will keep changing.
		 *
		 * It is here because it regressed: the menu used to start a new column whenever `column` changed
		 * while walking the list, which is only right while the list is in column order. It is not —
		 * `mergeFormatLists` appends `custom-formats.ts` at the end, so its `column: 1` sections arrived
		 * after columns 2-4 and were rendered last. The old client, which this fork serves, buckets by
		 * column number instead.
		 */
		await clickButton(page, 'New Analysis From Teams');
		await page.evaluate(() => document.querySelector('.analysis-picker-format button.formatselect').click());
		await page.waitForSelector('.analysis-format-popup .options[data-column]', { timeout: 20000 });
		const menu = await page.evaluate(() => [...document.querySelectorAll('.analysis-format-popup .options')]
			.map(list => ({
				column: Number(list.dataset.column),
				firstSection: list.querySelector('h3')?.textContent.replace(/\s+/g, ' ').trim() || '',
				top: Math.round(list.getBoundingClientRect().top),
			})));
		expect(menu.length > 1, `expected several format columns, got ${JSON.stringify(menu)}`);
		expect(menu.every((entry, index) => !index || entry.column > menu[index - 1].column),
			`format columns should be in ascending column order, got ${JSON.stringify(menu)}`);
		// the fork's own formats declare column 1, so they lead the menu however late they are in the list
		expect(/DigiPen/i.test(menu[0].firstSection),
			`expected the fork's column-1 sections first, got ${JSON.stringify(menu)}`);
		/*
		 * All on one row. The columns are floats from `client2.css`, and a float row one pixel too wide
		 * drops its last column underneath the others — which is what happened once the fork's formats
		 * made it four columns: the popup's width formula had not paid for its own vertical scrollbar, and
		 * a classic 17px one left about a pixel of slack. `.analysis-picker-columns` is a flex row now, so
		 * being too narrow gives a horizontal scroll instead, but the width is checked here too because
		 * scrolling to reach a column is still worse than not needing to.
		 */
		const layout = await page.evaluate(() => {
			const popup = document.querySelector('.analysis-format-popup');
			const wrap = document.querySelector('.analysis-picker-columns');
			const box = popup.getBoundingClientRect();
			return {
				onScreen: Math.round(box.left) >= 0 && Math.round(box.right) <= window.innerWidth,
				slack: wrap.clientWidth - wrap.scrollWidth,
			};
		});
		expect([...new Set(menu.map(entry => entry.top))].length === 1,
			`every format column should sit on one row, got ${JSON.stringify(menu.map(e => e.top))}`);
		expect(layout.onScreen, 'the format menu should be fully on screen');
		expect(layout.slack >= 0,
			`the format menu should be wide enough for its columns without scrolling (${layout.slack}px slack)`);
		step('the format menu fits its columns on one row');
		await page.keyboard.press('Escape');
		await waitFor(page, () => !document.querySelector('.analysis-picker-popup'), 'the format menu to close');
		step('the format menu is laid out in ascending column order');

		await startAnalysisFromTeams(page);
		// p1 leads Rotom-Wash, p2 leads Kingambit
		await selectLeads(page, 1, 2);
		await waitForDecision(page);
		step('team preview submitted');

		// clicking a choice-summary cell opens that Pokémon's action selection, like clicking its sprite
		await page.evaluate(() => document.querySelector('.battle-controls .analysis-choice-selectable').click());
		await waitFor(page, () => !!document.querySelector('.movemenu button'), 'move menu from summary cell');
		await clickButton(page, 'Cancel');
		await waitFor(page, () => !document.querySelector('.movemenu'), 'selection to cancel');
		step('summary cell opens action selection; cancel works');

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
		const turn1Button = await page.evaluateHandle(() => [...document.querySelectorAll('.analysis-node-button')]
			.find(button => button.textContent.includes('Turn 1')));
		await turn1Button.hover();
		const tooltip = await page.evaluate(button => {
			const element = button.nextElementSibling;
			const rect = element.getBoundingClientRect();
			const buttonRect = button.getBoundingClientRect();
			return {
				text: element.textContent, visible: getComputedStyle(element).visibility === 'visible',
				leftOfButton: rect.right <= buttonRect.left, inWindow: rect.top >= 0 && rect.left >= 0 &&
					rect.bottom <= window.innerHeight,
			};
		}, turn1Button);
		if (!tooltip.text.includes('Turn 1 → Turn 2')) throw new Error(`unexpected Turn 1 outcome tooltip: ${tooltip.text}`);
		if (!tooltip.visible || !tooltip.leftOfButton || !tooltip.inWindow) {
			throw new Error(`Turn 1 tooltip misplaced: ${JSON.stringify(tooltip)}`);
		}
		if (!/Turn 4/.test(await linesText(page))) throw new Error('Lines lost later nodes after navigating back');
		step('navigated back to Turn 1 (outcome tooltip left of its button and inside the window, line intact)');

		// --- the header's settings popup and Debug Mode ---
		const debugPanels = () => page.evaluate(() => ({
			headings: [...document.querySelectorAll('h2')].map(heading => heading.textContent),
			logs: document.querySelectorAll('.analysis-debug-log').length,
			popup: !!document.querySelector('.analysis-settings-popup'),
		}));
		let panels = await debugPanels();
		if (panels.logs) throw new Error('developer panels should be hidden until Debug Mode is on');
		if (panels.headings.includes('Dropped Edits')) throw new Error('Dropped Edits should be hidden by default');
		if (!panels.headings.includes('Lines')) throw new Error(`the Lines heading should be there: ${JSON.stringify(panels.headings)}`);
		step('developer panels are hidden by default');

		await page.evaluate(() => document.querySelector('.analysis-settings-button').click());
		panels = await debugPanels();
		if (!panels.popup) throw new Error('the gear button should open the settings popup');
		await page.evaluate(() => {
			const box = document.querySelector('[data-settings="Debug Mode"]');
			box.checked = true;
			box.dispatchEvent(new Event('change', { bubbles: true }));
		});
		panels = await debugPanels();
		if (!panels.headings.includes('Dropped Edits')) {
			throw new Error(`Debug Mode should reveal the developer panels: ${JSON.stringify(panels.headings)}`);
		}
		if (panels.logs !== 2) throw new Error(`expected both debug logs, saw ${panels.logs}`);
		step('Debug Mode reveals the node data and dropped edits');

		// clicking away closes the popup, and the setting survives a reload
		await page.evaluate(() => document.body.click());
		if ((await debugPanels()).popup) throw new Error('clicking outside should close the settings popup');
		const remembered = await page.evaluate(() => window.localStorage.getItem('analysis-debug-mode'));
		if (remembered !== '1') throw new Error(`Debug Mode should be remembered, got ${remembered}`);
		step('the popup closes on an outside click and the setting is remembered');

		// put it back, so the stored setting doesn't leak into the next run
		await page.evaluate(() => document.querySelector('.analysis-settings-button').click());
		await waitFor(page, () => !!document.querySelector('[data-settings="Debug Mode"]'), 'the settings popup');
		await page.evaluate(() => {
			const box = document.querySelector('[data-settings="Debug Mode"]');
			box.checked = false;
			box.dispatchEvent(new Event('change', { bubbles: true }));
			document.body.click();
		});
		if ((await debugPanels()).logs) throw new Error('turning Debug Mode off should hide the panels again');
		step('turning Debug Mode off hides them again');

		/*
		 * The header's controls have to be *clickable*, not merely present.
		 *
		 * `.nav-wrapper` is full width but only centres its buttons, and it comes after the tab bar in
		 * document order at the same stacking level, so its empty left and right thirds painted over the
		 * tab bar and the settings gear and ate their clicks. Everything looked right and nothing
		 * responded: with a tab open there was no way back to Home, and the gear never opened (user
		 * report, 2026-09-20).
		 *
		 * This is hit-testing, deliberately, not `element.click()`. A synthetic click dispatches straight
		 * at the node and passes happily through an overlay, which is why the suites that already click
		 * Home never caught this. `elementFromPoint` is what a real cursor does.
		 */
		const headerHits = await page.evaluate(() => {
			const reach = el => {
				if (!el) return 'missing';
				const box = el.getBoundingClientRect();
				const top = document.elementFromPoint(
					Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
				if (el === top || el.contains(top)) return 'ok';
				return top ? `covered by ${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/).join('.')}` : 'nothing';
			};
			const tabs = [...document.querySelectorAll('.tabbar a.roomtab.closable')];
			const navButtons = [...document.querySelectorAll('.nav a.button')];
			const hits = (a, b) => {
				const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
				return x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
			};
			// a nav button no tab reaches: it must still take its own clicks
			const freeButton = navButtons.find(b => !tabs.some(t => hits(t, b)));
			return {
				homeTab: reach([...document.querySelectorAll('.tabbar a')].find(a => a.textContent.trim() === 'Home')),
				analysisTab: reach(document.querySelector('.roomtab.closable')),
				gear: reach(document.querySelector('.analysis-settings-button')),
				freeButtonLabel: freeButton ? freeButton.textContent.trim() : null,
				freeButton: reach(freeButton),
			};
		});
		expect(headerHits.homeTab === 'ok', `the Home tab should be clickable, but it is ${headerHits.homeTab}`);
		expect(headerHits.analysisTab === 'ok', `the analysis tab should be clickable, but it is ${headerHits.analysisTab}`);
		expect(headerHits.gear === 'ok', `the settings gear should be clickable, but it is ${headerHits.gear}`);
		/*
		 * The tab bar is raised above the nav so open tabs cover the buttons they reach, and its box spans
		 * the whole header — so it has to stay transparent to clicks everywhere it isn't a tab, or it takes
		 * every nav button with it.
		 */
		expect(headerHits.freeButton === 'ok',
			`the nav's ${headerHits.freeButtonLabel} button should still be clickable, but it is ${headerHits.freeButton}`);

		// and the click actually lands: a real mouse click on Home, with the analysis still open
		const homeTab = await page.evaluateHandle(() =>
			[...document.querySelectorAll('.tabbar a')].find(a => a.textContent.trim() === 'Home'));
		await homeTab.asElement().click();
		await waitFor(page, () => !!document.querySelector('.analysis-home'), 'the home screen after clicking the Home tab');
		expect(await page.evaluate(() => document.querySelectorAll('.roomtab.closable').length) === 1,
			'going Home should leave the analysis tab open, not close it');
		// back into the analysis, so the close check below still has one to close
		await page.evaluate(() => document.querySelector('.roomtab.closable').click());
		await waitFor(page, () => !!document.querySelector('.ps-room'), 'the analysis again');
		step('the Home tab, the analysis tab and the gear are clickable, and Home leaves the tab open');

		/*
		 * Closing the tab has to take the analysis with it. It used to drop the tab from the list and
		 * nothing else, leaving the battle rendered over the home screen and handing the next tab the closed
		 * one's draft, forms and calcs (user report, 2026-09-20).
		 */
		await page.evaluate(() => {
			const close = document.querySelector('.closebutton');
			if (!close) throw new Error('no close button on the analysis tab');
			close.click();
		});
		await waitFor(page, () => !!document.querySelector('.analysis-home'), 'the home screen after closing');
		const afterClose = await page.evaluate(() => ({
			tabs: document.querySelectorAll('.roomtab.closable').length,
			/*
			 * Deliberately NOT scoped to `.battle`. The scene builds its own markup outside the frame preact
			 * manages, so closing the tab removes `.battle` while `.innerbattle` stays in the document —
			 * which is the leak. Scoping this to `.battle .innerbattle` made it pass against the bug.
			 */
			battleScene: document.querySelectorAll('.innerbattle').length,
			controls: document.querySelectorAll('.battle-controls').length,
			log: document.querySelectorAll('.battle-log .inner div').length,
			lines: document.querySelectorAll('.analysis-node-button').length,
		}));
		expect(!afterClose.tabs, `closing should leave no analysis tab, saw ${afterClose.tabs}`);
		expect(!afterClose.battleScene, `the battle should be gone, saw ${afterClose.battleScene}`);
		expect(!afterClose.controls, `the controls should be gone, saw ${afterClose.controls}`);
		expect(!afterClose.log, `the battle log should be gone, saw ${afterClose.log} lines`);
		expect(!afterClose.lines, `the Lines panel should be gone, saw ${afterClose.lines} nodes`);
		step('closing an analysis closes everything belonging to it');

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
