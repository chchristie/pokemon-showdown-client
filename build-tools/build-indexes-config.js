'use strict';

/**
 * DigiPen fork: which server repo and branch `build-indexes` builds the client data from.
 *
 * The values live in the gitignored `build-indexes-config` next to this file (copy
 * `build-indexes-config.example`), so pointing the build at a feature branch or at a different
 * fork does not mean editing a tracked file. There is no default: without that file the build
 * stops, rather than silently indexing someone else's server.
 *
 * The config must stay untracked. A fork that commits its own — by renaming the example instead of
 * copying it, or by `git add -f` — turns it into a normal tracked file, and merging that back
 * deletes the example and overwrites everyone else's local values. The build refuses to run in that
 * state so it is caught in the fork rather than in a pull request.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'build-indexes-config';
const CONFIG_EXAMPLE = 'build-indexes-config.example';
const COPY_HINT =
	`Copy build-tools/${CONFIG_EXAMPLE} to build-tools/${CONFIG_FILE} and set "repo" to your ` +
	`server fork's clone URL and "branch" to the branch the client should build from.\n` +
	`It is gitignored, so it stays local to your checkout.`;

function fail(message, hint = COPY_HINT) {
	console.error(`\n${message}\n${hint}\n`);
	process.exit(1);
}

/** Tracked by git? False when it isn't, and when git or the repo is unavailable. */
function isTrackedByGit(configPath) {
	try {
		childProcess.execFileSync('git', ['ls-files', '--error-unmatch', configPath], {
			cwd: __dirname,
			stdio: 'ignore',
		});
		return true;
	} catch {
		return false;
	}
}

/** @return {{repo: string, branch: string}} */
function loadServerRepoConfig() {
	const configPath = path.join(__dirname, CONFIG_FILE);
	if (!fs.existsSync(configPath)) fail(`Missing build-tools/${CONFIG_FILE}.`);

	if (isTrackedByGit(configPath)) {
		fail(
			`build-tools/${CONFIG_FILE} is committed to git, and it must not be.`,
			`It holds settings local to one checkout, so committing it makes every clone fight over ` +
			`them, and merging that commit into another fork overwrites its values.\n` +
			`Untrack it with: git rm --cached build-tools/${CONFIG_FILE}\n` +
			`Then restore build-tools/${CONFIG_EXAMPLE} if the commit renamed it, and copy it instead.`
		);
	}

	let config;
	try {
		config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	} catch (err) {
		fail(`build-tools/${CONFIG_FILE} is not valid JSON: ${err.message}`);
	}
	for (const key of ['repo', 'branch']) {
		if (typeof config[key] !== 'string' || !config[key].trim()) {
			fail(`build-tools/${CONFIG_FILE} must set "${key}" to a non-empty string.`);
		}
	}
	return { repo: config.repo.trim(), branch: config.branch.trim() };
}

exports.CONFIG_FILE = CONFIG_FILE;
exports.CONFIG_EXAMPLE = CONFIG_EXAMPLE;
exports.loadServerRepoConfig = loadServerRepoConfig;
