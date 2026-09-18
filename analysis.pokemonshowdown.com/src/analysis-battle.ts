/**
 * The battle renderer for the analysis page. Lives here rather than in upstream battle.ts to keep that file
 * mergeable.
 *
 * State edits (tools/analysis-edits.ts) can set state the protocol has no way to express, and send it as
 * extra keywords and `analysiscounter` lines that only this renderer reads.
 *
 * They can set how many turns a field effect has left, but the protocol has
 * no way to say that: the client estimates durations from `-weather`/`-fieldstart`/`-sidestart` (e.g.
 * "Reflect (5 or 8 turns)"). The server's `Analysis edits` message carries the exact values in
 * `[analysisdurations]`, and this applies them to the same counters the client counts down each turn, so the
 * values stay right during playback too.
 */
import { Battle } from '../../play.pokemonshowdown.com/src/battle';
import { toID } from '../../play.pokemonshowdown.com/src/battle-dex';
import type { Args, KWArgs } from '../../play.pokemonshowdown.com/src/battle-text-parser';

export class AnalysisBattleRenderer extends Battle {
	override runMinor(args: Args, kwArgs: KWArgs, nextArgs?: Args, nextKwargs?: KWArgs) {
		super.runMinor(args, kwArgs, nextArgs, nextKwargs);
		if (args[0] === '-message' && kwArgs.analysisdurations) this.applyAnalysisDurations(kwArgs.analysisdurations);
		// `|-message|analysiscounter|POKEMON|toxic|3|[silent]`: the toxic and sleep counters an edit set
		if (args[0] === '-message' && args[1] === 'analysiscounter') {
			const pokemon = this.getPokemon(args[2]);
			const turns = Number(args[4]);
			if (pokemon && turns >= 0) {
				if (args[3] === 'toxic') pokemon.statusData.toxicTurns = turns;
				if (args[3] === 'sleep') pokemon.statusData.sleepTurns = turns;
			}
		}
		// `|-message|analysistera|POKEMON||[silent]`: an edit took a Terastallization back. No protocol line
		// clears it on a living Pokémon, and the client keeps it in three places, so clear all of them the
		// way the client's own faint path does (battle.ts).
		if (args[0] === '-message' && args[1] === 'analysistera') {
			const pokemon = this.getPokemon(args[2]);
			if (pokemon) {
				pokemon.terastallized = '';
				pokemon.details = pokemon.details.replace(/, tera:[a-z?]+/i, '');
				pokemon.searchid = pokemon.searchid.replace(/, tera:[a-z?]+/i, '');
				this.scene.updateSidebar(pokemon.side);
				if (pokemon.side.active.includes(pokemon)) this.scene.resetStatbar(pokemon);
			}
		}
	}

	/** `weather:3`, `trickroom:2` (pseudo-weather or terrain id), `p1:reflect:5` */
	applyAnalysisDurations(durations: string) {
		for (const entry of durations.split(',')) {
			const parts = entry.split(':');
			const turns = Number(parts.pop());
			const id = parts.pop() || '';
			const side = parts.pop();
			if (!turns) continue;
			if (side) {
				const condition = this.sides[side === 'p1' ? 0 : 1]?.sideConditions[id];
				if (condition) {
					condition[2] = turns;
					condition[3] = 0;
				}
			} else if (id === 'weather') {
				this.weatherTimeLeft = turns;
				this.weatherMinTimeLeft = 0;
			} else {
				for (const pseudoWeather of this.pseudoWeather) {
					if (toID(pseudoWeather[0]) !== id) continue;
					pseudoWeather[1] = turns;
					pseudoWeather[2] = 0;
				}
			}
		}
		this.scene.updateWeather();
		// A weather change fades the old text out and writes the new text when the fade ends, using text built
		// before these durations were applied. Re-render after that fade so it doesn't bring the estimates back.
		const $weather = (this.scene as any).$weather;
		$weather?.queue?.((next: () => void) => {
			this.scene.updateWeather(true);
			next();
		});
	}
}
