'use strict';
/**
 * Helpers for driving the analysis page in headless Chrome (puppeteer-core).
 * See README.md in this folder. Scenarios (e.g. smoke.js) build on these.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const OUTPUT_DIR = path.join(__dirname, 'output');

const config = {
	/** where `node start-analysis` serves the client (client repo root on 8081) */
	pageURL: process.env.ANALYSIS_URL || 'http://localhost:8081/analysis.pokemonshowdown.com/',
	/** host:port of the analysis API (`?~~host:port` on the page) */
	api: process.env.ANALYSIS_API || 'localhost:8002',
	headful: process.env.HEADFUL === '1',
	chromePath: process.env.CHROME_PATH || [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
	].find(candidate => fs.existsSync(candidate)),
};

/**
 * Packed test team (gen9ou-legal): Garchomp (Earthquake, Dragon Tail, Stealth Rock, Spikes),
 * Rotom-Wash (Hydro Pump, Volt Switch, Will-O-Wisp, Protect),
 * Kingambit (Kowtow Cleave, Sucker Punch, Iron Head, Swords Dance).
 */
const SMOKE_TEAM = 'Garchomp||RockyHelmet|RoughSkin|earthquake,dragontail,stealthrock,spikes|Jolly|252,,4,,,252|||||]' +
	'Rotom-Wash||Leftovers|Levitate|hydropump,voltswitch,willowisp,protect|Bold|252,,252,,4,|||||]' +
	'Kingambit||BlackGlasses|SupremeOverlord|kowtowcleave,suckerpunch,ironhead,swordsdance|Adamant|252,252,,,4,|||||';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const step = message => console.log(`- ${message}`);

/** Fails fast with a useful message if the client or API isn't running. */
async function checkServers() {
	const problems = [];
	try {
		const response = await fetch(config.pageURL);
		if (!response.ok) problems.push(`client page returned HTTP ${response.status}: ${config.pageURL}`);
	} catch (error) {
		problems.push(`client page unreachable: ${config.pageURL} (${error.message})`);
	}
	try {
		// an empty request is rejected with 400, which proves the API is up
		const response = await fetch(`http://${config.api}/analysis/start`, { method: 'POST', body: '{}' });
		if (response.status !== 400) problems.push(`analysis API returned unexpected HTTP ${response.status}`);
	} catch (error) {
		problems.push(`analysis API unreachable at ${config.api} (${error.message})`);
	}
	if (problems.length) {
		throw new Error(`${problems.join('\n')}\nStart both with: cd pokemon-showdown && node start-analysis`);
	}
}

/** Launches Chrome and opens the analysis page with the given teams in localStorage. */
async function openAnalysisPage(teams) {
	if (!config.chromePath) throw new Error('Chrome not found; set CHROME_PATH to a Chrome/Chromium executable.');
	const browser = await puppeteer.launch({
		executablePath: config.chromePath,
		headless: !config.headful,
		args: ['--no-sandbox'],
	});
	const page = await browser.newPage();
	await page.setViewport({ width: 1500, height: 950 });
	const errors = [];
	page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
	page.on('console', message => {
		// resource failures are reported with URLs by the 'response' listener below
		if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
			errors.push(`console: ${message.text()}`);
		}
	});
	page.on('response', response => {
		// pokedex-mini*.js are expected to 404 locally; the page falls back to the official copies
		if (response.status() >= 400 && !/pokedex-mini/.test(response.url())) {
			errors.push(`http ${response.status()}: ${response.url()}`);
		}
	});

	await page.goto(config.pageURL, { waitUntil: 'domcontentloaded' });
	await page.evaluate(storedTeams => {
		localStorage.setItem('showdown_teams', storedTeams.map(team => `${team.format}]${team.name}|${team.packed}`).join('\n'));
	}, teams);
	await page.goto(`${config.pageURL}?~~${config.api}`, { waitUntil: 'networkidle2' });
	return { browser, page, errors };
}

/** Clicks the first visible, enabled button whose text contains `text`. */
async function clickButton(page, text, timeout = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const clicked = await page.evaluate(buttonText => {
			const button = [...document.querySelectorAll('button')].find(candidate =>
				!candidate.disabled && candidate.offsetParent !== null &&
				candidate.textContent.replace(/\s+/g, ' ').trim().includes(buttonText));
			if (!button) return false;
			// some analysis buttons listen for mouseup (team preview), others for click
			button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
			button.click();
			return true;
		}, text);
		if (clicked) return;
		await sleep(150);
	}
	throw new Error(`Button not found or not enabled: "${text}"`);
}

/** Polls a function evaluated in the page until it returns truthy. */
async function waitFor(page, fn, label, timeout = 30000, ...args) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await page.evaluate(fn, ...args)) return;
		await sleep(150);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function battleControlsText(page) {
	return page.evaluate(() => document.querySelector('.battle-controls')?.textContent || '');
}

function linesText(page) {
	return page.evaluate(() => document.querySelector('.analysis-node-tree')?.textContent || '');
}

/**
 * Waits until the controls show `readyText`, clicking "Skip Turn" through turn animations and
 * submitting end-of-turn faint replacements (first available Pokémon) if random rolls cause a KO.
 * Returns how many times replacements were submitted.
 *
 * NOTE: right after clicking Submit Choices, the controls still show the previous decision's text for a
 * moment, so this would return immediately. First wait for something that proves the request finished
 * (e.g. the new Turn node in Lines), then call this. When the turn can end in a faint, the new node only
 * appears after replacements, so wait for a different signal (e.g. the controls changing) instead.
 */
async function waitForDecision(page, readyText = 'Click on an active', timeout = 60000) {
	const start = Date.now();
	let replacements = 0;
	while (Date.now() - start < timeout) {
		const state = await page.evaluate(ready => {
			const text = document.querySelector('.battle-controls')?.textContent || '';
			if ([...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Skip Turn')) return 'skip';
			if (text.includes(ready)) return 'ready';
			if (text.includes('Choose replacement')) return 'faint';
			return 'wait';
		}, readyText);
		if (state === 'ready') return replacements;
		if (state === 'skip') await clickButton(page, 'Skip Turn', 2000).catch(() => {});
		if (state === 'faint') {
			await page.evaluate(() => {
				for (const menu of document.querySelectorAll('.switchcontrols .switchmenu')) {
					[...menu.querySelectorAll('button')].find(button => !button.disabled)?.click();
				}
			});
			await clickButton(page, 'Submit replacements');
			replacements++;
		}
		await sleep(250);
	}
	throw new Error(`Timed out waiting for "${readyText}" (controls: ${(await battleControlsText(page)).slice(0, 200)})`);
}

/**
 * Home page -> New Analysis From Teams -> (optional format) -> Start Analysis.
 * Teams for `format` must already be in localStorage (see openAnalysisPage).
 */
async function startAnalysisFromTeams(page, format) {
	await clickButton(page, 'New Analysis From Teams');
	if (format) {
		await page.evaluate(formatId => {
			const select = document.querySelector('select.formatselect');
			select.value = formatId;
			select.dispatchEvent(new Event('change', { bubbles: true }));
		}, format);
	}
	await clickButton(page, 'Start Analysis');
}

/**
 * Team preview: picks leads by team index (0-based) and sends them out. Pass a number for one lead
 * (singles) or an array for several (e.g. doubles picks two).
 */
async function selectLeads(page, p1Leads, p2Leads) {
	await waitFor(page, () => document.body.textContent.includes('Choose Pokémon'), 'team preview');
	for (const [side, leads] of [[0, p1Leads], [1, p2Leads]]) {
		for (const lead of [].concat(leads)) {
			await page.evaluate((sideIndex, leadIndex) => {
				const menu = document.querySelectorAll('.switchcontrols .switchmenu')[sideIndex];
				menu.querySelectorAll('button')[leadIndex].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
			}, side, lead);
			await sleep(200);
		}
	}
	await clickButton(page, 'Send out Pokémon');
}

/**
 * Clicks side `sideIndex`'s (0 = p1) first active Pokémon in the battle to open its action menu.
 * Retries, because clicks are ignored while a turn animation is still finishing.
 */
async function openActionMenu(page, sideIndex, timeout = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const opened = await page.evaluate(n => {
			if (document.querySelector('.movemenu button')) return true;
			const active = [...document.querySelectorAll(`.battle [data-tooltip^="analysispokemon|${n}|"]`)]
				.find(element => !element.classList.contains('picon'));
			active?.click();
			return !!document.querySelector('.movemenu button');
		}, sideIndex);
		if (opened) return;
		await sleep(250);
	}
	throw new Error(`Timed out opening the action menu for side ${sideIndex}`);
}

/** Chooses move slot `moveIndex` (0-based) for side `sideIndex`'s first active Pokémon (singles). */
async function chooseMove(page, sideIndex, moveIndex) {
	await openActionMenu(page, sideIndex);
	await page.evaluate(index => document.querySelectorAll('.movemenu button')[index].click(), moveIndex);
	await waitFor(page, () => !document.querySelector('.movemenu'), 'move menu to close');
	await sleep(200);
}

/**
 * Hovers the `index`th element matching `selector` (optionally only those whose text includes `text`)
 * and returns the visible tooltip's text and HTML once `until(text)` is true (or null on timeout).
 */
async function hoverTooltip(page, selector, { text, index = 0, until = () => true, timeout = 15000 } = {}) {
	await page.mouse.move(0, 0);
	const handles = await page.$$(selector);
	const matches = [];
	for (const handle of handles) {
		const content = await handle.evaluate(element => element.textContent);
		if (!text || content.includes(text)) matches.push(handle);
	}
	if (!matches[index]) throw new Error(`No element to hover: ${selector}${text ? ` containing "${text}"` : ''}`);
	await matches[index].hover();
	const start = Date.now();
	let tooltip = null;
	while (Date.now() - start < timeout) {
		tooltip = await page.evaluate(() => {
			const wrapper = document.querySelector('#tooltipwrapper');
			return wrapper?.textContent ? { text: wrapper.textContent, html: wrapper.innerHTML } : null;
		});
		if (tooltip && until(tooltip.text)) return tooltip;
		await sleep(150);
	}
	return tooltip && until(tooltip.text) ? tooltip : null;
}

/** Number of damage calc lines in a tooltip's HTML (see analysis-tooltips.ts). */
function calcLineCount(tooltipHTML) {
	const match = /<p class="tooltip-section analysis-calc-lines">([\s\S]*?)<\/p>/.exec(tooltipHTML || '');
	return match ? match[1].split('<br>').length : 0;
}

/** Prints page state and saves a screenshot to output/ for debugging a failure. */
async function dumpFailure(page, name = 'failure') {
	if (!page) return;
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	const state = await page.evaluate(() => ({
		controls: document.querySelector('.battle-controls')?.textContent.replace(/\s+/g, ' ').slice(0, 300),
		lines: document.querySelector('.analysis-node-tree')?.textContent.replace(/\s+/g, ' ').slice(0, 400),
		error: document.querySelector('.message-error')?.textContent,
		recentLog: [...document.querySelectorAll('.battle-log .inner div')].slice(-12).map(div => div.textContent).join(' | '),
	})).catch(error => ({ evaluateError: error.message }));
	console.log(JSON.stringify(state, null, 1));
	const file = path.join(OUTPUT_DIR, `${name}.png`);
	await page.screenshot({ path: file }).catch(() => {});
	console.log(`screenshot: ${file}`);
}

module.exports = {
	config, SMOKE_TEAM, OUTPUT_DIR, sleep, step, checkServers, openAnalysisPage, clickButton, waitFor,
	battleControlsText, linesText, waitForDecision, startAnalysisFromTeams, selectLeads, openActionMenu, chooseMove,
	hoverTooltip, calcLineCount, dumpFailure,
};
