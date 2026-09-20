'use strict';
/**
 * Turn-event summaries (analysis-turn-events.tsx) from hand-written protocol logs, run inside the real page.
 * Deterministic: doesn't depend on battle RNG. Checks switch reasons shown as "Switched to X (reason)".
 * Usage and prerequisites: see README.md in this folder.
 */
const { step, checkServers, openAnalysisPage } = require('./lib');

const CASES = [
	{
		name: 'chosen switch has no reason',
		log: ['|switch|p1a: Pikachu|Pikachu, L50|100/100', '|move|p2a: Blissey|Soft-Boiled|p2a: Blissey'],
		expect: [['switch', 'p1', undefined]],
	},
	{
		name: 'U-turn replacement',
		log: [
			'|move|p1a: Scizor|U-turn|p2a: Blissey', '|-damage|p2a: Blissey|90/100',
			'|switch|p1a: Pikachu|Pikachu, L50|100/100',
		],
		expect: [['switch', 'p1', 'U-turn']],
	},
	{
		name: 'Eject Button replacement (and no switch for the attacker)',
		log: [
			'|move|p1a: Scizor|U-turn|p2a: Blissey', '|-damage|p2a: Blissey|90/100',
			'|-enditem|p2a: Blissey|Eject Button', '|switch|p2a: Chansey|Chansey, F|100/100',
		],
		expect: [['switch', 'p2', 'Eject Button']],
	},
	{
		name: 'faint replacement',
		log: [
			'|move|p1a: Mewtwo|Psystrike|p2a: Golisopod', '|-damage|p2a: Golisopod|0 fnt', '|faint|p2a: Golisopod',
			'|upkeep', '|switch|p2a: Magikarp|Magikarp, M|100/100',
		],
		expect: [['switch', 'p2', 'Fainted']],
	},
	{
		name: 'fainted pivot user is replaced for fainting, not U-turn',
		log: [
			'|move|p1a: Scizor|U-turn|p2a: Ferrothorn', '|-damage|p2a: Ferrothorn|95/100',
			'|-damage|p1a: Scizor|0 fnt|[from] item: Rocky Helmet|[of] p2a: Ferrothorn', '|faint|p1a: Scizor',
			'|upkeep', '|switch|p1a: Pikachu|Pikachu, L50|100/100',
		],
		expect: [['switch', 'p1', 'Fainted']],
	},
	{
		name: 'Dragon Tail drag',
		log: [
			'|move|p1a: Garchomp|Dragon Tail|p2a: Blissey', '|-damage|p2a: Blissey|80/100',
			'|drag|p2a: Chansey|Chansey, F|100/100',
		],
		expect: [['switch', 'p2', 'Dragon Tail']],
	},
	{
		name: 'Red Card drag',
		log: [
			'|move|p1a: Garchomp|Earthquake|p2a: Blissey', '|-damage|p2a: Blissey|60/100',
			'|-enditem|p2a: Blissey|Red Card|[of] p1a: Garchomp', '|drag|p1a: Pikachu|Pikachu, L50|100/100',
		],
		expect: [['switch', 'p1', 'Red Card']],
	},
	{
		name: 'Emergency Exit',
		log: [
			'|move|p1a: Mewtwo|Tackle|p2a: Golisopod', '|-damage|p2a: Golisopod|40/100',
			'|-activate|p2a: Golisopod|ability: Emergency Exit', '|switch|p2a: Magikarp|Magikarp, M|100/100',
		],
		expect: [['switch', 'p2', 'Emergency Exit']],
	},
	{
		name: 'chosen switch then a pivot in the same turn',
		log: [
			'|switch|p2a: Chansey|Chansey, F|100/100', '|move|p1a: Scizor|U-turn|p2a: Chansey',
			'|-damage|p2a: Chansey|90/100', '|switch|p1a: Pikachu|Pikachu, L50|100/100',
		],
		expect: [['switch', 'p2', undefined], ['switch', 'p1', 'U-turn']],
	},
];

async function main() {
	await checkServers();
	const { browser, page, errors } = await openAnalysisPage([]);
	let failures = 0;
	try {
		for (const testCase of CASES) {
			const result = await page.evaluate(log => ({
				actions: getTurnEventSummary({ log, turnLog: log }),
				html: (() => {
					const container = document.createElement('div');
					preact.render(preact.h(AnalysisTurnEventSummaryView, { actions: getTurnEventSummary({ log, turnLog: log }) }), container);
					return container.textContent;
				})(),
			}), testCase.log);
			const switches = result.actions.filter(action => action.type === 'switch')
				.map(action => [action.type, `p${action.side}`, action.reason]);
			const ok = JSON.stringify(switches) === JSON.stringify(testCase.expect.map(([type, side, reason]) => [type, side, reason])) &&
				testCase.expect.every(([, , reason]) => !reason || result.html.includes(`(${reason})`));
			if (!ok) {
				failures++;
				console.log(`FAIL ${testCase.name}: got ${JSON.stringify(switches)}; text: ${result.html}`);
			} else {
				step(`${testCase.name}: ${result.html.trim().replace(/\s+/g, ' ')}`);
			}
		}
		if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
		console.log(failures ? `FAIL: ${failures} case(s)` : 'PASS');
		if (failures) process.exitCode = 1;
	} catch (error) {
		console.log(`FAIL: ${error.message}`);
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

main().catch(error => {
	console.log(`FAIL: ${error.message}`);
	process.exitCode = 1;
});
