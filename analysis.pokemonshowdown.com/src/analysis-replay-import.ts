/**
 * Replay import, stage C: getting a replay log from a URL or a file, and turning a parsed replay into a
 * tab's worth of nodes. The parsing itself is `analysis-replay-parse.ts`.
 *
 * Everything here runs in the browser. Both replay endpoints send `access-control-allow-origin: *`, and
 * the page already loads the client `Battle` the parser needs, so no server round trip is involved until
 * the position is rebuilt.
 */

import { Teams } from '../../play.pokemonshowdown.com/src/battle-teams';
import type { AnalysisNode, AnalysisReplayAction, AnalysisSideID } from './analysis-model';
import { replayChoiceSummary, type AnalysisReplayImport } from './analysis-replay-parse';

const REPLAY_HOST = 'https://replay.pokemonshowdown.com';

/**
 * Accepts a full replay URL or a bare id, with or without an extension.
 *
 * A private replay's id carries a `-<password>pw` suffix, which is deliberately left alone: passing it
 * through is all the support private replays need (audit, QG).
 */
export function replayIdFromInput(input: string) {
	const trimmed = input.trim();
	if (!trimmed) return '';
	const withoutHost = trimmed.replace(/^https?:\/\/[^/]+\//, '');
	// Drop a trailing extension and any query string, but nothing else.
	return withoutHost.replace(/\?.*$/, '').replace(/\.(json|log|html)$/, '').replace(/\/+$/, '');
}

/** Fetches a replay's log by URL or id. */
export async function fetchReplayLog(input: string) {
	const id = replayIdFromInput(input);
	if (!id) throw new Error('Enter a replay URL or id.');
	const response = await fetch(`${REPLAY_HOST}/${id}.json`);
	if (!response.ok) {
		throw new Error(response.status === 404 ?
			`No replay found at "${id}".` :
			`Couldn't load that replay (${response.status}).`);
	}
	const data = await response.json();
	if (!data?.log) throw new Error('That replay has no battle log.');
	return { log: (data.log as string).split('\n'), id };
}

/**
 * Pulls the log out of a downloaded replay `.html`, or takes a `.log` as-is.
 *
 * The embedded copy is JS-escaped, because it lives inside a `<script>` block: `<\/div>` rather than
 * `</div>`, so the browser doesn't end the script early.
 */
export function readReplayFileText(text: string, filename = '') {
	if (!/\.html?$/i.test(filename) && !/<script/i.test(text)) return text.split('\n');
	const match = /<script[^>]*class="battle-log-data"[^>]*>([\s\S]*?)<\/script>/i.exec(text);
	if (!match) throw new Error("That file doesn't contain a battle log.");
	return match[1].replace(/<\\\//g, '</').trim().split('\n');
}

/**
 * The Team Preview choices for an imported replay: the Pokémon that were actually seen, padded out of the
 * rest of the roster if fewer appeared than were brought.
 *
 * A Pokémon that was brought but never sent out is indistinguishable from one left behind (audit, Q7), so
 * when the replay is short the remaining slots are filled in roster order and the user corrects them in
 * the Team Preview step.
 */
export function teamPreviewPicks(parsed: AnalysisReplayImport, side: 'p1' | 'p2') {
	const size = parsed.teamSize?.[side] ?? parsed.teams[side].length;
	const picks: number[] = [];
	for (const slot of parsed.revealed[side]) {
		if (picks.length < size) picks.push(slot + 1);
	}
	for (let slot = 0; slot < parsed.teams[side].length && picks.length < size; slot++) {
		if (!picks.includes(slot + 1)) picks.push(slot + 1);
	}
	return picks;
}

/**
 * Whether the import needs to ask which Pokémon were brought, and which slots the replay already settled.
 *
 * Only VGC-likes can need it: a format that brings the whole roster has nothing to pick. Even there the
 * question is only worth asking when the replay is short of the bring count — if every brought Pokémon
 * appeared, `teamPreviewPicks` already knows the answer exactly and asking would be busywork.
 *
 * The returned slots are 0-based roster indices, and they are **locked** in the step: the replay proved
 * those Pokémon were brought, so the user only fills the remainder.
 */
export function replayPreviewStep(parsed: AnalysisReplayImport) {
	if (!parsed.teamSize) return null;
	const sides = ['p1', 'p2'] as const;
	let asks = false;
	for (const side of sides) {
		const size = Math.min(parsed.teamSize[side], parsed.teams[side].length);
		if (parsed.revealed[side].length < size) asks = true;
	}
	if (!asks) return null;
	return { p1: [...parsed.revealed.p1], p2: [...parsed.revealed.p2] };
}

/** Move target types the user is asked to aim; anything else hits what it hits and takes no target. */
const AIMED_TARGETS = ['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf'];

/** `p2b` → the slot index its letter stands for. */
function slotOfPosition(position: string) {
	return 'abcdef'.indexOf(position.charAt(2));
}

/**
 * One slot's action as a choice string (`move 2 +1`, `switch 3`), resolved against the live request.
 *
 * Returns `null` when the replay's action can't be expressed here — the move isn't on this Pokémon any
 * more, or the Pokémon it switched to isn't on the team — which leaves the slot undecided rather than
 * guessing. Onboarding and later set edits are free to change both, which is exactly why this is resolved
 * at the last moment instead of being baked in at import.
 */
function replayChoiceString(action: AnalysisReplayAction, request: any, gameType?: string) {
	if (action.switchTo) {
		const roster: any[] = request?.side?.pokemon || [];
		for (let i = 0; i < roster.length; i++) {
			const species = (roster[i]?.details || '').split(',')[0];
			if (species === action.switchTo && !roster[i]?.active) return `switch ${i + 1}`;
		}
		return null;
	}
	if (!action.moveId) return null;
	const moves: any[] = request?.active?.[action.slot]?.moves || [];
	let index = -1;
	for (let i = 0; i < moves.length; i++) {
		if (moves[i]?.id === action.moveId) index = i;
	}
	if (index < 0) return null;
	let choice = `move ${index + 1}`;
	if (gameType !== 'singles' && action.targetPosition) {
		const target = slotOfPosition(action.targetPosition);
		const moveTarget = (window as any).Dex?.moves?.get(action.moveId)?.target || moves[index]?.target;
		// Only moves the user aims take a target; giving a spread move one is rejected outright.
		if (target >= 0 && AIMED_TARGETS.includes(moveTarget)) {
			const foe = action.targetPosition.slice(0, 2) !== action.side;
			choice += ` ${foe ? '+' : '-'}${target + 1}`;
		}
	}
	if (action.terastallize) choice += ' terastallize';
	else if (action.mega) choice += ' mega';
	return choice;
}

/**
 * A replay turn's actions as the `>pN …` lines a node stores, plus the slots that stayed undecided.
 *
 * This is what makes the replay's own choices *real*: they land in `node.inputLog`, so they hydrate the
 * draft like any other node's, show up in the Action Summary, survive selecting the node, and can be
 * submitted or changed one action at a time.
 *
 * An undecided slot is written as `pass` and reported, because `BattleChoiceBuilder.addChoice` refuses
 * `pass` outright — the caller hands the list to `hydrate`, which then applies the line slot by slot.
 */
export function replayInputLog(actions: AnalysisReplayAction[], requests: any[] | undefined, gameType?: string) {
	const inputLog: string[] = [];
	const undecided: { side: AnalysisSideID, slot: number }[] = [];
	for (const side of ['p1', 'p2'] as const) {
		const request = requests?.[side === 'p1' ? 0 : 1];
		if (!request?.active) continue;
		const parts: string[] = [];
		for (let slot = 0; slot < request.active.length; slot++) {
			let choice: string | null = null;
			for (const action of actions) {
				if (action.side === side && action.slot === slot) choice = replayChoiceString(action, request, gameType);
			}
			if (!choice && request.active[slot]) undecided.push({ side, slot });
			parts.push(choice || 'pass');
		}
		let chose = false;
		for (const part of parts) {
			if (part !== 'pass') chose = true;
		}
		if (chose) inputLog.push(`>${side} ${parts.join(', ')}`);
	}
	return { inputLog, undecided };
}

/** The slots a stored replay line left undecided, so re-selecting the node hydrates it the same way. */
export function undecidedReplaySlots(inputLog: string[]) {
	const undecided: { side: AnalysisSideID, slot: number }[] = [];
	for (const line of inputLog) {
		const match = /^>p([12])\s+(.+)$/.exec(line);
		if (!match) continue;
		const side: AnalysisSideID = match[1] === '1' ? 'p1' : 'p2';
		const parts = match[2].split(',').map(part => part.trim());
		for (let slot = 0; slot < parts.length; slot++) {
			if (parts[slot] === 'pass') undecided.push({ side, slot });
		}
	}
	return undecided;
}

export function packReplayTeams(parsed: AnalysisReplayImport) {
	return {
		team1: Teams.pack(parsed.teams.p1 as any) || '',
		team2: Teams.pack(parsed.teams.p2 as any) || '',
	};
}

/**
 * The node line for an imported replay: the hidden root, the turn-0 Team Preview node carrying the choices
 * that get the battle to turn 1, then one **replay** node per turn.
 *
 * Every replay node holds the whole position absolutely, so it is rebuilt from itself rather than by
 * replaying its ancestors (`replayNodesFor`). Each is the first child of the one before, which is what
 * makes the replay read as the main line in Lines and lets copy-on-edit fork cleanly from any turn.
 */
export function buildReplayNodes(parsed: AnalysisReplayImport, previewInputLog: string[], actionSeed: string | null) {
	const stamp = Date.now();
	const rootNodeId = `node-${stamp}-root`;
	const previewNodeId = `node-${stamp}-0`;
	const nodes: Record<string, AnalysisNode> = {
		[rootNodeId]: { id: rootNodeId, parentId: null, seed: null, turn: -1, inputLog: [] },
		[previewNodeId]: {
			id: previewNodeId, parentId: rootNodeId, seed: actionSeed, turn: 0, inputLog: previewInputLog,
		},
	};
	let parentId = previewNodeId;
	const nodeIds: string[] = [];
	for (const turn of parsed.turns) {
		// The end node shares its turn number with the turn that decided the game, so it needs its own id.
		const id = turn.gameOver ? `node-${stamp}-end` : `node-${stamp}-t${turn.turn}`;
		nodes[id] = {
			id,
			parentId,
			seed: null,
			turn: turn.turn,
			inputLog: [],
			kind: 'replay',
			// the reconstruction, kept apart from anything the user later edits on this node
			importedEdits: turn.edits,
			gameOver: turn.gameOver,
			// The replay's own actions, which become this node's drafted choices as soon as the position
			// behind it exists (`replayInputLog`); until then the summary is what Lines shows.
			replayActions: turn.actions,
			choiceSummary: replayChoiceSummary(turn.actions),
			turnEventSummary: turn.turnEventSummary,
		};
		nodeIds.push(id);
		parentId = id;
	}
	return { nodes, rootNodeId, previewNodeId, nodeIds };
}
