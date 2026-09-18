/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
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
	// edits apply at the start of the turn, so they're shown before the turn has been played
	const summary = node.editSummary;
	const editSummary = node.turn > 0 && summary && (summary.field.length || summary.p1.length || summary.p2.length) ?
		summary : null;
	// a team set at Team Preview isn't an edit layer, so it has its own summary (see resolveTeamsFor)
	const teams = node.teamSummary;
	const teamSummary = teams && (teams.p1.length || teams.p2.length) ?
		{ field: [] as string[], p1: teams.p1, p2: teams.p2 } : null;
	const showTooltip = showTurnEvents || !!editSummary || !!teamSummary;
	return <li class={`analysis-node-entry${node.id === tab.currentNodeId ? ' analysis-node-current' : ''}`}>
		<button
			class="analysis-node-button" onClick={() => onSelect(node.id)}
			onMouseEnter={showTooltip ? positionNodeTooltip : undefined}
			onFocus={showTooltip ? positionNodeTooltip : undefined}
			aria-describedby={showTooltip ? tooltipId : undefined}
		>
			<strong>{node.turn === 0 ? 'Team Preview' : `Turn ${node.turn}`}</strong>
			{node.turn === 0 ?
				<AnalysisTeamSelectionSummaryView teams={node.teamSelectionSummary || { p1: [], p2: [] }} /> :
				<AnalysisChoiceSummaryView choices={node.choiceSummary || []} gameType={tab.gameType} />}
		</button>
		{showTooltip ? <div id={tooltipId} class="analysis-node-tooltip" role="tooltip">
			{teamSummary ? <div class="analysis-node-edits">
				<strong>Teams:</strong>
				<div class="analysis-node-edits-teams">
					{(['p1', 'p2'] as const).map((side, index) => <div>
						<em>Side {index + 1}</em>
						{teamSummary[side].map(line => <span>{line}</span>)}
					</div>)}
				</div>
			</div> : null}
			{editSummary ? <div class="analysis-node-edits">
				<strong>Turn {node.turn} Edits:</strong>
				{editSummary.field.map(line => <span>{line}</span>)}
				{editSummary.p1.length || editSummary.p2.length ? <div class="analysis-node-edits-teams">
					{(['p1', 'p2'] as const).map((side, index) => <div>
						<em>Side {index + 1}</em>
						{editSummary[side].map(line => <span>{line}</span>)}
					</div>)}
				</div> : null}
			</div> : null}
			{showTurnEvents ? <>
				<strong>Turn {node.turn} → Turn {node.turn + 1}</strong>
				<AnalysisTurnEventSummaryView actions={node.turnEventSummary!} />
			</> : null}
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
