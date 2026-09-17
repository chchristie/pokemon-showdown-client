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
export interface AnalysisEdits {
	teams?: { p1?: Dex.PokemonSet[], p2?: Dex.PokemonSet[] };
	active?: { p1?: (number | null)[], p2?: (number | null)[] };
	pokemon?: { [sideAndIndex: string]: AnalysisPokemonStateEdit };
	field?: AnalysisFieldStateEdit;
}

export interface AnalysisPokemonStateEdit {
	hp?: number;
	pp?: (number | null)[];
	status?: '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';
	toxicStage?: number;
	sleepTurns?: number;
	terastallized?: boolean;
	megaEvolved?: boolean;
	boosts?: AnalysisBoostsTable;
	volatiles?: { [id: string]: false | { [param: string]: number | string | boolean } };
}

export interface AnalysisFieldStateEdit {
	weather?: string;
	terrain?: string;
	pseudoWeather?: { [id: string]: boolean };
	sides?: { p1?: { [id: string]: boolean | number }, p2?: { [id: string]: boolean | number } };
}

export interface AnalysisNode {
	id: string;
	parentId: string | null;
	seed: string | null;
	turn: number;
	inputLog: string[];
	edits?: AnalysisEdits;
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
}

export interface AnalysisPokemonSnapshot {
	index: number;
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
	sides: {
		id: AnalysisSideID,
		name: string,
		sideConditions: AnalysisEffectSnapshot[],
		active: (number | null)[],
		pokemon: AnalysisPokemonSnapshot[],
	}[];
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

export interface AnalysisCalcMoveResult {
	attacker: AnalysisCalcPokemonRef;
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
	team1: string;
	team2: string;
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

export function getRequestState(requestState: string | undefined, requests: any[] | undefined) {
	if (requests?.some(request => request?.teamPreview)) return 'teampreview';
	if (requests?.some(request => request?.forceSwitch)) return 'switch';
	if (requestState) return requestState;
	if (requests?.[0]?.active) return 'move';
	return '';
}
