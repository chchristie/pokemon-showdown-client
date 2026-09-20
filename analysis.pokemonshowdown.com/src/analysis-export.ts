import { toID } from '../../play.pokemonshowdown.com/src/battle-dex';
import { formatDisplayName, type AnalysisNode, type AnalysisTab } from './analysis-model';

/**
 * Exporting an analysis to a file (docs/analysis/plan.md, Phase 6).
 *
 * **The file is a recipe, not a set of positions.** It carries what cannot be rebuilt — the teams, the
 * root seed, and per node the seed, the edits and the choices — and nothing that the server regenerates
 * from those. Rebuilding an imported analysis is then the same `/analysis/start` call that selecting a
 * node already makes, so an import has no second reconstruction path to keep correct.
 *
 * That is also the format's one real risk, and why `createdWith.serverCommit` is recorded: a seed only
 * replays the same way under the same sim and mod code, so an upstream merge or a fakemon change can make
 * the same file rebuild into a different position, silently. The importer compares the commit and warns.
 *
 * **What is deliberately left out** is *tab* state, because `/analysis/start` returns it: `log`, `snapshot`,
 * `requests`, `requestState`, `editOptions`, `gameType` and `droppedEdits`. Simulation results are left out
 * too — a Monte Carlo grouping dwarfs the rest of the file and is only valid for the sim that produced it.
 * **Nodes are stored whole**; see `AnalysisExportNode` for why their summaries have to be.
 *
 * **The imported replay's log is the one exception.** It is kept, in `source`, because it is the only part
 * of the display no rebuild can reproduce: node data holds the position and the actions, but not the
 * replay's narration, and without it every node opens on a fresh battle's leads instead of the real game
 * (see `getReplaySplice`). A tab that was not imported from a replay has no `source` block at all.
 */

/** Bumped when a change would stop an older importer reading a newer file. */
export const ANALYSIS_EXPORT_SCHEMA = 1;

/**
 * A node as it is written to a file: **the whole node**.
 *
 * An earlier version dropped the summary fields (`choiceSummary`, `teamSelectionSummary`, `editSummary`,
 * `teamSummary`, `turnEventSummary`) as derived display data. That was wrong, and it shipped a visible bug:
 * they are computed **once**, when the turn is played, the edits are applied or the simulation is chosen,
 * and a rebuild does not recompute them. `restoreAnalysisNode` refreshes only the node it is restoring, so
 * an import without them showed a correct current node and blank Lines buttons everywhere else — icons
 * missing, because a missing summary still renders its empty cells.
 *
 * They cannot be recomputed from the file either: a played node's summary needs the battle state at that
 * node, which means rebuilding every node on import. They are small next to `importedEdits` and the replay
 * log, so the node is stored as it stands.
 */
export type AnalysisExportNode = AnalysisNode;

export interface AnalysisExport {
	schema: number;
	exportedAt: string;
	/** what produced the file, so an import can warn when the sim has moved on; may be empty */
	createdWith: { serverCommit: string };
	tab: {
		title: string,
		format: string,
		formatName?: string,
		players?: { p1: string, p2: string },
		team1: string,
		team2: string,
		sandbox?: boolean,
		rootSeed: string,
		simulationCount: number,
		currentNodeId: string,
		nodes: Record<string, AnalysisExportNode>,
	};
	/** present only for a tab imported from a replay */
	source?: { type: 'replay', log: string[] };
}

/** A shallow copy per node, so a file and the tab it came from can't reach into each other. */
function copyNodes(nodes: Record<string, AnalysisNode>): Record<string, AnalysisNode> {
	const copy: Record<string, AnalysisNode> = {};
	for (const [id, node] of Object.entries(nodes)) copy[id] = { ...node };
	return copy;
}

export function buildAnalysisExport(tab: AnalysisTab, serverCommit: string, now = new Date()): AnalysisExport {
	const nodes = copyNodes(tab.nodes);
	return {
		schema: ANALYSIS_EXPORT_SCHEMA,
		exportedAt: now.toISOString(),
		createdWith: { serverCommit },
		tab: {
			title: tab.title,
			format: tab.format,
			formatName: tab.formatName,
			players: tab.players,
			team1: tab.team1,
			team2: tab.team2,
			sandbox: tab.sandbox,
			rootSeed: tab.rootSeed,
			simulationCount: tab.simulationCount,
			currentNodeId: tab.currentNodeId,
			nodes,
		},
		...(tab.replayLog?.length ? { source: { type: 'replay' as const, log: tab.replayLog } } : {}),
	};
}

/*********************************************************
 * Import
 *********************************************************/

function fail(message: string): never {
	throw new Error(message);
}

function requireString(value: any, what: string) {
	// `fail` returns never, so the guard already narrows this to string
	if (typeof value !== 'string' || !value) fail(`This analysis file has no ${what}.`);
	return value;
}

/**
 * Reads a file's text into an `AnalysisExport`, or throws a message worth showing the user.
 *
 * Validation is deliberately about **what the rebuild will dereference** — the teams and seed it is built
 * from, and a node graph whose parent links all resolve — rather than a full schema check. A file that
 * passes here can be handed to `/analysis/start` without the reconstruction walking off the end of
 * something; a file that fails says which part is wrong instead of throwing from inside the rebuild.
 */
export function parseAnalysisExport(text: string): AnalysisExport {
	let file: any;
	try {
		file = JSON.parse(text);
	} catch {
		fail("That file isn't valid JSON, so it isn't an exported analysis.");
	}
	if (!file || typeof file !== 'object') fail("That file isn't an exported analysis.");
	if (typeof file.schema !== 'number') fail("That file isn't an exported analysis (no schema).");
	if (file.schema > ANALYSIS_EXPORT_SCHEMA) {
		fail(`This file was saved by a newer version of the analysis tool (schema ${file.schema}, this ` +
			`reads ${ANALYSIS_EXPORT_SCHEMA}).`);
	}
	const tab = file.tab;
	if (!tab || typeof tab !== 'object') fail('This analysis file has no tab data.');
	requireString(tab.format, 'format');
	requireString(tab.team1, 'team for side 1');
	requireString(tab.team2, 'team for side 2');
	requireString(tab.rootSeed, 'root seed');
	const currentNodeId = requireString(tab.currentNodeId, 'current node');
	if (!tab.nodes || typeof tab.nodes !== 'object') fail('This analysis file has no nodes.');
	const nodes = tab.nodes as Record<string, any>;
	const ids = Object.keys(nodes);
	if (!ids.length) fail('This analysis file has no nodes.');
	if (!nodes[currentNodeId]) fail("This analysis file's current node is missing from its nodes.");
	for (const id of ids) {
		const node = nodes[id];
		if (!node || typeof node !== 'object') fail(`Node ${id} is not readable.`);
		if (typeof node.turn !== 'number') fail(`Node ${id} has no turn number.`);
		if (!Array.isArray(node.inputLog)) fail(`Node ${id} has no choices.`);
		// A parent that isn't here would make `pathFromLastReplayNode` walk off the end of the tree.
		if (node.parentId !== null && node.parentId !== undefined && !nodes[node.parentId]) {
			fail(`Node ${id} names a parent that isn't in the file.`);
		}
	}
	if (file.source && (file.source.type !== 'replay' || !Array.isArray(file.source.log))) {
		fail("This analysis file's replay source is not readable.");
	}
	return file as AnalysisExport;
}

/**
 * The message shown when a file was saved under a different build, or the empty string when there is
 * nothing to say.
 *
 * It is a *possible*-divergence warning and says so: nothing here checks whether the sim actually changed
 * in a way that matters, only that it is not the same code. Saying nothing when either commit is unknown
 * is deliberate — a warning that fires on every file from a server without git would train the user to
 * ignore it.
 */
export function stalenessWarning(file: AnalysisExport, serverCommit: string) {
	const saved = file.createdWith?.serverCommit || '';
	if (!saved || !serverCommit || saved === serverCommit) return '';
	return `This analysis was saved under a different server build (${saved.slice(0, 9)}; this server is ` +
		`${serverCommit.slice(0, 9)}). Positions rebuild from seeds, so simulated turns may differ from ` +
		`what you saw when you saved it.`;
}

/**
 * The tab an imported file opens as. It has no position yet: every field the server owns is filled in by
 * the caller's `restoreAnalysisNode`, which is the same rebuild selecting a node already does.
 */
export function tabFromAnalysisExport(file: AnalysisExport, id: string): AnalysisTab {
	const { tab } = file;
	return {
		id,
		title: tab.title || 'Imported analysis',
		format: tab.format,
		formatName: tab.formatName,
		players: tab.players,
		log: [],
		team1: tab.team1,
		team2: tab.team2,
		sandbox: tab.sandbox,
		/*
		 * A sandbox tab shows its "click a placeholder" intro instead of the controls until the teambuilder
		 * has been opened — which means Export was unreachable before that, so an imported sandbox tab is
		 * always past it. Starting one back at the intro would hide the turn controls on a built position.
		 */
		sandboxIntroDone: !!tab.sandbox,
		replayLog: file.source?.log,
		phase: 'default',
		// copied, so editing the reopened analysis can't mutate the parsed file
		nodes: copyNodes(tab.nodes),
		currentNodeId: tab.currentNodeId,
		rootSeed: tab.rootSeed,
		simulationCount: tab.simulationCount || 1000,
	};
}

/*********************************************************
 * Filenames
 *********************************************************/

/** `[Gen 9] OU` → `Gen9OU`, as the client's own Download Replay button builds its filename. */
function formatToken(tab: AnalysisTab) {
	const name = formatDisplayName(tab.format, tab.formatName);
	return (name || 'Analysis').replace(/[^A-Za-z0-9]/g, '') || 'Analysis';
}

/** Zero-padded by hand, as the client's Download Replay button does: the page targets pre-ES2017. */
function dateToken(date: Date) {
	const month = `${date.getMonth() >= 9 ? '' : '0'}${date.getMonth() + 1}`;
	const day = `${date.getDate() >= 10 ? '' : '0'}${date.getDate()}`;
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * `Gen9OU-2026-09-19-analysis.json`, or `Gen9OU-2026-09-19-geckonavajo-felipodi-analysis.json` when the
 * analysis came from a replay that named both trainers (user request, 2026-09-19).
 *
 * The date is the day of **export**, matching the Download Replay button; a replay log carries no reliable
 * date of its own.
 */
export function analysisExportFilename(tab: AnalysisTab, now = new Date()) {
	const trainers = tab.players ?
		[toID(tab.players.p1), toID(tab.players.p2)].filter(Boolean) : [];
	return [formatToken(tab), dateToken(now), ...trainers, 'analysis'].join('-') + '.json';
}

/**
 * Hands the file to the browser. This is an ordinary page, so an object URL on a generated `<a download>`
 * is all it takes; the link is never added to the document, which keeps it out of the rendered tree.
 */
export function downloadAnalysisExport(tab: AnalysisTab, serverCommit: string, now = new Date()) {
	const contents = JSON.stringify(buildAnalysisExport(tab, serverCommit, now), null, '\t');
	const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = analysisExportFilename(tab, now);
	link.click();
	/*
	 * The object URL pins the blob in memory until it is let go, but revoking it in the same tick as the
	 * click can cancel the download before the browser has read it. Yielding first is the usual fix, and
	 * costs nothing here.
	 */
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
