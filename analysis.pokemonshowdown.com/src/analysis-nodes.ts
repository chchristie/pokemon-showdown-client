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
 * The packed teams to build the battle with for a position. A team edited at Team Preview is stored on
 * that node (`node.teams`) and replaces the tab's starting team, rather than being applied as an edit
 * layer: the battle is then constructed from it, so it emits its own correct `clearpoke`/`poke` lines and
 * no roster resync is needed. Team slots are whatever the new team's order says.
 */
export function resolveTeamsFor(tab: AnalysisTab, nodeId = tab.currentNodeId) {
	let team1 = tab.team1;
	let team2 = tab.team2;
	for (const node of getNodePath(tab, nodeId)) {
		if (node.teams?.p1) team1 = node.teams.p1;
		if (node.teams?.p2) team2 = node.teams.p2;
	}
	return { team1, team2 };
}

/**
 * Records that rebuild the position at `nodeId`: every node on the path contributes its
 * edits (applied at the start of its turn) and, once executed, its seed and choices.
 * The target node's own edits are always included; its choices only if `includeNode`.
 */
export function replayNodesFor(tab: AnalysisTab, nodeId: string, includeNode: boolean) {
	const records: AnalysisReplayRecord[] = [];
	for (const node of getNodePath(tab, nodeId)) {
		const runChoices = (node.id !== nodeId || includeNode) && !!node.seed && node.inputLog.length > 0;
		const edits = hasEdits(node) ? node.edits : undefined;
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

/** Lines presentation: the first child continues the line, later children become branches. */
export function getAnalysisNodeTreeItems(tab: AnalysisTab) {
	const nodes = Object.values(tab.nodes);
	const root = nodes.find(node => node.parentId === null);
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

export function getChildNodes(tab: AnalysisTab, nodeId: string) {
	return Object.values(tab.nodes).filter(node => node.parentId === nodeId);
}

export function hasChildNodes(tab: AnalysisTab, nodeId: string) {
	return Object.values(tab.nodes).some(node => node.parentId === nodeId);
}
