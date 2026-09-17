/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { BattleChoiceBuilder } from '../../play.pokemonshowdown.com/src/battle-choices';
import { Teams } from '../../play.pokemonshowdown.com/src/battle-teams';
import {
	FORMATS, LAYOUT, getRequestState,
	type AnalysisBattle, type AnalysisCalcState, type AnalysisChoiceSummary, type AnalysisGroupingMode,
	type AnalysisMidTurnSwitchOption, type AnalysisNode, type AnalysisPhase, type AnalysisSideID, type AnalysisSimulationGroup,
	type AnalysisSimulationRoll, type AnalysisTab, type LocalTeam, type PlaybackStage, type StartMode,
} from './analysis-model';
import { runAnalysis, runAnalysisBatch, runAnalysisCalc, type AnalysisStartResponse } from './analysis-api';
import { AnalysisChoiceDraft, sideIndex } from './analysis-choices';
import { AnalysisChoiceSummaryView } from './analysis-choice-summary';
import { AnalysisHeader } from './analysis-header';
import { hasChildNodes, replayNodesFor } from './analysis-nodes';
import { AnalysisNodeTree } from './analysis-node-tree';
import { AnalysisReplayControls } from './analysis-replay-controls';
import { packTeamSyntax } from './analysis-team-utils';
import { AnalysisTooltips } from './analysis-tooltips';
import { AnalysisTurnEventSummaryView, getLogTurnEventSummary, getTurnEventSummary } from './analysis-turn-events';

function PSIcon(props: { pokemon: any }) {
	return <span class="picon" style={(window as any).Dex.getPokemonIcon(props.pokemon)} />;
}

function pokemonLabel(pokemon: any) {
	return (pokemon?.details || pokemon?.name || '').split(',')[0];
}

class AnalysisApp extends preact.Component {
	tabs: AnalysisTab[] = [];
	activeTab: string | null = null;
	draggedTab: string | null = null;
	mode: StartMode | null = null;
	format = FORMATS[0].id;
	team1 = '';
	team2 = '';
	replayURL = '';
	teams: LocalTeam[] = [];
	showSyntaxImport = false;
	teamSyntax1 = '';
	teamSyntax2 = '';
	startError = '';
	starting = false;
	battle: AnalysisBattle | null = null;
	battleTabId: string | null = null;
	battleFrame: HTMLElement | null = null;
	battleLogFrame: HTMLElement | null = null;
	battleTooltipObserver: MutationObserver | null = null;
	analysisTeams: any[] = [];
	choiceControlsFrame: HTMLElement | null = null;
	choiceTooltips: AnalysisTooltips | null = null;
	/** damage calcs for the current decision point and draft (see refreshCalcs) */
	calcs: AnalysisCalcState | null = null;
	calcAbortController: AbortController | null = null;
	choiceTooltipsFrame: HTMLElement | null = null;
	draft = new AnalysisChoiceDraft();
	pendingHydration: { tabId: string, inputLog: string[] } | null = null;
	simulationGroupElements: Record<number, HTMLElement | null> = {};
	simulationAbortController: AbortController | null = null;
	playbackStage: PlaybackStage = null;
	oneTurnStartTurn: number | null = null;
	turnView: boolean | string = false;
	layout = {
		battleWidth: LAYOUT.battleWidth, battleHeight: LAYOUT.battleHeight,
		mainWidth: LAYOUT.leftWidth, treeWidth: LAYOUT.rightWidth, sideBySide: true,
	};

	constructor() {
		super();
		this.loadTeams();
		window.addEventListener('message', this.receiveStorageMessage);
		window.addEventListener('resize', this.updateLayout);
		this.updateLayout();
		this.openHome();
	}

	updateLayout = () => {
		const width = document.documentElement.clientWidth;
		const height = Math.max(LAYOUT.battleHeight, document.documentElement.clientHeight - LAYOUT.headerHeight);
		let scale = Math.min(1, width / LAYOUT.battleWidth, height / LAYOUT.battleHeight);
		const sideBySide = width > LAYOUT.minSideBySideWidth;
		if (sideBySide) scale = Math.min(scale, Math.max(0, width - LAYOUT.logReserveWidth) / LAYOUT.battleWidth);
		const battleWidth = Math.round(LAYOUT.battleWidth * scale);
		const { leftWidth, leftMaxWidth, rightWidth, rightMaxWidth } = LAYOUT;
		const excess = width - leftWidth - rightWidth;
		let mainWidth = leftWidth;
		let treeWidth = Math.max(0, width - mainWidth);
		if (excess >= 0) {
			const leftStretch = leftMaxWidth - leftWidth;
			const rightStretch = rightMaxWidth - rightWidth;
			if (leftStretch + rightStretch > excess) {
				mainWidth = leftWidth + Math.floor(excess * leftStretch / (leftStretch + rightStretch));
			} else {
				mainWidth = leftMaxWidth;
			}
			treeWidth = width - mainWidth;
		} else if (width < leftWidth + rightWidth) {
			mainWidth = width;
			treeWidth = width - mainWidth;
		}
		const battleRoomMinimum = Math.min(width, battleWidth + rightWidth);
		mainWidth = Math.max(mainWidth, battleRoomMinimum);
		treeWidth = Math.max(0, width - mainWidth);
		this.layout = {
			battleWidth, battleHeight: Math.round(LAYOUT.battleHeight * scale), mainWidth, treeWidth,
			sideBySide: sideBySide && treeWidth >= rightWidth,
		};
		if (this.battle) {
			const frame = (this.battle as any)?.scene?.$frame;
			frame?.css('transform', `scale(${this.layout.battleHeight / 360})`);
		}
		this.forceUpdate();
	};

	receiveStorageMessage = (event: MessageEvent) => {
		if (event.origin !== 'https://play.pokemonshowdown.com' || typeof event.data !== 'string') return;
		if (event.data.startsWith('t')) {
			this.loadTeamsFromPacked(event.data.slice(1));
			this.forceUpdate();
		}
	};

	/*********************************************************
	 * Node tree
	 *********************************************************/

	newNodeId(tab: AnalysisTab) {
		return `node-${Date.now()}-${Object.keys(tab.nodes).length}`;
	}

	storeAnalysisNode(tab: AnalysisTab, inputLog: string[], parentId: string | null = tab.currentNodeId) {
		const id = this.newNodeId(tab);
		const parent = parentId ? tab.nodes[parentId] : null;
		tab.nodes[id] = {
			id,
			parentId,
			seed: null,
			turn: (parent?.turn ?? -1) + 1,
			inputLog,
		};
		tab.currentNodeId = id;
		return tab.nodes[id];
	}

	/** Copy-on-edit: editing a node that already has children edits a new sibling instead. */
	editCurrentNode(tab: AnalysisTab, edit: (node: AnalysisNode) => void) {
		let node = tab.nodes[tab.currentNodeId];
		if (!node) return null;
		if (hasChildNodes(tab, node.id)) {
			const id = this.newNodeId(tab);
			node = tab.nodes[id] = {
				...node,
				id,
				inputLog: [...node.inputLog],
				edits: node.edits && JSON.parse(JSON.stringify(node.edits)),
				choiceSummary: node.choiceSummary?.map(choice => ({ ...choice })),
				teamSelectionSummary: node.teamSelectionSummary && {
					p1: [...node.teamSelectionSummary.p1],
					p2: [...node.teamSelectionSummary.p2],
				},
			};
			tab.currentNodeId = id;
		}
		edit(node);
		return node;
	}

	initializeCurrentNodeSummary(tab: AnalysisTab) {
		const node = tab.nodes[tab.currentNodeId];
		if (!node) return;
		if (tab.requests?.some(request => request?.teamPreview)) {
			node.teamSelectionSummary ||= this.getTeamSelectionSummary(tab);
		} else {
			node.choiceSummary ||= this.getMoveChoiceSummary(tab);
		}
	}

	updateCurrentNodeSummary(tab: AnalysisTab) {
		const node = tab.nodes[tab.currentNodeId];
		if (!node) return;
		if (tab.requests?.some(request => request?.teamPreview)) {
			node.teamSelectionSummary = this.getTeamSelectionSummary(tab);
		} else {
			node.choiceSummary = this.getMoveChoiceSummary(tab);
		}
	}

	/** Keeps unsubmitted choices on a leaf node so they survive navigating away. */
	saveLeafDraft(tab: AnalysisTab, inputLog?: string[]) {
		const node = tab.nodes[tab.currentNodeId];
		if (!node || hasChildNodes(tab, node.id)) return;
		node.inputLog = inputLog ? [...inputLog] : this.draft.toInputLog(tab.requests);
		this.updateCurrentNodeSummary(tab);
	}

	commitCurrentDraft(tab: AnalysisTab, inputLog?: string[]) {
		const draft = inputLog || this.draft.toInputLog(tab.requests);
		return this.editCurrentNode(tab, node => {
			node.inputLog = [...draft];
			this.updateCurrentNodeSummary(tab);
		});
	}

	selectAnalysisNode(tab: AnalysisTab, nodeId: string) {
		this.saveLeafDraft(tab);
		void this.restoreAnalysisNode(tab, nodeId);
	}

	restoreAnalysisNode = async (tab: AnalysisTab, nodeId: string, inputLog?: string[]) => {
		const node = tab.nodes[nodeId];
		if (!node) return;
		try {
			const data = await runAnalysis({
				format: tab.format, team1: tab.team1, team2: tab.team2,
				seed: tab.rootSeed, replayNodes: replayNodesFor(tab, nodeId, false),
			});
			tab.currentNodeId = nodeId;
			const requestState = this.applyBattleResponse(tab, data);
			tab.phase = requestState === 'teampreview' ? 'preview' : 'default';
			this.pendingHydration = { tabId: tab.id, inputLog: [...(inputLog ?? node.inputLog)] };
			this.destroyBattle();
			this.forceUpdate();
		} catch (error: any) {
			this.startError = error.message || 'Unable to restore this node.';
			this.forceUpdate();
		}
	};

	/*********************************************************
	 * Applying API responses
	 *********************************************************/

	/** Copies the reconstructed position onto the tab. Returns the normalized request state. */
	applyBattleResponse(tab: AnalysisTab, data: AnalysisStartResponse) {
		tab.log = data.log || [];
		tab.snapshot = data.snapshot;
		tab.requests = data.requests;
		tab.requestState = getRequestState(data.requestState, data.requests);
		tab.gameType = data.gameType || tab.gameType;
		return tab.requestState;
	}

	/**
	 * If the executed turn fully resolved (no replacements pending), records its outcome on
	 * `node` and opens the next decision point as its child.
	 */
	completeNodeIfResolved(tab: AnalysisTab, node: AnalysisNode, data: AnalysisStartResponse, requestState: string) {
		if (data.pendingMidTurnSwitches?.length || requestState === 'switch') return false;
		node.turnEventSummary = getLogTurnEventSummary(data.log || [], node.turn);
		this.storeAnalysisNode(tab, [], node.id);
		return true;
	}

	/** Sets where one-turn playback should end up: a pending replacement prompt or the next decision. */
	setPendingReplacements(tab: AnalysisTab, data: AnalysisStartResponse, requestState: string) {
		const pending = data.pendingMidTurnSwitches?.length ? data.pendingMidTurnSwitches : undefined;
		tab.midTurnSwitchOptions = pending;
		tab.midTurnSwitchOptionIndex = pending ? 0 : undefined;
		tab.oneTurnDestination = pending ? 'mid-turn-switch-selection' :
			requestState === 'switch' ? 'switch-selection' : 'default';
	}

	refreshChoicesForResponse(tab: AnalysisTab) {
		this.setAnalysisTeams(tab.requests);
		this.setChoiceBuilders(tab.requests, tab.gameType);
		this.initializeCurrentNodeSummary(tab);
	}

	/** Streams new log lines into the live battle if the old log is a prefix; otherwise rebuilds it. */
	continuePlayback(tab: AnalysisTab, previousLog: string[], startTurn: number) {
		const battle = this.battle as any;
		const prefixMatches = previousLog.every((line, index) =>
			tab.log[index] === line || (line.startsWith('|t:|') && tab.log[index]?.startsWith('|t:|')));
		if (battle && prefixMatches) {
			battle.pause();
			for (const line of tab.log.slice(previousLog.length)) battle.add(line);
			this.playbackStage = 'playing';
			battle.play();
		} else {
			this.oneTurnStartTurn = startTurn;
			this.destroyBattle();
		}
	}

	/*********************************************************
	 * Executing turns
	 *********************************************************/

	submitChoices = async (tab: AnalysisTab, p1Choice: string, p2Choice: string) => {
		if (!p1Choice || !p2Choice || tab.loading) return;
		const nodeInputLog = [`>p1 ${p1Choice}`, `>p2 ${p2Choice}`];
		const currentNode = this.commitCurrentDraft(tab, nodeInputLog);
		if (!currentNode) return;
		tab.loading = true;
		this.forceUpdate();
		try {
			const data = await runAnalysis({
				format: tab.format, team1: tab.team1, team2: tab.team2, seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, tab.currentNodeId, false), inputLog: nodeInputLog,
			});
			currentNode.seed = data.actionSeed || null;
			const requestState = getRequestState(data.requestState, data.requests);
			this.completeNodeIfResolved(tab, currentNode, data, requestState);
			tab.simulationGroups = undefined;
			tab.simulationResultCount = undefined;
			tab.selectedSimulationIndex = undefined;
			this.applyBattleResponse(tab, data);
			this.setPendingReplacements(tab, data, requestState);
			tab.phase = requestState === 'teampreview' ? 'preview' : 'one-turn';
			this.oneTurnStartTurn = currentNode.turn;
			this.refreshChoicesForResponse(tab);
			this.destroyBattle();
		} catch (error: any) {
			this.startError = error.message || 'Unable to submit choices.';
		} finally {
			tab.loading = false;
			this.forceUpdate();
		}
	};

	/** Appends replacement switch choices to the executing node and replays it. */
	submitReplacements = async (tab: AnalysisTab, switchInputLog: string[], errorPhase: AnalysisPhase) => {
		if (!switchInputLog.length) return;
		const parent = this.editCurrentNode(tab, node => node.inputLog.push(...switchInputLog))!;
		tab.loading = true;
		this.forceUpdate();
		try {
			const previousLog = tab.log;
			const data = await runAnalysis({
				format: tab.format, team1: tab.team1, team2: tab.team2, seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, parent.id, true),
			});
			const requestState = getRequestState(data.requestState, data.requests);
			this.completeNodeIfResolved(tab, parent, data, requestState);
			this.applyBattleResponse(tab, data);
			this.setPendingReplacements(tab, data, requestState);
			tab.phase = 'one-turn';
			this.refreshChoicesForResponse(tab);
			this.continuePlayback(tab, previousLog, parent.turn);
		} catch (error: any) {
			parent.inputLog.splice(-switchInputLog.length);
			this.startError = error.message || 'Unable to submit replacements.';
			tab.phase = errorPhase;
		} finally {
			tab.loading = false;
			this.forceUpdate();
		}
	};

	selectMidTurnSwitch = (tab: AnalysisTab, replacementIndex: number) => {
		const index = tab.midTurnSwitchOptionIndex || 0;
		const option = tab.midTurnSwitchOptions?.[index];
		if (!option) return;
		option.replacementIndex = replacementIndex;
		if (index + 1 < tab.midTurnSwitchOptions!.length) {
			tab.midTurnSwitchOptionIndex = index + 1;
			this.forceUpdate();
			return;
		}
		void this.submitMidTurnSwitches(tab);
	};

	submitMidTurnSwitches = async (tab: AnalysisTab) => {
		const parent = tab.nodes[tab.currentNodeId];
		const options = tab.midTurnSwitchOptions || [];
		if (!parent?.seed || !options.length || tab.loading) return;
		const switchInputLog: string[] = [];
		for (const side of ['p1', 'p2'] as const) {
			const sideOptions: AnalysisMidTurnSwitchOption[] = [];
			for (const option of options) {
				if (option.side === side) sideOptions.push(option);
			}
			if (!sideOptions.length) continue;
			const request = tab.requests?.[sideIndex(side)];
			const active = request?.side?.pokemon?.filter((pokemon: any) => pokemon.active) || [];
			const choices: string[] = [];
			for (let slot = 0; slot < (request?.forceSwitch?.length || 0); slot++) {
				if (!request.forceSwitch[slot]) {
					choices.push('pass');
					continue;
				}
				const pokemonIndex = request.side.pokemon.indexOf(active[slot]);
				let replacementIndex: number | undefined;
				for (const option of sideOptions) {
					if (option.pokemonIndex === pokemonIndex) replacementIndex = option.replacementIndex;
				}
				choices.push(replacementIndex !== undefined ? `switch ${replacementIndex + 1}` : 'pass');
			}
			if (choices.length) switchInputLog.push(`>${side} ${choices.join(', ')}`);
		}
		await this.submitReplacements(tab, switchInputLog, 'mid-turn-switch-selection');
	};

	submitSwitchChoices = async (tab: AnalysisTab) => {
		const parent = tab.nodes[tab.currentNodeId];
		if (!parent?.seed || tab.loading) return;
		const switchInputLog: string[] = [];
		for (const side of ['p1', 'p2'] as const) {
			const request = tab.requests?.[sideIndex(side)];
			if (request?.forceSwitch) {
				switchInputLog.push(`>${side} ${this.draft.builders[side]?.toString() || 'default'}`);
			}
		}
		await this.submitReplacements(tab, switchInputLog, 'switch-selection');
	};

	/*********************************************************
	 * Simulation
	 *********************************************************/

	getPotentialMidTurnSwitches(tab: AnalysisTab) {
		const options: AnalysisMidTurnSwitchOption[] = [];
		const dex = (window as any).Dex;
		for (const side of ['p1', 'p2'] as const) {
			const request = tab.requests?.[sideIndex(side)];
			if (!request?.active || !request.side?.pokemon) continue;
			const activePokemon = request.side.pokemon.filter((pokemon: any) => pokemon.active);
			for (let slot = 0; slot < request.active.length; slot++) {
				const pokemon = activePokemon[slot];
				if (!pokemon) continue;
				const pokemonIndex = request.side.pokemon.indexOf(pokemon);
				const moveChoice = this.draft.moveChoicesBySlot[side][slot];
				const moveIndex = Number(/^move (\d+)/.exec(moveChoice || '')?.[1]) - 1;
				const move = request.active[slot]?.moves?.[moveIndex];
				const moveData = move && dex.moves.get(move.id || move.name);
				if (move?.selfSwitch || moveData?.selfSwitch) {
					options.push({
						side, pokemonIndex, pokemon: pokemon.name || pokemon.details,
						reason: moveData.id, reasonName: moveData.name,
					});
				}
			}
			for (let pokemonIndex = 0; pokemonIndex < request.side.pokemon.length; pokemonIndex++) {
				const pokemon = request.side.pokemon[pokemonIndex];
				if (pokemon.fainted) continue;
				const item = dex.items.get(pokemon.item);
				if (item.id === 'ejectbutton' || item.id === 'ejectpack') {
					options.push({
						side, pokemonIndex, pokemon: pokemon.name || pokemon.details,
						reason: item.id, reasonName: item.name,
					});
				}
			}
		}
		return options;
	}

	prepareSimulation = (tab: AnalysisTab) => {
		const options = this.getPotentialMidTurnSwitches(tab);
		if (!options.length) return void this.simulateNextTurn(tab);
		tab.midTurnSwitchOptions = options;
		tab.midTurnSwitchOptionIndex = 0;
		tab.phase = 'simulation-switch-selection';
		this.forceUpdate();
	};

	simulateNextTurn = async (tab: AnalysisTab) => {
		if (tab.loading) return;
		const abortController = new AbortController();
		this.simulationAbortController?.abort();
		this.simulationAbortController = abortController;
		tab.loading = true;
		tab.phase = 'simulating';
		this.forceUpdate();
		try {
			const inputLog = [
				`>p1 ${this.draft.actionChoiceString(tab.requests, 'p1')}`,
				`>p2 ${this.draft.actionChoiceString(tab.requests, 'p2')}`,
			];
			tab.simulationInputLog = inputLog;
			const data = await runAnalysisBatch({
				format: tab.format, team1: tab.team1, team2: tab.team2, seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, tab.currentNodeId, false), inputLog,
				midTurnSwitchChoices: tab.midTurnSwitchOptions?.map(option => ({
					side: option.side, pokemonIndex: option.pokemonIndex, reason: option.reason,
					replacementIndex: option.replacementIndex!,
				})),
				count: tab.simulationCount,
			}, abortController.signal);
			if (abortController.signal.aborted || this.simulationAbortController !== abortController) return;
			const simulationGroups = data.turnGroups || [];
			tab.turnSimulationGroups = simulationGroups;
			tab.stateSimulationGroups = data.stateGroups || [];
			tab.simulationGroupingMode = 'turn';
			tab.simulationGroups = simulationGroups;
			tab.simulationResultCount = data.simulationCount || 0;
			tab.selectedSimulationGroupIndex = 0;
			tab.simulationRoll = 'median';
			const simulation = simulationGroups[0]?.median;
			if (simulation) {
				this.oneTurnStartTurn = tab.nodes[tab.currentNodeId]?.turn ?? 0;
				tab.selectedSimulationIndex = simulation.index;
				tab.log = simulation.log;
				tab.phase = 'one-turn';
				tab.oneTurnDestination = 'simulation-selection';
				this.destroyBattle();
			} else {
				tab.phase = 'default';
			}
		} catch (error: any) {
			if (error.name !== 'AbortError' && !abortController.signal.aborted) {
				this.startError = error.message || 'Unable to simulate the turn.';
				tab.phase = 'default';
			}
		} finally {
			tab.midTurnSwitchOptions = undefined;
			tab.midTurnSwitchOptionIndex = undefined;
			if (this.simulationAbortController === abortController) {
				this.simulationAbortController = null;
				tab.loading = false;
				this.forceUpdate();
			}
		}
	};

	getSelectedSimulation(tab: AnalysisTab) {
		const group = tab.simulationGroups?.[tab.selectedSimulationGroupIndex ?? 0];
		return group?.[tab.simulationRoll || 'median'] || null;
	}

	clearSimulationState(tab: AnalysisTab) {
		this.simulationAbortController?.abort();
		this.simulationAbortController = null;
		tab.loading = false;
		tab.simulationGroups = undefined;
		tab.turnSimulationGroups = undefined;
		tab.stateSimulationGroups = undefined;
		tab.simulationGroupingMode = undefined;
		tab.simulationResultCount = undefined;
		tab.selectedSimulationIndex = undefined;
		tab.selectedSimulationGroupIndex = undefined;
		tab.hoveredSimulationGroupIndex = undefined;
		tab.simulationRoll = undefined;
		tab.midTurnSwitchOptions = undefined;
		tab.midTurnSwitchOptionIndex = undefined;
		tab.oneTurnDestination = undefined;
	}

	cancelSimulationSwitchSelection = (tab: AnalysisTab) => {
		tab.midTurnSwitchOptions = undefined;
		tab.midTurnSwitchOptionIndex = undefined;
		tab.phase = 'default';
		this.forceUpdate();
	};

	selectSimulationSwitch = (tab: AnalysisTab, replacementIndex: number) => {
		const index = tab.midTurnSwitchOptionIndex || 0;
		const option = tab.midTurnSwitchOptions?.[index];
		if (!option) return;
		option.replacementIndex = replacementIndex;
		if (index + 1 < tab.midTurnSwitchOptions!.length) {
			tab.midTurnSwitchOptionIndex = index + 1;
			this.forceUpdate();
			return;
		}
		void this.simulateNextTurn(tab);
	};

	cancelSimulation = (tab: AnalysisTab, nodeId = tab.currentNodeId) => {
		this.clearSimulationState(tab);
		tab.simulationInputLog = undefined;
		void this.restoreAnalysisNode(tab, nodeId);
	};

	showSimulation = (
		tab: AnalysisTab, groupIndex: number, roll = tab.simulationRoll || 'median', scroll = false
	) => {
		const simulation = tab.simulationGroups?.[groupIndex]?.[roll];
		if (!simulation) return;
		tab.log = simulation.log;
		tab.selectedSimulationGroupIndex = groupIndex;
		tab.simulationRoll = roll;
		tab.selectedSimulationIndex = simulation.index;
		tab.hoveredSimulationGroupIndex = undefined;
		tab.phase = 'simulation-selection';
		this.destroyBattle();
		this.forceUpdate();
		if (scroll) {
			requestAnimationFrame(() => this.simulationGroupElements[groupIndex]?.scrollIntoView({ block: 'start' }));
		}
	};

	changeSimulationGrouping = (tab: AnalysisTab, mode: AnalysisGroupingMode) => {
		tab.simulationGroupingMode = mode;
		tab.simulationGroups = mode === 'state' ? tab.stateSimulationGroups : tab.turnSimulationGroups;
		this.showSimulation(tab, 0, 'median', true);
	};

	previewSimulation = (tab: AnalysisTab, groupIndex?: number) => {
		const selectedIndex = tab.selectedSimulationGroupIndex ?? 0;
		const simulation = tab.simulationGroups?.[groupIndex ?? selectedIndex]?.[tab.simulationRoll || 'median'];
		if (!simulation) return;
		tab.hoveredSimulationGroupIndex = groupIndex;
		tab.log = simulation.log;
		this.destroyBattle();
		this.forceUpdate();
	};

	changeSimulationRoll = (tab: AnalysisTab, roll: AnalysisSimulationRoll) => {
		this.showSimulation(tab, tab.selectedSimulationGroupIndex ?? 0, roll);
	};

	replaySimulationTurn = (tab: AnalysisTab) => {
		const simulation = this.getSelectedSimulation(tab);
		if (!simulation) return;
		tab.log = simulation.log;
		tab.phase = 'one-turn';
		tab.oneTurnDestination = 'simulation-selection';
		this.destroyBattle();
		this.oneTurnStartTurn = tab.nodes[tab.currentNodeId]?.turn ?? 0;
		this.forceUpdate();
	};

	/** Commits the selected simulation's seed and choices to the current node. */
	selectSimulationOutcome = async (tab: AnalysisTab) => {
		const simulation = this.getSelectedSimulation(tab);
		if (!simulation || !tab.nodes[tab.currentNodeId] || !tab.simulationInputLog) return;
		const selectedInputLog = [...tab.simulationInputLog, ...(simulation.switchInputLog || [])];
		this.setChoiceBuilders(tab.requests, tab.gameType);
		this.draft.hydrate(tab.simulationInputLog);
		const choiceSummary = this.getMoveChoiceSummary(tab);
		const parent = this.editCurrentNode(tab, node => {
			node.seed = simulation.seed;
			node.inputLog = [...selectedInputLog];
			node.choiceSummary = choiceSummary.map(choice => ({ ...choice }));
		})!;
		tab.loading = true;
		this.forceUpdate();
		try {
			const data = await runAnalysis({
				format: tab.format, team1: tab.team1, team2: tab.team2, seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, parent.id, true),
			});
			this.clearSimulationState(tab);
			tab.simulationInputLog = undefined;
			const requestState = this.applyBattleResponse(tab, data);
			if (requestState === 'switch') {
				tab.phase = 'switch-selection';
			} else {
				parent.turnEventSummary = getTurnEventSummary(simulation);
				this.storeAnalysisNode(tab, [], parent.id);
				tab.phase = requestState === 'teampreview' ? 'preview' : 'default';
			}
			this.destroyBattle();
			this.refreshChoicesForResponse(tab);
		} catch (error: any) {
			this.startError = error.message || 'Unable to select this outcome.';
		} finally {
			tab.loading = false;
			this.forceUpdate();
		}
	};

	renderSimulationGroup(tab: AnalysisTab, group: AnalysisSimulationGroup, index: number) {
		const simulationCount = tab.simulationResultCount || 0;
		const proportion = simulationCount ? group.count / simulationCount : 0;
		const errorPercentage = 100 * Math.sqrt(proportion * (1 - proportion) / simulationCount);
		const simulation = group[tab.simulationRoll || 'median'];
		const selected = index === tab.selectedSimulationGroupIndex;
		const hovered = index === tab.hoveredSimulationGroupIndex;
		const playbackActive = tab.phase === 'one-turn';
		const mode = tab.simulationGroupingMode || 'turn';
		const executions = mode === 'state' && group.executions.length > 1 ? group.executions : [simulation];
		const visibleExecutions = selected ? executions : executions.slice(0, 2);
		const setElement = (element: HTMLElement | null) => {
			this.simulationGroupElements[index] = element;
		};
		return <li class="analysis-simulation-group" ref={setElement}>
			<button
				class={`analysis-simulation-outcome ${selected ? 'selected' : ''}${hovered ? ' hovered' : ''}`}
				disabled={playbackActive}
				onMouseEnter={() => { if (!playbackActive) this.previewSimulation(tab, index); }}
				onMouseLeave={() => { if (!playbackActive) this.previewSimulation(tab); }}
				onClick={() => { if (!playbackActive) this.showSimulation(tab, index, undefined, true); }}
			>
				<strong>Outcome {index + 1}</strong>
				<span>
					{group.count} / {simulationCount} simulations
					({group.percentage.toFixed(1)}% ± {errorPercentage.toFixed(1)}%)
				</span>
				{visibleExecutions.map((execution, executionIndex) => <>
					{executionIndex ? <span class="analysis-execution-separator">or</span> : null}
					<AnalysisTurnEventSummaryView actions={getTurnEventSummary(execution, mode, group)} />
				</>)}
				{!selected && executions.length > 2 ? <span class="analysis-execution-separator">
					... ({executions.length - 2} more possible turn{executions.length === 3 ? '' : 's'})
				</span> : null}
			</button>
		</li>;
	}

	/*********************************************************
	 * Teams and tabs
	 *********************************************************/

	setChoiceBuilders(requests: any[] | undefined, gameType = '') {
		this.draft.reset(requests, gameType);
		if (this.battle) {
			for (const request of requests || []) {
				if (request) BattleChoiceBuilder.fixRequest(request, this.battle as any);
			}
		}
	}

	loadTeams() {
		let buffer = '';
		try {
			buffer = localStorage.getItem('showdown_teams') || localStorage.getItem('showdown_teams_local') || '';
		} catch {}
		this.loadTeamsFromPacked(buffer);
	}

	loadTeamsFromPacked(buffer: string) {
		this.teams = [];
		for (const line of buffer.split('\n')) {
			const pipeIndex = line.indexOf('|');
			if (pipeIndex < 0) continue;
			const bracketIndex = line.indexOf(']');
			const hasFormat = bracketIndex > pipeIndex ? -1 : bracketIndex;
			const slashIndex = line.lastIndexOf('/', pipeIndex);
			const nameStart = slashIndex >= 0 ? slashIndex + 1 : hasFormat + 1;
			const format = hasFormat >= 0 ? line.slice(line.indexOf('[') + 1, hasFormat) : 'gen9';
			this.teams.push({
				name: line.slice(nameStart, pipeIndex),
				format: format.startsWith('gen') ? format : `gen6${format}`,
				packedTeam: line.slice(pipeIndex + 1),
			});
		}
		this.updateTeamChoices();
	}

	loadTeamsFromPlay = () => {
		const iframe = document.createElement('iframe');
		iframe.hidden = true;
		const query = [
			`host=${encodeURIComponent(location.hostname)}`,
			`path=${encodeURIComponent(location.pathname.slice(1))}`,
			`protocol=${encodeURIComponent(location.protocol)}`,
		].join('&');
		iframe.src = `https://play.pokemonshowdown.com/crossdomain.php?${query}`;
		document.body.appendChild(iframe);
		setTimeout(() => iframe.remove(), 3000);
	};

	updateTeamChoices() {
		const matchingTeams = this.teams.filter(team => !team.format || team.format === this.format);
		if (!matchingTeams.some(team => team.packedTeam === this.team1)) {
			this.team1 = matchingTeams[0]?.packedTeam || '';
		}
		if (!matchingTeams.some(team => team.packedTeam === this.team2)) {
			this.team2 = matchingTeams[1]?.packedTeam || matchingTeams[0]?.packedTeam || '';
		}
	}

	openHome = () => {
		this.destroyBattle();
		this.activeTab = null;
		this.mode = null;
		this.forceUpdate();
	};

	closeTab = (event: Event, id: string) => {
		event.preventDefault();
		event.stopPropagation();
		this.tabs = this.tabs.filter(tab => tab.id !== id);
		if (this.activeTab === id) this.activeTab = this.tabs[this.tabs.length - 1]?.id || null;
		this.forceUpdate();
	};

	dragStart = (event: DragEvent, id: string) => {
		this.draggedTab = id;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', id);
		}
	};

	dragEnter = (event: DragEvent, id: string) => {
		event.preventDefault();
		if (!this.draggedTab || this.draggedTab === id) return;
		const from = this.tabs.findIndex(tab => tab.id === this.draggedTab);
		const to = this.tabs.findIndex(tab => tab.id === id);
		if (from < 0 || to < 0) return;
		const tabs = [...this.tabs];
		const [tab] = tabs.splice(from, 1);
		tabs.splice(to, 0, tab);
		this.tabs = tabs;
		this.forceUpdate();
	};

	/*********************************************************
	 * Battle rendering and playback
	 *********************************************************/

	destroyBattle() {
		this.battleFrame?.removeEventListener('click', this.handleBattleClick);
		this.battleTooltipObserver?.disconnect();
		this.battleTooltipObserver = null;
		if (this.choiceTooltips && this.choiceTooltipsFrame) this.choiceTooltips.unlisten(this.choiceTooltipsFrame);
		this.choiceTooltips = null;
		this.choiceTooltipsFrame = null;
		this.choiceControlsFrame = null;
		this.battle?.destroy();
		this.battle = null;
		this.battleTabId = null;
		this.playbackStage = null;
	}

	finishOneTurn(tab: AnalysisTab) {
		this.playbackStage = null;
		if (tab.oneTurnDestination === 'mid-turn-switch-selection') {
			tab.oneTurnDestination = undefined;
			tab.phase = 'mid-turn-switch-selection';
			this.forceUpdate();
			return;
		}
		if (tab.oneTurnDestination === 'switch-selection') {
			tab.oneTurnDestination = undefined;
			tab.phase = 'switch-selection';
			this.setChoiceBuilders(tab.requests, tab.gameType);
			this.forceUpdate();
			return;
		}
		if (tab.oneTurnDestination === 'simulation-selection') {
			tab.oneTurnDestination = undefined;
			tab.phase = 'simulation-selection';
			this.forceUpdate();
			return;
		}
		tab.phase = 'default';
		void this.restoreAnalysisNode(tab, tab.currentNodeId);
	}

	handleBattleSubscription = (state: string) => {
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		const battle = this.battle as any;
		if (!tab || !battle) return;
		if (tab.phase === 'one-turn') {
			if (state === 'atqueueend' && this.playbackStage === 'seek-end') {
				this.playbackStage = 'seek-previous';
				setTimeout(() => {
					if (this.battle === battle && tab.phase === 'one-turn' && this.playbackStage === 'seek-previous') {
						battle.seekBy(-1);
					}
				}, 0);
				return;
			}
			if (state === 'paused' && this.playbackStage === 'seek-previous') {
				this.playbackStage = 'playing';
				setTimeout(() => {
					if (this.battle === battle && tab.phase === 'one-turn' && this.playbackStage === 'playing') {
						battle.play();
					}
				}, 0);
				return;
			}
			if (state === 'turn' && this.playbackStage === 'playing') {
				this.playbackStage = null;
				setTimeout(() => {
					if (this.battle !== battle || tab.phase !== 'one-turn') return;
					battle.pause();
					this.finishOneTurn(tab);
				}, 0);
				return;
			}
			if (state === 'atqueueend' && this.playbackStage === 'playing') {
				this.finishOneTurn(tab);
			}
		} else if (tab.phase === 'replay' && state === 'atqueueend') {
			tab.phase = 'default';
			this.turnView = false;
			this.forceUpdate();
			requestAnimationFrame(() => {
				if (this.battle === battle && tab.phase === 'default') this.rebindChoiceTooltips();
			});
		} else {
			this.forceUpdate();
		}
	};

	handleBattleClick = (event: Event) => {
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		if (!tab || (tab.phase !== 'default' && tab.phase !== 'selection')) return;
		const target = event.target as HTMLElement;
		const marker = target.closest<HTMLElement>('.has-tooltip[data-tooltip]');
		const tooltip = marker?.dataset.tooltip;
		if (!tooltip) return;
		const args = tooltip.split('|');
		if (args[0] === 'analysispokemon') {
			const sideNumber = Number(args[1]);
			const teamIndex = Number(args[2]);
			const battleSide = (this.battle as any)?.sides?.[sideNumber];
			const activeIndex = battleSide?.active?.findIndex((pokemon: any) =>
				this.findAnalysisTeamIndex(sideNumber, pokemon) === teamIndex);
			if (activeIndex === undefined || activeIndex < 0) return;
			this.selectMovePokemon(sideNumber === 0 ? 'p1' : 'p2', activeIndex);
		} else if (args[0] === 'activepokemon') {
			const sideNumber = Number(args[1]);
			this.selectMovePokemon(sideNumber === 0 ? 'p1' : 'p2', Number(args[2]) || 0);
		} else {
			return;
		}
		this.forceUpdate();
	};

	openReplayFromStart = (tab: AnalysisTab) => {
		tab.phase = 'replay';
		this.turnView = false;
		const battle = this.battle as any;
		battle?.pause();
		battle?.seekTurn(0);
		this.forceUpdate();
	};

	replayPreviousTurn = (tab: AnalysisTab) => {
		if (!this.battle) return;
		const parentId = tab.nodes[tab.currentNodeId]?.parentId;
		tab.phase = 'one-turn';
		this.destroyBattle();
		this.oneTurnStartTurn = parentId ? tab.nodes[parentId]?.turn ?? 0 : 0;
		this.forceUpdate();
	};

	skipOneTurn = (tab: AnalysisTab) => {
		this.playbackStage = null;
		(this.battle as any)?.seekTurn(Infinity);
		if (tab.phase === 'one-turn') this.finishOneTurn(tab);
	};

	previousNode = (tab: AnalysisTab) => {
		const parentId = tab.nodes[tab.currentNodeId]?.parentId;
		if (parentId) this.selectAnalysisNode(tab, parentId);
	};

	openTurn = () => {
		this.turnView = `${(this.battle as any)?.turn || ''}` || true;
		this.forceUpdate();
	};

	closeTurn = (event?: Event) => {
		event?.preventDefault();
		this.turnView = false;
		this.forceUpdate();
	};

	goToTurn = (event: Event) => {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const value = (form.elements.namedItem('turn') as HTMLInputElement)?.value.trim();
		if (!value) return this.closeTurn();
		let turn = Number(value);
		if (['e', 'end', 'f', 'finish'].includes(value.toLowerCase())) turn = Infinity;
		if (isNaN(turn) || turn < 0) {
			this.startError = 'Invalid turn.';
			this.forceUpdate();
			return;
		}
		(this.battle as any)?.seekTurn(turn);
		this.closeTurn();
	};

	getReplaySpeed() {
		const battle = this.battle as any;
		if (!battle) return 'normal';
		if (battle.messageFadeTime <= 40) return 'hyperfast';
		if (battle.messageFadeTime <= 50) return 'fast';
		if (battle.messageFadeTime >= 1000) return 'reallyslow';
		if (battle.messageFadeTime >= 500) return 'slow';
		return 'normal';
	}

	changeReplaySpeed = (event: Event) => {
		type Speed = 'hyperfast' | 'fast' | 'normal' | 'slow' | 'reallyslow';
		const speed = (event.target as HTMLSelectElement).value as Speed;
		const fade = { hyperfast: 40, fast: 50, normal: 300, slow: 500, reallyslow: 1000 };
		const delay = { hyperfast: 1, fast: 1, normal: 1, slow: 1000, reallyslow: 3000 };
		const battle = this.battle as any;
		if (!battle) return;
		battle.messageFadeTime = fade[speed];
		battle.messageShownTime = delay[speed];
		battle.scene.updateAcceleration();
		this.forceUpdate();
	};

	/*********************************************************
	 * Choosing actions
	 *********************************************************/

	selectPreviewPokemon = (side: AnalysisSideID, index: number) => {
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		const builder = this.draft.builders[side];
		if (!builder || builder.alreadySwitchingIn.includes(index + 1)) return;
		const error = builder.addChoice(`team ${index + 1}`);
		if (error) this.startError = error;
		if (tab) this.saveLeafDraft(tab);
		this.forceUpdate();
	};

	selectMovePokemon = (side: AnalysisSideID, index: number) => {
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		if (!tab || (tab.phase !== 'default' && tab.phase !== 'selection')) return;
		if (tab.phase === 'default') {
			this.draft.saveSnapshot();
			tab.phase = 'selection';
		}
		const { choiceSide } = this.draft;
		if (this.draft.pendingTarget && choiceSide) {
			const previousRequest = tab.requests?.[sideIndex(choiceSide.side)];
			if (previousRequest?.active) this.draft.rebuildMoveBuilder(choiceSide.side, previousRequest);
		}
		this.draft.pendingTarget = null;
		this.draft.choiceSide = { side, index };
		this.forceUpdate();
	};

	cancelActionSelection = (tab: AnalysisTab) => {
		this.draft.restoreSnapshot(tab.requests, tab.gameType);
		tab.phase = 'default';
		this.saveLeafDraft(tab);
		this.forceUpdate();
	};

	cancelIntermediateSelection = (tab: AnalysisTab) => {
		if (!this.draft.choiceSide) return;
		const { side } = this.draft.choiceSide;
		this.draft.pendingTarget = null;
		const request = tab.requests?.[sideIndex(side)];
		if (request?.active) this.draft.rebuildMoveBuilder(side, request);
		this.forceUpdate();
	};

	finishActionSelection = (tab: AnalysisTab) => {
		this.draft.snapshot = null;
		this.draft.choiceSide = null;
		this.draft.pendingTarget = null;
		tab.phase = 'default';
		this.commitCurrentDraft(tab);
		this.forceUpdate();
	};

	setAnalysisTeams(requests: any[] | undefined) {
		if (!this.battle) return;
		const teams = requests?.map(request => request?.side?.pokemon || []) || [];
		this.analysisTeams = teams;
		(this.battle as any).myPokemon = teams[0];
		(this.battle as any).myAllyPokemon = teams[1];
	}

	findAnalysisTeamIndex(side: number, pokemon: any) {
		const team = this.analysisTeams[side] || [];
		if (!pokemon) return -1;
		const exactIndex = team.findIndex((entry: any) => entry.ident && pokemon.ident && entry.ident === pokemon.ident);
		if (exactIndex >= 0) return exactIndex;
		const detailsIndex = team.findIndex((entry: any) =>
			entry.details && pokemon.details && entry.details === pokemon.details);
		if (detailsIndex >= 0) return detailsIndex;
		return team.findIndex((entry: any) =>
			entry.speciesForme && pokemon.speciesForme && entry.speciesForme === pokemon.speciesForme);
	}

	getMoveData(move: any) {
		const dex = (window as any).Dex;
		const data = dex?.moves?.get(move.id || move.name || move.move);
		return {
			name: move.name || move.move,
			type: data?.type || move.type || 'Normal',
			target: data?.target || move.target || 'normal',
		};
	}

	getTargetCandidates(tab: AnalysisTab, side: AnalysisSideID, attackerSlot: number, targetType: string) {
		const attackerSide = sideIndex(side);
		const candidates: { pokemon: any, side: number, slot: number, teamIndex: number }[] = [];
		for (const targetSide of [0, 1]) {
			const activeSlots = (this.battle as any)?.sides?.[targetSide]?.active || [];
			for (let slot = 0; slot < activeSlots.length; slot++) {
				const battlePokemon = activeSlots[slot];
				const teamIndex = this.findAnalysisTeamIndex(targetSide, battlePokemon);
				const pokemon = this.analysisTeams[targetSide]?.[teamIndex];
				if (!battlePokemon || teamIndex < 0 || !pokemon || battlePokemon.fainted) continue;
				const isSelf = targetSide === attackerSide && slot === attackerSlot;
				const isAlly = targetSide === attackerSide && slot !== attackerSlot;
				const isFoe = targetSide !== attackerSide;
				const adjacent = Math.abs(slot - attackerSlot) <= 1;
				let valid = false;
				switch (targetType) {
				case 'self': valid = isSelf; break;
				case 'adjacentAlly': valid = isAlly && adjacent; break;
				case 'adjacentAllyOrSelf': valid = (isAlly || isSelf) && adjacent; break;
				case 'adjacentFoe': valid = isFoe && adjacent; break;
				case 'any': valid = !isSelf; break;
				case 'normal': valid = !isSelf && adjacent; break;
				default: valid = false;
				}
				if (valid) candidates.push({ pokemon, side: targetSide, slot, teamIndex });
			}
		}
		return candidates;
	}

	/*********************************************************
	 * Damage calcs
	 *********************************************************/

	/** Calcs apply to the current decision point and draft; null when no move decision is shown. */
	calcKey(tab: AnalysisTab | undefined) {
		if (!tab || (tab.phase !== 'default' && tab.phase !== 'selection')) return null;
		if (getRequestState(tab.requestState, tab.requests) !== 'move') return null;
		return [tab.id, tab.currentNodeId, ...this.draft.toInputLog(tab.requests)].join('\n');
	}

	/** Fetches calcs when the decision point or draft choices change, so tooltips can show them instantly. */
	refreshCalcs(tab: AnalysisTab | undefined) {
		const key = this.calcKey(tab);
		if (key === (this.calcs?.key ?? null)) return;
		this.calcAbortController?.abort();
		this.calcAbortController = null;
		if (!key || !tab) {
			this.calcs = null;
			return;
		}
		const calcs: AnalysisCalcState = { key, loading: true };
		this.calcs = calcs;
		const abortController = new AbortController();
		this.calcAbortController = abortController;
		void this.fetchCalcs(tab, calcs, abortController.signal);
	}

	async fetchCalcs(tab: AnalysisTab, calcs: AnalysisCalcState, signal: AbortSignal) {
		try {
			const data = await runAnalysisCalc({
				format: tab.format, team1: tab.team1, team2: tab.team2, seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, tab.currentNodeId, false),
				choices: this.draft.toInputLog(tab.requests),
			}, signal);
			calcs.results = data.results;
		} catch (error: any) {
			if (error?.name !== 'AbortError') calcs.error = error?.message || 'Unable to calculate damage.';
		} finally {
			calcs.loading = false;
			if (this.calcs === calcs) this.choiceTooltips?.refreshVisibleTooltip();
		}
	}

	/*********************************************************
	 * Tooltips
	 *********************************************************/

	syncChoiceTooltips() {
		const tooltipFrame = this.battleFrame?.parentElement || this.choiceControlsFrame;
		if (!this.battle || !tooltipFrame || this.choiceTooltipsFrame === tooltipFrame) return;
		const sceneTooltips = (this.battle as any).scene?.tooltips;
		sceneTooltips?.unlisten(tooltipFrame);
		if (this.battleFrame) sceneTooltips?.unlisten(this.battleFrame);
		const $ = (window as any).$;
		if ($) {
			$(tooltipFrame).off('.battleTooltips');
			if (this.battleFrame) $(this.battleFrame).off('.battleTooltips');
		}
		if (this.choiceTooltips && this.choiceTooltipsFrame) this.choiceTooltips.unlisten(this.choiceTooltipsFrame);
		this.choiceTooltips = new AnalysisTooltips(this.battle as any, () => this.calcs);
		this.choiceTooltips.listen(tooltipFrame);
		this.choiceTooltipsFrame = tooltipFrame;
	}

	rebindChoiceTooltips() {
		if (this.choiceTooltips && this.choiceTooltipsFrame) this.choiceTooltips.unlisten(this.choiceTooltipsFrame);
		this.choiceTooltips = null;
		this.choiceTooltipsFrame = null;
		this.syncChoiceTooltips();
		this.upgradeBattleTooltips();
	}

	/** Points the battle's Pokémon tooltips at exact server data for both sides. */
	upgradeBattleTooltips() {
		if (!this.battleFrame || !this.battle) return;
		const battle = this.battle as any;
		const elements = this.battleFrame.querySelectorAll<HTMLElement>('.has-tooltip[data-tooltip]');
		for (const element of elements) {
			const args = (element.dataset.tooltip || '').split('|');
			if (args[1] !== '0' && args[1] !== '1') continue;
			const side = Number(args[1]);
			let pokemon;
			if (args[0] === 'pokemon') {
				pokemon = battle.sides[side]?.pokemon?.[Number(args[2])];
			} else if (args[0] === 'activepokemon') {
				pokemon = battle.sides[side]?.active?.[Number(args[2])];
			} else {
				continue;
			}
			const teamIndex = this.findAnalysisTeamIndex(side, pokemon);
			if (!Number.isInteger(teamIndex) || teamIndex < 0) continue;
			element.dataset.tooltip = `analysispokemon|${side}|${teamIndex}`;
		}
	}

	observeBattleTooltips() {
		if (!this.battleFrame || this.battleTooltipObserver) return;
		this.battleTooltipObserver = new MutationObserver(() => this.upgradeBattleTooltips());
		this.battleTooltipObserver.observe(this.battleFrame, { childList: true, subtree: true });
		this.upgradeBattleTooltips();
	}

	setChoiceControlsFrame = (element: HTMLElement | null) => {
		if (this.choiceTooltips && this.choiceTooltipsFrame && this.choiceTooltipsFrame !== element) {
			this.choiceTooltips.unlisten(this.choiceTooltipsFrame);
		}
		this.choiceControlsFrame = element;
		this.choiceTooltipsFrame = null;
		this.syncChoiceTooltips();
	};

	override componentDidUpdate() {
		this.syncChoiceTooltips();
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		this.refreshCalcs(tab);
		if (!tab || !this.battleFrame || !this.battleLogFrame || !tab.log.length || this.battleTabId === tab.id) return;
		this.destroyBattle();
		const BattleConstructor = (window as any).Battle;
		const $ = (window as any).$;
		if (!BattleConstructor || !$) return;
		this.battle = new BattleConstructor({
			id: tab.id,
			$frame: $(this.battleFrame),
			$logFrame: $(this.battleLogFrame),
			log: tab.log,
			isReplay: true,
			paused: true,
			autoresize: true,
			subscription: this.handleBattleSubscription,
		});
		const battle = this.battle as any;
		for (const request of tab.requests || []) {
			if (request) BattleChoiceBuilder.fixRequest(request, battle);
		}
		this.setAnalysisTeams(tab.requests);
		this.setChoiceBuilders(tab.requests, tab.gameType);
		this.upgradeBattleTooltips();
		this.battleFrame.addEventListener('click', this.handleBattleClick);
		battle.scene?.$frame?.css('transform', `scale(${this.layout.battleHeight / 360})`);
		this.battleTabId = tab.id;
		if (this.pendingHydration?.tabId === tab.id) {
			const inputLog = this.pendingHydration.inputLog;
			this.pendingHydration = null;
			this.draft.hydrate(inputLog);
			this.updateCurrentNodeSummary(tab);
			this.forceUpdate();
		}
		if (tab.phase === 'replay') {
			battle.seekTurn(0);
		} else if (tab.phase === 'one-turn') {
			if (this.oneTurnStartTurn !== null) {
				const startTurn = this.oneTurnStartTurn;
				this.oneTurnStartTurn = null;
				this.playbackStage = 'seek-previous';
				battle.seekTurn(startTurn);
			} else {
				this.playbackStage = 'seek-end';
				battle.seekTurn(Infinity);
			}
		} else {
			battle.seekTurn(Infinity);
		}
		this.syncChoiceTooltips();
		this.observeBattleTooltips();
	}

	override componentWillUnmount() {
		this.destroyBattle();
		window.removeEventListener('message', this.receiveStorageMessage);
		window.removeEventListener('resize', this.updateLayout);
	}

	/*********************************************************
	 * Home and start forms
	 *********************************************************/

	openMode = (mode: StartMode) => {
		this.mode = mode;
		if (mode === 'teams') this.updateTeamChoices();
		this.forceUpdate();
	};

	startAnalysis = async (event: Event) => {
		event.preventDefault();
		if (this.mode === 'teams' && this.showSyntaxImport) {
			this.team1 = packTeamSyntax(this.teamSyntax1);
			this.team2 = packTeamSyntax(this.teamSyntax2);
		}
		if (this.mode === 'teams' && (!this.team1 || !this.team2)) return;
		if (this.mode !== 'teams') {
			this.startError = 'Only New Analysis From Teams is connected to the simulator yet.';
			this.forceUpdate();
			return;
		}
		this.starting = true;
		this.startError = '';
		this.forceUpdate();
		try {
			const data = await runAnalysis({ format: this.format, team1: this.team1, team2: this.team2 });
			const rootNodeId = `node-${Date.now()}-root`;
			const teamSelectionNodeId = `node-${Date.now()}-0`;
			const requestState = getRequestState(data.requestState, data.requests);
			const tab: AnalysisTab = {
				id: `analysis-${Date.now()}`,
				title: 'New analysis',
				format: this.format,
				log: data.log || [],
				snapshot: data.snapshot,
				gameType: data.gameType,
				team1: this.team1,
				team2: this.team2,
				requests: data.requests,
				requestState,
				phase: requestState === 'teampreview' ? 'preview' : 'default',
				nodes: {
					[rootNodeId]: {
						id: rootNodeId,
						parentId: null,
						seed: null,
						turn: -1,
						inputLog: [],
					},
					[teamSelectionNodeId]: {
						id: teamSelectionNodeId,
						parentId: rootNodeId,
						seed: null,
						turn: 0,
						inputLog: [],
					},
				},
				currentNodeId: teamSelectionNodeId,
				rootSeed: data.seed,
				simulationCount: 1000,
			};
			this.tabs = [...this.tabs, tab];
			this.activeTab = tab.id;
			this.setChoiceBuilders(data.requests, data.gameType);
			this.initializeCurrentNodeSummary(tab);
			this.mode = null;
		} catch (error: any) {
			this.startError = error.message || 'Unable to start the analysis.';
		} finally {
			this.starting = false;
		}
		this.forceUpdate();
	};

	renderHome() {
		return <div class="analysis-home">
			<h1>Battle Analysis</h1>
			<p>Build branches from a battle position, inspect choices, and compare possible next turns.</p>
			<div class="analysis-options">
				<button class="button analysis-option" onClick={() => this.openMode('setup')}>
					<strong>Set Up Position</strong><small>Choose a format and begin from a manual position.</small>
				</button>
				<button class="button analysis-option" disabled>
					<strong>Import Analysis</strong>
					<small>Analysis file import will be added after the export format is stable.</small>
				</button>
				<button class="button analysis-option" onClick={() => this.openMode('replay')}>
					<strong>Import Replay</strong><small>Load a replay URL or prepare an uploaded replay file.</small>
				</button>
				<button class="button analysis-option" onClick={() => this.openMode('teams')}>
					<strong>New Analysis From Teams</strong><small>Choose a format and two local teams.</small>
				</button>
			</div>
			{this.mode && this.renderStartForm()}
		</div>;
	}

	renderStartForm() {
		const onSubmit = (event: Event) => void this.startAnalysis(event);
		if (this.mode === 'replay') {
			return <form class="analysis-form" onSubmit={onSubmit}>
				<h2>Import Replay</h2>
				<label>
					Replay URL{' '}
					<input
						type="text" value={this.replayURL} placeholder="https://replay.pokemonshowdown.com/..."
						onInput={event => { this.replayURL = (event.target as HTMLInputElement).value; }}
					/>
				</label>
				<label>Replay HTML file<input type="file" accept=".html,.log,.json" /></label>
				<button class="button" type="submit">Open Replay Analysis</button>
				<button class="button" type="button" onClick={this.openHome}>Cancel</button>
			</form>;
		}
		return <form class="analysis-form" onSubmit={onSubmit}>
			<h2>{this.mode === 'teams' ? 'New Analysis From Teams' : 'Set Up Position'}</h2>
			<p>
				<label class="label">Format:</label>
				<select
					class="select formatselect" value={this.format}
					onChange={event => {
						this.format = (event.target as HTMLSelectElement).value;
						this.updateTeamChoices();
						this.forceUpdate();
					}}
				>{FORMATS.map(format => <option value={format.id}>{format.name}</option>)}</select>
			</p>
			{this.mode === 'teams' && <div>
				<button class="button" type="button" onClick={this.loadTeamsFromPlay}>Load teams from Play</button>
				<button
					class="button" type="button"
					onClick={() => { this.showSyntaxImport = !this.showSyntaxImport; this.forceUpdate(); }}
				>Import team syntax</button>
				{this.showSyntaxImport && <div>
					<label>
						Team 1 syntax{' '}
						<textarea
							value={this.teamSyntax1} placeholder="Paste a standard exported Pokemon Showdown team here"
							onInput={event => { this.teamSyntax1 = (event.target as HTMLTextAreaElement).value; }}
						/>
					</label>
					<label>
						Team 2 syntax{' '}
						<textarea
							value={this.teamSyntax2} placeholder="Paste a standard exported Pokemon Showdown team here"
							onInput={event => { this.teamSyntax2 = (event.target as HTMLTextAreaElement).value; }}
						/>
					</label>
				</div>}
				{this.renderTeamSelect('Team 1', this.team1, value => { this.team1 = value; })}
				{this.renderTeamSelect('Team 2', this.team2, value => { this.team2 = value; })}
			</div>}
			{this.startError && <p class="message-error">{this.startError}</p>}
			<button
				class="button" type="submit"
				disabled={this.starting || (this.mode === 'teams' && (!this.team1 || !this.team2))}
			>{this.starting ? 'Starting...' : 'Start Analysis'}</button>
			<button class="button" type="button" onClick={this.openHome}>Cancel</button>
		</form>;
	}

	renderTeamSelect(label: string, selected: string, onChange: (value: string) => void) {
		const teams = this.teams.filter(team => !team.format || team.format === this.format);
		const selectedTeam = teams.find(team => team.packedTeam === selected);
		const species = selectedTeam?.packedTeam ? Teams.unpackSpeciesOnly(selectedTeam.packedTeam) : [];
		const id = `analysis-${label.replace(/\s+/g, '-').toLowerCase()}`;
		return <p>
			<label class="label" for={id}>{label}:</label>
			<select
				id={id} name="team" class="select teamselect" value={selected} disabled={!teams.length}
				onChange={event => {
					onChange((event.target as HTMLSelectElement).value);
					this.forceUpdate();
				}}
			>
				{!teams.length && <option value="">No local teams</option>}
				{teams.map(team => <option value={team.packedTeam}>{team.name}</option>)}
			</select>
			{selectedTeam && <span class="analysis-team-preview">
				<strong>{selectedTeam.name}</strong>
				<small>{species.map(pokemon => <PSIcon pokemon={pokemon} />)}</small>
			</span>}
		</p>;
	}

	/*********************************************************
	 * Battle controls
	 *********************************************************/

	renderMoveChoices(tab: AnalysisTab) {
		const { choiceSide } = this.draft;
		if (!choiceSide) return null;
		const { side, index: choiceIndex } = choiceSide;
		const builder = this.draft.builders[side];
		const request = tab.requests?.[sideIndex(side)];
		const active = request?.active?.[choiceIndex];
		if (!builder || !active) return null;
		const pendingTarget = this.draft.pendingTarget?.side === side && this.draft.pendingTarget.index === choiceIndex ?
			this.draft.pendingTarget : null;
		if (builder.current.move || pendingTarget) {
			return this.renderTargetChoices(tab, side, choiceIndex, builder, pendingTarget);
		}
		const toggle = (key: 'mega' | 'megax' | 'megay' | 'tera') => {
			builder.current[key] = !builder.current[key];
			this.forceUpdate();
		};
		const megaOption = (key: 'mega' | 'megax' | 'megay' | 'tera', label: string) =>
			<label class={`megaevo${builder.current[key] ? ' cur' : ''}`}>
				<input type="checkbox" checked={builder.current[key]} onChange={() => toggle(key)} /> {label}
			</label>;
		return <div class="analysis-choice-controls"><div class="analysis-action-controls">
			<div class="movecontrols">
				<h3 class="moveselect">Attack</h3>
				<div class="movemenu">{active.moves.map((move: any, index: number) =>
					this.renderMoveButton(tab, side, choiceIndex, move, index))}</div>
				{(active.canMegaEvo || active.canMegaEvoX || active.canMegaEvoY || active.canTerastallize) &&
					<div class="megaevo-box">
						{active.canMegaEvo && megaOption('mega', 'Mega Evolution')}
						{active.canMegaEvoX && megaOption('megax', 'Mega Evolution X')}
						{active.canMegaEvoY && megaOption('megay', 'Mega Evolution Y')}
						{active.canTerastallize && megaOption('tera', 'Terastallize')}
					</div>}
			</div>
			<div class="switchcontrols">
				<h3 class="switchselect">Switch</h3>
				<div class="switchmenu">{(request?.side?.pokemon || []).map((pokemon: any, index: number) => {
					const unavailable = pokemon.fainted || pokemon.active;
					return <button
						disabled={unavailable} class={`has-tooltip${unavailable ? ' disabled' : ''}`}
						data-tooltip={`analysispokemon|${sideIndex(side)}|${index}`}
						onClick={() => {
							this.draft.moveChoicesBySlot[side][choiceIndex] = null;
							if (pendingTarget) this.draft.pendingTarget = null;
							this.draft.switchChoicesBySlot[side][choiceIndex] = `switch ${index + 1}`;
							this.finishActionSelection(tab);
						}}
					><PSIcon pokemon={pokemonLabel(pokemon)} />{pokemon.name || pokemon.details}</button>;
				})}</div>
			</div>
		</div></div>;
	}

	renderMoveButton(tab: AnalysisTab, side: AnalysisSideID, choiceIndex: number, move: any, index: number) {
		const builder = this.draft.builders[side]!;
		const moveData = this.getMoveData(move);
		const onClick = () => {
			const targetType = moveData.target;
			const validTargets = this.getTargetCandidates(tab, side, choiceIndex, targetType);
			const multiBattle = tab.gameType !== 'singles';
			const explicitTarget = ['adjacentAlly', 'adjacentAllyOrSelf', 'any', 'adjacentFoe'].includes(targetType);
			const needsTarget = validTargets.length > 1 || (validTargets.length === 1 && multiBattle && explicitTarget);
			const modifiers = [
				builder.current.mega && ' mega', builder.current.megax && ' megax',
				builder.current.megay && ' megay', builder.current.tera && ' terastallize',
			].filter(Boolean).join('');
			const choice = `move ${index + 1}${modifiers}`;
			if (needsTarget) {
				(builder.request as any).targetable = true;
				this.draft.pendingTarget = { side, index: choiceIndex, choice, targetType };
				this.forceUpdate();
			} else {
				this.draft.moveChoicesBySlot[side][choiceIndex] = choice;
				this.draft.rebuildMoveBuilder(side, tab.requests![sideIndex(side)]);
				this.finishActionSelection(tab);
			}
		};
		return <button
			class={`movebutton has-tooltip type-${moveData.type}`} disabled={!!move.disabled} onClick={onClick}
			data-tooltip={`analysismove|${move.id || move.move || move.name}|${sideIndex(side)}|${choiceIndex}`}
		>
			{moveData.name}<br />
			<small class="type">{moveData.type} <span class="effectiveness-icon"></span></small>{' '}
			<small class="pp">{move.pp ?? ''}/{move.maxpp ?? ''}</small>&nbsp;
		</button>;
	}

	renderTargetChoices(
		tab: AnalysisTab, side: AnalysisSideID, choiceIndex: number, builder: BattleChoiceBuilder,
		pendingTarget: { choice: string, targetType: string } | null
	) {
		const targetType = pendingTarget ? pendingTarget.targetType : builder.currentMove()?.target;
		const targetChoice = pendingTarget ? pendingTarget.choice : builder.stringChoice(builder.current);
		const attackerSide = sideIndex(side);
		const targets = this.getTargetCandidates(tab, side, choiceIndex, targetType || 'normal');
		const targetMap = new Map(targets.map(target => [`${target.side}:${target.slot}`, target]));
		const foeSide = attackerSide === 0 ? 1 : 0;
		const allySide = attackerSide;
		let targetLayout: (string | null)[][];
		if (targetType === 'adjacentAlly' || targetType === 'adjacentAllyOrSelf' || targetType === 'self') {
			targetLayout = [
				[null, null],
				[
					`${allySide}:${choiceIndex === 0 ? 1 : 0}`,
					targetType === 'self' ? null : `${allySide}:${choiceIndex === 0 ? 0 : 1}`,
				],
			];
		} else if (attackerSide === 0) {
			targetLayout = choiceIndex === 0 ?
				[[`${foeSide}:1`, `${foeSide}:0`], [null, `${allySide}:1`]] :
				[[`${foeSide}:1`, `${foeSide}:0`], [`${allySide}:0`, null]];
		} else {
			targetLayout = choiceIndex === 0 ?
				[[`${allySide}:1`, null], [`${foeSide}:0`, `${foeSide}:1`]] :
				[[null, `${allySide}:0`], [`${foeSide}:0`, `${foeSide}:1`]];
		}
		const renderTarget = (target: { pokemon: any, side: number, slot: number, teamIndex: number }) => {
			const targetLoc = target.side === attackerSide ? `-${target.slot + 1}` : `+${target.slot + 1}`;
			return <button
				class="has-tooltip" data-tooltip={`analysispokemon|${target.side}|${target.teamIndex}`}
				onClick={() => {
					this.draft.moveChoicesBySlot[side][choiceIndex] = `${targetChoice} ${targetLoc}`;
					this.draft.rebuildMoveBuilder(side, tab.requests![attackerSide]);
					this.finishActionSelection(tab);
				}}
			><PSIcon pokemon={target.pokemon} />{target.pokemon.name || target.pokemon.details}</button>;
		};
		return <div class="analysis-choice-controls"><div class="switchcontrols">
			<h3 class="switchselect">Choose target</h3>
			<div class="switchmenu">{targetLayout.map(row => <div style={{ clear: 'both' }}>
				{row.map(key => key && targetMap.get(key) ?
					renderTarget(targetMap.get(key)!) :
					<button class="disabled" disabled>&nbsp;</button>)}
			</div>)}</div>
		</div></div>;
	}

	renderSwitchChoices(tab: AnalysisTab, onSubmit?: (tab: AnalysisTab) => void) {
		const renderSide = (side: AnalysisSideID) => {
			const request = tab.requests?.[sideIndex(side)];
			const builder = this.draft.builders[side];
			if (!request?.forceSwitch || !builder || !request.side?.pokemon) return null;
			const pending = request.forceSwitch.filter(Boolean).length;
			return <div class="switchcontrols">
				<h3 class="switchselect">{side.toUpperCase()} Choose replacement</h3>
				<div class="switchmenu">{request.side.pokemon.map((pokemon: any, index: number) => {
					const unavailable = pokemon.fainted || pokemon.active || builder.alreadySwitchingIn.includes(index + 1);
					return <button
						class={`has-tooltip${unavailable ? ' disabled' : ''}`} disabled={unavailable}
						data-tooltip={`analysispokemon|${sideIndex(side)}|${index}`}
						onClick={() => {
							const replacementSlot = request.forceSwitch.findIndex((required: boolean, slot: number) =>
								required && !this.draft.switchChoicesBySlot[side][slot]);
							if (replacementSlot < 0) return;
							this.draft.switchChoicesBySlot[side][replacementSlot] = `switch ${index + 1}`;
							this.draft.rebuildSwitchBuilder(side, request);
							if (tab.phase !== 'switch-selection') this.saveLeafDraft(tab);
							this.forceUpdate();
						}}
					><PSIcon pokemon={pokemonLabel(pokemon)} />{pokemon.name || pokemon.details}</button>;
				})}</div>
				<p>{builder.alreadySwitchingIn.length}/{pending} Chosen</p>
			</div>;
		};
		const ready = (['p1', 'p2'] as const).every(side =>
			!tab.requests?.[sideIndex(side)]?.forceSwitch || !!this.draft.builders[side]?.isDone());
		const hasChoices = (['p1', 'p2'] as const).some(side => !this.draft.builders[side]?.isEmpty());
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			<button
				class="button" disabled={!hasChoices}
				onClick={() => {
					this.setChoiceBuilders(tab.requests, tab.gameType);
					this.forceUpdate();
				}}
			>Back</button>
			{renderSide('p1')}{renderSide('p2')}
			<button
				class="button" disabled={!ready}
				onClick={() => {
					if (!ready) return;
					if (onSubmit) {
						onSubmit(tab);
					} else {
						void this.submitChoices(
							tab, this.draft.builders.p1?.toString() || 'default', this.draft.builders.p2?.toString() || 'default'
						);
					}
				}}
			>Submit replacements</button>
		</div>;
	}

	renderMidTurnSwitchChoice(tab: AnalysisTab, simulation: boolean) {
		const optionIndex = tab.midTurnSwitchOptionIndex || 0;
		const option = tab.midTurnSwitchOptions?.[optionIndex];
		if (!option) return null;
		const request = tab.requests?.[sideIndex(option.side)];
		const pokemon = request?.side?.pokemon || [];
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			{simulation ? <div>
				<button class="button" onClick={() => this.cancelSimulationSwitchSelection(tab)}>Cancel</button>
			</div> : null}
			<div class="switchcontrols">
				<h3 class="switchselect">
					{option.side.toUpperCase()} Choose Replacement ({option.pokemon}: {option.reasonName})
				</h3>
				<div class="switchmenu">{pokemon.map((replacement: any, index: number) => {
					const alreadySelected = !simulation && tab.midTurnSwitchOptions?.some((entry, entryIndex) =>
						entryIndex < optionIndex && entry.side === option.side && entry.replacementIndex === index);
					const unavailable = index === option.pokemonIndex ||
						(!simulation && (replacement.fainted || replacement.active || alreadySelected));
					return <button
						class={`has-tooltip${unavailable ? ' disabled' : ''}`} disabled={unavailable}
						data-tooltip={`analysispokemon|${sideIndex(option.side)}|${index}`}
						onClick={() => simulation ? this.selectSimulationSwitch(tab, index) : this.selectMidTurnSwitch(tab, index)}
					>
						<PSIcon pokemon={pokemonLabel(replacement)} />
						{replacement.name || replacement.details}
					</button>;
				})}</div>
			</div>
		</div>;
	}

	getTeamSelectionSummary(tab: AnalysisTab) {
		const summary = { p1: [] as string[], p2: [] as string[] };
		for (const side of ['p1', 'p2'] as const) {
			const request = tab.requests?.[sideIndex(side)];
			const builder = this.draft.builders[side];
			if (!request?.side?.pokemon || !builder) continue;
			for (const teamIndex of builder.alreadySwitchingIn) {
				const pokemon = request.side.pokemon[teamIndex - 1];
				if (pokemon) summary[side].push(pokemonLabel(pokemon));
			}
		}
		return summary;
	}

	getMoveChoiceSummary(tab: AnalysisTab) {
		const choices: AnalysisChoiceSummary[] = [];
		for (const side of ['p1', 'p2'] as const) {
			const request = tab.requests?.[sideIndex(side)];
			const activePokemon = request?.side?.pokemon?.filter((pokemon: any) => pokemon.active) || [];
			for (let slot = 0; slot < (request?.active?.length || 0); slot++) {
				const pokemon = activePokemon[slot];
				const active = request.active[slot];
				if (!active || !pokemon) continue;
				const moveChoice = this.draft.moveChoicesBySlot[side][slot];
				const switchChoice = this.draft.switchChoicesBySlot[side][slot];
				const moveIndex = Number(/^move (\d+)/.exec(moveChoice || '')?.[1]) - 1;
				const move = active.moves?.[moveIndex];
				let action = 'No action selected';
				let targetPokemon: any = null;
				if (moveChoice && move) {
					const modifiers: string[] = [];
					if (/\bterastallize\b/.test(moveChoice)) modifiers.push('Terastallize');
					if (/\bmega(?:x|y)?\b/.test(moveChoice)) modifiers.push('Mega-Evolve');
					if (/\b(?:dynamax|max)\b/.test(moveChoice)) modifiers.push('Dynamax');
					const moveName = move.name || move.move || (window as any).Dex.moves.get(move.id).name || 'Move';
					const targetType = this.getMoveData(move).target;
					const targetMatch = /(?:^|\s)([+-]\d+)(?:\s|$)/.exec(moveChoice);
					if (tab.gameType !== 'singles' && targetType !== 'self' && targetMatch) {
						const targetLoc = Number(targetMatch[1]);
						const targetSide = targetLoc > 0 ? (side === 'p1' ? 'p2' : 'p1') : side;
						const targetRequest = tab.requests?.[sideIndex(targetSide)];
						targetPokemon = targetRequest?.side?.pokemon?.filter((entry: any) => entry.active)[Math.abs(targetLoc) - 1];
					} else if (tab.gameType !== 'singles' && targetType !== 'self') {
						const targets = this.getTargetCandidates(tab, side, slot, targetType);
						if (targets.length === 1) targetPokemon = targets[0].pokemon;
					}
					action = [...modifiers, moveName].join(', ');
				} else if (switchChoice) {
					const targetIndex = Number(/^switch (\d+)/.exec(switchChoice)?.[1]) - 1;
					targetPokemon = request.side.pokemon[targetIndex];
					action = 'Switch to';
				}
				choices.push({
					side, slot, action,
					moveId: moveChoice && move ? move.id : undefined,
					pokemon: pokemonLabel(pokemon),
					targetPokemon: targetPokemon ? pokemonLabel(targetPokemon) || targetPokemon : undefined,
				});
			}
		}
		return choices;
	}

	renderTeamPreviewChoices(tab: AnalysisTab) {
		const renderSide = (side: AnalysisSideID) => {
			const request = tab.requests?.[sideIndex(side)];
			if (!request?.side?.pokemon) {
				return <p class="message-error">{side.toUpperCase()} team preview request is missing.</p>;
			}
			let builder = this.draft.builders[side];
			if (!builder) {
				builder = new BattleChoiceBuilder({
					...request,
					requestType: 'team',
					chosenTeamSize: request.chosenTeamSize || request.maxChosenTeamSize || 1,
				});
				this.draft.builders[side] = builder;
			}
			return <div class="switchcontrols">
				<h3 class="switchselect">Team {side === 'p1' ? 1 : 2} Choose Pokémon</h3>
				<div class="switchmenu">{request.side.pokemon.map((pokemon: any, index: number) => {
					const selected = builder.alreadySwitchingIn.includes(index + 1);
					const name = pokemon.name || pokemon.details || `Pokemon ${index + 1}`;
					return <button
						data-cmd={`/switch ${index + 1}`} class={`has-tooltip${selected ? ' disabled' : ''}`}
						style={selected ? 'opacity:.5' : ''} data-tooltip={`analysispokemon|${sideIndex(side)}|${index}`}
						aria-disabled={selected} aria-pressed={selected}
						onMouseUp={() => this.selectPreviewPokemon(side, index)}
					><PSIcon pokemon={pokemonLabel(pokemon)} />{name}</button>;
				})}</div>
				<p>{builder.alreadySwitchingIn.length}/{builder.requestLength()} Chosen</p>
			</div>;
		};
		const { p1, p2 } = this.draft.builders;
		const ready = !!p1?.isDone() && !!p2?.isDone();
		const hasChoices = !!(p1?.alreadySwitchingIn.length || p2?.alreadySwitchingIn.length);
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			<button
				class="button" disabled={!hasChoices}
				onClick={() => {
					this.setChoiceBuilders(tab.requests, tab.gameType);
					this.saveLeafDraft(tab);
					this.forceUpdate();
				}}
			>Back</button>
			{renderSide('p1')}{renderSide('p2')}
			<button
				class="button" disabled={!ready}
				onClick={() => {
					if (ready) void this.submitChoices(tab, p1!.toString(), p2!.toString());
				}}
			>Send out Pokémon</button>
		</div>;
	}

	renderSimulationControls(tab: AnalysisTab) {
		const selectedIndex = tab.selectedSimulationGroupIndex ?? 0;
		const groupCount = tab.simulationGroups?.length || 0;
		const roll = tab.simulationRoll || 'median';
		const rollOption = (value: AnalysisSimulationRoll, label: string) => <label>
			<input
				type="radio" name={`damage-roll-${tab.id}`} checked={roll === value}
				onChange={() => this.changeSimulationRoll(tab, value)}
			/> {label}
		</label>;
		return <div class="analysis-choice-controls">
			<div>
				<button class="button" onClick={() => this.cancelSimulation(tab)}>Cancel</button>
				<button
					class="button" disabled={selectedIndex <= 0}
					onClick={() => this.showSimulation(tab, selectedIndex - 1, roll, true)}
				>Prev</button>
				<button
					class="button" disabled={selectedIndex >= groupCount - 1}
					onClick={() => this.showSimulation(tab, selectedIndex + 1, roll, true)}
				>Next</button>
				<button class="button" onClick={() => this.replaySimulationTurn(tab)}>Replay Turn</button>
				<button
					class="button" disabled={tab.loading}
					onClick={() => void this.selectSimulationOutcome(tab)}
				>Select Outcome</button>
			</div>
			<fieldset class="analysis-radio-group"><legend>Damage Rolls</legend>
				{rollOption('min', 'Min')}
				{rollOption('median', 'Median')}
				{rollOption('max', 'Max')}
			</fieldset>
		</div>;
	}

	renderBattleControls(tab: AnalysisTab, requestState: string) {
		if (tab.phase === 'simulating') {
			return <div class="analysis-choice-controls">
				<div><button class="button" onClick={() => this.cancelSimulation(tab)}>Cancel</button></div>
				<p>Simulating...</p>
			</div>;
		}
		if (tab.phase === 'one-turn') {
			return <div class="analysis-choice-controls">
				<button class="button" onClick={() => this.skipOneTurn(tab)}>Skip Turn</button>
			</div>;
		}
		if (tab.phase === 'simulation-switch-selection') return this.renderMidTurnSwitchChoice(tab, true);
		if (tab.phase === 'mid-turn-switch-selection') return this.renderMidTurnSwitchChoice(tab, false);
		if (tab.phase === 'simulation-selection') return this.renderSimulationControls(tab);
		if (tab.phase === 'switch-selection') {
			return this.renderSwitchChoices(tab, selectedTab => void this.submitSwitchChoices(selectedTab));
		}
		if (tab.phase === 'replay') {
			return <AnalysisReplayControls
				battle={this.battle} turnView={this.turnView} speed={this.getReplaySpeed()}
				onOpenTurn={this.openTurn} onCloseTurn={this.closeTurn} onGoToTurn={this.goToTurn}
				onChangeSpeed={this.changeReplaySpeed}
			/>;
		}
		if (tab.phase === 'selection') {
			const { choiceSide } = this.draft;
			const side = choiceSide?.side;
			const slot = choiceSide?.index ?? 0;
			const sidePokemon = side ? tab.requests?.[sideIndex(side)]?.side?.pokemon || [] : [];
			const pokemon = sidePokemon.filter((entry: any) => entry.active)[slot];
			const name = (pokemon?.name || pokemon?.details || `Pokemon ${slot + 1}`).split(',')[0];
			return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
				<div class="analysis-selection-heading">
					<button
						class="button"
						onClick={() => this.draft.pendingTarget ? this.cancelIntermediateSelection(tab) : this.cancelActionSelection(tab)}
					>Cancel</button>
					{choiceSide && <span>What will <strong>{name}</strong> ({side === 'p1' ? 1 : 2}) do?</span>}
				</div>
				{requestState === 'switch' ? this.renderSwitchChoices(tab) : this.renderMoveChoices(tab)}
			</div>;
		}
		const currentNode = tab.nodes[tab.currentNodeId];
		const canReplayPrevious = !!currentNode?.parentId;
		const nextNode = Object.values(tab.nodes).find(node => node.parentId === tab.currentNodeId);
		const ready = this.draft.actionChoicesReady(tab.requests, 'p1') && this.draft.actionChoicesReady(tab.requests, 'p2');
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			<div>
				<button class="button" onClick={() => this.openReplayFromStart(tab)}>Replay from Start</button>
				<button class="button" disabled={!canReplayPrevious} onClick={() => this.replayPreviousTurn(tab)}>
					Replay Prev Turn
				</button>
				<button class="button" disabled={!canReplayPrevious} onClick={() => this.previousNode(tab)}>Prev Turn</button>
				<button
					class="button" disabled={!nextNode}
					onClick={() => nextNode && this.selectAnalysisNode(tab, nextNode.id)}
				>Next Turn</button>
			</div>
			<p>Click on an active Pokémon to choose its actions.</p>
			<AnalysisChoiceSummaryView choices={this.getMoveChoiceSummary(tab)} gameType={tab.gameType} tooltips />
			<div>
				<button
					class="button" disabled={!ready || tab.loading}
					onClick={() => void this.submitChoices(
						tab, this.draft.actionChoiceString(tab.requests, 'p1'), this.draft.actionChoiceString(tab.requests, 'p2')
					)}
				>Submit Choices</button>
				<button class="button" disabled={!ready || tab.loading} onClick={() => this.prepareSimulation(tab)}>
					{tab.loading ? 'Simulating...' : 'Simulate Possible Turns'}
				</button>{' '}
				<label>
					# Simulations: <input
						class="textbox" type="number" min="1" step="1" value={tab.simulationCount}
						onInput={event => {
							tab.simulationCount = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
							this.forceUpdate();
						}}
					/>
				</label>
			</div>
		</div>;
	}

	/*********************************************************
	 * Layout
	 *********************************************************/

	renderGroupingOptions(tab: AnalysisTab) {
		const turnHelp = "Groups outcomes by the events on the turn, ignoring damage rolls that don't alter " +
			"the game state at the end of the turn.";
		const stateHelp = "Groups outcomes by the game state at the end of the turn. This ignores damage rolls, " +
			"critical hits, move misses, failures to move (e.g. due to flinching, paralysis, or confusion), multihit " +
			"move counts, speed ties, and Quick Claw activations that don't alter the game state at the end of the " +
			"turn. Item consumption dependent on HP and turn events that cause a Pokemon holding the item Focus Sash " +
			"or with the ability Sturdy, Multiscale, Shadow Shield, or Tera Shell to fall below full health are " +
			"distinguished as game states.";
		const mode = tab.simulationGroupingMode || 'turn';
		return <fieldset class="analysis-radio-group analysis-grouping-mode">
			<legend>Group Outcomes</legend>
			<label>
				<input
					type="radio" name={`grouping-${tab.id}`} checked={mode === 'turn'} disabled={tab.phase === 'one-turn'}
					onChange={() => this.changeSimulationGrouping(tab, 'turn')}
				/> By Turn Events{' '}
				<span class="analysis-grouping-help" data-help={turnHelp} aria-label="About grouping by turn execution">
					<i class="fa fa-info-circle" aria-hidden="true" />
				</span>
			</label>
			<label>
				<input
					type="radio" name={`grouping-${tab.id}`} checked={mode === 'state'} disabled={tab.phase === 'one-turn'}
					onChange={() => this.changeSimulationGrouping(tab, 'state')}
				/> By Game State{' '}
				<span class="analysis-grouping-help" data-help={stateHelp} aria-label="About grouping by game state">
					<i class="fa fa-info-circle" aria-hidden="true" />
				</span>
			</label>
		</fieldset>;
	}

	renderAnalysis(tab: AnalysisTab) {
		const { battleWidth, battleHeight, mainWidth, treeWidth, sideBySide } = this.layout;
		const requestState = getRequestState(tab.requestState, tab.requests);
		const selectedData = tab.simulationGroups ? this.getSelectedSimulation(tab) : tab.nodes[tab.currentNodeId] || null;
		const controlsStyle = `position:absolute;top:${battleHeight + 10}px;left:0;width:${battleWidth}px`;
		const setBattleFrame = (element: HTMLElement | null) => {
			this.battleFrame = element;
		};
		const setBattleLogFrame = (element: HTMLElement | null) => {
			this.battleLogFrame = element;
		};
		const roomStyle = sideBySide ?
			`left:0;width:${mainWidth}px;right:auto;display:block;` :
			`left:0;width:100%;right:auto;display:block;`;
		return [
			<div class="ps-room ps-room-opaque" style={roomStyle}>
				<div class="analysis-battle-stage" style="height:100%;">
					<div
						class="battle" ref={setBattleFrame}
						style={`position:absolute;top:0;left:0;width:${battleWidth}px;height:${battleHeight}px`}
					/>
					{(requestState === 'move' || requestState === 'switch') &&
						<div class="battle-controls" style={controlsStyle} role="complementary" aria-label="Battle Controls">
							{this.renderBattleControls(tab, requestState)}
						</div>}
					{(requestState === 'teampreview' || tab.requests?.[0]?.teamPreview) &&
						<div class="battle-controls" style={controlsStyle} role="complementary" aria-label="Battle Controls">
							{this.renderTeamPreviewChoices(tab)}
						</div>}
					<div
						class="battle-log" aria-label="Battle Log" role="complementary" ref={setBattleLogFrame}
						style={`position:absolute;top:0;left:${battleWidth}px;right:0;bottom:0;width:auto;`}
					/>
				</div>
			</div>,
			<div
				class="ps-room ps-room-light scrollable"
				style={`top:56px;left:${mainWidth + 1}px;width:${treeWidth}px;right:auto;bottom:0;display:block;`}
			>
				<div class="pad">
					<h2>{tab.simulationGroups ? 'Simulation Outcomes' : 'Lines'}</h2>
					{tab.simulationGroups ? this.renderGroupingOptions(tab) : null}
					{tab.simulationGroups ?
						<ol class="analysis-simulation-list">
							{tab.simulationGroups.map((group, index) => this.renderSimulationGroup(tab, group, index))}
						</ol> :
						<AnalysisNodeTree
							tab={tab} onSelect={nodeId => {
								if (tab.phase === 'simulating') this.cancelSimulation(tab, nodeId);
								else this.selectAnalysisNode(tab, nodeId);
							}}
						/>}
					<h2>{tab.simulationGroups ? 'Selected Simulation Result' : 'Selected Node Data'}</h2>
					<pre class="analysis-debug-log">{JSON.stringify(selectedData, null, 2)}</pre>
				</div>
			</div>,
		];
	}

	override render() {
		const activeTab = this.tabs.find(tab => tab.id === this.activeTab);
		const header = <AnalysisHeader
			tabs={this.tabs} activeTab={activeTab} onOpenHome={this.openHome}
			onActivateTab={tabId => { this.activeTab = tabId; this.forceUpdate(); }}
			onCloseTab={this.closeTab} onDragStart={this.dragStart} onDragEnter={this.dragEnter}
			onDragEnd={() => { this.draggedTab = null; }}
		/>;
		const rooms = activeTab ? this.renderAnalysis(activeTab) : [<div class="analysis-panel">{this.renderHome()}</div>];
		return preact.h(preact.Fragment, null, header, ...rooms) as any;
	}
}

preact.render(<AnalysisApp />, document.getElementById('main')!);
