/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type { AnalysisNode, AnalysisTab } from './analysis-model';
import { AnalysisChoiceSummaryView, AnalysisTeamSelectionSummaryView } from './analysis-choice-summary';
import { getAnalysisNodeTreeItems } from './analysis-nodes';
import type { AnalysisNodeTreeItem } from './analysis-nodes';

function NodeSummary(props: { tab: AnalysisTab, node: AnalysisNode, onSelect: (nodeId: string) => void }) {
	const { tab, node, onSelect } = props;
	return <li class={`analysis-node-entry${node.id === tab.currentNodeId ? ' analysis-node-current' : ''}`}>
		<button class="analysis-node-button" onClick={() => onSelect(node.id)}>
			<strong>{node.turn === 0 ? 'Team Selection' : `Turn ${node.turn}`}</strong>
			{node.turn === 0 ?
				<AnalysisTeamSelectionSummaryView teams={node.teamSelectionSummary || { p1: [], p2: [] }} /> :
				<AnalysisChoiceSummaryView choices={node.choiceSummary || []} gameType={tab.gameType} />}
		</button>
	</li>;
}

function NodeTreeItems(props: {
	tab: AnalysisTab, items: AnalysisNodeTreeItem[], onSelect: (nodeId: string) => void,
}) {
	return <>{props.items.map(item => 'node' in item ?
		<NodeSummary key={item.node.id} tab={props.tab} node={item.node} onSelect={props.onSelect} /> :
		<li class="analysis-node-branch">
			<ol><NodeTreeItems tab={props.tab} items={item.branch} onSelect={props.onSelect} /></ol>
		</li>
	)}</>;
}

export function AnalysisNodeTree(props: { tab: AnalysisTab, onSelect: (nodeId: string) => void }) {
	return <ol class="analysis-node-tree">
		<NodeTreeItems tab={props.tab} items={getAnalysisNodeTreeItems(props.tab)} onSelect={props.onSelect} />
	</ol>;
}
