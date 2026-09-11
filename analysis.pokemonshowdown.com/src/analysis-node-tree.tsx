/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type { AnalysisNode, AnalysisTab } from './analysis-model';
import { getPrimaryNodeChain } from './analysis-nodes';

function PSIcon(props: { pokemon: any }) {
	return <span class="picon" style={(window as any).Dex.getPokemonIcon(props.pokemon)} />;
}

function NodeSummary(props: { tab: AnalysisTab, node: AnalysisNode, onSelect: (nodeId: string) => void }) {
	const { tab, node, onSelect } = props;
	const choices: { side: number, choice: string }[] = [];
	const inputLines = node.inputLog.slice().reverse();
	for (var lineIndex = 0; lineIndex < inputLines.length; lineIndex++) {
		var match = /^>p([12])\s+(.+)$/.exec(inputLines[lineIndex]);
		if (!match) continue;
		var side = Number(match[1]) - 1;
		if (choices.some(choice => choice.side === side)) continue;
		choices.push({ side, choice: match[2] });
		if (choices.length === 2) break;
	}
	choices.sort((left, right) => left.side - right.side);
	return <li class={node.id === tab.currentNodeId ? 'analysis-node-current' : ''}>
		<button class="analysis-node-button" onClick={() => onSelect(node.id)}>
			<strong>{node.turn}.</strong>{choices.map(choice => {
				const pokemon = tab.requests?.[choice.side]?.side?.pokemon?.find((entry: any) => entry.active);
				return <span class="analysis-node-action">
					{pokemon && <PSIcon pokemon={(pokemon.details || pokemon.name || '').split(',')[0]} />}{choice.choice}
				</span>;
			})}
		</button>
	</li>;
}

export function AnalysisNodeTree(props: { tab: AnalysisTab, onSelect: (nodeId: string) => void }) {
	return <ol class="analysis-node-tree">
		{getPrimaryNodeChain(props.tab).map(node => <NodeSummary tab={props.tab} node={node} onSelect={props.onSelect} />)}
	</ol>;
}
