/**
 * The analysis tool's cross-origin team bridge (`play.pokemonshowdown.com/analysis-teams.html`).
 * Fork-owned: the analysis tool isn't part of upstream.
 *
 * The page hands this origin's saved teams to the analysis tool on another host, so the only thing that
 * really matters about it is **who it will hand them to**. That check is a dozen lines of inline script in
 * an HTML file, which no browser suite can reach — the local dev server serves both apps from one origin,
 * so the bridge is never loaded there at all, and a faithful end-to-end test needs the two real hosts.
 *
 * So the script is lifted out and run in a `vm` context with a stubbed `location`, `localStorage` and
 * `parent.postMessage`, the way `battle-choices.test.js` runs the compiled client. That makes every
 * allow/refuse decision testable without a browser, which is the half that would be a security bug.
 */
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const vm = require('vm');

const BRIDGE = path.resolve(__dirname, '../play.pokemonshowdown.com/analysis-teams.html');
const html = fs.readFileSync(BRIDGE, 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

/**
 * Runs the bridge once and returns what it posted, or null.
 *
 * `storage` may be a function, which is how the "localStorage throws" case is expressed — some privacy
 * modes throw on access rather than returning null.
 */
function runBridge({ href, target, storage = {}, framed = true }) {
	const url = new URL(href);
	const posted = [];
	const sandbox = {
		location: {
			protocol: url.protocol,
			hostname: url.hostname,
			origin: url.origin,
			search: target === undefined ? '' : `?origin=${encodeURIComponent(target)}`,
		},
		localStorage: {
			getItem(key) {
				if (typeof storage === 'function') return storage(key);
				return key in storage ? storage[key] : null;
			},
		},
	};
	sandbox.window = sandbox;
	sandbox.window.parent = framed ?
		{ postMessage: (data, origin) => posted.push({ data, origin }) } :
		sandbox.window;
	vm.runInNewContext(script, sandbox, { filename: BRIDGE });
	return posted.length ? posted[0] : null;
}

const PLAY = 'https://play.digipenshowdown.dynv6.net/analysis-teams.html';
const ANALYSIS = 'https://analysis.digipenshowdown.dynv6.net';
const TEAMS = 'gen9ou]Test|Garchomp||Leftovers|RoughSkin|earthquake|Jolly|||||';

describe('analysis team bridge', () => {
	it('should hand the teams to the analysis host derived from this one', () => {
		const posted = runBridge({ href: PLAY, target: ANALYSIS, storage: { showdown_teams: TEAMS } });
		assert.deepEqual(posted, { data: `t${TEAMS}`, origin: ANALYSIS });
	});

	it('should fall back to showdown_teams_local', () => {
		const posted = runBridge({ href: PLAY, target: ANALYSIS, storage: { showdown_teams_local: TEAMS } });
		assert.equal(posted.data, `t${TEAMS}`);
	});

	it('should refuse an origin it did not derive', () => {
		for (const target of [
			'https://evil.example.com',
			// a near miss: the right shape on somebody else's domain
			'https://analysis.digipenshowdown.dynv6.net.evil.example.com',
			// the right name over plain http, when this page is https
			'http://analysis.digipenshowdown.dynv6.net',
			// a different subdomain of the same site is still not the analysis tool
			'https://dex.digipenshowdown.dynv6.net',
		]) {
			assert.equal(runBridge({ href: PLAY, target, storage: { showdown_teams: TEAMS } }), null,
				`should not have posted the teams to ${target}`);
		}
	});

	it('should post nothing when no origin is claimed', () => {
		assert.equal(runBridge({ href: PLAY, target: undefined, storage: { showdown_teams: TEAMS } }), null);
	});

	it('should post nothing when it is not in a frame', () => {
		assert.equal(
			runBridge({ href: PLAY, target: ANALYSIS, storage: { showdown_teams: TEAMS }, framed: false }), null
		);
	});

	it('should allow its own origin, so a same-origin check still works', () => {
		const posted = runBridge({
			href: PLAY, target: 'https://play.digipenshowdown.dynv6.net', storage: { showdown_teams: TEAMS },
		});
		assert.equal(posted.origin, 'https://play.digipenshowdown.dynv6.net');
	});

	it('should derive nothing from a bare hostname, so localhost grants only itself', () => {
		assert.equal(runBridge({
			href: 'http://localhost:8081/analysis-teams.html', target: 'http://analysis.localhost:8081',
			storage: { showdown_teams: TEAMS },
		}), null);
		assert.ok(runBridge({
			href: 'http://localhost:8081/analysis-teams.html', target: 'http://localhost:8081',
			storage: { showdown_teams: TEAMS },
		}));
	});

	it('should answer with an empty payload when storage throws, rather than going quiet', () => {
		const posted = runBridge({
			href: PLAY, target: ANALYSIS, storage: () => { throw new Error('storage is blocked'); },
		});
		// the caller waits on a message; silence would mean it sat there until its own timeout
		assert.deepEqual(posted, { data: 't', origin: ANALYSIS });
	});
});
