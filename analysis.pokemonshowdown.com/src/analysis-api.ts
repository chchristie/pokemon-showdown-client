import {
	ANALYSIS_API, type AnalysisAppliedEdits, type AnalysisCalcMoveResult, type AnalysisFieldEffectOption,
	type AnalysisMidTurnSwitchOption, type AnalysisReplayRecord, type AnalysisSimulationGroup, type AnalysisSnapshot,
} from './analysis-model';

export interface AnalysisRequest {
	format: string;
	team1: string;
	team2: string;
	seed?: string;
	/** path from the root to the target position (see replayNodesFor) */
	replayNodes?: AnalysisReplayRecord[];
	/** choices to execute from the reconstructed position; the server picks a fresh seed */
	inputLog?: string[];
	autoTurn?: boolean;
}

export interface AnalysisBatchRequest extends AnalysisRequest {
	inputLog: string[];
	midTurnSwitchChoices?: AnalysisMidTurnSwitchChoice[];
	count: number;
}

export interface AnalysisMidTurnSwitchChoice {
	side: 'p1' | 'p2';
	pokemonIndex: number;
	reason: string;
	replacementIndex: number;
}

export interface AnalysisStartResponse {
	format: string;
	gameType: string;
	/** root seed of the battle */
	seed: string;
	currentSeed: string;
	/** seed generated for `inputLog`, if choices were executed */
	actionSeed?: string;
	log: string[];
	snapshot: AnalysisSnapshot;
	/** edits the server skipped because earlier layers invalidated them */
	droppedEdits: string[];
	/** one entry per `replayNodes` record: what its edits changed (null if it had none) */
	appliedEdits: (AnalysisAppliedEdits | null)[];
	editOptions: { field: AnalysisFieldEffectOption[] };
	requestState: string;
	requests: any[];
	pendingMidTurnSwitches: AnalysisMidTurnSwitchOption[];
}

export interface AnalysisCalcRequest extends AnalysisRequest {
	/** draft choices (`>p1 move 1 +2`) for choice-dependent flags (Protect, switching, Helping Hand) and targets */
	choices?: string[];
}

export interface AnalysisBatchResponse {
	simulationCount: number;
	turnGroups: AnalysisSimulationGroup[];
	stateGroups: AnalysisSimulationGroup[];
}

async function postAnalysis(path: string, request: AnalysisRequest, signal?: AbortSignal) {
	const response = await fetch(`${ANALYSIS_API}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request),
		signal,
	});
	const data = await response.json();
	if (!response.ok || data.error) {
		throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
	}
	return data;
}

export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisStartResponse> {
	return postAnalysis('/analysis/start', request);
}

export async function runAnalysisBatch(
	request: AnalysisBatchRequest, signal?: AbortSignal
): Promise<AnalysisBatchResponse> {
	return postAnalysis('/analysis/simulate', request, signal);
}

export async function runAnalysisCalc(
	request: AnalysisCalcRequest, signal?: AbortSignal
): Promise<{ results: AnalysisCalcMoveResult[] }> {
	return postAnalysis('/analysis/calc', request, signal);
}
