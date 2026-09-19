import type { Dex } from '../../play.pokemonshowdown.com/src/battle-dex';

export type StartMode = 'setup' | 'teams' | 'replay';

export interface AnalysisChoiceSummary {
	side: 'p1' | 'p2';
	slot: number;
	pokemon: string;
	action: string;
	targetPokemon?: string;
	/** set when the action is a move; used for the damage calc tooltip */
	moveId?: string;
}

export interface AnalysisTeamSelectionSummary {
	p1: string[];
	p2: string[];
}

export interface AnalysisTurnEventDetail {
	label: string;
	pokemon?: string;
}

export interface AnalysisTurnEventSummary {
	side: string;
	pokemon: string;
	type: 'move' | 'switch' | 'cant' | 'faint';
	move?: string;
	switchedTo?: string;
	reason?: string;
	details?: AnalysisTurnEventDetail[];
}

export type AnalysisSideID = 'p1' | 'p2';
export type AnalysisBoostsTable = { [stat in Dex.BoostStatName]?: number };

/**
 * Manual state edits stored on a node, applied by the server at the start of the
 * node's turn. Mirrors `AnalysisEdits` in pokemon-showdown/tools/analysis-state.ts;
 * see docs/analysis/plan.md (D3).
 */
/**
 * A side's whole roster at this node, in `side.pokemon` order. `from[i]` is the team slot entry `i` came
 * from, so a set keeps its identity (and its slot) through a reorder; `null` means the entry is new.
 * Mirrors AnalysisTeamEdit in tools/analysis-state.ts.
 */
export interface AnalysisTeamEdit {
	sets: Dex.PokemonSet[];
	from: (number | null)[];
}

export interface AnalysisEdits {
	teams?: { p1?: AnalysisTeamEdit, p2?: AnalysisTeamEdit };
	/** team slot per active position; `null` leaves that position alone */
	active?: { p1?: (number | null)[], p2?: (number | null)[] };
	/** keyed `p1:<teamSlot>` (see AnalysisPokemonSnapshot) */
	pokemon?: { [sideAndTeamSlot: string]: AnalysisPokemonStateEdit };
	field?: AnalysisFieldStateEdit;
}

export interface AnalysisPokemonStateEdit {
	hp?: number;
	/**
	 * PP by move id, not by slot: a slot's move can change, and an edit naming a move that is no longer
	 * there is simply irrelevant rather than something to invalidate.
	 */
	pp?: { [moveid: string]: number };
	status?: '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';
	toxicStage?: number;
	sleepTurns?: number;
	/** current types, which moves like Soak and Reflect Type change mid-battle */
	types?: string[];
	terastallized?: boolean;
	megaEvolved?: boolean;
	boosts?: AnalysisBoostsTable;
	volatiles?: { [id: string]: null | { [param: string]: number | string | boolean } };
}

/** Turns remaining (including the current turn) and layers; each defaults to the condition's standard value. */
export interface AnalysisConditionEdit {
	duration?: number;
	layers?: number;
}

export interface AnalysisWeatherEdit extends AnalysisConditionEdit {
	id: string;
}

/** `null` removes the effect; a missing key leaves it as is. */
export interface AnalysisFieldStateEdit {
	weather?: AnalysisWeatherEdit | null;
	terrain?: AnalysisWeatherEdit | null;
	pseudoWeather?: { [id: string]: AnalysisConditionEdit | null };
	sides?: { p1?: { [id: string]: AnalysisConditionEdit | null }, p2?: { [id: string]: AnalysisConditionEdit | null } };
}

/** Edit summary lines (`Rain (3 Turns)`, `Spikes (2 Layers)`): field-wide, then each team's. */
export interface AnalysisEditSummary {
	field: string[];
	p1: string[];
	p2: string[];
}

/** What a node's edits actually changed, as returned per replay record. Mirrors tools/analysis-edits.ts. */
export interface AnalysisAppliedEdits {
	edits: AnalysisEdits;
	summary: AnalysisEditSummary;
}

export type AnalysisFieldEffectKind = 'weather' | 'terrain' | 'pseudoWeather' | 'sideCondition';

/** A field effect the edit form can set in this format. Mirrors tools/analysis-edits.ts. */
export interface AnalysisFieldEffectOption {
	id: string;
	kind: AnalysisFieldEffectKind;
	name: string;
	/** button label; options that share a `group` form one segmented row */
	label: string;
	group: string;
	/** visible options with the same `row` share a line, with turns inputs below their buttons */
	row?: string;
	/** shown without "Show more" */
	common: boolean;
	/** turns remaining when newly set; absent if the effect doesn't expire */
	duration?: number;
	maxLayers?: number;
}

export interface AnalysisNode {
	id: string;
	parentId: string | null;
	seed: string | null;
	turn: number;
	inputLog: string[];
	/**
	 * Packed teams for the whole line, only meaningful on the Team Preview node (turn 0). Editing a team
	 * there changes what is fed to the battle constructor rather than being applied as an edit layer, so
	 * the battle is simply built from this team (see resolveTeamsFor).
	 */
	teams?: { p1?: string, p2?: string };
	edits?: AnalysisEdits;
	/** what `edits` changed, for the Lines tooltip ("Turn N Edits") */
	editSummary?: AnalysisEditSummary;
	/** what `teams` changed, for the Lines tooltip; built on the client, since the server never sees it */
	teamSummary?: { p1: string[], p2: string[] };
	choiceSummary?: AnalysisChoiceSummary[];
	teamSelectionSummary?: AnalysisTeamSelectionSummary;
	turnEventSummary?: AnalysisTurnEventSummary[];
}

/** One node on the path to a position, as sent to the analysis API. */
export interface AnalysisReplayRecord {
	edits?: AnalysisEdits;
	seed?: string | null;
	inputLog?: string[];
}

/** Compact battle state returned by the API. Mirrors `AnalysisSnapshot` in tools/analysis-state.ts. */
export interface AnalysisEffectSnapshot {
	id: string;
	duration?: number;
	data?: { [key: string]: number | string | boolean };
	/** the position of the Pokémon this effect hangs off (`p2a`), for Leech Seed and partial trapping */
	sourceSlot?: string;
}

export interface AnalysisPokemonSnapshot {
	/** current position in the team (request order); changes when Pokémon switch */
	index: number;
	/** position in the original team, which never changes: edits name a Pokémon by it */
	teamSlot: number;
	ident: string;
	name: string;
	species: string;
	baseSpecies: string;
	set: Dex.PokemonSet;
	item: string;
	ability: string;
	level: number;
	hp: number;
	maxhp: number;
	fainted: boolean;
	status: string;
	toxicStage?: number;
	sleepTurns?: number;
	moves: { id: string, name: string, pp: number, maxpp: number, disabled: boolean }[];
	isActive: boolean;
	slot: number | null;
	boosts: AnalysisBoostsTable;
	volatiles: AnalysisEffectSnapshot[];
	types: string[];
	teraType: string;
	terastallized: string | null;
	canTerastallize: boolean;
	megaEvolved: boolean;
	canMegaEvo: boolean;
	stats: Dex.StatsTable;
}

export interface AnalysisSnapshot {
	turn: number;
	gen: number;
	gameType: string;
	formatId: string;
	rules: { terastallization: boolean, dynamax: boolean };
	field: {
		weather: AnalysisEffectSnapshot | null,
		terrain: AnalysisEffectSnapshot | null,
		pseudoWeather: AnalysisEffectSnapshot[],
	};
	sides: AnalysisSideSnapshot[];
}

export interface AnalysisSideSnapshot {
	id: AnalysisSideID;
	name: string;
	sideConditions: AnalysisEffectSnapshot[];
	/** index into `pokemon` for each active slot */
	active: (number | null)[];
	/** in `side.pokemon` order, which matches request order */
	pokemon: AnalysisPokemonSnapshot[];
}

/** Damage calc results from /analysis/calc. Mirrors tools/analysis-calc.ts. */
export interface AnalysisCalcPokemonRef {
	side: AnalysisSideID;
	/** index in the side's team (request order) */
	index: number;
	/** active slot */
	slot: number;
}

export interface AnalysisCalcTargetResult {
	target: AnalysisCalcPokemonRef;
	relation: 'foe' | 'ally';
	/** show when hovering the move button */
	onMoveHover: boolean;
	/** hit by the attacker's current draft choice */
	selected: boolean;
	damage?: [number, number];
	percent?: [number, number];
	/** calc result sentence with ANALYSIS_CALC_ATTACKER / ANALYSIS_CALC_DEFENDER placeholders */
	text?: string;
	error?: string;
}

/** Attacker's own transformation this turn; results exist for each mode it can still use. */
export type AnalysisCalcMode = '' | 'tera' | 'mega' | 'megax' | 'megay';

export interface AnalysisCalcMoveResult {
	attacker: AnalysisCalcPokemonRef;
	mode: AnalysisCalcMode;
	moveSlot: number;
	moveId: string;
	moveName: string;
	targets: AnalysisCalcTargetResult[];
}

export const ANALYSIS_CALC_ATTACKER = '[[ATTACKER]]';
export const ANALYSIS_CALC_DEFENDER = '[[DEFENDER]]';

/** Calcs for one decision point and draft; `key` identifies which. */
export interface AnalysisCalcState {
	key: string;
	loading: boolean;
	results?: AnalysisCalcMoveResult[];
	error?: string;
}

export interface AnalysisSimulationResult {
	index: number;
	seed: string;
	log: string[];
	turnLog: string[];
	switchInputLog: string[];
	totalDamage: number;
	protectedMisses: string[];
	brokenProtections: string[];
}

export interface AnalysisSimulationGroup {
	count: number;
	percentage: number;
	min: AnalysisSimulationResult;
	median: AnalysisSimulationResult;
	max: AnalysisSimulationResult;
	executions: AnalysisSimulationResult[];
	requiredCritMoves: string[];
	requiredMissMoves: string[];
}

export type AnalysisSimulationRoll = 'min' | 'median' | 'max';
export type AnalysisGroupingMode = 'turn' | 'state';
export type AnalysisPhase = 'preview' | 'default' | 'selection' | 'one-turn' | 'replay' |
	'simulation' | 'simulating' | 'simulation-selection' | 'simulation-switch-selection' |
	'mid-turn-switch-selection' | 'switch-selection';

export interface AnalysisMidTurnSwitchOption {
	side: 'p1' | 'p2';
	pokemonIndex: number;
	pokemon: string;
	reason: string;
	reasonName: string;
	replacementIndex?: number;
}

export interface AnalysisTab {
	id: string;
	title: string;
	format: string;
	log: string[];
	snapshot?: AnalysisSnapshot;
	/** what the state edit forms can set in this format */
	editOptions?: { field: AnalysisFieldEffectOption[] };
	/** edits the server refused, from the last call; only shown in debug mode */
	droppedEdits?: string[];
	team1: string;
	team2: string;
	/**
	 * A Set Up Position tab: it starts at turn 1 from placeholder Pokémon rather than from two real teams,
	 * so its teams are never validated and its Team Preview node is hidden (see startSetupAnalysis).
	 */
	sandbox?: boolean;
	/**
	 * Whether the teambuilder has been opened on this sandbox tab yet. Until it has, the controls are just
	 * the line telling you how to start (see renderBattleControls): there is nothing useful to do with a
	 * field of placeholders, and the turn controls would only invite you to play one.
	 */
	sandboxIntroDone?: boolean;
	loading?: boolean;
	requests?: any[];
	requestState?: string;
	phase: AnalysisPhase;
	gameType?: string;
	nodes: Record<string, AnalysisNode>;
	currentNodeId: string;
	rootSeed: string;
	simulationCount: number;
	simulationGroups?: AnalysisSimulationGroup[];
	turnSimulationGroups?: AnalysisSimulationGroup[];
	stateSimulationGroups?: AnalysisSimulationGroup[];
	simulationGroupingMode?: AnalysisGroupingMode;
	simulationResultCount?: number;
	selectedSimulationIndex?: number;
	selectedSimulationGroupIndex?: number;
	hoveredSimulationGroupIndex?: number;
	simulationRoll?: AnalysisSimulationRoll;
	simulationInputLog?: string[];
	midTurnSwitchOptions?: AnalysisMidTurnSwitchOption[];
	midTurnSwitchOptionIndex?: number;
	oneTurnDestination?: 'default' | 'simulation-selection' | 'mid-turn-switch-selection' | 'switch-selection';
}

export interface AnalysisBattle {
	destroy(): void;
}

export type PlaybackStage = 'seek-end' | 'seek-previous' | 'playing' | null;

export interface LocalTeam {
	name: string;
	format: string;
	packedTeam: string;
}

export const FORMATS = [
	{ id: 'gen9ou', name: '[Gen 9] OU' },
	{ id: 'gen9doublesou', name: '[Gen 9] Doubles OU' },
	{ id: 'gen9championsvgc2026regmb', name: '[Champions] VGC 2026 Reg M-B' },
	{ id: 'gen9fnafsingles', name: '[Gen 9] FNAF' },
];

export const LAYOUT = {
	battleWidth: 640,
	battleHeight: 360,
	leftWidth: 900,
	leftMaxWidth: 1020,
	rightWidth: 0,
	rightMaxWidth: 650,
	minSideBySideWidth: 780,
	headerHeight: 56,
	logReserveWidth: 180,
};

export function getAnalysisApi() {
	const match = /\?~~([^:/]+)(?::(\d+))?/.exec(window.location.search);
	if (!match) return 'http://localhost:8002';
	return `http://${match[1]}:${match[2] || '8002'}`;
}

export const ANALYSIS_API = getAnalysisApi();

/**
 * Whether this is still one of a Set Up Position tab's untouched placeholders, which is what makes its
 * sprite open the Pokémon panel instead of the action menu.
 *
 * Having no moves is enough to tell: only the starting placeholders can have none, because every edit path
 * runs its sets through the server's `normalizeSet`, which gives a moveless set Splash rather than letting
 * it through (the `Pokemon` constructor throws on one). So the flag clears the moment the user edits it.
 */
export function isPlaceholderPokemon(pokemon: AnalysisPokemonSnapshot | undefined) {
	return !!pokemon && !pokemon.moves.length && !(pokemon.set.moves || []).some(move => !!move);
}

/**
 * The log the renderer should play, which for a Set Up Position tab is not quite the log the server sent.
 *
 * A setup tab's turn-1 edits *are* the position: watching them apply — a roster resync, HP jumping, a
 * Bulbasaur turning into a Garchomp — is setup noise, not battle history. The sim emits them straight after
 * `|turn|1`, because a node's edits apply at the start of its turn, so anything that starts playing at turn
 * 1 (Submit Choices, Simulate, Replay Prev Turn from turn 2) animates them first.
 *
 * Hoisting that block above `|turn|1` makes it part of the battle's silent setup instead, and leaves
 * `|turn|1` marking the real start of play. Nothing else has to change: every seek is by turn number, and
 * `seekTurn(1)` then lands on the built position rather than in front of the edits.
 *
 * Only turn 1 is hoisted. Later turns' edits are ordinary history and stay where they are.
 */
/**
 * Upstream `battle.resetRNG` announces itself, and the determinism model reseeds at the start of every node
 * (see replayAnalysisRecords), so this lands in the log once per node and says nothing about the battle.
 * `sim/battle.ts` is an upstream file, so it is dropped here rather than suppressed at the source.
 */
export const RNG_RESET_LINE = "|message|The battle's RNG was reset.";

export function stripAnalysisNoise(log: string[]) {
	return log.filter(line => line !== RNG_RESET_LINE);
}

export function getRenderedLog(tab: AnalysisTab) {
	const log = stripAnalysisNoise(tab.log);
	if (!tab.sandbox) return log;
	const turnIndex = log.findIndex(line => line === '|turn|1');
	if (turnIndex < 0) return log;
	// the block runs to its `Analysis edits:` summary, the last line the edit layer emits for a node
	let end = -1;
	for (let i = turnIndex + 1; i < log.length; i++) {
		if (log[i].startsWith('|turn|')) break;
		if (log[i].startsWith('|-message|Analysis edits:')) end = i;
	}
	if (end < 0) return log;
	return [
		...log.slice(0, turnIndex), ...log.slice(turnIndex + 1, end + 1), log[turnIndex], ...log.slice(end + 1),
	];
}

/** Where "from the start" is for a tab: a setup tab's battle begins once its turn-1 edits have been applied. */
export function getReplayStartTurn(tab: AnalysisTab) {
	return tab.sandbox ? 1 : 0;
}

export function getRequestState(requestState: string | undefined, requests: any[] | undefined) {
	if (requests?.some(request => request?.teamPreview)) return 'teampreview';
	if (requests?.some(request => request?.forceSwitch)) return 'switch';
	if (requestState) return requestState;
	if (requests?.[0]?.active) return 'move';
	return '';
}

/**
 * Volatiles the Pokémon panel can set (docs/analysis/plan.md, Phase 2b-2).
 *
 * The panel offers these through a filterable multi-select rather than a wall of toggle buttons, so the list
 * can stay long without dominating a group that is usually empty.
 *
 * Only the id and any linked state cross the wire: the server fills in every other default (confusion's
 * turn counter, Substitute's HP), so there is one authority on what a manually-added volatile looks like.
 *
 * `unavailable` mirrors the `onStart` guards that make the sim refuse a volatile outright. Without it those
 * options would appear to work and silently do nothing, because `droppedEdits` is deliberately never shown.
 * It reads the *form's* live values, not the snapshot's, so setting Status to Sleep enables Nightmare at once.
 */
export interface AnalysisVolatileContext {
	status: string;
	ability: string;
	item: string;
	types: string[];
	/** every volatile currently on the Pokémon, including ones this panel doesn't offer */
	selected: string[];
	gen: number;
}

export interface AnalysisVolatileInfo {
	id: string;
	name: string;
	minGen?: number;
	maxGen?: number;
	/**
	 * Needs an opposing Pokémon as its source. In doubles this becomes one option per foe slot; in singles
	 * there is only one possible source, so it stays a single option. The source is stored as a foe *slot*
	 * rather than a team slot, unlike everything else here, because the sim itself resolves it positionally
	 * (`getAtSlot(volatiles.leechseed.sourceSlot)`).
	 */
	perFoeSlot?: boolean;
	/** the sim's `onStart` returns false when the other one is already present */
	exclusiveWith?: string;
	/** a reason the sim would refuse this right now, or null when it is fine */
	unavailable?: (context: AnalysisVolatileContext) => string | null;
}

function volatileId(text: string) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const ANALYSIS_VOLATILES: AnalysisVolatileInfo[] = [
	{ id: 'aquaring', name: 'Aqua Ring' },
	{ id: 'charge', name: 'Charge' },
	{ id: 'confusion', name: 'Confusion' },
	{ id: 'curse', name: 'Curse' },
	{ id: 'destinybond', name: 'Destiny Bond' },
	{ id: 'dragoncheer', name: 'Dragon Cheer', exclusiveWith: 'focusenergy' },
	// gen 8 only: `Side.canDynamaxNow` refuses every other generation
	{ id: 'dynamax', name: 'Dynamax', minGen: 8, maxGen: 8 },
	{ id: 'embargo', name: 'Embargo' },
	{ id: 'flashfire', name: 'Flash Fire' },
	{ id: 'focusenergy', name: 'Focus Energy', exclusiveWith: 'dragoncheer' },
	{ id: 'foresight', name: 'Foresight' },
	{
		id: 'gastroacid',
		name: 'Gastro Acid',
		unavailable: context => volatileId(context.item) === 'abilityshield' ? 'an Ability Shield blocks it' : null,
	},
	{ id: 'healblock', name: 'Heal Block' },
	{ id: 'laserfocus', name: 'Laser Focus' },
	{ id: 'leechseed', name: 'Leech Seed', perFoeSlot: true },
	{ id: 'magnetrise', name: 'Magnet Rise' },
	{ id: 'minimize', name: 'Minimize' },
	{ id: 'miracleeye', name: 'Miracle Eye' },
	{
		id: 'nightmare',
		name: 'Nightmare',
		unavailable: context => context.status === 'slp' || volatileId(context.ability) === 'comatose' ?
			null : 'the Pokémon must be asleep',
	},
	{ id: 'octolock', name: 'Octolock' },
	{ id: 'partiallytrapped', name: 'Partially Trapped', perFoeSlot: true },
	{ id: 'powershift', name: 'Power Shift' },
	{ id: 'powertrick', name: 'Power Trick' },
	{ id: 'saltcure', name: 'Salt Cure' },
	{
		id: 'smackdown',
		name: 'Smack Down',
		unavailable: context => {
			if (volatileId(context.item) === 'ironball' || context.selected.includes('ingrain')) {
				return 'the Pokémon is already grounded';
			}
			const airborne = context.types.includes('Flying') || volatileId(context.ability) === 'levitate' ||
				context.selected.includes('magnetrise') || context.selected.includes('telekinesis');
			return airborne ? null : 'the Pokémon must be airborne';
		},
	},
	{ id: 'substitute', name: 'Substitute' },
	{ id: 'syrupbomb', name: 'Syrup Bomb' },
	{ id: 'yawn', name: 'Yawn' },
];
