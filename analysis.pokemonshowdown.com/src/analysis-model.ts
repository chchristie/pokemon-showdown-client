export type StartMode = 'setup' | 'teams' | 'replay';

export interface AnalysisChoiceSummary {
	side: 'p1' | 'p2';
	slot: number;
	pokemon: string;
	action: string;
	targetPokemon?: string;
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

export interface AnalysisNode {
	id: string;
	parentId: string | null;
	seed: string | null;
	turn: number;
	inputLog: string[];
	choiceSummary?: AnalysisChoiceSummary[];
	teamSelectionSummary?: AnalysisTeamSelectionSummary;
	turnEventSummary?: AnalysisTurnEventSummary[];
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
	state?: any;
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
	const match = /\?~~([^:\/]+)(?::(\d+))?/.exec(window.location.search);
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
