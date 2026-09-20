/**
 * Draft choices for both sides at the current decision point: which move/switch each
 * active slot has picked, pending target selection, and the BattleChoiceBuilders that
 * validate them. Rendering and battle-dependent logic stay in analysis.tsx.
 */
import { BattleChoiceBuilder } from '../../play.pokemonshowdown.com/src/battle-choices';
import type { AnalysisSideID, AnalysisSideSnapshot, AnalysisSnapshot } from './analysis-model';

export interface PendingTarget {
	side: AnalysisSideID;
	index: number;
	choice: string;
	targetType: string;
}

type SlotChoices = { p1: (string | null)[], p2: (string | null)[] };

const INPUT_LINE = /^>p([12])\s+(.+)$/;

export function sideIndex(side: AnalysisSideID) {
	return side === 'p1' ? 0 : 1;
}

function activePokemon(side: AnalysisSideSnapshot, slot: number) {
	const index = side.active[slot];
	return index === null || index === undefined ? null : side.pokemon[index] || null;
}

/** `move N` still means what it did only if slot N holds the same move, on the same Pokémon. */
function isStaleMove(before: AnalysisSideSnapshot, after: AnalysisSideSnapshot, slot: number, choice: string) {
	const index = Number(/^move (\d+)/.exec(choice)?.[1]);
	if (!index) return false;
	const beforePokemon = activePokemon(before, slot);
	const afterPokemon = activePokemon(after, slot);
	// the slot's own Pokémon changing is reported separately, through edits.active
	if (!beforePokemon || !afterPokemon || beforePokemon.teamSlot !== afterPokemon.teamSlot) return false;
	const beforeMove = beforePokemon.moves[index - 1];
	const afterMove = afterPokemon.moves[index - 1];
	return !afterMove || beforeMove?.id !== afterMove.id;
}

/** `switch N` names a position in the roster, which a team edit can repoint at a different Pokémon. */
function isStaleSwitch(before: AnalysisSideSnapshot, after: AnalysisSideSnapshot, choice: string) {
	const index = Number(/^switch (\d+)/.exec(choice)?.[1]);
	if (!index) return false;
	const beforeTarget = before.pokemon[index - 1];
	const afterTarget = after.pokemon[index - 1];
	return !afterTarget || beforeTarget?.teamSlot !== afterTarget.teamSlot;
}

/**
 * Active slots whose drafted action a team edit invalidated: a chosen move whose slot now holds a
 * different move (or none), or a chosen switch whose target position now holds a different Pokémon.
 * Compare the snapshots from before and after the save.
 */
export function getStaleChoiceSlots(
	before: AnalysisSnapshot | undefined, after: AnalysisSnapshot | undefined, draft: AnalysisChoiceDraft
) {
	const stale: { side: AnalysisSideID, slot: number }[] = [];
	if (!before || !after) return stale;
	for (const side of ['p1', 'p2'] as const) {
		const beforeSide = before.sides[sideIndex(side)];
		const afterSide = after.sides[sideIndex(side)];
		if (!beforeSide || !afterSide) continue;
		const moves = draft.moveChoicesBySlot[side];
		const switches = draft.switchChoicesBySlot[side];
		for (let slot = 0; slot < Math.max(moves.length, switches.length); slot++) {
			const move = moves[slot];
			const switchChoice = switches[slot];
			if (move ? isStaleMove(beforeSide, afterSide, slot, move) :
				!!switchChoice && isStaleSwitch(beforeSide, afterSide, switchChoice)) {
				stale.push({ side, slot });
			}
		}
	}
	return stale;
}

export class AnalysisChoiceDraft {
	builders: { p1: BattleChoiceBuilder | null, p2: BattleChoiceBuilder | null } = { p1: null, p2: null };
	moveChoicesBySlot: SlotChoices = { p1: [], p2: [] };
	switchChoicesBySlot: SlotChoices = { p1: [], p2: [] };
	pendingTarget: PendingTarget | null = null;
	/** the active slot whose action is being chosen */
	choiceSide: { side: AnalysisSideID, index: number } | null = null;
	/** choices before entering selection, restored on cancel */
	snapshot: { moves: SlotChoices, switches: SlotChoices } | null = null;

	/** Clears all choices and creates fresh builders for the given requests. */
	reset(requests: any[] | undefined, gameType = '') {
		this.choiceSide = null;
		this.pendingTarget = null;
		this.moveChoicesBySlot = { p1: [], p2: [] };
		this.switchChoicesBySlot = { p1: [], p2: [] };
		const normalize = (request: any) => {
			if (!request) return null;
			if (request.teamPreview) {
				let chosenTeamSize = request.chosenTeamSize || request.maxChosenTeamSize;
				if (!chosenTeamSize) {
					chosenTeamSize = gameType === 'doubles' ? 2 : gameType === 'triples' || gameType === 'rotation' ? 3 : 1;
				}
				return { ...request, requestType: 'team', chosenTeamSize };
			}
			if (request.forceSwitch) return { ...request, requestType: 'switch' };
			if (request.active) return { ...request, requestType: 'move' };
			return { ...request, requestType: 'wait' };
		};
		const p1 = normalize(requests?.[0]);
		const p2 = normalize(requests?.[1]);
		this.builders = {
			p1: p1 ? new BattleChoiceBuilder(p1) : null,
			p2: p2 ? new BattleChoiceBuilder(p2) : null,
		};
	}

	rebuildMoveBuilder(side: AnalysisSideID, request: any) {
		const builder = new BattleChoiceBuilder({ ...request, requestType: 'move' });
		const choices = this.moveChoicesBySlot[side];
		for (let index = 0; index < (request.active?.length || 0); index++) {
			if (choices[index]) builder.addChoice(choices[index]!);
			else if (request.active[index]) builder.choices.push('pass');
		}
		this.builders[side] = builder;
	}

	rebuildSwitchBuilder(side: AnalysisSideID, request: any) {
		const builder = new BattleChoiceBuilder({ ...request, requestType: 'switch' });
		const choices = this.switchChoicesBySlot[side];
		const slots: number[] = request.forceSwitch ?
			request.forceSwitch
				.map((required: boolean, slot: number) => required ? slot : -1)
				.filter((slot: number) => slot >= 0) :
			[0];
		for (const slot of slots) {
			if (choices[slot]) builder.addChoice(choices[slot]);
		}
		this.builders[side] = builder;
	}

	/**
	 * Re-applies saved `>pN choice` lines to the current builders.
	 *
	 * `skip` drops the choices for those slots instead of replaying them. A team edit can leave a choice
	 * naming a move slot or a switch target that no longer exists, and `addChoices` abandons the rest of
	 * the line at the first one it can't parse, which would silently lose the other slot's valid choice.
	 * Such a line is applied slot by slot instead, and the builder rebuilt (it pads skipped slots with
	 * `pass`, which `addChoice` itself refuses).
	 */
	hydrate(inputLog: string[], requests?: any[], skip?: { side: AnalysisSideID, slot: number }[]) {
		for (const line of inputLog) {
			const match = INPUT_LINE.exec(line);
			if (!match) continue;
			const side = match[1] === '1' ? 'p1' : 'p2';
			const builder = this.builders[side];
			if (!builder) continue;
			// an inner loop, not .filter: a closure over the loop variable fails the client build
			const skipped: number[] = [];
			for (const entry of skip || []) {
				if (entry.side === side) skipped.push(entry.slot);
			}
			const request = requests?.[sideIndex(side)];
			if (skipped.length && request?.active) {
				const parts = match[2].split(',').map(part => part.trim());
				for (let slot = 0; slot < parts.length; slot++) {
					if (skipped.includes(slot) || parts[slot] === 'pass') continue;
					if (parts[slot].startsWith('move ')) this.moveChoicesBySlot[side][slot] = parts[slot];
					else if (parts[slot].startsWith('switch ')) this.switchChoicesBySlot[side][slot] = parts[slot];
				}
				this.rebuildMoveBuilder(side, request);
				continue;
			}
			builder.addChoices(match[2]);
			for (let index = 0; index < builder.choices.length; index++) {
				const choice = builder.choices[index];
				if (choice.startsWith('move ')) this.moveChoicesBySlot[side][index] = choice;
				if (choice.startsWith('switch ')) this.switchChoicesBySlot[side][index] = choice;
			}
		}
	}

	/** The draft as `>pN choice` lines; sides with nothing chosen are omitted. */
	toInputLog(requests: any[] | undefined) {
		const inputLog: string[] = [];
		for (const side of ['p1', 'p2'] as const) {
			const request = requests?.[sideIndex(side)];
			if (request?.active) {
				const choices = this.slotChoices(request, side);
				if (choices.some(choice => choice !== 'pass')) inputLog.push(`>${side} ${choices.join(', ')}`);
				continue;
			}
			const builder = this.builders[side];
			if (builder && !builder.isEmpty()) inputLog.push(`>${side} ${builder.toString()}`);
		}
		return inputLog;
	}

	private slotChoices(request: any, side: AnalysisSideID) {
		return request.active.map((active: any, index: number) => active ?
			this.moveChoicesBySlot[side][index] || this.switchChoicesBySlot[side][index] || 'pass' :
			'pass') as string[];
	}

	/** Whether every active slot on this side has an action (move requests only). */
	actionChoicesReady(requests: any[] | undefined, side: AnalysisSideID) {
		const request = requests?.[sideIndex(side)];
		if (!request?.active) return false;
		if (this.pendingTarget?.side === side) return false;
		return request.active.every((active: any, index: number) =>
			!active || !!this.moveChoicesBySlot[side][index] || !!this.switchChoicesBySlot[side][index]);
	}

	actionChoiceString(requests: any[] | undefined, side: AnalysisSideID) {
		const request = requests?.[sideIndex(side)];
		if (!request?.active) return 'default';
		return this.slotChoices(request, side).join(', ');
	}

	saveSnapshot() {
		this.snapshot = {
			moves: { p1: [...this.moveChoicesBySlot.p1], p2: [...this.moveChoicesBySlot.p2] },
			switches: { p1: [...this.switchChoicesBySlot.p1], p2: [...this.switchChoicesBySlot.p2] },
		};
	}

	/** Restores the choices saved by saveSnapshot, rebuilding builders for `requests`. */
	restoreSnapshot(requests: any[] | undefined, gameType?: string) {
		const snapshot = this.snapshot;
		this.reset(requests, gameType);
		if (snapshot) {
			this.moveChoicesBySlot = { p1: [...snapshot.moves.p1], p2: [...snapshot.moves.p2] };
			this.switchChoicesBySlot = { p1: [...snapshot.switches.p1], p2: [...snapshot.switches.p2] };
			for (const side of ['p1', 'p2'] as const) {
				const request = requests?.[sideIndex(side)];
				if (request?.active) this.rebuildMoveBuilder(side, request);
				if (request?.forceSwitch) this.rebuildSwitchBuilder(side, request);
			}
		}
		this.snapshot = null;
	}
}
