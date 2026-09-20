'use strict';
/**
 * Export and Import (docs/analysis/plan.md, Phase 6): the download button in the default controls, and the
 * shape of the file it writes.
 * - the button sits after Next Turn, and carries the same download icon as the client's replay download
 * - the file is a *recipe*: teams, root seed, and per node the seed, edits and choices
 * - everything `/analysis/start` returns is left out (log, snapshot, requests, editOptions, ...), as are
 *   simulation results; nodes are kept whole, summaries included, because nothing recomputes those
 * - an imported replay's own log **is** kept, because no rebuild can reproduce it
 * - the filename is format + date, plus both trainers when a replay named them
 *
 * The download is captured in the page rather than written to disk: `HTMLAnchorElement.click` is stubbed
 * so the blob is read back through `fetch` instead of reaching the browser's download manager, which
 * headless Chrome would otherwise have to be configured for.
 *
 * Usage and prerequisites: see README.md in this folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
	SMOKE_TEAM, step, checkServers, openAnalysisPage, clickButton, chooseMove, waitFor, waitForDecision,
	startAnalysisFromTeams, selectLeads, dumpFailure,
} = require('./lib');

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

/**
 * The same two-turn gen 9 OU replay `replay.js` uses, kept in step with it deliberately: this suite only
 * cares that an import carries its log and its trainers into the file.
 */
const REPLAY_LOG = [
	'|player|p1|Alice|1|', '|player|p2|Bob|2|', '|gametype|singles', '|gen|9', '|tier|[Gen 9] OU',
	'|clearpoke',
	'|poke|p1|Pikachu, M|', '|poke|p1|Bulbasaur, F|', '|poke|p1|Charmander, M|',
	'|poke|p1|Squirtle, F|', '|poke|p1|Eevee, M|', '|poke|p1|Snorlax, F|',
	'|poke|p2|Charmander, M|', '|poke|p2|Squirtle, F|', '|poke|p2|Bulbasaur, M|',
	'|poke|p2|Pidgey, F|', '|poke|p2|Rattata, M|', '|poke|p2|Meowth, F|',
	'|teampreview',
	'|teamsize|p1|6', '|teamsize|p2|6', '|start',
	'|switch|p1a: Snorlax|Snorlax, F|100/100', '|switch|p2a: Meowth|Meowth, F|100/100',
	'|turn|1',
	'|move|p1a: Snorlax|Body Slam|p2a: Meowth', '|-damage|p2a: Meowth|62/100',
	'|move|p2a: Meowth|Scratch|p1a: Snorlax', '|-damage|p1a: Snorlax|81/100',
	'|upkeep', '|turn|2',
].join('\n');

/** Drives the file input directly, which is what a user choosing a `.log` does. */
async function importReplay(page, log) {
	const file = path.join(os.tmpdir(), `analysis-export-test-${Date.now()}.log`);
	fs.writeFileSync(file, log);
	try {
		await clickButton(page, 'Import Replay');
		const input = await page.waitForSelector('.analysis-form input[type="file"]', { timeout: 20000 });
		await input.uploadFile(file);
		await waitFor(page, () => /Loaded /.test(
			document.querySelector('.analysis-form')?.textContent || ''
		), 'the replay file to load');
		await clickButton(page, 'Open Replay Analysis');
	} finally {
		fs.rmSync(file, { force: true });
	}
}

/**
 * Stubs the anchor click the export uses, so the file is read back here instead of being downloaded.
 * The blob is fetched synchronously inside the stub: the export revokes the object URL on a timer, so
 * waiting until after the click to ask for it would race that.
 */
function captureDownloads(page) {
	return page.evaluate(() => {
		window.__captured = null;
		const original = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function () {
			if (!this.download) return original.apply(this, arguments);
			const filename = this.download;
			window.__capturing = fetch(this.href).then(response => response.text()).then(text => {
				window.__captured = { filename, text };
			});
		};
	});
}

/** Clicks Export and returns `{ filename, file }` with the parsed JSON. */
async function exportAnalysis(page) {
	await clickButton(page, 'Export');
	await waitFor(page, () => !!window.__captured, 'the exported file');
	const captured = await page.evaluate(() => window.__captured);
	let file;
	try {
		file = JSON.parse(captured.text);
	} catch (error) {
		throw new Error(`exported file is not JSON: ${error.message}\n${captured.text.slice(0, 200)}`);
	}
	return { filename: captured.filename, file };
}

/**
 * Each Lines button as `{ text, icons }`.
 *
 * The icon count is the point: a node whose `choiceSummary` is missing still renders its `Turn N` heading
 * and empty summary cells, so comparing the panel's text alone reports a match while the Pokémon icons —
 * the actual content of the summary — are gone.
 */
function linesNodes(page) {
	return page.evaluate(() => [...document.querySelectorAll('.analysis-node-button')].map(button => ({
		text: button.textContent.replace(/\s+/g, ' ').trim(),
		icons: button.querySelectorAll('.picon, span[style*="background"]').length,
	})));
}

/** The rendered battle log, as one string. */
function battleLogText(page) {
	return page.evaluate(() =>
		[...document.querySelectorAll('.battle-log .inner div')].map(div => div.textContent).join(' | '));
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

/** Writes an exported file to disk and drives the Import Analysis form with it. */
async function importAnalysis(page, file) {
	const target = path.join(os.tmpdir(), `analysis-import-test-${Date.now()}.json`);
	fs.writeFileSync(target, JSON.stringify(file));
	try {
		await clickButton(page, 'Import Analysis');
		const input = await page.waitForSelector('.analysis-form input[type="file"]', { timeout: 20000 });
		await input.uploadFile(target);
		await waitFor(page, () => /Loaded /.test(
			document.querySelector('.analysis-form')?.textContent || ''
		), 'the analysis file to load');
		await clickButton(page, 'Open Analysis');
	} finally {
		fs.rmSync(target, { force: true });
	}
}

/**
 * The Lines panel's text, for comparing a reopened analysis against the one it came from.
 *
 * Hover tooltips live inside the tree and render only while the pointer is over a node, so they are
 * stripped: whether one is open depends on where the last click left the mouse, not on the analysis.
 */
function linesSummary(page) {
	return page.evaluate(() => {
		const tree = document.querySelector('.analysis-node-tree');
		if (!tree) return '';
		const copy = tree.cloneNode(true);
		for (const tooltip of copy.querySelectorAll('.analysis-node-tooltip')) tooltip.remove();
		return copy.textContent.replace(/\s+/g, ' ').trim();
	});
}

/** Today's date as the filename spells it, so the assertion doesn't hard-code a day. */
function today() {
	const date = new Date();
	const month = `${date.getMonth() >= 9 ? '' : '0'}${date.getMonth() + 1}`;
	const day = `${date.getDate() >= 10 ? '' : '0'}${date.getDate()}`;
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Every key an import has no use for, because `/analysis/start` returns it. */
const REBUILT_TAB_KEYS = [
	'log', 'snapshot', 'requests', 'requestState', 'editOptions', 'gameType', 'droppedEdits',
	'simulationGroups', 'turnSimulationGroups', 'stateSimulationGroups', 'simulationInputLog',
	'onboarding', 'importWarnings', 'importPreview', 'importedTeams', 'replayLog',
];

/**
 * A node's summaries, which **are** exported. They are computed once, when the turn is played or the edits
 * are applied, and no rebuild recomputes them — an export that dropped them left every Lines button but the
 * current one without its icons.
 */
const NODE_SUMMARY_KEYS = ['choiceSummary', 'teamSelectionSummary'];

async function fromTeams() {
	const { browser, page, errors } = await openAnalysisPage([
		{ format: 'gen9ou', name: 'Export A', packed: SMOKE_TEAM },
		{ format: 'gen9ou', name: 'Export B', packed: SMOKE_TEAM },
	]);
	try {
		await captureDownloads(page);
		await startAnalysisFromTeams(page, 'gen9ou');
		// roster indexes, as smoke.js uses: Rotom-Wash leads for p1, Kingambit for p2
		await selectLeads(page, 1, 2);
		await waitForDecision(page);

		/*
		 * The button is checked by position, not just presence: it was asked for after Next Turn, and a
		 * button that renders anywhere in the controls would pass a text-only assertion.
		 */
		const placement = await page.evaluate(() => {
			const buttons = [...document.querySelectorAll('.battle-controls button')];
			const next = buttons.findIndex(button => /Next Turn/.test(button.textContent));
			const exportIndex = buttons.findIndex(button => /Export/.test(button.textContent));
			return {
				next, exportIndex,
				icon: !!buttons[exportIndex]?.querySelector('i.fa.fa-download'),
				enabled: exportIndex >= 0 && !buttons[exportIndex].disabled,
			};
		});
		expect(placement.exportIndex >= 0, 'expected an Export button in the default controls');
		expect(placement.exportIndex === placement.next + 1,
			`Export should follow Next Turn, got indexes ${JSON.stringify(placement)}`);
		expect(placement.icon, 'expected the fa-download icon on Export');
		expect(placement.enabled, 'Export should be clickable');
		step('Export sits after Next Turn with a download icon');

		const { filename, file } = await exportAnalysis(page);
		expect(filename === `Gen9OU-${today()}-analysis.json`,
			`unexpected filename for a tab built from teams: ${filename}`);
		step('a tab built from teams is named format + date');

		expect(file.schema === 1, `expected schema 1, got ${file.schema}`);
		expect(typeof file.exportedAt === 'string' && file.exportedAt.includes('T'),
			`expected an ISO exportedAt, got ${file.exportedAt}`);
		expect(typeof file.createdWith?.serverCommit === 'string',
			'expected createdWith.serverCommit, even if empty');
		expect(file.tab.format === 'gen9ou', `expected gen9ou, got ${file.tab.format}`);
		expect(!!file.tab.team1 && !!file.tab.team2, 'expected both packed teams');
		expect(!!file.tab.rootSeed, 'expected the root seed');
		expect(!!file.tab.nodes[file.tab.currentNodeId],
			`currentNodeId ${file.tab.currentNodeId} is not among the exported nodes`);
		step('the file carries what a rebuild cannot recompute');

		for (const key of REBUILT_TAB_KEYS) {
			expect(!(key in file.tab), `tab.${key} is rebuilt by the server and should not be exported`);
		}
		expect(!file.source, 'a tab that was not imported from a replay should have no source block');
		const nodes = Object.values(file.tab.nodes);
		expect(nodes.length > 0, 'expected at least one node');
		for (const node of nodes) {
			expect('id' in node && 'parentId' in node && 'turn' in node && 'inputLog' in node,
				`a node is missing its identity or choices: ${JSON.stringify(node).slice(0, 120)}`);
		}
		// The Team Preview node carries the icons Lines shows for each side's chosen team.
		const preview = nodes.find(node => node.turn === 0);
		expect(preview && NODE_SUMMARY_KEYS.some(key => key in preview),
			`the Team Preview node should keep its summary: ${JSON.stringify(preview).slice(0, 160)}`);
		step('rebuilt tab state is left out, and node summaries are kept');

		/*
		 * The round trip, which is the assertion that actually matters: a file is only worth writing if
		 * reopening it gives back the same line. Played a turn first, so the tree has a parent, a child and
		 * a real seed rather than the single node Team Preview leaves.
		 */
		/*
		 * Two turns, not one. With a single played turn the only node in Lines besides Team Preview is the
		 * current one, whose summary the rebuild refreshes anyway — so a line this short hides exactly the
		 * bug this is here to catch.
		 */
		for (let turn = 0; turn < 2; turn++) {
			await chooseMove(page, 0, 0);
			await chooseMove(page, 1, 0);
			await clickButton(page, 'Submit Choices');
			await waitForDecision(page);
		}
		const playedLines = await linesSummary(page);
		const playedNodes = await linesNodes(page);
		expect(playedNodes.some(node => node.icons > 0),
			`expected Pokémon icons in Lines before exporting, got ${JSON.stringify(playedNodes)}`);
		const played = await exportAnalysis(page);
		expect(Object.keys(played.file.tab.nodes).length > 1,
			'expected more than one node after playing a turn');

		await goHome(page);
		await importAnalysis(page, played.file);
		await waitForDecision(page);
		expect(await linesSummary(page) === playedLines,
			`a reopened analysis should show the same Lines:\n  before: ${playedLines}\n  after:  ${await linesSummary(page)}`);
		/*
		 * Every node's summary, not just the one that happens to be selected. A played node's summary is
		 * rebuilt when you *visit* it, so an import that doesn't restore it looks right on the current node
		 * and blank everywhere else — which is invisible to a comparison of the panel's text.
		 */
		const reopenedNodes = await linesNodes(page);
		expect(JSON.stringify(reopenedNodes) === JSON.stringify(playedNodes),
			`every Lines button should come back the same, icons included:\n  before: ${JSON.stringify(playedNodes)}\n  after:  ${JSON.stringify(reopenedNodes)}`);
		step('an exported analysis reopens to the same line');

		// Exporting the reopened tab must produce the same file, or something was lost in the round trip.
		const reexported = await exportAnalysis(page);
		expect(JSON.stringify(reexported.file.tab.nodes) === JSON.stringify(played.file.tab.nodes),
			're-exporting an imported analysis should give back the same nodes');
		expect(reexported.file.tab.rootSeed === played.file.tab.rootSeed,
			'the root seed should survive the round trip');
		step('re-exporting an imported analysis gives back the same nodes');
	} catch (error) {
		await dumpFailure(page, 'export');
		throw error;
	} finally {
		await browser.close();
	}
	if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
}

async function fromReplay() {
	const { browser, page, errors } = await openAnalysisPage([]);
	try {
		await captureDownloads(page);
		await importReplay(page, REPLAY_LOG);
		await waitFor(page, () => !!document.querySelector('.analysis-teambuilder'), 'the onboarding teambuilder');
		await clickButton(page, 'Skip');
		await waitForDecision(page);

		const { filename, file } = await exportAnalysis(page);
		// `|player|p1|Alice|` and `|player|p2|Bob|`, lowercased through toID as the replay download does
		expect(filename === `Gen9OU-${today()}-alice-bob-analysis.json`,
			`expected the trainers in the filename, got: ${filename}`);
		step('a replay import is named format + date + both trainers');

		expect(file.source?.type === 'replay', 'expected a replay source block');
		expect(Array.isArray(file.source.log) && file.source.log.length > 0, 'expected the replay log');
		expect(file.source.log.some(line => /Body Slam/.test(line)),
			'the replay log should be the real history, not the reconstruction');
		expect(!('replayLog' in file.tab), 'the replay log belongs in source, not on the tab');
		step('the imported replay log is kept, because no rebuild reproduces it');

		/*
		 * A replay node is rebuilt from itself, so its reconstruction is the one thing on it that no
		 * ancestor can supply. Dropping it would leave an import with correct-looking but empty turns.
		 */
		const replayNodes = Object.values(file.tab.nodes).filter(node => node.kind === 'replay');
		expect(replayNodes.length > 0, 'expected the imported turns to be exported as replay nodes');
		expect(replayNodes.every(node => !!node.importedEdits),
			'every replay node needs its reconstruction');
		expect(replayNodes.some(node => !!node.replayActions?.length),
			'expected the replay actions the Action Summary is built from');
		step('replay nodes keep their reconstruction and actions');

		/*
		 * The round trip that matters for a replay: the spliced history has to come back. A reopened node
		 * reads as the real replay only because `source.log` was carried, so this is the assertion that
		 * would catch dropping it — the position would still be right.
		 */
		const before = await linesSummary(page);
		await goHome(page);
		await importAnalysis(page, file);
		await waitForDecision(page);
		expect(await linesSummary(page) === before,
			`a reopened replay import should show the same Lines:\n  before: ${before}\n  after:  ${await linesSummary(page)}`);
		/*
		 * The replay's own trainers are the tell: a position rebuilt without `source.log` opens on a fresh
		 * battle, whose players the server names "Analysis 1" and "Analysis 2". A turn-1 node shows the
		 * history *before* turn 1, so there is no move in it yet — hence the step to Turn 2 below.
		 */
		const openingLog = await battleLogText(page);
		expect(/Alice/.test(openingLog) && /Bob/.test(openingLog),
			`the reopened log should name the replay's trainers, got: ${openingLog.slice(0, 200)}`);
		expect(!/Analysis 1/.test(openingLog),
			`the reopened log should be the replay, not a fresh battle: ${openingLog.slice(0, 200)}`);
		await clickButton(page, 'Next Turn');
		await waitForDecision(page);
		await waitFor(page, () => /Body Slam/.test(
			[...document.querySelectorAll('.battle-log .inner div')].map(div => div.textContent).join(' | ')
		), "turn 1's move in the spliced history");
		step('a reopened replay import still plays the real history');
	} catch (error) {
		await dumpFailure(page, 'export-replay');
		throw error;
	} finally {
		await browser.close();
	}
	if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
}

/**
 * A file the importer should refuse, and say why. The point is that it is refused **before** anything is
 * opened: a half-built tab left behind by a bad file is worse than the error.
 */
async function badFile() {
	const { browser, page, errors } = await openAnalysisPage([]);
	try {
		await clickButton(page, 'Import Analysis');
		const target = path.join(os.tmpdir(), `analysis-bad-test-${Date.now()}.json`);
		// valid JSON, right shape, but its current node is not among its nodes
		fs.writeFileSync(target, JSON.stringify({
			schema: 1,
			createdWith: { serverCommit: '' },
			tab: {
				title: 'Broken', format: 'gen9ou', team1: 'x', team2: 'y', rootSeed: '1,2,3,4',
				currentNodeId: 'missing', simulationCount: 1000,
				nodes: { 'node-1': { id: 'node-1', parentId: null, seed: null, turn: 1, inputLog: [] } },
			},
		}));
		try {
			const input = await page.waitForSelector('.analysis-form input[type="file"]', { timeout: 20000 });
			await input.uploadFile(target);
			await waitFor(page, () => /current node is missing/.test(
				document.querySelector('.analysis-form')?.textContent || ''
			), 'the validation error');
		} finally {
			fs.rmSync(target, { force: true });
		}
		const state = await page.evaluate(() => ({
			openDisabled: [...document.querySelectorAll('.analysis-form button')]
				.find(button => /Open Analysis/.test(button.textContent))?.disabled,
			// the header's own class: an open analysis is a closable room tab, Home is not
			tabs: document.querySelectorAll('.roomtab.closable').length,
		}));
		expect(state.openDisabled === true, 'Open Analysis should stay disabled for a file that failed to read');
		expect(!state.tabs, `a refused file should open no tab, saw ${state.tabs}`);
		step('a broken analysis file is refused with a reason, and opens nothing');
	} catch (error) {
		await dumpFailure(page, 'export-bad-file');
		throw error;
	} finally {
		await browser.close();
	}
	if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
}

async function main() {
	await checkServers();
	await fromTeams();
	await fromReplay();
	await badFile();
	console.log('PASS');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
