/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type { AnalysisChoiceSummary, AnalysisSideID, AnalysisTeamSelectionSummary } from './analysis-model';

function PSIcon(props: { pokemon: any }) {
	return <span class="picon" style={(window as any).Dex.getPokemonIcon(props.pokemon)} />;
}

/**
 * For the current decision's summary only: `tooltips` enables damage calc tooltips on cells whose action
 * is a move (analysis-tooltips.ts), and `onSelect` makes cells open that Pokémon's action selection.
 */
export function AnalysisChoiceSummaryView(props: {
	choices: AnalysisChoiceSummary[], gameType?: string, tooltips?: boolean,
	onSelect?: (side: AnalysisSideID, slot: number) => void,
}) {
	const positions: { side: 'p1' | 'p2', slot: number }[] = props.gameType === 'singles' ? [
		{ side: 'p1', slot: 0 }, { side: 'p2', slot: 0 },
	] : [
		{ side: 'p2', slot: 1 }, { side: 'p2', slot: 0 },
		{ side: 'p1', slot: 0 }, { side: 'p1', slot: 1 },
	];
	return <div class="analysis-choice-summary-wrap">{positions.map(position => {
		const choice = props.choices.find(entry => entry.side === position.side && entry.slot === position.slot);
		if (!choice) return <div class="analysis-choice-summary" aria-hidden="true" />;
		const tooltip = props.tooltips && choice.moveId ?
			`analysischoice|${choice.moveId}|${choice.side === 'p1' ? 0 : 1}|${choice.slot}` : undefined;
		const { onSelect } = props;
		const classes = `analysis-choice-summary${tooltip ? ' has-tooltip' : ''}${onSelect ? ' analysis-choice-selectable' : ''}`;
		return <div
			class={classes} data-tooltip={tooltip}
			onClick={onSelect ? () => onSelect(choice.side, choice.slot) : undefined}
		>
			<PSIcon pokemon={choice.pokemon} />: {choice.action}
			{choice.targetPokemon ? <> <PSIcon pokemon={choice.targetPokemon} /></> : null}
		</div>;
	})}</div>;
}

export function AnalysisTeamSelectionSummaryView(props: { teams: AnalysisTeamSelectionSummary }) {
	return <div class="analysis-choice-summary-wrap">
		{(['p1', 'p2'] as const).map((side, sideIndex) => <div class="analysis-choice-summary">
			Team {sideIndex + 1}: {props.teams[side].map(pokemon => <PSIcon pokemon={pokemon} />)}
		</div>)}
	</div>;
}
