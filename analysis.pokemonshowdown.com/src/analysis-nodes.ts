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

export function getPrimaryNodeChain(tab: AnalysisTab) {
	const chain: AnalysisNode[] = [];
	let node: AnalysisNode | undefined = Object.values(tab.nodes).find(candidate => candidate.parentId === null);
	while (node) {
		chain.unshift(node);
		const children = Object.values(tab.nodes).filter(child => child.parentId === node!.id);
		node = children[0];
	}
	return chain;
}
