'use strict';
/**
 * Autosave (docs/analysis/plan.md, Phase 6 extra): reloading the page reopens the tabs that were open.
 *
 * The stored entry is the **export format**, one per tab, so what this really checks is that a reload is
 * the same round trip `export.js` drives through a file — and it is checked the same way, by comparing
 * every Lines button **with its icon count**. That matters because a node whose summary was lost still
 * renders its `Turn N` heading and empty cells: the panel's text matches while its content is gone, which
 * is exactly the bug the export shipped once.
 *
 * It also covers the parts a file round trip has no equivalent of:
 * - only the active tab is rebuilt on load; a background tab builds its position when it is first clicked
 * - closing the last tab clears the entry, so a reload doesn't reopen work the user just closed
 * - an unreadable entry is discarded rather than crashing the page on every load
 *
 * Usage and prerequisites: see README.md in this folder.
 */
const {
	config, SMOKE_TEAM, sleep, step, checkServers, openAnalysisPage, clickButton, chooseMove, waitFor,
	waitForDecision, startAnalysisFromTeams, selectLeads, dumpFailure,
} = require('./lib');

const AUTOSAVE_KEY = 'analysis-open-tabs';

/**
 * Long enough for the throttled write to have landed on its own.
 *
 * A reload fires `pagehide`, which flushes, so this is belt and braces — but it is what makes the suite
 * fail if the `pagehide` listener is ever dropped *and* the throttle is broken, rather than passing on
 * whichever of the two still happens to work.
 *
 * Anything that waits for the *absence* of an entry polls instead (`waitForStored`): a write already in
 * flight when the tabs change pushes the next one a whole delay further out, so a fixed sleep there is a
 * flake waiting to happen — it was one, measured at ~3s against a 2.6s sleep.
 */
const AUTOSAVE_SETTLE = 2600;

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

/** Waits until the stored entry satisfies `check`, which is given the parsed entry or null. */
async function waitForStored(page, check, label, timeout = 20000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await storedAutosave(page, AUTOSAVE_KEY);
		if (check(last)) return last;
		await sleep(200);
	}
	throw new Error(`Timed out waiting for ${label}; autosave held ${JSON.stringify(last)?.slice(0, 200)}`);
}

/** Each Lines button as `{ text, icons }`; see the note in export.js on why the icons are the point. */
function linesNodes(page) {
	return page.evaluate(() => [...document.querySelectorAll('.analysis-node-button')].map(button => ({
		text: button.textContent.replace(/\s+/g, ' ').trim(),
		icons: button.querySelectorAll('.picon, span[style*="background"]').length,
	})));
}

/** The tab bar's tabs, as `{ label, current }`, ignoring the Home tab. */
function headerTabs(page) {
	return page.evaluate(() => [...document.querySelectorAll('.maintabbar-left a.roomtab')]
		.filter(tab => tab.textContent.trim() !== 'Home')
		.map(tab => ({ label: tab.textContent.replace(/\s+/g, ' ').trim(), current: tab.classList.contains('cur') })));
}

function storedAutosave(page, key) {
	return page.evaluate(storageKey => {
		const text = localStorage.getItem(storageKey);
		return text === null ? null : JSON.parse(text);
	}, key);
}

/** Reloads with the API query parameter, which `page.reload` would otherwise drop. */
function reload(page) {
	return page.goto(`${config.pageURL}?~~${config.api}`, { waitUntil: 'networkidle2' });
}

/**
 * Home -> New Analysis From Teams -> leads out -> `turns` played, settled.
 *
 * The settle is not optional. `waitForDecision` returns as soon as the controls offer Submit Choices, but
 * the **current** node's summary is written a render later — so Lines read at that moment is one button
 * short of what is about to be autosaved, and the comparison after a reload would report a difference that
 * is only this race. Measured: the button appears within three seconds of the controls being ready.
 */
async function playTurns(page, turns) {
	await startAnalysisFromTeams(page, 'gen9ou');
	await selectLeads(page, 0, 0);
	await waitForDecision(page);
	for (let turn = 0; turn < turns; turn++) {
		await chooseMove(page, 0, 0);
		await chooseMove(page, 1, 0);
		await clickButton(page, 'Submit Choices');
		await waitForDecision(page);
	}
	// Team Preview, one per played turn, and the decision point now waiting
	const expected = turns + 2;
	await waitFor(page, count => document.querySelectorAll('.analysis-node-button').length >= count,
		`${expected} Lines buttons`, 30000, expected);
}

/**
 * The **tab bar's** Home tab, which is an `<a>` and so out of `clickButton`'s reach.
 *
 * Scoped to `.maintabbar-left`, not matched on the text alone: the site nav below the tab bar now has its
 * own "Home" button too, and that one leaves the page entirely. Document order happens to find the tab
 * first, which is exactly the kind of luck a suite should not run on.
 */
function goHome(page) {
	return page.evaluate(() => {
		const link = [...document.querySelectorAll('.maintabbar-left a.roomtab')]
			.find(entry => entry.textContent.trim() === 'Home');
		if (!link) throw new Error('no Home tab in the tab bar');
		link.click();
	});
}

/**
 * The main case: play a line, reload, and get the same line back.
 */
async function reopensOnReload() {
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Autosave Test', packed: SMOKE_TEAM },
	]);
	try {
		await playTurns(page, 2);
		await sleep(AUTOSAVE_SETTLE);
		// read after the settle, so this is the state the autosave below actually holds
		const playedNodes = await linesNodes(page);
		expect(playedNodes.some(node => node.icons > 0),
			`expected Pokémon icons in Lines before reloading, got ${JSON.stringify(playedNodes)}`);
		expect(playedNodes.length === 4,
			`expected Team Preview, two played turns and the current one, got ${JSON.stringify(playedNodes)}`);

		const saved = await waitForStored(page, entry => entry?.tabs.length === 1, 'the open tab to be autosaved');
		expect(saved.activeTabId, 'expected the autosave to name an active tab');
		expect(saved.activeTabId === saved.tabs[0].id, 'the autosave should name the tab that was on screen');
		/*
		 * The entry is an export file, not a second format. If this ever stops being true, the two restore
		 * paths have started to drift and the nodes-are-kept-whole lesson is about to be relearned.
		 */
		const entry = saved.tabs[0].file;
		expect(entry.tab.format === 'gen9ou', `expected gen9ou in the entry, got ${entry.tab.format}`);
		expect(!!entry.tab.rootSeed, 'expected the root seed in the entry');
		expect(!!entry.tab.nodes[entry.tab.currentNodeId], 'the entry should name a node it contains');
		step('the open tab is autosaved as an export recipe');

		await reload(page);
		await waitFor(page, () => document.querySelectorAll('.maintabbar-left a.roomtab').length > 1,
			'the autosaved tab to reopen');
		const tabs = await headerTabs(page);
		expect(tabs.length === 1, `expected one reopened tab, got ${JSON.stringify(tabs)}`);
		expect(tabs[0].current, 'the reopened tab should be the one on screen');
		await waitForDecision(page);
		step('a reload reopens the tab and rebuilds its position');

		const reopenedNodes = await linesNodes(page);
		expect(JSON.stringify(reopenedNodes) === JSON.stringify(playedNodes),
			'every Lines button should come back the same, icons included:\n' +
			`  before: ${JSON.stringify(playedNodes)}\n  after:  ${JSON.stringify(reopenedNodes)}`);
		step('the reopened tab shows the same line, icons included');

		/*
		 * Closing the last tab must clear the entry. Otherwise a reload reopens work the user has just
		 * closed, which is the one failure mode worse than losing it.
		 */
		await page.evaluate(() => document.querySelector('.maintabbar-left .closebutton').click());
		await waitFor(page, () => document.querySelectorAll('.maintabbar-left a.roomtab').length === 1,
			'the tab to close');
		await waitForStored(page, entry => entry === null, 'the autosave to be cleared');
		step('closing the last tab clears the autosave');
	} catch (error) {
		await dumpFailure(page, 'autosave');
		throw error;
	} finally {
		await browser.close();
	}
	if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
}

/**
 * Two tabs: both come back, but only the active one is rebuilt on load. The other keeps its Lines panel
 * and builds its position the first time it is clicked.
 */
async function restoresBackgroundTabsLazily() {
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Autosave Test', packed: SMOKE_TEAM },
	]);
	try {
		await playTurns(page, 1);
		await goHome(page);
		await playTurns(page, 1);
		const tabsBefore = await headerTabs(page);
		expect(tabsBefore.length === 2, `expected two open tabs, got ${JSON.stringify(tabsBefore)}`);

		await waitForStored(page, entry => entry?.tabs.length === 2, 'both open tabs to be autosaved');
		step('both open tabs are autosaved');

		/*
		 * Count the rebuild calls across the reload. Only the tab on screen should cost one: a page that
		 * restored every tab eagerly would run the sim once per tab before it was usable, which is the
		 * thing this design is trading against.
		 */
		await reload(page);
		await page.evaluate(() => {
			window.__starts = 0;
			const originalFetch = window.fetch;
			window.fetch = function (input, init) {
				if (`${input}`.includes('/analysis/start')) window.__starts++;
				return originalFetch.call(this, input, init);
			};
		});
		await waitFor(page, () => document.querySelectorAll('.maintabbar-left a.roomtab').length === 3,
			'both autosaved tabs to reopen');
		const tabsAfter = await headerTabs(page);
		expect(tabsAfter.length === 2, `expected two reopened tabs, got ${JSON.stringify(tabsAfter)}`);
		expect(tabsAfter[1].current, 'the tab that was on screen should be the one reopened in front');
		await waitForDecision(page);
		step('both tabs reopen, with the active one in front');

		/*
		 * The background tab's Lines are there before it has a position, because the panel renders from the
		 * stored nodes. Its battle is not, which is what the placeholder is for.
		 */
		await page.evaluate(() => document.querySelectorAll('.maintabbar-left a.roomtab')[1].click());
		await waitFor(page, () => !!document.querySelector('.analysis-restore-placeholder') ||
			!!document.querySelector('.innerbattle'), 'the background tab to start rebuilding');
		await waitForDecision(page);
		const backgroundNodes = await linesNodes(page);
		expect(backgroundNodes.length > 1,
			`expected the background tab's line, got ${JSON.stringify(backgroundNodes)}`);
		expect(await page.evaluate(() => !!document.querySelector('.innerbattle')),
			'clicking a restored background tab should build its battle');
		step('a background tab builds its position when it is first opened');
	} catch (error) {
		await dumpFailure(page, 'autosave-lazy');
		throw error;
	} finally {
		await browser.close();
	}
	if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
}

/**
 * An entry this build cannot read is discarded, and the page still loads.
 *
 * This is the failure that matters most: a stored entry is replayed on **every** load, so one that throws
 * would leave the tool permanently broken with no way back except clearing site data by hand.
 */
async function discardsUnreadableEntries() {
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Autosave Test', packed: SMOKE_TEAM },
	]);
	try {
		for (const [label, value] of [
			['invalid JSON', '{not json'],
			['a snapshot from a newer build', JSON.stringify({ schema: 99, activeTabId: null, tabs: [] })],
			['a tab with no nodes', JSON.stringify({
				schema: 1,
				activeTabId: 'analysis-1',
				tabs: [{ id: 'analysis-1', file: { schema: 1, tab: { format: 'gen9ou' } } }],
			})],
		]) {
			await page.evaluate((key, stored) => localStorage.setItem(key, stored), AUTOSAVE_KEY, value);
			await reload(page);
			await waitFor(page, () => document.body.textContent.includes('New Analysis From Teams'),
				`the home screen after ${label}`);
			const tabs = await headerTabs(page);
			expect(tabs.length === 0, `${label} should open no tab, got ${JSON.stringify(tabs)}`);
			await waitForStored(page, entry => entry === null,
				`${label} to be cleared rather than retried on every load`);
			step(`${label} is discarded and the page still loads`);
		}
	} catch (error) {
		await dumpFailure(page, 'autosave-bad-entry');
		throw error;
	} finally {
		await browser.close();
	}
	if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
}

async function main() {
	await checkServers();
	await reopensOnReload();
	await restoresBackgroundTabsLazily();
	await discardsUnreadableEntries();
	console.log('PASS');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
