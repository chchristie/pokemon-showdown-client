import {
	ANALYSIS_API, type AnalysisAppliedEdits, type AnalysisCalcMoveResult, type AnalysisFieldEffectOption,
	type AnalysisFormat,
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
	/**
	 * Skip team validation. Set by a Set Up Position tab, whose placeholder team is deliberately illegal
	 * for the format; see AnalysisTeamValidationError below for why that is consistent.
	 */
	sandbox?: boolean;
}

/** One side's placeholder team for a Set Up Position tab (server tools/analysis-setup.ts). */
export interface AnalysisSetupResponse {
	format: string;
	gameType: string;
	/** placeholders per side: one per active slot */
	count: number;
	/** one species per active slot, all different so the renderer can tell them apart */
	species: string[];
	/** the nickname each placeholder carries: "Placeholder", or "Placeholder N" when a side has several */
	names: string[];
	level: number;
	team1: string;
	team2: string;
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

/**
 * A team the server refused as illegal for the format. It carries the validator's problems so a form can
 * list them, instead of showing the raw `{"team1":[...]}` the endpoints return.
 *
 * Only teams sent as `team1`/`team2` are validated, which means the Team Preview teambuilder (it edits
 * the team the battle is built from) and the start form. Mid-battle edits are applied during replay and
 * never go through the validator, on purpose: the tool is a sandbox. A Set Up Position tab extends that
 * to its own starting team, through `sandbox` on the request.
 */
export class AnalysisTeamValidationError extends Error {
	problems: { team1: string[], team2: string[] };
	constructor(problems: { team1: string[], team2: string[] }) {
		super('This team is not legal for this format.');
		this.problems = problems;
	}
}

function isTeamProblems(error: any) {
	return !!error && typeof error === 'object' && (Array.isArray(error.team1) || Array.isArray(error.team2));
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
		if (isTeamProblems(data.error)) {
			throw new AnalysisTeamValidationError({ team1: data.error.team1 || [], team2: data.error.team2 || [] });
		}
		throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
	}
	return data;
}

export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisStartResponse> {
	return postAnalysis('/analysis/start', request);
}

/** Builds the placeholder teams a Set Up Position tab starts from. The server owns this: picking a species
 * the format allows needs its rule table, which the client doesn't have. */
export async function runAnalysisSetup(format: string): Promise<AnalysisSetupResponse> {
	return postAnalysis('/analysis/setup', { format } as AnalysisRequest);
}

/**
 * The commit the analysis API is running, for an export's `createdWith`. Empty when the server has no git
 * checkout to read, in which case an import has nothing to compare and stays quiet.
 *
 * Failure is not worth surfacing: this only feeds a staleness warning, so an export should still produce a
 * file if the route is missing (an older server) or the call fails.
 */
export async function getAnalysisVersion(): Promise<string> {
	try {
		const response = await fetch(`${ANALYSIS_API}/analysis/version`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		if (!response.ok) return '';
		return (await response.json()).serverCommit || '';
	} catch {
		return '';
	}
}

/**
 * Every format an analysis can be started in. Falls back to an empty list, which leaves the pickers on
 * `FORMATS`: a start form that can still offer the usual handful beats one that offers nothing.
 */
export async function getAnalysisFormats(): Promise<AnalysisFormat[]> {
	try {
		const response = await fetch(`${ANALYSIS_API}/analysis/formats`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		if (!response.ok) return [];
		return (await response.json()).formats || [];
	} catch {
		return [];
	}
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
