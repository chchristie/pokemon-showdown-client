/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { BattleChoiceBuilder } from '../../play.pokemonshowdown.com/src/battle-choices';
import { BattleTooltips } from '../../play.pokemonshowdown.com/src/battle-tooltips';
import { Teams } from '../../play.pokemonshowdown.com/src/battle-teams';
import {
	FORMATS, LAYOUT, getRequestState,
	type AnalysisBattle, type AnalysisNode, type AnalysisSimulationGroup, type AnalysisSimulationResult, type AnalysisTab,
	type LocalTeam, type PlaybackStage, type StartMode,
} from './analysis-model';
import { runAnalysis, runAnalysisBatch } from './analysis-api';
import { AnalysisHeader } from './analysis-header';
import { replayNodesFor } from './analysis-nodes';
import { AnalysisNodeTree } from './analysis-node-tree';
import { AnalysisReplayControls } from './analysis-replay-controls';
import { packTeamSyntax } from './analysis-team-utils';

function PSIcon(props: { pokemon: any }) {
	return <span class="picon" style={(window as any).Dex.getPokemonIcon(props.pokemon)} />;
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
	choiceTooltips: BattleTooltips | null = null;
	choiceTooltipsFrame: HTMLElement | null = null;
	choiceBuilders: { p1: BattleChoiceBuilder | null, p2: BattleChoiceBuilder | null } = { p1: null, p2: null };
	moveChoicesBySlot: { p1: (string | null)[], p2: (string | null)[] } = { p1: [], p2: [] };
	switchChoicesBySlot: { p1: (string | null)[], p2: (string | null)[] } = { p1: [], p2: [] };
	pendingTarget: { side: 'p1' | 'p2', index: number, choice: string, targetType: string } | null = null;
	choiceSide: { side: 'p1' | 'p2', index: number } | null = null;
	choiceSnapshot: { moves: AnalysisApp['moveChoicesBySlot'], switches: AnalysisApp['switchChoicesBySlot'] } | null = null;
	playbackStage: PlaybackStage = null;
	turnView: boolean | string = false;
	layout = { battleWidth: LAYOUT.battleWidth, battleHeight: LAYOUT.battleHeight, mainWidth: LAYOUT.leftWidth, treeWidth: LAYOUT.rightWidth, sideBySide: true };

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
		const leftWidth = LAYOUT.leftWidth;
		const leftMaxWidth = LAYOUT.leftMaxWidth;
		const rightWidth = LAYOUT.rightWidth;
		const rightMaxWidth = LAYOUT.rightMaxWidth;
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
		this.layout = { battleWidth, battleHeight: Math.round(LAYOUT.battleHeight * scale), mainWidth, treeWidth, sideBySide: sideBySide && treeWidth >= rightWidth };
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

	storeAnalysisNode(tab: AnalysisTab, inputLog: string[], parentId: string | null = tab.currentNodeId) {
		const id = `node-${Date.now()}-${Object.keys(tab.nodes).length}`;
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

	hydrateNodeChoices(tab: AnalysisTab, node: AnalysisNode) {
		for (const line of node.inputLog) {
			const match = /^>p([12])\s+(.+)$/.exec(line);
			if (!match) continue;
			const side = match[1] === '1' ? 'p1' : 'p2';
			const builder = this.choiceBuilders[side];
			if (!builder) continue;
			const index = builder.index();
			builder.addChoices(match[2]);
			if (match[2].startsWith('move ')) this.moveChoicesBySlot[side][index] = match[2];
			if (match[2].startsWith('switch ')) this.switchChoicesBySlot[side][index] = match[2];
		}
	}

	replayNodesFor = (tab: AnalysisTab, nodeId: string, includeNode: boolean) => {
		return replayNodesFor(tab, nodeId, includeNode);
	};

	restoreAnalysisNode = async (tab: AnalysisTab, nodeId: string) => {
		const node = tab.nodes[nodeId];
		if (!node) return;
		try {
			const data = await runAnalysis({
				format: tab.format, team1: tab.team1, team2: tab.team2,
				seed: tab.rootSeed, replayNodes: this.replayNodesFor(tab, nodeId, false),
			});
			tab.currentNodeId = nodeId;
			tab.log = data.log || [];
			tab.state = data.state;
			tab.requests = data.requests;
			tab.requestState = getRequestState(data.requestState, data.requests);
			tab.gameType = data.gameType || tab.gameType;
			tab.phase = tab.requestState === 'teampreview' ? 'preview' : 'default';
			this.destroyBattle();
			this.setAnalysisTeams(tab.requests);
			this.setChoiceBuilders(tab.requests, tab.gameType);
			this.hydrateNodeChoices(tab, node);
			this.forceUpdate();
		} catch (error: any) {
			this.startError = error.message || 'Unable to restore this node.';
			this.forceUpdate();
		}
	};

	simulateNextTurn = async (tab: AnalysisTab) => {
		if (tab.loading) return;
		tab.loading = true;
		this.forceUpdate();
		try {
			const inputLog = [
				`>p1 ${this.actionChoiceString(tab, 'p1')}`,
				`>p2 ${this.actionChoiceString(tab, 'p2')}`,
			];
			const data = await runAnalysisBatch({
				format: tab.format, team1: tab.team1, team2: tab.team2, seed: tab.rootSeed,
				replayNodes: this.replayNodesFor(tab, tab.currentNodeId, false), inputLog,
				count: tab.simulationCount,
			});
			tab.simulationGroups = data.groups || [];
			tab.simulationResultCount = data.simulationCount || 0;
			tab.selectedSimulationIndex = undefined;
		} catch (error: any) {
			this.startError = error.message || 'Unable to simulate the turn.';
		} finally {
			tab.loading = false;
			this.forceUpdate();
		}
	};

	submitChoices = async (tab: AnalysisTab, p1Choice: string, p2Choice: string) => {
		if (!p1Choice || !p2Choice || tab.loading) return;
		tab.loading = true;
		this.forceUpdate();
		try {
			const currentNode = tab.nodes[tab.currentNodeId];
			const nodeInputLog = [`>p1 ${p1Choice}`, `>p2 ${p2Choice}`];
			if (currentNode) currentNode.inputLog = nodeInputLog;
			const data = await runAnalysis({
				format: tab.format, team1: tab.team1, team2: tab.team2, seed: tab.rootSeed,
				replayNodes: this.replayNodesFor(tab, tab.currentNodeId, false), inputLog: nodeInputLog,
			});
			if (currentNode) currentNode.seed = data.actionSeed;
			this.storeAnalysisNode(tab, [], currentNode?.id || null);
			tab.simulationGroups = undefined;
			tab.simulationResultCount = undefined;
			tab.selectedSimulationIndex = undefined;
			tab.log = data.log || [];
			tab.state = data.state;
			tab.requests = data.requests;
			tab.requestState = getRequestState(data.requestState, data.requests);
			tab.phase = tab.requestState === 'teampreview' ? 'preview' : 'one-turn';
			tab.gameType = data.gameType || tab.gameType;
			this.setAnalysisTeams(tab.requests);
			this.setChoiceBuilders(data.requests, tab.gameType);
			this.destroyBattle();
		} catch (error: any) {
			this.startError = error.message || 'Unable to submit choices.';
		} finally {
			tab.loading = false;
			this.forceUpdate();
		}
	};

	openSimulation = (tab: AnalysisTab, simulation: AnalysisSimulationResult) => {
		tab.log = simulation.log;
		tab.phase = 'simulation';
		tab.selectedSimulationIndex = simulation.index;
		this.destroyBattle();
		this.forceUpdate();
	};

	closeSimulation = (tab: AnalysisTab) => {
		tab.selectedSimulationIndex = undefined;
		void this.restoreAnalysisNode(tab, tab.currentNodeId);
	};

	getSelectedSimulation(tab: AnalysisTab) {
		if (tab.selectedSimulationIndex === undefined) return null;
		for (const group of tab.simulationGroups || []) {
			for (const simulation of [group.min, group.median, group.max]) {
				if (simulation.index === tab.selectedSimulationIndex) return simulation;
			}
		}
		return null;
	}

	renderSimulationGroup(tab: AnalysisTab, group: AnalysisSimulationGroup, index: number) {
		const simulationCount = tab.simulationResultCount || 0;
		const proportion = simulationCount ? group.count / simulationCount : 0;
		const errorPercentage = 100 * Math.sqrt(proportion * (1 - proportion) / simulationCount);
		const renderRoll = (label: string, simulation: AnalysisSimulationResult) => <button
			class={simulation.index === tab.selectedSimulationIndex ? 'cur' : ''}
			onClick={() => this.openSimulation(tab, simulation)}
		>
			<strong>{label}</strong><span>{simulation.totalDamage} total damage</span><small>{simulation.seed}</small>
		</button>;
		return <li class="analysis-simulation-group">
			<h3>Outcome {index + 1}</h3>
			<p>{group.count} / {simulationCount} simulations ({group.percentage.toFixed(1)}% ± {errorPercentage.toFixed(1)}%)</p>
			<div>{renderRoll('Min', group.min)}{renderRoll('Median', group.median)}{renderRoll('Max', group.max)}</div>
		</li>;
	}

	setChoiceBuilders(requests: any[] | undefined, gameType = '') {
		this.choiceSide = null;
		this.pendingTarget = null;
		this.moveChoicesBySlot = { p1: [], p2: [] };
		this.switchChoicesBySlot = { p1: [], p2: [] };
		const normalize = (request: any) => {
			if (!request) return null;
			if (request.teamPreview) {
				let chosenTeamSize = request.chosenTeamSize || request.maxChosenTeamSize;
				if (!chosenTeamSize) chosenTeamSize = gameType === 'doubles' ? 2 : gameType === 'triples' || gameType === 'rotation' ? 3 : 1;
				return { ...request, requestType: 'team', chosenTeamSize };
			}
			if (request.forceSwitch) return { ...request, requestType: 'switch' };
			if (request.active) return { ...request, requestType: 'move' };
			return { ...request, requestType: 'wait' };
		};
		this.choiceBuilders = {
			p1: normalize(requests?.[0]) ? new BattleChoiceBuilder(normalize(requests?.[0])) : null,
			p2: normalize(requests?.[1]) ? new BattleChoiceBuilder(normalize(requests?.[1])) : null,
		};
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
		iframe.src = `https://play.pokemonshowdown.com/crossdomain.php?host=${encodeURIComponent(location.hostname)}&path=${encodeURIComponent(location.pathname.slice(1))}&protocol=${encodeURIComponent(location.protocol)}`;
		document.body.appendChild(iframe);
		setTimeout(() => iframe.remove(), 3000);
	};

	updateTeamChoices() {
		const matchingTeams = this.teams.filter(team => !team.format || team.format === this.format);
		if (!matchingTeams.some(team => team.packedTeam === this.team1)) this.team1 = matchingTeams[0]?.packedTeam || '';
		if (!matchingTeams.some(team => team.packedTeam === this.team2)) this.team2 = matchingTeams[1]?.packedTeam || matchingTeams[0]?.packedTeam || '';
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
		tab.phase = 'default';
		this.playbackStage = null;
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
				this.findAnalysisTeamIndex(sideNumber, pokemon) === teamIndex
			);
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

	selectPreviewPokemon = (side: 'p1' | 'p2', index: number) => {
		const builder = this.choiceBuilders[side];
		if (!builder || builder.alreadySwitchingIn.includes(index + 1)) return;
		const error = builder.addChoice(`team ${index + 1}`);
		if (error) this.startError = error;
		this.forceUpdate();
	};

	selectMovePokemon = (side: 'p1' | 'p2', index: number) => {
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		if (!tab || (tab.phase !== 'default' && tab.phase !== 'selection')) return;
		if (tab.phase === 'default') {
			this.choiceSnapshot = {
				moves: { p1: [...this.moveChoicesBySlot.p1], p2: [...this.moveChoicesBySlot.p2] },
				switches: { p1: [...this.switchChoicesBySlot.p1], p2: [...this.switchChoicesBySlot.p2] },
			};
			tab.phase = 'selection';
		}
		if (this.pendingTarget && this.choiceSide) {
			const previousRequest = tab.requests?.[this.choiceSide.side === 'p1' ? 0 : 1];
			if (previousRequest?.active) this.rebuildMoveBuilder(this.choiceSide.side, previousRequest);
		}
		this.pendingTarget = null;
		this.choiceSide = { side, index };
		this.forceUpdate();
	};

	cancelActionSelection = (tab: AnalysisTab) => {
		const snapshot = this.choiceSnapshot;
		this.setChoiceBuilders(tab.requests, tab.gameType);
		if (snapshot) {
			this.moveChoicesBySlot = { p1: [...snapshot.moves.p1], p2: [...snapshot.moves.p2] };
			this.switchChoicesBySlot = { p1: [...snapshot.switches.p1], p2: [...snapshot.switches.p2] };
			for (const side of ['p1', 'p2'] as const) {
				const request = tab.requests?.[side === 'p1' ? 0 : 1];
				if (request?.active) this.rebuildMoveBuilder(side, request);
				if (request?.forceSwitch) this.rebuildSwitchBuilder(side, request);
			}
		}
		this.choiceSnapshot = null;
		this.choiceSide = null;
		this.pendingTarget = null;
		tab.phase = 'default';
		this.forceUpdate();
	};

	cancelIntermediateSelection = (tab: AnalysisTab) => {
		if (!this.choiceSide) return;
		const { side } = this.choiceSide;
		this.pendingTarget = null;
		const request = tab.requests?.[side === 'p1' ? 0 : 1];
		if (request?.active) this.rebuildMoveBuilder(side, request);
		this.forceUpdate();
	};

	finishActionSelection = (tab: AnalysisTab) => {
		this.choiceSnapshot = null;
		this.choiceSide = null;
		this.pendingTarget = null;
		tab.phase = 'default';
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
		tab.phase = 'one-turn';
		this.destroyBattle();
		this.forceUpdate();
	};

	skipOneTurn = (tab: AnalysisTab) => {
		this.finishOneTurn(tab);
	};

	previousNode = (tab: AnalysisTab) => {
		const parentId = tab.nodes[tab.currentNodeId]?.parentId;
		if (parentId) void this.restoreAnalysisNode(tab, parentId);
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
		const speed = (event.target as HTMLSelectElement).value as 'hyperfast' | 'fast' | 'normal' | 'slow' | 'reallyslow';
		const fade = { hyperfast: 40, fast: 50, normal: 300, slow: 500, reallyslow: 1000 };
		const delay = { hyperfast: 1, fast: 1, normal: 1, slow: 1000, reallyslow: 3000 };
		const battle = this.battle as any;
		if (!battle) return;
		battle.messageFadeTime = fade[speed];
		battle.messageShownTime = delay[speed];
		battle.scene.updateAcceleration();
		this.forceUpdate();
	};

	rebuildMoveBuilder = (side: 'p1' | 'p2', request: any) => {
		const builder = new BattleChoiceBuilder({ ...request, requestType: 'move' });
		const choices = this.moveChoicesBySlot[side];
		for (let index = 0; index < (request.active?.length || 0); index++) {
			if (choices[index]) builder.addChoice(choices[index]!);
			else if (request.active[index]) builder.choices.push('pass');
		}
		this.choiceBuilders[side] = builder;
	};

	rebuildSwitchBuilder = (side: 'p1' | 'p2', request: any) => {
		const builder = new BattleChoiceBuilder({ ...request, requestType: 'switch' });
		const choices = this.switchChoicesBySlot[side];
		const slots = request.forceSwitch ? request.forceSwitch.map((required: boolean, slot: number) => required ? slot : -1).filter((slot: number) => slot >= 0) : [0];
		for (const slot of slots) {
			if (choices[slot]) builder.addChoice(choices[slot]!);
		}
		this.choiceBuilders[side] = builder;
	};

	setAnalysisTeams(requests: any[] | undefined) {
		if (!this.battle) return;
		const teams = requests?.map(request => request?.side?.pokemon || []) || [];
		this.analysisTeams = teams;
		(this.battle as any).myPokemon = teams[0];
		(this.battle as any).myAllyPokemon = teams[1];
	}

	findAnalysisTeamIndex(sideIndex: number, pokemon: any) {
		const team = this.analysisTeams[sideIndex] || [];
		if (!pokemon) return -1;
		const exactIndex = team.findIndex((entry: any) => entry.ident && pokemon.ident && entry.ident === pokemon.ident);
		if (exactIndex >= 0) return exactIndex;
		const detailsIndex = team.findIndex((entry: any) => entry.details && pokemon.details && entry.details === pokemon.details);
		if (detailsIndex >= 0) return detailsIndex;
		return team.findIndex((entry: any) => entry.speciesForme && pokemon.speciesForme && entry.speciesForme === pokemon.speciesForme);
	}

	getMoveData(move: any) {
		const dex = (window as any).Dex;
		const data = dex?.moves?.get(move.id || move.name || move.move);
		return { name: move.name || move.move, type: data?.type || move.type || 'Normal', target: data?.target || move.target || 'normal' };
	}

	getTargetCandidates(tab: AnalysisTab, side: 'p1' | 'p2', attackerSlot: number, targetType: string) {
		const attackerSide = side === 'p1' ? 0 : 1;
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
		this.choiceTooltips = new BattleTooltips(this.battle as any);
		this.choiceTooltips.listen(tooltipFrame);
		this.choiceTooltipsFrame = tooltipFrame;
	}

	upgradeBattleTooltips() {
		if (!this.battleFrame || !this.battle) return;
		const battle = this.battle as any;
		const elements = this.battleFrame.querySelectorAll<HTMLElement>('.has-tooltip[data-tooltip]');
		for (var i = 0; i < elements.length; i++) {
			var element = elements[i];
			var args = (element.dataset.tooltip || '').split('|');
			if (args[0] === 'pokemon' && (args[1] === '0' || args[1] === '1')) {
					var side = Number(args[1]);
					var iconIndex = Number(args[2]);
					var iconSide = battle.sides[side];
					var iconPokemon = iconSide?.pokemon?.[iconIndex];
					var teamIndex = this.findAnalysisTeamIndex(side, iconPokemon);
					if (teamIndex < 0) continue;
					element.dataset.tooltip = `analysispokemon|${side}|${teamIndex}`;
				continue;
			}
			if (args[0] !== 'activepokemon' || (args[1] !== '0' && args[1] !== '1')) continue;
			var sideIndex = Number(args[1]);
			var activeIndex = Number(args[2]);
			var actualSide = battle.sides[sideIndex];
			var active = actualSide?.active?.[activeIndex];
			var teamIndex = this.findAnalysisTeamIndex(sideIndex, active);
			if (!Number.isInteger(teamIndex) || teamIndex < 0) continue;
			element.dataset.tooltip = `analysispokemon|${sideIndex}|${teamIndex}`;
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
		for (const request of tab.requests || []) {
			if (request) BattleChoiceBuilder.fixRequest(request, this.battle as any);
		}
		this.setAnalysisTeams(tab.requests);
		this.setChoiceBuilders(tab.requests, tab.gameType);
		this.upgradeBattleTooltips();
		this.battleFrame.addEventListener('click', this.handleBattleClick);
		const scale = this.layout.battleHeight / 360;
		(this.battle as any)?.scene?.$frame?.css('transform', `scale(${scale})`);
		this.battleTabId = tab.id;
		if (tab.phase === 'replay') {
			(this.battle as any).seekTurn(0);
		} else if (tab.phase === 'one-turn') {
			this.playbackStage = 'seek-end';
			(this.battle as any).seekTurn(Infinity);
		} else {
			(this.battle as any).seekTurn(Infinity);
		}
		this.syncChoiceTooltips();
		this.observeBattleTooltips();
	}

	override componentWillUnmount() {
		this.destroyBattle();
		window.removeEventListener('message', this.receiveStorageMessage);
		window.removeEventListener('resize', this.updateLayout);
	}

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
		const tab: AnalysisTab = {
			id: `analysis-${Date.now()}`,
			title: 'New analysis',
			format: this.format,
			log: data.log || [],
			state: data.state,
			gameType: data.gameType,
			team1: this.team1,
			team2: this.team2,
			requests: data.requests,
			requestState: getRequestState(data.requestState, data.requests),
			phase: getRequestState(data.requestState, data.requests) === 'teampreview' ? 'preview' : 'default',
			nodes: {
				[rootNodeId]: {
					id: rootNodeId,
					parentId: null,
					seed: null,
					turn: 0,
					inputLog: [],
				},
			},
			currentNodeId: rootNodeId,
			rootSeed: data.seed,
			simulationCount: 1000,
		};
		this.tabs = [...this.tabs, tab];
		this.activeTab = tab.id;
			this.setChoiceBuilders(data.requests, data.gameType);
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
					<strong>Import Analysis</strong><small>Analysis file import will be added after the export format is stable.</small>
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
		if (this.mode === 'replay') {
			return <form class="analysis-form" onSubmit={this.startAnalysis}>
				<h2>Import Replay</h2>
				<label>Replay URL<input type="text" value={this.replayURL} onInput={(event) => this.replayURL = (event.target as HTMLInputElement).value} placeholder="https://replay.pokemonshowdown.com/..." /></label>
				<label>Replay HTML file<input type="file" accept=".html,.log,.json" /></label>
				<button class="button" type="submit">Open Replay Analysis</button>
				<button class="button" type="button" onClick={this.openHome}>Cancel</button>
			</form>;
		}
		return <form class="analysis-form" onSubmit={this.startAnalysis}>
			<h2>{this.mode === 'teams' ? 'New Analysis From Teams' : 'Set Up Position'}</h2>
			<p><label class="label">Format:</label><select class="select formatselect" value={this.format} onChange={(event) => {
				this.format = (event.target as HTMLSelectElement).value;
				this.updateTeamChoices();
				this.forceUpdate();
			}}>{FORMATS.map(format => <option value={format.id}>{format.name}</option>)}</select></p>
			{this.mode === 'teams' && <div>
				<button class="button" type="button" onClick={this.loadTeamsFromPlay}>Load teams from Play</button>
				<button class="button" type="button" onClick={() => { this.showSyntaxImport = !this.showSyntaxImport; this.forceUpdate(); }}>Import team syntax</button>
				{this.showSyntaxImport && <div>
					<label>Team 1 syntax<textarea value={this.teamSyntax1} onInput={(event) => this.teamSyntax1 = (event.target as HTMLTextAreaElement).value} placeholder="Paste a standard exported Pokemon Showdown team here" /></label>
					<label>Team 2 syntax<textarea value={this.teamSyntax2} onInput={(event) => this.teamSyntax2 = (event.target as HTMLTextAreaElement).value} placeholder="Paste a standard exported Pokemon Showdown team here" /></label>
				</div>}
				{this.renderTeamSelect('Team 1', this.team1, value => this.team1 = value)}
				{this.renderTeamSelect('Team 2', this.team2, value => this.team2 = value)}
				{!this.teams.length && <p class="analysis-muted">No local teams were found. Create a team in the main client first.</p>}
			</div>}
			{this.startError && <p class="message-error">{this.startError}</p>}
			<button class="button" type="submit" disabled={this.starting || (this.mode === 'teams' && (!this.team1 || !this.team2))}>{this.starting ? 'Starting...' : 'Start Analysis'}</button>
			<button class="button" type="button" onClick={this.openHome}>Cancel</button>
		</form>;
	}

	renderTeamSelect(label: string, selected: string, onChange: (value: string) => void) {
		const teams = this.teams.filter(team => !team.format || team.format === this.format);
		const selectedTeam = teams.find(team => team.packedTeam === selected);
		const species = selectedTeam?.packedTeam ? Teams.unpackSpeciesOnly(selectedTeam.packedTeam) : [];
		return <p><label class="label" for={`analysis-${label.replace(/\s+/g, '-').toLowerCase()}`}>{label}:</label>
			<select id={`analysis-${label.replace(/\s+/g, '-').toLowerCase()}`} name="team" class="select teamselect" value={selected} onChange={(event) => {
				onChange((event.target as HTMLSelectElement).value);
				this.forceUpdate();
			}} disabled={!teams.length}>
				{!teams.length && <option value="">No local teams</option>}
				{teams.map(team => <option value={team.packedTeam}>{team.name}</option>)}
			</select>
			{selectedTeam && <span class="analysis-team-preview"><strong>{selectedTeam.name}</strong><small>{species.map(pokemon => PSIcon({ pokemon }))}</small></span>}
		</p>;
	}

	renderMoveChoices(tab: AnalysisTab) {
		if (!this.choiceSide) return <p class="analysis-muted">Click an active Pokémon to choose its move.</p>;
		const renderSide = (side: 'p1' | 'p2') => {
			if (side !== this.choiceSide!.side) return null;
			const builder = this.choiceBuilders[side];
			const choiceIndex = this.choiceSide!.index;
			const active = tab.requests?.[side === 'p1' ? 0 : 1]?.active?.[choiceIndex];
			if (!builder || !active) return null;
			if (builder.current.move || (this.pendingTarget?.side === side && this.pendingTarget.index === choiceIndex)) {
				const targetType = this.pendingTarget?.side === side && this.pendingTarget.index === choiceIndex ? this.pendingTarget.targetType : builder.currentMove()?.target;
				const attackerSide = side === 'p1' ? 0 : 1;
				const targetChoice = this.pendingTarget?.side === side && this.pendingTarget.index === choiceIndex ? this.pendingTarget.choice : builder.stringChoice(builder.current);
				const targets = this.getTargetCandidates(tab, side, choiceIndex, targetType || 'normal');
				const targetMap = new Map(targets.map(target => [`${target.side}:${target.slot}`, target]));
				const foeSide = attackerSide === 0 ? 1 : 0;
				const allySide = attackerSide;
				const targetLayout = targetType === 'adjacentAlly' || targetType === 'adjacentAllyOrSelf' || targetType === 'self' ? [
					[null, null], [`${allySide}:${choiceIndex === 0 ? 1 : 0}`, targetType === 'self' ? null : `${allySide}:${choiceIndex === 0 ? 0 : 1}`],
				] : attackerSide === 0 ? (choiceIndex === 0 ?
					[[`${foeSide}:1`, `${foeSide}:0`], [null, `${allySide}:1`]] :
					[[`${foeSide}:1`, `${foeSide}:0`], [`${allySide}:0`, null]]) : (choiceIndex === 0 ?
					[[`${allySide}:1`, null], [`${foeSide}:0`, `${foeSide}:1`]] :
					[[null, `${allySide}:0`], [`${foeSide}:0`, `${foeSide}:1`]]);
				const renderTarget = (target: { pokemon: any, side: number, slot: number, teamIndex: number }) => {
					const targetLoc = target.side === attackerSide ? `-${target.slot + 1}` : `+${target.slot + 1}`;
					return <button class="has-tooltip" data-tooltip={`analysispokemon|${target.side}|${target.teamIndex}`} onClick={() => {
						this.moveChoicesBySlot[this.choiceSide!.side][this.choiceSide!.index] = `${targetChoice} ${targetLoc}`;
						this.rebuildMoveBuilder(this.choiceSide!.side, tab.requests![this.choiceSide!.side === 'p1' ? 0 : 1]);
						this.finishActionSelection(tab);
					}}>{PSIcon({ pokemon: target.pokemon })}{target.pokemon.name || target.pokemon.details}</button>;
				};
				return <div class="switchcontrols">
					<h3 class="switchselect">Choose target</h3>
					<div class="switchmenu">{targetLayout.map((row: (string | null)[]) => <div style={{ clear: 'both' }}>{row.map(key => key && targetMap.get(key) ? renderTarget(targetMap.get(key)!) : <button class="disabled" disabled>&nbsp;</button>)}</div>)}</div>
				</div>;
			}
			return <div class="analysis-action-controls"><div class="movecontrols">
				<h3 class="moveselect">{side.toUpperCase()} Pokemon {choiceIndex + 1} Battle</h3>
				{(active.canMegaEvo || active.canMegaEvoX || active.canMegaEvoY || active.canTerastallize) && <div class="megaevo-box">
					{active.canMegaEvo && <label class={`megaevo${builder.current.mega ? ' cur' : ''}`}><input type="checkbox" checked={builder.current.mega} onChange={() => { builder.current.mega = !builder.current.mega; this.forceUpdate(); }} /> Mega Evolution</label>}
					{active.canMegaEvoX && <label class={`megaevo${builder.current.megax ? ' cur' : ''}`}><input type="checkbox" checked={builder.current.megax} onChange={() => { builder.current.megax = !builder.current.megax; this.forceUpdate(); }} /> Mega Evolution X</label>}
					{active.canMegaEvoY && <label class={`megaevo${builder.current.megay ? ' cur' : ''}`}><input type="checkbox" checked={builder.current.megay} onChange={() => { builder.current.megay = !builder.current.megay; this.forceUpdate(); }} /> Mega Evolution Y</label>}
					{active.canTerastallize && <label class={`megaevo${builder.current.tera ? ' cur' : ''}`}><input type="checkbox" checked={builder.current.tera} onChange={() => { builder.current.tera = !builder.current.tera; this.forceUpdate(); }} /> Terastallize</label>}
				</div>}
				<div class="movemenu">{active.moves.map((move: any, index: number) => { const moveData = this.getMoveData(move); return <button class={`movebutton has-tooltip type-${moveData.type}`} disabled={!!move.disabled} onClick={() => {
					const targetType = moveData.target;
					const validTargets = this.getTargetCandidates(tab, side, choiceIndex, targetType);
					const multiBattle = tab.gameType !== 'singles';
					const explicitTarget = targetType === 'adjacentAlly' || targetType === 'adjacentAllyOrSelf' || targetType === 'any' || targetType === 'adjacentFoe';
					const needsTarget = validTargets.length > 1 || (validTargets.length === 1 && multiBattle && explicitTarget);
					const modifiers = [builder.current.mega && ' mega', builder.current.megax && ' megax', builder.current.megay && ' megay', builder.current.tera && ' terastallize'].filter(Boolean).join('');
					const choice = `move ${index + 1}${modifiers}`;
					if (needsTarget) {
						(builder.request as any).targetable = true;
						this.pendingTarget = { side, index: choiceIndex, choice, targetType };
					} else {
						this.moveChoicesBySlot[side][choiceIndex] = choice;
						this.rebuildMoveBuilder(side, tab.requests![side === 'p1' ? 0 : 1]);
						this.finishActionSelection(tab);
					}
					if (needsTarget) this.forceUpdate();
				}}>{moveData.name}<br /><small class="type">{moveData.type} <span class="effectiveness-icon"></span></small> <small class="pp">{move.pp ?? ''}/{move.maxpp ?? ''}</small>&nbsp;</button>; })}</div>
				<p class="analysis-muted">{builder.isDone() ? builder.toString() : 'Choose a move'}</p>
			</div><div class="switchcontrols"><h3 class="switchselect">Switch</h3><div class="switchmenu">{(tab.requests?.[side === 'p1' ? 0 : 1]?.side?.pokemon || []).map((pokemon: any, index: number) => {
					const unavailable = pokemon.fainted || pokemon.active;
					return <button disabled={unavailable} class={unavailable ? 'disabled' : ''} onClick={() => {
						this.moveChoicesBySlot[side][choiceIndex] = null;
						if (this.pendingTarget?.side === side && this.pendingTarget.index === choiceIndex) this.pendingTarget = null;
						this.switchChoicesBySlot[side][choiceIndex] = `switch ${index + 1}`;
						this.finishActionSelection(tab);
					}}>{PSIcon({ pokemon: (pokemon.details || pokemon.name || '').split(',')[0] })}{pokemon.name || pokemon.details}</button>;
				})}</div></div></div>;
		};
		return <div class="analysis-choice-controls">{renderSide(this.choiceSide.side)}</div>;
	}

	renderSubmitChoices(tab: AnalysisTab) {
		const ready = this.actionChoicesReady(tab, 'p1') && this.actionChoicesReady(tab, 'p2');
		return <button class="button" disabled={!ready} onClick={() => {
			if (ready) this.submitChoices(tab, this.actionChoiceString(tab, 'p1'), this.actionChoiceString(tab, 'p2'));
		}}>Submit Choices</button>;
	}

	actionChoicesReady(tab: AnalysisTab, side: 'p1' | 'p2') {
		const request = tab.requests?.[side === 'p1' ? 0 : 1];
		if (!request?.active) return false;
		if (this.pendingTarget?.side === side) return false;
		return request.active.every((active: any, index: number) => !active || !!this.moveChoicesBySlot[side][index] || !!this.switchChoicesBySlot[side][index]);
	}

	actionChoiceString(tab: AnalysisTab, side: 'p1' | 'p2') {
		const request = tab.requests?.[side === 'p1' ? 0 : 1];
		if (!request?.active) return 'default';
		return request.active.map((active: any, index: number) => active ?
			this.moveChoicesBySlot[side][index] || this.switchChoicesBySlot[side][index] || 'pass' : 'pass'
		).join(', ');
	}

	renderSwitchChoices(tab: AnalysisTab) {
		const renderSide = (side: 'p1' | 'p2') => {
			const request = tab.requests?.[side === 'p1' ? 0 : 1];
			const builder = this.choiceBuilders[side];
			if (!request?.forceSwitch || !builder || !request.side?.pokemon) return null;
			const pending = request.forceSwitch.filter(Boolean).length;
			return <div class="switchcontrols">
				<h3 class="switchselect">{side.toUpperCase()} Choose replacement</h3>
				<div class="switchmenu">{request.side.pokemon.map((pokemon: any, index: number) => {
					const unavailable = pokemon.fainted || pokemon.active || builder.alreadySwitchingIn.includes(index + 1);
					return <button class={`has-tooltip${unavailable ? ' disabled' : ''}`} disabled={unavailable} data-tooltip={`analysispokemon|${side === 'p1' ? 0 : 1}|${index}`} onClick={() => {
						const replacementSlot = request.forceSwitch.findIndex((required: boolean, slot: number) => required && !this.switchChoicesBySlot[side][slot]);
						if (replacementSlot < 0) return;
						this.switchChoicesBySlot[side][replacementSlot] = `switch ${index + 1}`;
						this.rebuildSwitchBuilder(side, request);
						this.forceUpdate();
					}}>{PSIcon({ pokemon: (pokemon.details || pokemon.name || '').split(',')[0] })}{pokemon.name || pokemon.details}</button>;
				})}</div>
				<p class="analysis-muted">{builder.alreadySwitchingIn.length}/{pending} replacements selected</p>
			</div>;
		};
		const ready = ['p1', 'p2'].every(side => {
			const request = tab.requests?.[side === 'p1' ? 0 : 1];
			return !request?.forceSwitch || !!this.choiceBuilders[side as 'p1' | 'p2']?.isDone();
		});
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			{renderSide('p1')}{renderSide('p2')}
			<button class="button" disabled={!ready} onClick={() => {
				if (ready) this.submitChoices(tab, this.choiceBuilders.p1?.toString() || 'default', this.choiceBuilders.p2?.toString() || 'default');
			}}>Submit replacements</button>
		</div>;
	}

	moveChoicesReady(tab: AnalysisTab, side: 'p1' | 'p2') {
		const builder = this.choiceBuilders[side];
		const request = tab.requests?.[side === 'p1' ? 0 : 1];
		if (!builder || !request?.active || builder.current.move) return false;
		return request.active.every((active: any, index: number) => !active || builder.choices[index] && builder.choices[index] !== 'pass');
	}

	renderMoveChoiceSummary(tab: AnalysisTab) {
		const renderSide = (side: 'p1' | 'p2') => {
			const builder = this.choiceBuilders[side];
			const request = tab.requests?.[side === 'p1' ? 0 : 1];
			if (!builder || !request?.active) return null;
			const actions = request.active.map((active: any, index: number) => active ?
				`${side.toUpperCase()} Pokemon ${index + 1}: ${this.moveChoicesBySlot[side][index] || this.switchChoicesBySlot[side][index] || 'Choose move'}` : null
			).filter(Boolean);
			return <div class="analysis-choice-summary">{actions.map((action: string) => <div>{action}</div>)}</div>;
		};
		return <div class="analysis-choice-summary-wrap">{renderSide('p1')}{renderSide('p2')}</div>;
	}

	renderTeamPreviewChoices(tab: AnalysisTab) {
		const renderSide = (side: 'p1' | 'p2') => {
			const request = tab.requests?.[side === 'p1' ? 0 : 1];
			if (!request?.side?.pokemon) return <p class="message-error">{side.toUpperCase()} team preview request is missing.</p>;
			let builder = this.choiceBuilders[side];
			if (!builder) {
				builder = new BattleChoiceBuilder({
					...request,
					requestType: 'team',
					chosenTeamSize: request.chosenTeamSize || request.maxChosenTeamSize || 1,
				} as any);
				this.choiceBuilders[side] = builder;
			}
			return <div class="switchcontrols">
				<h3 class="switchselect">{side.toUpperCase()} Choose team</h3>
				<div class="switchmenu">{request.side.pokemon.map((pokemon: any, index: number) => {
					const selected = builder.alreadySwitchingIn.includes(index + 1);
					const name = pokemon.name || pokemon.details || `Pokemon ${index + 1}`;
					const tooltip = `analysispokemon|${side === 'p1' ? 0 : 1}|${index}`;
					return <button data-cmd={`/switch ${index + 1}`} class={`has-tooltip${selected ? ' disabled' : ''}`} style={selected ? 'opacity:.5' : ''} data-tooltip={tooltip} aria-disabled={selected} aria-pressed={selected} onMouseUp={() => {
						this.selectPreviewPokemon(side, index);
					}}>{PSIcon({ pokemon: (pokemon.details || pokemon.name || '').split(',')[0] })}{name}</button>;
				})}</div>
				<p class="analysis-muted">{builder.alreadySwitchingIn.length}/{builder.requestLength()} selected</p>
			</div>;
		};
		const ready = !!this.choiceBuilders.p1?.isDone() && !!this.choiceBuilders.p2?.isDone();
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			{(this.choiceBuilders.p1?.alreadySwitchingIn.length || this.choiceBuilders.p2?.alreadySwitchingIn.length) ? <button class="button" onClick={() => {
				if (this.choiceBuilders.p1?.alreadySwitchingIn.length) this.choiceBuilders.p1 = this.choiceBuilders.p1.previous();
				if (this.choiceBuilders.p2?.alreadySwitchingIn.length) this.choiceBuilders.p2 = this.choiceBuilders.p2.previous();
				this.forceUpdate();
			}}>Back</button> : null}
			{renderSide('p1')}{renderSide('p2')}
			{ready && <button class="button" onClick={() => {
				this.submitChoices(tab, this.choiceBuilders.p1!.toString(), this.choiceBuilders.p2!.toString());
			}}>Send out teams</button>}
		</div>;
	}

	renderBattleControls(tab: AnalysisTab, requestState: string) {
		if (tab.phase === 'simulation') {
			return <div class="analysis-choice-controls"><button class="button" onClick={() => this.closeSimulation(tab)}>Return to Position</button></div>;
		}
		if (tab.phase === 'one-turn') {
			return <div class="analysis-choice-controls"><button class="button" onClick={() => this.skipOneTurn(tab)}>Skip Turn</button></div>;
		}
		if (tab.phase === 'replay') return <AnalysisReplayControls
			battle={this.battle} turnView={this.turnView} speed={this.getReplaySpeed()}
			onOpenTurn={this.openTurn} onCloseTurn={this.closeTurn} onGoToTurn={this.goToTurn}
			onChangeSpeed={this.changeReplaySpeed}
		/>;
		if (tab.phase === 'selection') {
			const side = this.choiceSide?.side;
			const slot = this.choiceSide?.index ?? 0;
			const sidePokemon = side ? tab.requests?.[side === 'p1' ? 0 : 1]?.side?.pokemon || [] : [];
			const pokemon = sidePokemon.filter((entry: any) => entry.active)[slot];
			const name = (pokemon?.name || pokemon?.details || `Pokemon ${slot + 1}`).split(',')[0];
			return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
				<div><button class="button" onClick={() => this.pendingTarget ? this.cancelIntermediateSelection(tab) : this.cancelActionSelection(tab)}>Cancel</button></div>
				{this.renderMoveChoiceSummary(tab)}
				{this.choiceSide && <p>What will <strong>{name}</strong> do?</p>}
				{requestState === 'switch' ? this.renderSwitchChoices(tab) : this.renderMoveChoices(tab)}
			</div>;
		}
		const currentNode = tab.nodes[tab.currentNodeId];
		const canReplayPrevious = !!currentNode?.parentId;
		const ready = this.actionChoicesReady(tab, 'p1') && this.actionChoicesReady(tab, 'p2');
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			<div>
				<button class="button" onClick={() => this.openReplayFromStart(tab)}>Replay from Start</button>
				<button class="button" disabled={!canReplayPrevious} onClick={() => this.replayPreviousTurn(tab)}>Replay Prev Turn</button>
				<button class="button" disabled={!canReplayPrevious} onClick={() => this.previousNode(tab)}>Prev Turn</button>
				<button class="button" disabled>Next Turn</button>
			</div>
			{this.renderMoveChoiceSummary(tab)}
			<p class="analysis-muted">Click an active Pokemon to choose its actions.</p>
			<div>
				<button class="button" disabled={!ready || tab.loading} onClick={() => this.submitChoices(tab, this.actionChoiceString(tab, 'p1'), this.actionChoiceString(tab, 'p2'))}>Submit Choices</button>
				<button class="button" disabled={!ready || tab.loading} onClick={() => this.simulateNextTurn(tab)}>{tab.loading ? 'Simulating...' : 'Simulate Possible Turns'}</button>{' '}
				<label>Number of Simulations: <input class="textbox" type="number" min="1" step="1" value={tab.simulationCount} onInput={(event) => {
					tab.simulationCount = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
					this.forceUpdate();
				}} /></label>
			</div>
		</div>;
	}

	renderAnalysis(tab: AnalysisTab) {
		const { battleWidth, battleHeight, mainWidth, treeWidth, sideBySide } = this.layout;
		const requestState = getRequestState(tab.requestState, tab.requests);
		const selectedData = tab.simulationGroups ? this.getSelectedSimulation(tab) : tab.nodes[tab.currentNodeId] || null;
		return [
			<div class="ps-room ps-room-opaque" style={sideBySide ? `left:0;width:${mainWidth}px;right:auto;display:block;` : `left:0;width:100%;right:auto;display:block;`}>
				<div class="analysis-battle-stage" style="height:100%;">
				<div class="battle" style={`position:absolute;top:0;left:0;width:${battleWidth}px;height:${battleHeight}px`} ref={(element: HTMLElement | null) => this.battleFrame = element} />
				{(requestState === 'move' || requestState === 'switch') && <div class="battle-controls" style={`position:absolute;top:${battleHeight + 10}px;left:0;width:${battleWidth}px`} role="complementary" aria-label="Battle Controls">{this.renderBattleControls(tab, requestState)}</div>}
				{(requestState === 'teampreview' || tab.requests?.[0]?.teamPreview) && <div class="battle-controls" style={`position:absolute;top:${battleHeight + 10}px;left:0;width:${battleWidth}px`} role="complementary" aria-label="Battle Controls">{this.renderTeamPreviewChoices(tab)}</div>}
				<div class="battle-log" style={`position:absolute;top:0;left:${battleWidth}px;right:0;bottom:0;width:auto;`} aria-label="Battle Log" role="complementary" ref={(element: HTMLElement | null) => this.battleLogFrame = element} />
				</div>
			</div>,
			<div class="ps-room ps-room-light scrollable" style={`top:56px;left:${mainWidth + 1}px;width:${treeWidth}px;right:auto;bottom:0;display:block;`}>
				<h2>Lines</h2>
				{tab.simulationGroups ? <ol class="analysis-simulation-list">{tab.simulationGroups.map((group, index) =>
					this.renderSimulationGroup(tab, group, index)
				)}</ol> : <AnalysisNodeTree tab={tab} onSelect={nodeId => void this.restoreAnalysisNode(tab, nodeId)} />}
				<h2>{tab.simulationGroups ? 'Selected Simulation Result' : 'Selected Node Data'}</h2>
				<pre class="analysis-debug-log">{JSON.stringify(selectedData, null, 2)}</pre>
			</div>
		];
	}

	render() {
		const activeTab = this.tabs.find(tab => tab.id === this.activeTab);
		const header = <AnalysisHeader
			tabs={this.tabs} activeTab={activeTab} onOpenHome={this.openHome}
			onActivateTab={tabId => { this.activeTab = tabId; this.forceUpdate(); }}
			onCloseTab={this.closeTab} onDragStart={this.dragStart} onDragEnter={this.dragEnter}
			onDragEnd={() => this.draggedTab = null}
		/>;
		const rooms = activeTab ? this.renderAnalysis(activeTab) : [<div class="analysis-panel">{this.renderHome()}</div>];
		return preact.h(preact.Fragment, null, header, ...rooms) as any;
	}
}

preact.render(<AnalysisApp />, document.getElementById('main')!);