/**
 * BattleTooltips for the analysis page: exact server data for both sides, and damage calc
 * lines appended to move tooltips (docs/analysis/plan.md, Phase 1). Lives here rather than in
 * upstream battle-tooltips.ts to keep that file mergeable.
 *
 * Tooltip types:
 * - `analysispokemon|SIDE|TEAMINDEX`: Pokémon tooltip with full request data for either side.
 * - `analysismove|MOVEID|SIDE|ACTIVESLOT[|zmove]`: move button; calcs for all potential targets.
 * - `analysischoice|MOVEID|SIDE|ACTIVESLOT[|zmove]`: choice-summary cell; calcs for the chosen targets only.
 *
 * `MOVEID` is always the base move, even for a Z-move: `BattleTooltips` builds the Z-move from the base
 * move and the held crystal, and the calc results are keyed by the base move too.
 */
import { BattleTooltips } from '../../play.pokemonshowdown.com/src/battle-tooltips';
import { BattleLog } from '../../play.pokemonshowdown.com/src/battle-log';
import { Dex } from '../../play.pokemonshowdown.com/src/battle-dex';
import type { Battle } from '../../play.pokemonshowdown.com/src/battle';
import {
	ANALYSIS_CALC_ATTACKER, ANALYSIS_CALC_DEFENDER, type AnalysisCalcMode, type AnalysisCalcPokemonRef,
	type AnalysisCalcState, type AnalysisSnapshot,
} from './analysis-model';

export type AnalysisCalcUsage = 'hover' | 'selected';

export interface AnalysisTooltipSources {
	getCalcs(): AnalysisCalcState | null;
	/**
	 * The attacker's transformation for this tooltip: the move menu's Mega/Tera checkboxes for 'hover',
	 * the chosen move's modifier for 'selected'.
	 */
	getCalcMode(sideIndex: number, slot: number, usage: AnalysisCalcUsage): AnalysisCalcMode;
	/** exact state for this position, for PP the renderer can't know (edits, unused moves) */
	getSnapshot(): AnalysisSnapshot | null | undefined;
}

export class AnalysisTooltips extends BattleTooltips {
	sources: AnalysisTooltipSources;

	constructor(battle: Battle, sources: AnalysisTooltipSources) {
		super(battle);
		this.sources = sources;
	}

	override showTooltip(elem: HTMLElement) {
		const args = (elem.dataset.tooltip || '').split('|');
		let buf: string;
		switch (args[0]) {
		case 'analysispokemon': {
			const sideIndex = parseInt(args[1], 10);
			const index = parseInt(args[2], 10);
			const serverPokemon = this.serverTeam(sideIndex)?.[index];
			if (!serverPokemon) return false;
			const clientPokemon = this.battle.findCorrespondingPokemon(serverPokemon);
			this.syncMoveTrack(clientPokemon, sideIndex, index);
			buf = this.showPokemonTooltip(clientPokemon, serverPokemon);
			break;
		}
		case 'analysismove':
		case 'analysischoice': {
			const move = this.battle.dex.moves.get(args[1]);
			const sideIndex = parseInt(args[2], 10);
			const slot = parseInt(args[3], 10);
			const pokemon = this.battle.sides[sideIndex]?.active[slot];
			const serverPokemon = this.serverTeam(sideIndex)?.filter(candidate => candidate.active)[slot];
			if (!pokemon || !serverPokemon) return false;
			buf = this.showMoveTooltip(move, args[4] === 'zmove' ? 'zmove' : 'move', pokemon, serverPokemon);
			buf += this.renderCalcLines(sideIndex, slot, move, args[0] === 'analysischoice' ? 'selected' : 'hover');
			break;
		}
		default:
			return super.showTooltip(elem);
		}
		this.placeTooltip(buf, elem, !!elem.dataset.ownheight, args[0]);
		return true;
	}

	/** Re-renders the visible analysis tooltip, e.g. once calc results arrive. */
	refreshVisibleTooltip() {
		const elem = BattleTooltips.parentElem;
		if (!BattleTooltips.elem || !elem?.isConnected || !elem.dataset.tooltip?.startsWith('analysis')) return;
		this.showTooltip(elem);
	}

	/**
	 * The renderer only knows the PP of moves it saw used, so a PP edit wouldn't show. The snapshot has the
	 * exact values, so fill in the move track from it before the tooltip is built.
	 */
	syncMoveTrack(pokemon: { moveTrack: [string, number | [number, number]][] } | null, sideIndex: number, index: number) {
		const snapshot = this.sources.getSnapshot()?.sides[sideIndex]?.pokemon[index];
		if (!pokemon || !snapshot) return;
		pokemon.moveTrack = snapshot.moves.map(move => [move.name, move.maxpp - move.pp]);
	}

	serverTeam(sideIndex: number) {
		return sideIndex === 0 ? this.battle.myPokemon : this.battle.myAllyPokemon;
	}

	pokemonIconText(ref: AnalysisCalcPokemonRef) {
		const sideIndex = ref.side === 'p1' ? 0 : 1;
		const serverPokemon = this.serverTeam(sideIndex)?.[ref.index];
		const species = (serverPokemon?.details || serverPokemon?.ident || '').split(',')[0];
		return `<span class="picon" style="${Dex.getPokemonIcon(species)}"></span> (${sideIndex + 1})`;
	}

	/** Calc lines for a move tooltip; nothing for status moves. */
	renderCalcLines(sideIndex: number, slot: number, move: Dex.Move, usage: AnalysisCalcUsage) {
		if (move.category === 'Status') return '';
		const calcs = this.sources.getCalcs();
		const section = (content: string) => `<p class="tooltip-section analysis-calc-lines">${content}</p>`;
		if (!calcs || calcs.loading) return section('<small><em>Calculating damage…</em></small>');
		if (calcs.error) return section(`<small>Damage calc failed: ${BattleLog.escapeHTML(calcs.error)}</small>`);
		const side = sideIndex === 0 ? 'p1' : 'p2';
		const mode = this.sources.getCalcMode(sideIndex, slot, usage);
		const matches = (entryMode: AnalysisCalcMode) => calcs.results?.find(entry =>
			entry.attacker.side === side && entry.attacker.slot === slot && entry.moveId === move.id &&
			entry.mode === entryMode);
		// fall back to the untransformed result if that mode isn't available
		const result = matches(mode) || matches('');
		const targets = result?.targets.filter(target => usage === 'hover' ? target.onMoveHover : target.selected) || [];
		if (!result || !targets.length) return '';
		const lines = targets.map(target => {
			if (!target.text) return `<small>Damage calc failed: ${BattleLog.escapeHTML(target.error || 'unknown error')}</small>`;
			return BattleLog.escapeHTML(target.text)
				.replace(BattleLog.escapeHTML(ANALYSIS_CALC_ATTACKER), this.pokemonIconText(result.attacker))
				.replace(BattleLog.escapeHTML(ANALYSIS_CALC_DEFENDER), this.pokemonIconText(target.target));
		});
		return section(lines.join('<br />'));
	}
}
