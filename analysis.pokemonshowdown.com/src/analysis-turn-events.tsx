/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type {
	AnalysisGroupingMode, AnalysisSimulationGroup, AnalysisSimulationResult, AnalysisTurnEventDetail,
	AnalysisTurnEventSummary,
} from './analysis-model';
import { PSIcon } from './analysis-ps-shims';

export function getTurnEventSummary(
	simulation: Pick<AnalysisSimulationResult, 'log' | 'turnLog'>,
	mode: AnalysisGroupingMode = 'turn', group?: AnalysisSimulationGroup
) {
	const speciesByIdent = new Map<string, string>();
	const activeByPosition = new Map<string, string>();
	const turnStart = Math.max(0, simulation.log.length - simulation.turnLog.length);
	for (const line of simulation.log.slice(0, turnStart)) {
		const parts = line.split('|');
		if (!['switch', 'drag', 'replace'].includes(parts[1])) continue;
		const position = parts[2]?.split(':')[0];
		const species = parts[3]?.split(',')[0];
		if (parts[2] && species) speciesByIdent.set(parts[2], species);
		if (position && species) activeByPosition.set(position, species);
	}
	const actions: AnalysisTurnEventSummary[] = [];
	const statusNames: Record<string, string> = {
		brn: 'Burn', par: 'Paralysis', slp: 'Sleep', frz: 'Freeze', psn: 'Poison', tox: 'Poison',
	};
	const statNames: Record<string, string> = {
		atk: 'Atk', spa: 'Spa', def: 'Def', spd: 'Spd', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva',
	};
	const trackedItems = new Set([
		'Sitrus Berry', 'Salac Berry', 'Aguav Berry', 'Custap Berry', 'Figy Berry', 'Ganlon Berry',
		'Lansat Berry', 'Liechi Berry', 'Mago Berry', 'Micle Berry', 'Focus Sash', 'Starf Berry', 'Oran Berry',
	]);
	let pendingQuickClaw = false;
	let moveAction: AnalysisTurnEventSummary | null = null;
	let moveDamage = false;
	let moveResults: Record<string, AnalysisTurnEventDetail[]> = {};
	let currentMoveKey = '';
	const moveCounts = new Map<string, number>();
	/**
	 * Why the next switch at a position happens. No reason means the switch was the chosen action.
	 * Faints, Eject Button/Pack, and Emergency Exit/Wimp Out stick until that position switches;
	 * a position's own move (U-turn, Parting Shot, ...) only counts until the next move or end of turn.
	 */
	const switchReasons = new Map<string, string>();
	let pivot: { position: string, move: string } | null = null;
	let dragReason = '';
	const getPosition = (ident: string) => ident.split(':')[0];
	const getSide = (ident: string) => /^p([12])/.exec(ident)?.[1] || '';
	const getSpecies = (ident: string) => speciesByIdent.get(ident) ||
		activeByPosition.get(getPosition(ident)) || ident.replace(/^p[12][a-z]?: /, '');
	const addResult = (category: string, label: string, ident?: string) => {
		(moveResults[category] ||= []).push({ label, pokemon: ident ? getSpecies(ident) : undefined });
	};
	const finishMove = () => {
		if (!moveAction) return;
		const details = [
			...(moveResults.quickclaw || []),
			...(moveResults.miss || []),
			...(moveResults.crit || []),
			...(moveResults.hitcount || []),
			...(moveDamage ? moveResults.confusion || [] : []),
			...(moveDamage ? moveResults.status || [] : []),
			...(moveDamage ? moveResults.boost || [] : []),
			...(moveDamage ? moveResults.unboost || [] : []),
			...(moveResults.enditem || []),
		];
		if (details.length) moveAction.details = details;
		moveAction = null;
		moveDamage = false;
		moveResults = {};
		currentMoveKey = '';
	};
	for (const line of simulation.turnLog) {
		const parts = line.split('|');
		const event = parts[1];
		if (event === 'move' && parts[2]) {
			pivot = { position: getPosition(parts[2]), move: parts[3] || '' };
			dragReason = parts[3] || '';
		}
		if (event === 'upkeep') pivot = null;
		if (event === 'faint' && parts[2]) switchReasons.set(getPosition(parts[2]), 'Fainted');
		if (event === '-enditem' && parts[2] && ['Eject Button', 'Eject Pack'].includes(parts[3])) {
			switchReasons.set(getPosition(parts[2]), parts[3]);
		}
		if (event === '-enditem' && parts[3] === 'Red Card') dragReason = 'Red Card';
		if (event === '-activate' && parts[2] && ['ability: Emergency Exit', 'ability: Wimp Out'].includes(parts[3])) {
			switchReasons.set(getPosition(parts[2]), parts[3].slice('ability: '.length));
		}
		if (event === '-activate' && parts[3] === 'item: Quick Claw') {
			if (mode === 'turn') pendingQuickClaw = true;
			continue;
		}
		if (event === 'move' && moveAction && parts.slice(5).some(part => part.startsWith('[spread]')) &&
			moveAction.side === getSide(parts[2]) && moveAction.pokemon === getSpecies(parts[2]) &&
			moveAction.move === (parts[3] || 'Move')) {
			continue;
		}
		if (event === '-damage' && parts.slice(4).includes('[from] confusion')) {
			finishMove();
			const side = getSide(parts[2]);
			if (side) {
				moveAction = { side, pokemon: getSpecies(parts[2]), type: 'cant', reason: 'Confusion' };
				actions.push(moveAction);
				moveDamage = true;
			}
			continue;
		}
		if (!event || (!event.startsWith('-') && event !== 'faint')) finishMove();
		if (event === 'move') {
			const side = getSide(parts[2]);
			if (!side) continue;
			const occurrence = (moveCounts.get(parts[2]) || 0) + 1;
			moveCounts.set(parts[2], occurrence);
			currentMoveKey = `${parts[2]}|${occurrence}`;
			moveAction = { side, pokemon: getSpecies(parts[2]), type: 'move', move: parts[3] || 'Move' };
			actions.push(moveAction);
			if (pendingQuickClaw) {
				addResult('quickclaw', 'Quick Claw');
				pendingQuickClaw = false;
			}
			continue;
		}
		if (event === 'switch' || event === 'drag') {
			const side = getSide(parts[2]);
			const position = getPosition(parts[2]);
			const switchedTo = (parts[3] || '').split(',')[0];
			const reason = event === 'drag' ? dragReason || undefined :
				switchReasons.get(position) || (pivot?.position === position ? pivot.move : undefined);
			switchReasons.delete(position);
			if (pivot?.position === position) pivot = null;
			if (side) actions.push({
				side, pokemon: activeByPosition.get(position) || getSpecies(parts[2]), type: 'switch', switchedTo, reason,
			});
			if (parts[2] && switchedTo) speciesByIdent.set(parts[2], switchedTo);
			if (position && switchedTo) activeByPosition.set(position, switchedTo);
			continue;
		}
		if (event === 'cant') {
			const side = getSide(parts[2]);
			const reasons: Record<string, string> = {
				flinch: 'Flinch', par: 'Paralysis', frz: 'Frozen', slp: 'Sleep',
			};
			const rawReason = parts[3] || 'Unable to move';
			const reason = reasons[rawReason] || rawReason.charAt(0).toUpperCase() + rawReason.slice(1);
			if (side) actions.push({ side, pokemon: getSpecies(parts[2]), type: 'cant', reason });
			continue;
		}
		if (event === 'faint') {
			const side = getSide(parts[2]);
			if (side) actions.push({ side, pokemon: getSpecies(parts[2]), type: 'faint' });
			continue;
		}
		if (!moveAction || !event?.startsWith('-')) continue;
		if (event === '-damage') moveDamage = true;
		if (event === '-miss' && (mode === 'turn' || group?.requiredMissMoves.includes(currentMoveKey))) {
			addResult('miss', 'Miss', parts[3] || parts[2]);
		}
		if (event === '-crit' && (mode === 'turn' || group?.requiredCritMoves.includes(currentMoveKey))) {
			addResult('crit', 'Crit', parts[2]);
		}
		if (event === '-hitcount' && mode === 'turn') addResult('hitcount', `Hit Count ${parts[3] || ''}`.trim());
		if (event === '-start' && parts[3] === 'confusion') addResult('confusion', 'Confusion', parts[2]);
		if (event === '-status') addResult('status', statusNames[parts[3]] || parts[3] || 'Status', parts[2]);
		if (event === '-boost' || event === '-unboost') {
			const amount = parts[4] || '0';
			const stat = statNames[parts[3]] || parts[3] || 'Stat';
			addResult(event === '-boost' ? 'boost' : 'unboost', `${event === '-boost' ? '+' : '-'}${amount} ${stat}`, parts[2]);
		}
		if (event === '-enditem' && trackedItems.has(parts[3])) {
			addResult('enditem', parts[3], parts[2]);
		}
	}
	finishMove();
	return actions;
}

export function getLogTurnEventSummary(log: string[], turn: number) {
	let turnStart = -1;
	for (let index = log.length - 1; index >= 0; index--) {
		if (log[index] === `|turn|${turn}`) {
			turnStart = index;
			break;
		}
	}
	if (turnStart < 0) return [];
	const nextTurn = log.indexOf(`|turn|${turn + 1}`, turnStart + 1);
	const turnEnd = nextTurn < 0 ? log.length : nextTurn + 1;
	const turnLog = log.slice(turnStart + 1, turnEnd);
	return getTurnEventSummary({ log: [...log.slice(0, turnStart + 1), ...turnLog], turnLog });
}

export function AnalysisTurnEventSummaryView(props: { actions: AnalysisTurnEventSummary[] }) {
	return <span class="analysis-simulation-actions">
		{props.actions.map(action => <span>
			<PSIcon pokemon={action.pokemon} /> <b>({action.side})</b>: {action.type === 'switch' ? <>
				Switched to <PSIcon pokemon={action.switchedTo} />{action.reason ? ` (${action.reason})` : null}
			</> : action.type === 'cant' ? <>Can't Move ({action.reason}{action.details?.map(detail => <>
				, {detail.label}{detail.pokemon ? <> <PSIcon pokemon={detail.pokemon} /></> : null}
			</>)}).</> : action.type === 'faint' ? 'Fainted' : <>
				{action.move}{action.details?.length ? <> ({action.details.map((detail, detailIndex) => <>
					{detailIndex ? ', ' : ''}{detail.label}{detail.pokemon ? <> <PSIcon pokemon={detail.pokemon} /></> : null}
				</>)})</> : null}
			</>}
		</span>)}
	</span>;
}
