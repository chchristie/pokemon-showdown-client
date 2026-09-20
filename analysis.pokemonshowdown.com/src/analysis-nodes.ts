import type { AnalysisNode, AnalysisReplayRecord, AnalysisTab } from './analysis-model';

export function getNodePath(tab: AnalysisTab, nodeId = tab.currentNodeId) {
	const path: AnalysisNode[] = [];
	let node: AnalysisNode | undefined = tab.nodes[nodeId];
	while (node) {
		path.unshift(node);
		node = node.parentId ? tab.nodes[node.parentId] : undefined;
	}
	return path;
}

export function hasEdits(node: AnalysisNode) {
	return !!node.edits && Object.keys(node.edits).length > 0;
}

/**
 * The deepest replay node on the path to a position: the turn the position is rebuilt from, whether that is
 * the replay node itself or a line simulated on from it. `null` for a tab that was never imported.
 *
 * It is what tells the renderer which turn of the replay the real history has to run up to, so the
 * reconstruction can be spliced on behind it (`getRenderedLog`).
 */
export function getReplayAnchor(tab: AnalysisTab, nodeId = tab.currentNodeId) {
	let anchor: AnalysisNode | null = null;
	for (const node of getNodePath(tab, nodeId)) {
		if (node.kind === 'replay') anchor = node;
	}
	return anchor;
}

/**
 * The path with the turns before the deepest replay node dropped, since that node's edits already describe
 * the whole position. Setup nodes (turn ≤ 0) are kept either way: the Team Preview choices are what carry
 * the battle to turn 1, which is where an imported position is built.
 */
function pathFromLastReplayNode(tab: AnalysisTab, nodeId: string) {
	const path = getNodePath(tab, nodeId);
	let lastReplay = -1;
	for (let i = 0; i < path.length; i++) {
		if (path[i].kind === 'replay') lastReplay = i;
	}
	if (lastReplay < 0) return path;
	const kept: AnalysisNode[] = [];
	for (let i = 0; i < path.length; i++) {
		if (i < lastReplay && path[i].turn > 0) continue;
		kept.push(path[i]);
	}
	return kept;
}

/**
 * The packed teams to build the battle with for a position. A team edited at Team Preview is stored on
 * that node (`node.teams`) and replaces the tab's starting team, rather than being applied as an edit
 * layer: the battle is then constructed from it, so it emits its own correct `clearpoke`/`poke` lines and
 * no roster resync is needed. Team slots are whatever the new team's order says.
 *
 * It carries the tab's `sandbox` flag too, because every endpoint that takes teams also validates them,
 * and a Set Up Position tab's team is deliberately illegal. Spreading this into a request is how all
 * three of them stay in step.
 */
export function resolveTeamsFor(tab: AnalysisTab, nodeId = tab.currentNodeId) {
	let team1 = tab.team1;
	let team2 = tab.team2;
	for (const node of getNodePath(tab, nodeId)) {
		if (node.teams?.p1) team1 = node.teams.p1;
		if (node.teams?.p2) team2 = node.teams.p2;
	}
	return { team1, team2, sandbox: tab.sandbox };
}

/**
 * Records that rebuild the position at `nodeId`: every node on the path contributes its
 * edits (applied at the start of its turn) and, once executed, its seed and choices.
 * The target node's own edits are always included; its choices only if `includeNode`.
 *
 * **A replay node short-circuits the path.** Its edits describe the whole position absolutely, so
 * replaying the turns before it would be wasted work at best and would leak state the snapshot doesn't
 * mention at worst. Everything strictly between the setup and the deepest replay node is therefore
 * dropped. The setup itself (the hidden root and the turn-0 Team Preview node) is always kept: without
 * its choices the battle never leaves Team Preview, and a turn-1 position has nowhere to apply.
 *
 * A replay node needs no other special case, and must not have one. It is the **seed** that separates a
 * turn the replay merely showed from a turn the user actually played: an imported node carries neither a
 * seed nor choices (a replay's own choices are inferred, and are never stored or executed), while a node
 * the user submitted at does — and `editCurrentNode` copies `kind` onto the sibling it forks, so the node
 * that holds a simulated turn off the replay is itself a replay node. Skipping choices on `kind` alone
 * therefore threw that turn away and rebuilt the child at its parent's position.
 *
 * **A replay node contributes two records**, not one: the reconstruction, then whatever the user has edited
 * on top of it. Both could be merged into a single set of absolute edits, but keeping them apart is what
 * lets the renderer apply the first invisibly and show the second (`getRenderedLog`) — and it keeps the
 * node's own `edits` and `editSummary` meaning "what the user changed here", so the Lines tooltip doesn't
 * recite the whole reconstruction. The user's record stays **last**, which is what `saveEdits` reads back.
 */
export function replayNodesFor(tab: AnalysisTab, nodeId: string, includeNode: boolean) {
	const records: AnalysisReplayRecord[] = [];
	for (const node of pathFromLastReplayNode(tab, nodeId)) {
		const runChoices = (node.id !== nodeId || includeNode) && !!node.seed && node.inputLog.length > 0;
		const edits = hasEdits(node) ? node.edits : undefined;
		const imported = node.importedEdits && Object.keys(node.importedEdits).length ?
			node.importedEdits : undefined;
		if (imported) records.push({ edits: imported, seed: null, inputLog: [] });
		if (!runChoices && !edits) continue;
		records.push({
			edits,
			seed: runChoices ? node.seed : null,
			inputLog: runChoices ? node.inputLog : [],
		});
	}
	return records;
}

export type AnalysisNodeTreeItem = { node: AnalysisNode } | { branch: AnalysisNodeTreeItem[] };

/**
 * Lines presentation: the first child continues the line, later children become branches.
 *
 * A Set Up Position tab answered Team Preview for you, so its turn-0 node is hidden the way the turn -1
 * root always is: the tree starts at Turn 1. The node itself stays in the tab, because it holds the seed
 * and choices every replay of the line needs.
 */
export function getAnalysisNodeTreeItems(tab: AnalysisTab) {
	const nodes = Object.values(tab.nodes);
	let root = nodes.find(node => node.parentId === null);
	if (root && tab.sandbox) root = nodes.find(node => node.parentId === root!.id) || root;
	if (!root) return [];

	const appendChildren = (parent: AnalysisNode): AnalysisNodeTreeItem[] => {
		const children = nodes.filter(node => node.parentId === parent.id);
		const firstChild = children[0];
		if (!firstChild) return [];
		const items: AnalysisNodeTreeItem[] = [{ node: firstChild }];
		for (const child of children.slice(1)) items.push({ branch: appendBranch(child) });
		items.push(...appendChildren(firstChild));
		return items;
	};
	const appendBranch = (node: AnalysisNode): AnalysisNodeTreeItem[] => {
		return [{ node }, ...appendChildren(node)];
	};

	return appendChildren(root);
}

/**
 * The turn-0 Team Preview node: the hidden root's only child, which every line starts from.
 *
 * It holds the choices that get the battle out of Team Preview, so an imported replay's brought-Pokémon
 * step edits this node rather than adding one of its own.
 */
export function getSetupNode(tab: AnalysisTab) {
	const nodes = Object.values(tab.nodes);
	const root = nodes.find(node => node.parentId === null);
	if (!root) return null;
	return nodes.find(node => node.parentId === root.id) || null;
}

export function getChildNodes(tab: AnalysisTab, nodeId: string) {
	return Object.values(tab.nodes).filter(node => node.parentId === nodeId);
}

export function hasChildNodes(tab: AnalysisTab, nodeId: string) {
	return Object.values(tab.nodes).some(node => node.parentId === nodeId);
}
