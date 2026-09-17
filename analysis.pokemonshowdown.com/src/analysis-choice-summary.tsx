/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type { AnalysisChoiceSummary, AnalysisTeamSelectionSummary } from './analysis-model';

function PSIcon(props: { pokemon: any }) {
	return <span class="picon" style={(window as any).Dex.getPokemonIcon(props.pokemon)} />;
}

export function AnalysisChoiceSummaryView(props: { choices: AnalysisChoiceSummary[], gameType?: string }) {
	const positions: { side: 'p1' | 'p2', slot: number }[] = props.gameType === 'singles' ? [
		{ side: 'p1', slot: 0 }, { side: 'p2', slot: 0 },
	] : [
		{ side: 'p2', slot: 1 }, { side: 'p2', slot: 0 },
		{ side: 'p1', slot: 0 }, { side: 'p1', slot: 1 },
	];
	return <div class="analysis-choice-summary-wrap">{positions.map(position => {
		const choice = props.choices.find(entry => entry.side === position.side && entry.slot === position.slot);
		if (!choice) return <div class="analysis-choice-summary" aria-hidden="true" />;
		return <div class="analysis-choice-summary">
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
