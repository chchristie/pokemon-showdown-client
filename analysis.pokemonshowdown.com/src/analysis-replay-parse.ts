/**
 * Replay import, stage A: turn a spectator replay log into two inferred teams plus one absolute state
 * snapshot per turn. See docs/analysis/replay-import-audit.md.
 *
 * The parse runs the play client's own `Battle` headlessly (it instantiates `BattleSceneStub` when given
 * no frames), because that class already is a protocol-to-state reconstructor. Nothing here talks to the
 * analysis API; the caller turns these turns into nodes.
 *
 * Two things to keep in mind throughout:
 * - **A replay only ever shows percentage HP.** Exact HP needs a max HP, which needs EVs and IVs, which a
 *   replay never reveals — not even open team sheets, whose EV and IV fields are empty. So HP is emitted
 *   as `hpPercent` and resolved against the user's finished team when the edit applies.
 * - **A reconstructed position is a fresh battle at turn 1**, so every "since switch-in" and
 *   "once per battle" counter sits at its initial value unless we restore it. That is what the history
 *   counters below are for; without them Fake Out succeeds from a Pokémon that has been out all game.
 */

import { Battle } from '../../play.pokemonshowdown.com/src/battle';
import { Dex, toID } from '../../play.pokemonshowdown.com/src/battle-dex';
import type {
	AnalysisChoiceSummary, AnalysisEdits, AnalysisReplayAction, AnalysisSideID, AnalysisTurnEventSummary,
} from './analysis-model';
import { getLogTurnEventSummary } from './analysis-turn-events';

/** One turn of the replay, as absolute state. `edits` describe the whole position, not a delta. */
export interface AnalysisReplayTurn {
	turn: number;
	edits: AnalysisEdits;
	/**
	 * What each side did this turn, one entry per active slot. These become the node's **drafted choices**
	 * once the position exists (`replayInputLog`), so they show up in the Action Summary and can be
	 * submitted or altered like any other draft — not just as a label in Lines.
	 *
	 * A slot whose action can't be read off the log — a Pokémon that flinched, or was fully paralysed —
	 * carries no move or switch, and stays undecided exactly as one the user hasn't picked.
	 */
	actions: AnalysisReplayAction[];
	/** What the turn actually did, for the Lines outcome tooltip. */
	turnEventSummary: AnalysisTurnEventSummary[];
	/**
	 * The final position, after the last turn resolved. Not a turn at all: it carries the same absolute
	 * snapshot as one, but there is nothing left to choose there, so the UI shows only the turn controls.
	 */
	gameOver?: { winner: string };
}

/** Which Pokémon were on the field, per side and slot, when a turn began. */
interface ReplayTurnActive {
	side: AnalysisSideID;
	slot: number;
	species: string;
}

export interface AnalysisReplayImport {
	formatId: string;
	gameType: string;
	gen: number;
	players: { p1: string, p2: string };
	/** One set per roster entry, in the order the client revealed them; the index is the team slot. */
	teams: { p1: any[], p2: any[] };
	/** Team Preview bring-count, or null when the format brings everyone. */
	teamSize: { p1: number, p2: number } | null;
	/** Team slots that were actually seen on the field. The rest were never revealed. */
	revealed: { p1: number[], p2: number[] };
	turns: AnalysisReplayTurn[];
	/** Things the reconstruction could not determine, for the caller to surface. */
	warnings: string[];
}

/** The client's sentinel max HP for a Pokémon whose real HP has never been shown. */
const UNREVEALED_MAXHP = 1000;

/** Every boost the edit layer understands, so a snapshot can state the whole table rather than a delta. */
const BOOST_STATS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;

/**
 * Per-Pokémon history the protocol doesn't carry but the sim reads. Tracked by scanning the log rather
 * than read off the client `Battle`, which has no field for any of it.
 */
interface ReplayHistory {
	/** Turns since this Pokémon last switched in. Speed Boost, Stakeout, Slow Start, Octolock. */
	activeTurns: number;
	/** Move actions since it last switched in. Fake Out, First Impression, Mat Block. */
	activeMoveActions: number;
	/** Damaging hits taken, for Rage Fist. The client's own count is a heuristic; this mirrors it. */
	timesAttacked: number;
	/** Consecutive successful Protect-likes, for the stall counter. */
	stallCount: number;
	lastMove: string;
	/**
	 * Arguments the client `Battle` throws away. Its `-start` handler calls `addVolatile(effect.id)` and
	 * drops `args[3]`, so *which* move a Disable locked is absent from its state — but the replay log says
	 * it outright (`|-start|p1b: Ceruledge|Disable|Shadow Sneak|[from] ability: Cursed Body`), and we are
	 * reading the raw lines anyway.
	 */
	volatilePayloads: { [id: string]: string };
}

function newHistory(): ReplayHistory {
	return { activeTurns: 0, activeMoveActions: 0, timesAttacked: 0, stallCount: 0, lastMove: '', volatilePayloads: {} };
}

/**
 * Parses a full replay log. `log` is the raw protocol, one line per entry, exactly as the `.log` endpoint
 * and the `battle-log-data` script block carry it.
 */
export function parseAnalysisReplay(log: string[]): AnalysisReplayImport {
	const battle = new Battle({ log, paused: true });
	const warnings: string[] = [];

	// Per side, per roster index. Rebuilt lazily because the client replaces team-preview Pokémon objects
	// on their first switch-in, so keying by object identity would lose everything learned before that.
	const history: { [sideAndSlot: string]: ReplayHistory } = {};
	const revealed: { p1: Set<number>, p2: Set<number> } = { p1: new Set(), p2: new Set() };
	const turns: AnalysisReplayTurn[] = [];
	const activesAtTurnStart: ReplayTurnActive[][] = [];

	// Step the queue by hand. `seekTurn` yields to setTimeout on long logs, and `resetStep` ends by
	// calling `nextStep`, which would run the whole thing; a fresh paused Battle is already at step 0.
	let winner: string | null = null;
	while (battle.currentStep < battle.stepQueue.length) {
		const line = battle.stepQueue[battle.currentStep];
		battle.run(line);
		battle.currentStep++;
		applyHistoryLine(battle, line, history, revealed);
		// A `|turn|N` line means turn N is about to be chosen, so the state now is the start of turn N.
		if (line.startsWith('|turn|')) {
			turns.push({
				turn: battle.turn,
				edits: snapshotEdits(battle, history),
				actions: [],
				turnEventSummary: [],
			});
			activesAtTurnStart.push(readActives(battle));
		}
		if (line.startsWith('|win|')) winner = line.split('|')[2] || '';
		else if (line.startsWith('|tie|')) winner = '';
	}
	/*
	 * The last `|turn|` is not the last position. The turn that decided the game plays out after it, so a
	 * replay ending in a KO had nowhere to show the result at all — the final node was the *start* of the
	 * last turn (user request, 2026-09-19). The end state gets a node of its own.
	 */
	const playedTurns = turns.length;
	if (winner !== null && turns.length) {
		turns.push({
			turn: battle.turn,
			edits: snapshotEdits(battle, history),
			actions: [],
			turnEventSummary: [],
			gameOver: { winner },
		});
	}

	/*
	 * The Lines panel's table and its outcome tooltip, filled in now rather than when a node is first
	 * selected: a replay already says what both sides did, so a node has no reason to read "No action
	 * selected" until it is clicked (user report, 2026-09-19). The end node is skipped — nothing was
	 * chosen there and it has no turn of its own.
	 */
	for (let i = 0; i < playedTurns; i++) {
		// Sliced out of `log` rather than out of `battle.stepQueue`: the client builds its own queue and the
		// two do not share indices, which silently emptied the last turn's actions.
		const start = log.indexOf(`|turn|${turns[i].turn}`);
		if (start < 0) continue;
		const next = log.indexOf(`|turn|${turns[i].turn + 1}`, start + 1);
		const turnLog = log.slice(start + 1, next < 0 ? log.length : next);
		turns[i].actions = turnReplayActions(turnLog, activesAtTurnStart[i], battle.gameType);
		turns[i].turnEventSummary = getLogTurnEventSummary(log, turns[i].turn);
	}

	const teams = { p1: inferTeam(battle, 'p1', warnings), p2: inferTeam(battle, 'p2', warnings) };
	return {
		formatId: toID(battle.tier),
		gameType: battle.gameType,
		gen: battle.gen,
		players: { p1: battle.sides[0]?.name || 'Player 1', p2: battle.sides[1]?.name || 'Player 2' },
		teams,
		teamSize: readTeamSize(battle, teams),
		revealed: { p1: sortedSlots(revealed.p1), p2: sortedSlots(revealed.p2) },
		turns,
		warnings,
	};
}

/** Who is on the field right now, per side and slot, as the species the Lines table shows an icon for. */
function readActives(battle: any): ReplayTurnActive[] {
	const actives: ReplayTurnActive[] = [];
	for (let i = 0; i < 2; i++) {
		const side = battle.sides[i];
		if (!side) continue;
		const sideId: AnalysisSideID = i === 0 ? 'p1' : 'p2';
		for (let slot = 0; slot < side.active.length; slot++) {
			const pokemon = side.active[slot];
			if (pokemon) actives.push({ side: sideId, slot, species: pokemon.speciesForme });
		}
	}
	return actives;
}

/** Team Preview brings fewer than the roster in VGC-likes; null when everyone is brought. */
function readTeamSize(battle: any, teams: { p1: any[], p2: any[] }) {
	const p1 = battle.sides[0]?.totalPokemon ?? teams.p1.length;
	const p2 = battle.sides[1]?.totalPokemon ?? teams.p2.length;
	if (p1 >= teams.p1.length && p2 >= teams.p2.length) return null;
	return { p1, p2 };
}

/** `p1a: Nickname` → the Pokémon's index in its side's roster, which is the team slot we emit. */
function slotOf(battle: any, ident: string): { side: 'p1' | 'p2', slot: number } | null {
	const match = /^(p[12])[a-z]?: /.exec(ident);
	if (!match) return null;
	const side = match[1] as 'p1' | 'p2';
	const pokemon = battle.getPokemon(ident);
	if (!pokemon) return null;
	const slot = battle.sides[side === 'p1' ? 0 : 1].pokemon.indexOf(pokemon);
	return slot < 0 ? null : { side, slot };
}

function historyFor(history: { [key: string]: ReplayHistory }, side: string, slot: number) {
	const key = `${side}:${slot}`;
	return (history[key] ||= newHistory());
}

/** Protect-likes that feed the sim's `stall` volatile, whose counter halves the next one's odds. */
const STALL_MOVES = [
	'protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker', 'obstruct', 'silktrap',
	'burningbulwark', 'endure', 'maxguard',
];

/**
 * Updates the counters the protocol doesn't carry. Run *after* `battle.run(line)`, so idents resolve
 * against the state the line produced.
 */
function applyHistoryLine(
	battle: any, line: string, history: { [key: string]: ReplayHistory },
	revealed: { p1: Set<number>, p2: Set<number> }
) {
	const parts = line.split('|');
	const command = parts[1];
	if (!command) return;

	if (command === 'turn') {
		// `activeTurns` counts turns spent on the field, and the sim increments it at the end of a turn.
		for (let i = 0; i < battle.sides.length; i++) {
			const side = battle.sides[i];
			const sideId = i === 0 ? 'p1' : 'p2';
			for (const pokemon of side.active) {
				if (!pokemon) continue;
				// Resolve against the object we already hold rather than re-looking it up by ident.
				const slot = side.pokemon.indexOf(pokemon);
				if (slot >= 0) historyFor(history, sideId, slot).activeTurns++;
			}
		}
		return;
	}

	const found = slotOf(battle, parts[2] || '');
	if (!found) return;
	const entry = historyFor(history, found.side, found.slot);

	switch (command) {
	case 'switch': case 'drag': case 'replace':
		revealed[found.side].add(found.slot);
		// A switch-in resets everything "since switch-in", exactly as `BattleActions.switchIn` does.
		entry.activeTurns = 0;
		entry.activeMoveActions = 0;
		entry.stallCount = 0;
		entry.lastMove = '';
		entry.volatilePayloads = {};
		break;
	case 'move': {
		entry.activeMoveActions++;
		entry.lastMove = toID(parts[3]);
		// The sim's `stall` volatile ends the moment a non-stalling move is used.
		if (!STALL_MOVES.includes(entry.lastMove)) entry.stallCount = 0;
		break;
	}
	case '-start':
		// `|-start|POKEMON|Disable|Shadow Sneak|...` — keep the argument the client discards.
		// A real payload is a bare argument; `[from]`/`[of]` and friends are keywords, not the move.
		if (parts[3] && parts[4] && !parts[4].startsWith('[')) {
			entry.volatilePayloads[toID(parts[3])] = parts[4];
		}
		break;
	case '-end':
		if (parts[3]) delete entry.volatilePayloads[toID(parts[3])];
		break;
	case '-singleturn':
		// Emitted when a Protect-like actually takes effect, which is when the sim bumps the counter.
		if (STALL_MOVES.includes(toID(parts[3]))) entry.stallCount++;
		break;
	case '-damage':
		// Mirrors the client's own heuristic: a damage line with no `[from]` is a hit from a move.
		if (!line.includes('|[from]')) entry.timesAttacked++;
		break;
	}
}

/**
 * The action each side took this turn, read off the turn's own lines.
 *
 * Only what the log states outright is claimed. A Pokémon that flinched or was fully paralysed shows a
 * `|cant|` and no move, and a replay never says what it had been told to do, so that slot keeps the same
 * "No action selected" a slot the user hasn't decided gets.
 *
 * The distinctions that matter, all of them positional:
 * - a **called** move (Dancer, Instruct, Metronome) carries `[from]` and is not a choice;
 * - a Pokémon acts once, so the first move a position makes is its choice — the switch a pivot move causes
 *   comes after it and is ignored;
 * - a switch after a **faint** at that position is a replacement, not a choice, and neither is a `|drag|`.
 */
function turnReplayActions(
	turnLog: string[], actives: ReplayTurnActive[], gameType: string
): AnalysisReplayAction[] {
	const acted = new Set<string>();
	const fainted = new Set<string>();
	const chosen: { [position: string]: AnalysisReplayAction } = {};
	const speciesAt: { [position: string]: string } = {};
	const positionOf = (ident: string) => (ident || '').split(':')[0];
	for (const active of actives) {
		speciesAt[`${active.side}${'abcdef'[active.slot]}`] = active.species;
	}
	const speciesOf = (ident: string) =>
		speciesAt[positionOf(ident)] || (ident || '').replace(/^p[12][a-z]?: /, '').split(',')[0];
	// An action exists for every slot that was on the field, so an undecided one is stated rather than
	// missing; the extras are filled in below.
	for (const active of actives) {
		chosen[`${active.side}${'abcdef'[active.slot]}`] = {
			side: active.side, slot: active.slot, pokemon: active.species,
		};
	}

	for (const line of turnLog) {
		const parts = line.split('|');
		const position = positionOf(parts[2] || '');
		const action = chosen[position];
		if (!action) continue;
		switch (parts[1]) {
		case 'faint':
			fainted.add(position);
			break;
		case '-terastallize':
			action.terastallize = true;
			break;
		case '-mega':
			action.mega = true;
			break;
		case 'move': {
			if (acted.has(position) || line.includes('|[from]')) break;
			acted.add(position);
			action.moveId = toID(parts[3] || '');
			action.moveName = parts[3] || 'Move';
			// A self-targeting move names its own user as the target, which reads as nonsense ("Protect →
			// Ceruledge"); and in singles there is only ever one target worth naming.
			const target = parts[4] || '';
			if (gameType !== 'singles' && target && !target.startsWith('[') && positionOf(target) !== position) {
				action.targetPosition = positionOf(target);
				action.targetPokemon = speciesOf(target);
			}
			break;
		}
		case 'switch':
			// a replacement for something that fainted, or the other half of a pivot move
			if (acted.has(position) || fainted.has(position) || line.includes('|[from]')) break;
			acted.add(position);
			// the Pokémon coming *in*, which is the details on the line rather than the slot's old occupant
			action.switchTo = (parts[3] || '').split(',')[0];
			break;
		}
	}

	const actions: AnalysisReplayAction[] = [];
	for (const active of actives) actions.push(chosen[`${active.side}${'abcdef'[active.slot]}`]);
	return actions;
}

/** The same actions as the Lines table shows them, for before the position they belong to exists. */
export function replayChoiceSummary(actions: AnalysisReplayAction[]): AnalysisChoiceSummary[] {
	const choices: AnalysisChoiceSummary[] = [];
	for (const action of actions) {
		const modifiers: string[] = [];
		if (action.terastallize) modifiers.push('Terastallize');
		if (action.mega) modifiers.push('Mega-Evolve');
		const name = action.moveName || (action.switchTo ? 'Switch to' : '');
		choices.push({
			side: action.side,
			slot: action.slot,
			pokemon: action.pokemon,
			action: name ? [...modifiers, name].join(', ') : 'No action selected',
			moveId: action.moveId,
			targetPokemon: action.switchTo || action.targetPokemon,
		});
	}
	return choices;
}

/** Reads the whole position off the client `Battle` as one absolute edit set. */
function snapshotEdits(battle: any, history: { [key: string]: ReplayHistory }): AnalysisEdits {
	const edits: AnalysisEdits = { active: {}, pokemon: {}, field: {} };

	for (let i = 0; i < 2; i++) {
		const side = battle.sides[i];
		if (!side) continue;
		const sideId: 'p1' | 'p2' = i === 0 ? 'p1' : 'p2';

		// An explicit loop, not `.map`: a closure capturing the loop-scoped `side` fails the client build
		// (`throwIfClosureRequired`).
		const active: (number | null)[] = [];
		for (const pokemon of side.active) {
			active.push(pokemon ? side.pokemon.indexOf(pokemon) : null);
		}
		edits.active![sideId] = active;

		for (let slot = 0; slot < side.pokemon.length; slot++) {
			const pokemon = side.pokemon[slot];
			// A Pokémon that never switched in keeps the client's sentinel max HP, so nothing about its
			// battle state is known and there is nothing to restore.
			if (!pokemon || pokemon.maxhp === UNREVEALED_MAXHP) continue;
			const isActive = side.active.indexOf(pokemon) >= 0;
			edits.pokemon![`${sideId}:${slot}`] =
				pokemonEdit(pokemon, historyFor(history, sideId, slot), isActive, battle.dex || Dex);
		}

		const conditions: { [id: string]: { duration?: number, layers?: number } } = {};
		for (const id in side.sideConditions) {
			const [, levels, minTimeLeft] = side.sideConditions[id];
			conditions[id] = {};
			// The client only estimates turns remaining; `0` means it has no upper bound to offer.
			if (minTimeLeft > 0) conditions[id].duration = minTimeLeft;
			// Always state layers: omitting them makes the server fall back to the condition's standard
			// value, which for Spikes is the maximum rather than the one layer actually down.
			if (levels >= 1) conditions[id].layers = levels;
		}
		(edits.field!.sides ||= {})[sideId] = conditions;
	}

	edits.field!.weather = battle.weather ?
		{ id: battle.weather, duration: battle.weatherMinTimeLeft || undefined } : null;
	const pseudoWeather: { [id: string]: { duration?: number } } = {};
	for (const [name, minTimeLeft] of battle.pseudoWeather) {
		pseudoWeather[toID(name)] = minTimeLeft > 0 ? { duration: minTimeLeft } : {};
	}
	edits.field!.pseudoWeather = pseudoWeather;
	return edits;
}

/**
 * How much PP each of a Pokémon's moves has been seen to cost, for the server to subtract from the real
 * maximum (`ppUsed`).
 *
 * **Uses, not remaining PP.** A replay says how many times a move was used, never how many uses it started
 * with, and only the sim knows that — a mod may replace the formula outright, as Champions does, so a
 * client that subtracts for itself gets every value wrong. Worse, it fails *silently*: the server clamps to
 * the real maximum, so an overestimate comes back as full PP and nothing looks broken (user report).
 *
 * The client counts uses in `moveTrack`, **Pressure included** — a foe with Pressure makes a move cost two,
 * and it works that out for us. Two entries need care:
 *
 * - a **pair** is the client's "this foe might have had Pressure" range, and the low end is taken. Giving a
 *   move less PP than it really has can block a line of play; giving it more only costs a little realism.
 * - `Infinity` means the move was revealed without the client knowing what it cost (Mimic and friends), so
 *   it is left alone rather than driven to zero.
 */
function spentPP(pokemon: any, dex: any) {
	const ppUsed: { [moveid: string]: number } = {};
	for (const tracked of pokemon.moveTrack || []) {
		const name: string = tracked[0];
		// a '*'-prefixed entry is a Transform copy, not one of this Pokémon's own moves
		if (name.startsWith('*')) continue;
		const used: number = Array.isArray(tracked[1]) ? tracked[1][0] : tracked[1];
		if (!isFinite(used) || used <= 0) continue;
		const move = dex.moves.get(name);
		if (!move?.exists) continue;
		ppUsed[move.id] = used;
	}
	return Object.keys(ppUsed).length ? ppUsed : null;
}

function pokemonEdit(pokemon: any, entry: ReplayHistory, isActive: boolean, dex: any) {
	const edit: any = {
		// Percentage, never an absolute number: the real max HP depends on EVs and IVs a replay never
		// shows, so the server resolves this against the team the user finished.
		hpPercent: pokemon.maxhp ? (pokemon.hp / pokemon.maxhp) * 100 : 100,
		// Rage Fist's counter survives switching, so it is restored for benched Pokémon too.
		timesAttacked: entry.timesAttacked,
	};
	// A fainted Pokémon has no other state worth restoring, and the server refuses most of it anyway
	// (status and the transformations are all vetoed once something has fainted).
	if (pokemon.fainted) return edit;
	edit.status = pokemon.status || '';
	// PP the replay watched being spent. It survives switching out, so it is restored for the whole team,
	// not just whoever is on the field.
	const ppUsed = spentPP(pokemon, dex);
	if (ppUsed) edit.ppUsed = ppUsed;
	// The rest are "since switch-in" and the sim zeroes them the moment a Pokémon is sent out, so they
	// only mean anything for whoever is on the field.
	if (isActive) {
		// Boosts and volatiles are cleared on switch-out, so the server refuses them for a benched
		// Pokémon; sending them anyway would fill `droppedEdits` with noise on every single turn.
		//
		// **Every stat, zeros included.** The client only keeps non-zero boosts, but the edit layer's
		// `boosts` is a *delta* — the Pokémon panel sends only what the user changed — so an omitted stat
		// keeps whatever the reconstruction happens to have. A fresh battle's opening switch-in fires entry
		// abilities, so a replay where Intimidate never touched a Pokémon was reconstructing it at -1 Atk
		// (user report, 2026-09-19). Stating the whole table makes the snapshot absolute without changing
		// what `boosts` means for the panel.
		edit.boosts = {};
		for (const stat of BOOST_STATS) edit.boosts[stat] = pokemon.boosts?.[stat] || 0;
		// Only the id and, where the log gave one, the payload the client dropped; the server's VOLATILES
		// table fills in every other default, so there is one authority on what a volatile looks like.
		const volatiles: { [id: string]: { move?: string } } = {};
		for (const id in pokemon.volatiles || {}) {
			const payload = entry.volatilePayloads[id];
			volatiles[id] = payload ? { move: toID(payload) } : {};
		}
		edit.volatiles = volatiles;
		edit.activeTurns = entry.activeTurns;
		edit.activeMoveActions = entry.activeMoveActions;
		edit.lastMove = entry.lastMove;
		edit.stallCount = entry.stallCount;
	}
	// Current item and ability, deliberately separate from the set: a Pokémon that ate its berry still has
	// it on its team, and Trace or a Mega Evolution changes the ability without changing the set.
	// The client writes '' for both "no item" and "never revealed", so only claim what the replay showed:
	// a known item, or a known loss (`prevItem` set, meaning we watched it go).
	if (pokemon.item) edit.item = pokemon.item;
	else if (pokemon.prevItem) edit.item = '';
	if (pokemon.ability) edit.ability = pokemon.ability;

	if (pokemon.status === 'tox') edit.toxicStage = pokemon.statusData?.toxicTurns || 0;
	// The client only counts sleep turns it saw a `|cant|` for, so this is a floor, not the real value.
	if (pokemon.status === 'slp') edit.sleepTurns = pokemon.statusData?.sleepTurns || 1;
	// The server refuses both on a fainted Pokémon, and neither matters there anyway.
	if (!pokemon.fainted) {
		if (pokemon.terastallized) edit.terastallized = true;
		// A Mega/Primal forme is something that happened during the battle, not what the team holds.
		if (Dex.species.get(pokemon.speciesForme).isMega) edit.megaEvolved = true;
	}

	return edit;
}

/**
 * One set per roster entry, built from everything the whole replay revealed rather than from the state at
 * any one turn — the team is a single object the user completes once and every node then applies against.
 */
function inferTeam(battle: any, sideId: 'p1' | 'p2', warnings: string[]) {
	const side = battle.sides[sideId === 'p1' ? 0 : 1];
	if (!side) return [];
	return side.pokemon.map((pokemon: any, slot: number) => {
		// A team holds the base forme: Mega Gengar is Gengar plus a Gengarite, and the forme change is
		// per-node state. `battleOnly` names the forme to go back to (Mega, Primal, Ultra Burst).
		const current = Dex.species.get(pokemon.speciesForme);
		const battleOnly = typeof current.battleOnly === 'string' ? current.battleOnly : current.baseSpecies;
		const species = current.isMega || current.isPrimal ? Dex.species.get(battleOnly) : current;
		const moves = (pokemon.moveTrack || [])
			.map(([name]: [string, number]) => name)
			// Transform copies are stored '*'-prefixed and aren't the Pokémon's own moves.
			.filter((name: string) => !name.startsWith('*'));
		// An item that was consumed or knocked off still belongs on the team.
		const item = pokemon.item || pokemon.prevItem || '';
		// `baseAbility` is clobbered by Mega Evolution (Mega Gengar reads Shadow Tag where the sheet said
		// Cursed Body), so for a reverted forme fall back to the base species' own ability.
		const trustAbility = pokemon.baseAbility && species === current;
		// Named the way the rest of the tool names a Pokémon: the species, then which team it is on. The
		// roster position it happens to sit at is of no use to the reader.
		const label = `${species.name} (${sideId === 'p1' ? 1 : 2})`;
		if (!trustAbility && species.abilities) {
			warnings.push(`${label}: ability not revealed, guessed.`);
		}
		if (!moves.length) warnings.push(`${label}: no moves revealed.`);
		return {
			name: pokemon.name || species.name,
			species: species.name,
			item,
			// Neutral defaults where one exists; blank where guessing would be fiction (audit, QF).
			ability: (trustAbility ? pokemon.baseAbility : '') || species.abilities?.['0'] || '',
			moves,
			nature: pokemon.nature || 'Serious',
			evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
			ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
			gender: pokemon.gender || '',
			level: pokemon.level || 100,
			shiny: !!pokemon.shiny,
			teraType: pokemon.teraType || '',
		};
	});
}

/** `[...set]` compiles to `[set]` under this client's Babel config, so build the array by hand. */
function sortedSlots(slots: Set<number>) {
	const out: number[] = [];
	slots.forEach(slot => out.push(slot));
	return out.sort((a, b) => a - b);
}
