/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type { AnalysisNode, AnalysisTab } from './analysis-model';
import { AnalysisChoiceSummaryView, AnalysisTeamSelectionSummaryView } from './analysis-choice-summary';
import { getAnalysisNodeTreeItems, hasChildNodes, type AnalysisNodeTreeItem } from './analysis-nodes';
import { AnalysisTurnEventSummaryView } from './analysis-turn-events';

/**
 * Places a node's outcome tooltip to the left of its button, kept inside the window. It's `position: fixed`
 * because the scrollable Lines panel would clip anything positioned outside it.
 */
function positionNodeTooltip(event: Event) {
	const button = event.currentTarget as HTMLElement;
	const tooltip = button.nextElementSibling as HTMLElement | null;
	if (!tooltip?.classList.contains('analysis-node-tooltip')) return;
	const margin = 8;
	const buttonRect = button.getBoundingClientRect();
	const { width, height } = tooltip.getBoundingClientRect();
	const top = Math.max(margin, Math.min(buttonRect.top, window.innerHeight - height - margin));
	const left = Math.max(margin, buttonRect.left - width - margin);
	tooltip.style.top = `${top}px`;
	tooltip.style.left = `${left}px`;
}

function NodeSummary(props: {
	key?: string, tab: AnalysisTab, node: AnalysisNode, onSelect: (nodeId: string) => void,
}) {
	const { tab, node, onSelect } = props;
	const tooltipId = `analysis-node-events-${node.id}`;
	const hasChild = hasChildNodes(tab, node.id);
	const showTurnEvents = node.turn > 0 && hasChild && !!node.turnEventSummary;
	return <li class={`analysis-node-entry${node.id === tab.currentNodeId ? ' analysis-node-current' : ''}`}>
		<button
			class="analysis-node-button" onClick={() => onSelect(node.id)}
			onMouseEnter={showTurnEvents ? positionNodeTooltip : undefined}
			onFocus={showTurnEvents ? positionNodeTooltip : undefined}
			aria-describedby={showTurnEvents ? tooltipId : undefined}
		>
			<strong>{node.turn === 0 ? 'Team Preview' : `Turn ${node.turn}`}</strong>
			{node.turn === 0 ?
				<AnalysisTeamSelectionSummaryView teams={node.teamSelectionSummary || { p1: [], p2: [] }} /> :
				<AnalysisChoiceSummaryView choices={node.choiceSummary || []} gameType={tab.gameType} />}
		</button>
		{showTurnEvents ? <div id={tooltipId} class="analysis-node-tooltip" role="tooltip">
			<strong>Turn {node.turn} → Turn {node.turn + 1}</strong>
			<AnalysisTurnEventSummaryView actions={node.turnEventSummary!} />
		</div> : null}
	</li>;
}

function NodeTreeItems(props: {
	tab: AnalysisTab, items: AnalysisNodeTreeItem[], onSelect: (nodeId: string) => void,
}) {
	return <>{props.items.map(item => 'node' in item ?
		<NodeSummary key={item.node.id} tab={props.tab} node={item.node} onSelect={props.onSelect} /> :
		<li class="analysis-node-branch" key={`branch-${item.branch[0] && 'node' in item.branch[0] ? item.branch[0].node.id : ''}`}>
			<ol><NodeTreeItems tab={props.tab} items={item.branch} onSelect={props.onSelect} /></ol>
		</li>
	)}</>;
}

export function AnalysisNodeTree(props: { tab: AnalysisTab, onSelect: (nodeId: string) => void }) {
	return <ol class="analysis-node-tree">
		<NodeTreeItems tab={props.tab} items={getAnalysisNodeTreeItems(props.tab)} onSelect={props.onSelect} />
	</ol>;
}
