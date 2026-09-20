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
	/**
	 * `[analysisresync]` marks a line that states **how the position already stands**, rather than reporting
	 * something that just happened. `getRenderedLog` puts it on the reconstruction's whole edit block when it
	 * splices an imported replay's own history in front of that position.
	 *
	 * Against real history such a line is a restatement, and saying it again is wrong twice over.
	 *
	 * It **corrupts the field**, because `switch` and `swap` resolve *positionally* upstream while the edit
	 * layer wrote them as a delta from a fresh battle's Team Preview leads: a `|swap|` moves whoever happens
	 * to be sitting in the named slot, and `getSwitchedPokemon` skips Pokémon that are already active, so the
	 * `|switch|` after it adds a *second* copy of one that is already out (measured: Ceruledge in both of
	 * p1's slots).
	 *
	 * And it **narrates setup as history** — a Mega Evolution announced a second time, a Disable re-applied —
	 * in the middle of a replay the user is watching (user report, 2026-09-19).
	 *
	 * So each line is read absolutely: skipped wherever the replay already agrees, which is almost everywhere,
	 * and still applied where it doesn't, so a Set Active edit on a replay node moves the sprite as ever.
	 */
	override runMajor(args: Args, kwArgs: KWArgs, preempt?: boolean) {
		if (kwArgs.analysisresync && this.applyAnalysisResync(args)) return;
		super.runMajor(args, kwArgs, preempt);
	}

	/** True when the line has been dealt with and upstream should not see it. */
	applyAnalysisResync(args: Args) {
		if (args[0] === 'faint') {
			// already fainted in the replay's own history, so saying it again only re-plays the animation
			return !!this.getPokemon(args[1])?.fainted;
		}
		if (args[0] === 'detailschange' || args[0] === '-formechange') {
			const pokemon = this.getPokemon(args[1]);
			return !!pokemon && pokemon.speciesForme === (args[2] || '').split(',')[0];
		}
		if (args[0] === '-mega') {
			// the `detailschange` beside it carries the forme; this line is only the announcement
			return !!this.getPokemon(args[1])?.speciesForme.includes('-Mega');
		}
		if (args[0] === '-ability') {
			return this.getPokemon(args[1])?.ability === args[2];
		}
		if (args[0] === '-start' || args[0] === '-end') {
			// a volatile the replay already announced, Disable and its locked move included
			const pokemon = this.getPokemon(args[1]);
			const id = toID((args[2] || '').replace(/^(?:move|ability|item): /, ''));
			return !!pokemon && !!pokemon.volatiles[id] === (args[0] === '-start');
		}
		if (args[0] !== 'switch' && args[0] !== 'swap') return false;
		const { name, siden, slot } = this.parsePokemonId(args[1]);
		const side = this.sides[siden];
		if (!side) return false;
		// Where this Pokémon actually is on the field right now, which is what both lines are talking about.
		let index = -1;
		for (let i = 0; i < side.active.length; i++) {
			if (side.active[i]?.name === name) index = i;
		}
		const target = args[0] === 'swap' ? Number(args[2]) : slot;
		if (isNaN(target) || target < 0) return false;
		if (index === target) return true;
		// Already out, in the wrong slot: an arrangement change, whichever line said so.
		if (index >= 0) {
			side.swapTo(side.active[index]!, target);
			return true;
		}
		// Not on the field at all, so it really is switching in. A `swap` naming it is stale and does nothing.
		return args[0] === 'swap';
	}

	/**
	 * Whether the scene was animating before a resync block muted it, or `null` outside one.
	 *
	 * Skipping the lines a resync block restates isn't enough on its own to make it invisible: `-sethp`
	 * animates a heal or a hit whatever its keywords say, and the exact HP it sets never quite matches the
	 * percentage a replay showed. So the block is bracketed and the scene simply doesn't animate inside it.
	 */
	analysisResyncAnimating: boolean | null = null;

	beginAnalysisResync() {
		if (this.analysisResyncAnimating !== null) return;
		const scene = this.scene as any;
		this.analysisResyncAnimating = !!scene.animating;
		// Already seeking: playback is silent anyway, and turning it back on would end the seek early.
		if (scene.animating) scene.animating = false;
	}

	endAnalysisResync() {
		const wasAnimating = this.analysisResyncAnimating;
		this.analysisResyncAnimating = null;
		// `animationOn` is upstream's own way back: it re-enables the scene and resets every sprite, weather
		// and side condition to the state the block just wrote, which is exactly the resync we want.
		if (wasAnimating) (this.scene as any).animationOn();
	}

	override runMinor(args: Args, kwArgs: KWArgs, nextArgs?: Args, nextKwargs?: KWArgs) {
		// `|-message|analysisresync|start|[silent]` brackets a block the renderer applies but never shows
		if (args[0] === '-message' && args[1] === 'analysisresync') {
			if (args[2] === 'start') {
				this.beginAnalysisResync();
			} else {
				// the block's own summary line was dropped, so its exact durations ride on this bracket;
				// applied before the scene comes back, so the re-render shows the corrected turn counts
				if (kwArgs.analysisdurations) this.applyAnalysisDurations(kwArgs.analysisdurations);
				this.endAnalysisResync();
			}
			return;
		}
		if (kwArgs.analysisresync && this.applyAnalysisResync(args)) return;
		super.runMinor(args, kwArgs, nextArgs, nextKwargs);
		if (args[0] === '-message' && kwArgs.analysisdurations) this.applyAnalysisDurations(kwArgs.analysisdurations);
		// `|-message|analysiscounter|POKEMON|toxic|3|[silent]`: the toxic and sleep counters an edit set
		if (args[0] === '-message' && args[1] === 'analysiscounter') {
			const pokemon = this.getPokemon(args[2]);
			const turns = Number(args[4]);
			if (pokemon && turns >= 0) {
				if (args[3] === 'toxic') pokemon.statusData.toxicTurns = turns;
				if (args[3] === 'sleep') pokemon.statusData.sleepTurns = turns;
				// Rage Fist's base power; the renderer only counts hits it watched land
				if (args[3] === 'timesattacked') pokemon.timesAttacked = turns;
			}
		}
		/*
		 * `|-message|analysisfaintcounter|SIDE|N|[silent]`: how many Pokémon have fainted on that side, which
		 * an imported replay restores. The renderer's own tally only counts faints it watched happen, and a
		 * reconstructed position never watched any — so Last Respects and Supreme Overlord would read 0 in
		 * the tooltips while the sim had the real number.
		 */
		if (args[0] === '-message' && args[1] === 'analysisfaintcounter') {
			const side = this.sides[args[2] === 'p1' ? 0 : 1];
			const fainted = Number(args[3]);
			if (side && fainted >= 0) side.faintCounter = fainted;
		}
		/*
		 * `|-message|analysisfaint|SIDE|TEAMSLOT|1|[silent]`: an edit fainted or revived a **benched** Pokémon,
		 * so its team icon greys out or comes back (`Dex.getPokemonIcon` reads `fainted`).
		 *
		 * The protocol can say neither. `|faint|` assumes an active Pokémon and throws on one the renderer has
		 * never seen, since team-preview entries have no ident until they switch in, and there is no revive
		 * line at all. That is also why this names the Pokémon by team slot — the order the renderer keeps its
		 * own `side.pokemon` in — rather than by an ident `getPokemon` may fail to resolve.
		 */
		if (args[0] === '-message' && args[1] === 'analysisfaint') {
			const side = this.sides[args[2] === 'p1' ? 0 : 1];
			const pokemon = side?.pokemon[Number(args[3])];
			if (pokemon) {
				pokemon.fainted = args[4] === '1';
				if (pokemon.fainted) {
					pokemon.hp = 0;
					pokemon.status = '';
				} else if (!pokemon.hp) {
					// the `-sethp` that follows corrects this whenever it can resolve the Pokémon; when it
					// can't, the renderer never knew this Pokémon's HP in the first place
					pokemon.hp = pokemon.maxhp;
				}
				this.scene.updateSidebar(side);
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
