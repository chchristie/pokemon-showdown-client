import { ANALYSIS_API } from './analysis-model';

export interface AnalysisRequest {
	format: string;
	team1: string;
	team2: string;
	seed?: string;
	replayNodes?: { seed: string, inputLog: string[] }[];
	inputLog?: string[];
	autoTurn?: boolean;
}

export interface AnalysisBatchRequest extends AnalysisRequest {
	inputLog: string[];
	count: number;
}

async function postAnalysis(path: string, request: AnalysisRequest | AnalysisBatchRequest) {
	const response = await fetch(`${ANALYSIS_API}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request),
	});
	const data = await response.json();
	if (!response.ok || data.error) {
		throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
	}
	return data;
}

export async function runAnalysis(request: AnalysisRequest) {
	return postAnalysis('/analysis/start', request);
}

export async function runAnalysisBatch(request: AnalysisBatchRequest) {
	return postAnalysis('/analysis/simulate', request);
}
