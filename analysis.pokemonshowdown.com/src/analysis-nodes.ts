import type { AnalysisNode, AnalysisTab } from './analysis-model';

export function getNodePath(tab: AnalysisTab, nodeId = tab.currentNodeId) {
	const path: AnalysisNode[] = [];
	let node = tab.nodes[nodeId];
	while (node) {
		path.unshift(node);
		node = node.parentId ? tab.nodes[node.parentId] : undefined as any;
	}
	return path;
}

export function replayNodesFor(tab: AnalysisTab, nodeId: string, includeNode: boolean) {
	const path = getNodePath(tab, nodeId);
	const nodes = includeNode ? path : path.slice(0, -1);
	return nodes.filter(node => node.seed && node.inputLog.length).map(node => ({
		seed: node.seed!, inputLog: node.inputLog,
	}));
}

export interface AnalysisNodeTreeRow {
	node: AnalysisNode;
	depth: number;
}

export type AnalysisNodeTreeItem = { node: AnalysisNode } | { branch: AnalysisNodeTreeItem[] };

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

export function getAnalysisNodeTreeRows(tab: AnalysisTab) {
	const rows: AnalysisNodeTreeRow[] = [];
	const appendItems = (items: AnalysisNodeTreeItem[], depth: number) => {
		for (const item of items) {
			if ('node' in item) {
				rows.push({ node: item.node, depth });
			} else {
				appendItems(item.branch, depth + 1);
			}
		}
	};
	appendItems(getAnalysisNodeTreeItems(tab), 0);
	return rows;
}
