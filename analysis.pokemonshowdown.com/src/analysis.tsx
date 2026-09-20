/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { BattleChoiceBuilder } from '../../play.pokemonshowdown.com/src/battle-choices';
import type { ID } from '../../play.pokemonshowdown.com/src/battle-dex';
import { BattleSound } from '../../play.pokemonshowdown.com/src/battle-sound';
import { Teams } from '../../play.pokemonshowdown.com/src/battle-teams';
import {
	FORMATS, LAYOUT, getRenderedLog, getRenderedLogTail, getReplayStartTurn, getRequestState,
	isPlaceholderPokemon,
	type AnalysisBattle, type AnalysisCalcMode, type AnalysisCalcState, type AnalysisChoiceSummary,
	type AnalysisEdits, type AnalysisGroupingMode, type AnalysisMidTurnSwitchOption, type AnalysisNode,
	type AnalysisPhase, type AnalysisSideID, type AnalysisSimulationGroup, type AnalysisSimulationRoll, type AnalysisTab,
	type AnalysisTeamEdit, type LocalTeam, type PlaybackStage, type StartMode,
} from './analysis-model';
import {
	AnalysisTeamValidationError, getAnalysisVersion, runAnalysis, runAnalysisBatch, runAnalysisCalc,
	runAnalysisSetup, type AnalysisStartResponse,
} from './analysis-api';
import {
	downloadAnalysisExport, parseAnalysisExport, stalenessWarning, tabFromAnalysisExport,
	type AnalysisExport,
} from './analysis-export';
import { AnalysisBattleRenderer } from './analysis-battle';
import {
	buildReplayNodes, fetchReplayLog, packReplayTeams, readReplayFileText, replayInputLog,
	replayPreviewStep, teamPreviewPicks, undecidedReplaySlots,
} from './analysis-replay-import';
import { parseAnalysisReplay } from './analysis-replay-parse';
import { AnalysisChoiceDraft, getStaleChoiceSlots, sideIndex } from './analysis-choices';
import { AnalysisChoiceSummaryView } from './analysis-choice-summary';
import { AnalysisFieldEditor, AnalysisFieldFormState, mergeFieldEdits } from './analysis-field-editor';
import {
	AnalysisPokemonEditor, AnalysisPokemonFormState, mergePokemonEdits, type AnalysisPokemonTarget,
} from './analysis-pokemon-editor';
import { AnalysisHeader } from './analysis-header';
import { loadDebugMode, saveDebugMode } from './analysis-settings';
import {
	getReplayAnchor, getSetupNode, hasChildNodes, rebuiltTurnNumber, replayNodesFor, resolveTeamsFor,
} from './analysis-nodes';
import { AnalysisNodeTree } from './analysis-node-tree';
import { PSIcon } from './analysis-ps-shims';
import { AnalysisTeambuilder, AnalysisTeamFormState, summarizeTeam } from './analysis-teambuilder';
import { AnalysisReplayControls } from './analysis-replay-controls';
import { packTeamSyntax } from './analysis-team-utils';
import { AnalysisTooltips } from './analysis-tooltips';
import { AnalysisTurnEventSummaryView, getLogTurnEventSummary, getTurnEventSummary } from './analysis-turn-events';

/**
 * What you can click in the battle window, as the hover tooltip on the controls' info icon. It replaced a
 * line of text under the buttons, so the panel isn't carrying a permanent instruction. The tooltip renders
 * it with `white-space: pre-line`, so these are three lines.
 */
const DEFAULT_CONTROLS_HELP = [
	'Click on an active Pokémon to choose its actions.',
	'Click on a Pokémon icon to edit that Pokémon.',
	'Click on a trainer to open the teambuilder.',
].join('\n');

function pokemonLabel(pokemon: any) {
	return (pokemon?.details || pokemon?.name || '').split(',')[0];
}

/**
 * How the Simulation Outcomes list scrolls after a render:
 * - anchor: keep the outcome at the same on-screen position (selecting it can resize it and the previous selection)
 * - reveal: scroll the least amount needed to show the outcome (Prev/Next)
 * - top: start at the top (new simulation results)
 */
type OutcomeScroll = { mode: 'anchor', index: number, offset: number } | { mode: 'reveal' | 'top', index: number };

class AnalysisApp extends preact.Component {
	tabs: AnalysisTab[] = [];
	activeTab: string | null = null;
	draggedTab: string | null = null;
	mode: StartMode | null = null;
	format = FORMATS[0].id;
	team1 = '';
	team2 = '';
	replayURL = '';
	/** a replay log read from an uploaded file, which takes precedence over the URL box */
	replayFileLog: string[] | null = null;
	replayFileName = '';
	/** an analysis file chosen on the Import Analysis form, validated as soon as it is read */
	analysisFile: AnalysisExport | null = null;
	analysisFileName = '';
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
	/**
	 * The commit the analysis API is running, recorded in an exported file so a later import can warn that
	 * the sim has moved on. Fetched once at startup rather than when Export is clicked, so exporting stays
	 * synchronous; an empty string (the call failed, or the server has no git checkout) simply means an
	 * import has nothing to compare.
	 */
	serverCommit = '';
	/** developer panels, behind the header's settings popup; remembered across reloads */
	debugMode = loadDebugMode();
	settingsOpen = false;
	choiceControlsFrame: HTMLElement | null = null;
	choiceTooltips: AnalysisTooltips | null = null;
	/** damage calcs for the current decision point and draft (see refreshCalcs) */
	calcs: AnalysisCalcState | null = null;
	calcAbortController: AbortController | null = null;
	choiceTooltipsFrame: HTMLElement | null = null;
	draft = new AnalysisChoiceDraft();
	/** state edit forms for the current decision point (unsaved changes) */
	fieldForm = new AnalysisFieldFormState();
	pokemonForm = new AnalysisPokemonFormState();
	/** the Pokémon whose form replaces the field form, if any */
	editPokemon: AnalysisPokemonTarget | null = null;
	/** the teambuilder replaces the battle and controls entirely while a side is open */
	teamForm = new AnalysisTeamFormState();
	showMoreFieldEffects = false;
	editError = '';
	/** validator problems from a refused Team Preview team, listed in the teambuilder */
	editProblems: { team1: string[], team2: string[] } | null = null;
	/** `clearedSlots` drops choices for slots whose Pokémon an edit replaced */
	pendingHydration: {
		tabId: string, inputLog: string[], clearedSlots?: { side: AnalysisSideID, slot: number }[],
	} | null = null;
	simulationGroupElements: Record<number, HTMLElement | null> = {};
	/** outcome-list scroll adjustment to apply after the next render (see applyOutcomeScroll) */
	pendingOutcomeScroll: OutcomeScroll | null = null;
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
		// only an export reads it, and it never blocks one: a failed call leaves it empty
		void getAnalysisVersion().then(commit => {
			this.serverCommit = commit;
		});
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
				format: tab.format, ...resolveTeamsFor(tab, nodeId),
				seed: tab.rootSeed, replayNodes: replayNodesFor(tab, nodeId, false),
			});
			tab.currentNodeId = nodeId;
			this.editError = '';
			this.editProblems = null;
			this.editPokemon = null;
			// the teambuilder shows one node's roster, so navigating away closes it
			this.teamForm.close();
			const requestState = this.applyBattleResponse(tab, data);
			tab.phase = requestState === 'teampreview' ? 'preview' : 'default';
			const undecided = this.fillReplayChoices(tab, node);
			this.pendingHydration = {
				tabId: tab.id, inputLog: [...(inputLog ?? node.inputLog)], clearedSlots: undecided,
			};
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

	/**
	 * Turns an imported node's replay actions into the choices it actually holds, the first time the
	 * position behind it exists. Returns the slots the replay couldn't explain, which stay undecided.
	 *
	 * This is deliberately not done at import: a choice is written as `move 2` and `switch 3`, and which
	 * move and which Pokémon those are depends on the team the user finishes in onboarding. Once resolved
	 * it is stored on the node, so it survives selecting another node and behaves like any other draft —
	 * the Action Summary shows it, and it can be submitted or changed an action at a time.
	 */
	fillReplayChoices(tab: AnalysisTab, node: AnalysisNode) {
		if (!node.replayActions?.length) return undefined;
		if (!node.inputLog.length) {
			const { inputLog } = replayInputLog(node.replayActions, tab.requests, tab.gameType);
			node.inputLog = inputLog;
		}
		// Recomputed from the stored line rather than kept alongside it: `hydrate` needs to know which
		// slots are `pass` every time, and a forked copy carries the line but nothing else.
		return undecidedReplaySlots(node.inputLog);
	}

	/** Copies the reconstructed position onto the tab. Returns the normalized request state. */
	applyBattleResponse(tab: AnalysisTab, data: AnalysisStartResponse) {
		tab.log = data.log || [];
		tab.snapshot = data.snapshot;
		tab.editOptions = data.editOptions || tab.editOptions;
		tab.requests = data.requests;
		tab.requestState = getRequestState(data.requestState, data.requests);
		tab.gameType = data.gameType || tab.gameType;
		// only ever surfaced in debug mode; a dropped edit is also removed from the node, so it can't re-apply
		tab.droppedEdits = data.droppedEdits || [];
		return tab.requestState;
	}

	/**
	 * If the executed turn fully resolved (no replacements pending), records its outcome on
	 * `node` and opens the next decision point as its child.
	 */
	completeNodeIfResolved(tab: AnalysisTab, node: AnalysisNode, data: AnalysisStartResponse, requestState: string) {
		if (data.pendingMidTurnSwitches?.length || requestState === 'switch') return false;
		/*
		 * Asked in the rebuilt battle's numbering, not the replay's: a turn played off an imported replay
		 * node comes back in a log that calls that node's turn `|turn|1`, so looking up `node.turn` found
		 * nothing and stored an empty summary. `[]` is truthy, so the Lines tooltip still opened for the
		 * node's edits with the outcome section silently blank.
		 */
		const events = getLogTurnEventSummary(data.log || [], rebuiltTurnNumber(tab, node));
		// stored as absent rather than empty, so the tooltip offers no outcome section at all
		node.turnEventSummary = events.length ? events : undefined;
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
			// the renderer's queue is filtered and renumbered (getRenderedLog), so appended lines are too
			for (const line of getRenderedLogTail(tab, getReplayAnchor(tab), tab.log.slice(previousLog.length))) {
				battle.add(line);
			}
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
				format: tab.format, ...resolveTeamsFor(tab), seed: tab.rootSeed,
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
				format: tab.format, ...resolveTeamsFor(tab, parent.id), seed: tab.rootSeed,
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
	 * State edits
	 *********************************************************/

	/** Opens the form for the Pokémon at `index` in the side's current team order (as tooltips address them). */
	openPokemonEditorAt(tab: AnalysisTab, side: AnalysisSideID, index: number) {
		const pokemon = tab.snapshot?.sides[sideIndex(side)]?.pokemon[index];
		if (pokemon) this.openPokemonEditor(tab, { side, teamSlot: pokemon.teamSlot });
	}

	/**
	 * On a Set Up Position tab, an untouched placeholder's sprite opens **the teambuilder**, focused on that
	 * Pokémon's species — the same place you would land by clicking the trainer sprite and then its species.
	 * The point of that Pokémon is that it still has to be built, and there is nothing to choose for it
	 * anyway (no moves means a Struggle-only menu). Once it has been edited it behaves like any other.
	 *
	 * It wins over the action menu too: clicking a placeholder while choosing another Pokémon's action used
	 * to switch to the placeholder's own action selection, which is never what you wanted (user report,
	 * 2026-09-19). `openTeambuilder` cancels the open selection first.
	 */
	openPlaceholderInTeambuilder(tab: AnalysisTab, side: AnalysisSideID, index: number) {
		if (!tab.sandbox || (tab.phase !== 'default' && tab.phase !== 'selection')) return false;
		const pokemon = tab.snapshot?.sides[sideIndex(side)]?.pokemon[index];
		if (!isPlaceholderPokemon(pokemon)) return false;
		this.openTeambuilder(tab, side, pokemon!.teamSlot);
		return true;
	}

	/** Opens the Pokémon edit form in place of the field form, leaving the action menu if one is open. */
	openPokemonEditor = (tab: AnalysisTab, target: AnalysisPokemonTarget) => {
		if (tab.phase === 'selection') this.cancelActionSelection(tab);
		if (tab.phase !== 'default') return;
		this.editPokemon = target;
		this.editError = '';
		this.forceUpdate();
	};

	/**
	 * Opens the teambuilder for one side, replacing the battle and controls. Only at a decision point,
	 * where the sim's queues are empty and the server can rebuild a roster safely.
	 */
	openTeambuilder = (tab: AnalysisTab, side: AnalysisSideID, focusTeamSlot?: number) => {
		if (tab.phase === 'selection') this.cancelActionSelection(tab);
		if ((tab.phase !== 'default' && tab.phase !== 'preview') || !tab.snapshot) return;
		this.editPokemon = null;
		this.editError = '';
		this.editProblems = null;
		// the setup tab's opening instruction has been followed, so the normal controls take over
		tab.sandboxIntroDone = true;
		this.teamForm.open(side, tab.snapshot, tab.format, focusTeamSlot);
		this.forceUpdate();
	};

	closeTeambuilder = () => {
		this.teamForm.close();
		this.editError = '';
		this.editProblems = null;
		this.forceUpdate();
	};

	saveTeamEdits = async (tab: AnalysisTab, edit: AnalysisTeamEdit) => {
		const side = this.teamForm.side;
		if (!side) return;
		/*
		 * A side always needs at least one Pokémon, at every node. Refusing here rather than at the server
		 * keeps the two paths consistent: mid-battle the server would drop the edit and silently put the
		 * roster back, which reads as "Save did nothing", and at Team Preview an empty packed team is
		 * rejected as a missing team rather than as an empty one.
		 */
		if (!edit.sets.length) {
			const problems = { team1: [] as string[], team2: [] as string[] };
			problems[side === 'p1' ? 'team1' : 'team2'] = ['A team needs at least one Pokémon.'];
			this.editError = '';
			this.editProblems = problems;
			this.forceUpdate();
			return;
		}
		if (tab.phase === 'preview') await this.saveTeamPreviewTeam(tab, side, edit);
		else await this.saveEdits(tab, { teams: { [side]: edit } });
		// the save leaves an error set when the server refused it; keep the panel open so it can be fixed
		if (!this.editError && !this.editProblems) this.closeTeambuilder();
	};

	/**
	 * At Team Preview the team isn't an edit layer: it replaces the team the battle is built from, stored
	 * on this node (see resolveTeamsFor). The battle then emits its own `clearpoke`/`poke` lines, so no
	 * roster resync is needed and team slots are just the new team's order.
	 *
	 * Unlike mid-battle edits, this team *is* validated, because it's sent as `team1`/`team2`. An illegal
	 * team is refused: the node is rolled back and the problems are shown in the panel, which stays open.
	 */
	saveTeamPreviewTeam = async (tab: AnalysisTab, side: AnalysisSideID, edit: AnalysisTeamEdit) => {
		const original = tab.nodes[tab.currentNodeId];
		if (!original || tab.loading) return;
		const packed = Teams.pack(edit.sets as any);
		const { teams: originalTeams, teamSummary: originalSummary } = original;
		const node = this.editCurrentNode(tab, target => {
			target.teams = { ...target.teams, [side]: packed };
			target.teamSummary = { ...(target.teamSummary || { p1: [], p2: [] }), [side]: summarizeTeam(edit.sets) };
			// the stored selection names Pokémon by position, which the new roster invalidates
			target.inputLog = [];
			target.teamSelectionSummary = undefined;
			target.seed = null;
		})!;
		const copied = node !== original;
		tab.loading = true;
		this.editError = '';
		this.editProblems = null;
		this.forceUpdate();
		try {
			const data = await runAnalysis({
				format: tab.format, ...resolveTeamsFor(tab, node.id), seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, node.id, false),
			});
			const requestState = this.applyBattleResponse(tab, data);
			tab.phase = requestState === 'teampreview' ? 'preview' : 'default';
			// the rebuild in componentDidUpdate makes fresh choice builders from the new requests,
			// which is what drops the selection the old roster's positions referred to
			this.pendingHydration = { tabId: tab.id, inputLog: [] };
			this.destroyBattle();
		} catch (error: any) {
			if (copied) {
				delete tab.nodes[node.id];
				tab.currentNodeId = original.id;
			} else {
				node.teams = originalTeams;
				node.teamSummary = originalSummary;
			}
			if (error instanceof AnalysisTeamValidationError) this.editProblems = error.problems;
			else this.editError = error.message || 'Unable to apply this team.';
		} finally {
			tab.loading = false;
			this.forceUpdate();
		}
	};

	/** The team index of the Pokémon in active slot `slot`, for tooltips and the edit form. */
	activeTeamIndex(tab: AnalysisTab, side: AnalysisSideID, slot: number) {
		const pokemonList = tab.requests?.[sideIndex(side)]?.side?.pokemon || [];
		const active = pokemonList.filter((pokemon: any) => pokemon.active)[slot];
		const index = pokemonList.indexOf(active);
		return index < 0 ? null : index;
	}

	/**
	 * Merges form changes into the current node's edits (copy-on-edit if it has children), then rebuilds the
	 * position. The server reports what the edits actually changed, which replaces the stored edits.
	 */
	saveEdits = async (tab: AnalysisTab, changes: AnalysisEdits) => {
		const original = tab.nodes[tab.currentNodeId];
		if (!original || tab.loading) return;
		this.saveLeafDraft(tab);
		// kept to compare against the rebuilt position, so choices the edit invalidated can be dropped
		const beforeSnapshot = tab.snapshot;
		const { edits: originalEdits, editSummary: originalSummary } = original;
		const node = this.editCurrentNode(tab, target => {
			target.edits = mergePokemonEdits(target.edits || {}, changes);
			if (changes.field) target.edits.field = mergeFieldEdits(target.edits.field, changes.field);
			// a copy of an executed node is a new, undecided decision point
			target.seed = null;
			target.turnEventSummary = undefined;
		})!;
		const copied = node !== original;
		tab.loading = true;
		this.editError = '';
		this.forceUpdate();
		try {
			const data = await runAnalysis({
				format: tab.format, ...resolveTeamsFor(tab, node.id), seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, node.id, false),
			});
			// the node's own record is the last one, since it has edits
			const applied = data.appliedEdits?.[data.appliedEdits.length - 1];
			const edits: AnalysisEdits = applied?.edits || {};
			if (Object.keys(edits).length) {
				node.edits = edits;
				node.editSummary = applied?.summary;
			} else if (copied) {
				// nothing changed after all: drop the copy and stay on the original line
				delete tab.nodes[node.id];
				tab.currentNodeId = original.id;
			} else {
				delete node.edits;
				delete node.editSummary;
			}
			this.applyBattleResponse(tab, data);
			tab.phase = 'default';
			// a slot's chosen action belonged to the Pokémon that was there, so replacing it clears the choice
			const clearedSlots: { side: AnalysisSideID, slot: number }[] = [];
			for (const side of ['p1', 'p2'] as const) {
				const slots = applied?.edits.active?.[side] || [];
				for (let slot = 0; slot < slots.length; slot++) {
					if (slots[slot] !== null && slots[slot] !== undefined) clearedSlots.push({ side, slot });
				}
			}
			// a set or roster change can also leave a chosen move or switch target naming something else
			for (const stale of getStaleChoiceSlots(beforeSnapshot, tab.snapshot, this.draft)) {
				let already = false;
				for (const entry of clearedSlots) {
					if (entry.side === stale.side && entry.slot === stale.slot) already = true;
				}
				if (!already) clearedSlots.push(stale);
			}
			this.pendingHydration = {
				tabId: tab.id, inputLog: [...tab.nodes[tab.currentNodeId].inputLog], clearedSlots,
			};
			this.destroyBattle();
		} catch (error: any) {
			if (copied) {
				delete tab.nodes[node.id];
				tab.currentNodeId = original.id;
			} else {
				node.edits = originalEdits;
				node.editSummary = originalSummary;
			}
			this.editError = error.message || 'Unable to apply the edits.';
		} finally {
			tab.loading = false;
			this.forceUpdate();
		}
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
				format: tab.format, ...resolveTeamsFor(tab), seed: tab.rootSeed,
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
			this.pendingOutcomeScroll = { mode: 'top', index: 0 };
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
		tab: AnalysisTab, groupIndex: number, roll = tab.simulationRoll || 'median', scroll?: 'anchor' | 'reveal'
	) => {
		const simulation = tab.simulationGroups?.[groupIndex]?.[roll];
		if (!simulation) return;
		if (scroll === 'reveal') this.pendingOutcomeScroll = { mode: 'reveal', index: groupIndex };
		if (scroll === 'anchor') {
			const element = this.simulationGroupElements[groupIndex];
			const container = element?.closest<HTMLElement>('.scrollable');
			if (element && container) {
				const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
				this.pendingOutcomeScroll = { mode: 'anchor', index: groupIndex, offset };
			}
		}
		tab.log = simulation.log;
		tab.selectedSimulationGroupIndex = groupIndex;
		tab.simulationRoll = roll;
		tab.selectedSimulationIndex = simulation.index;
		tab.hoveredSimulationGroupIndex = undefined;
		tab.phase = 'simulation-selection';
		this.destroyBattle();
		this.forceUpdate();
	};

	applyOutcomeScroll() {
		const pending = this.pendingOutcomeScroll;
		if (!pending) return;
		this.pendingOutcomeScroll = null;
		const element = this.simulationGroupElements[pending.index];
		const container = element?.closest<HTMLElement>('.scrollable');
		if (!element || !container) return;
		const containerRect = container.getBoundingClientRect();
		const rect = element.getBoundingClientRect();
		if (pending.mode === 'top') {
			container.scrollTop = 0;
		} else if (pending.mode === 'anchor') {
			container.scrollTop += (rect.top - containerRect.top) - pending.offset;
		} else if (rect.top < containerRect.top) {
			container.scrollTop -= containerRect.top - rect.top;
		} else if (rect.bottom > containerRect.bottom) {
			// show the bottom too, unless the outcome is taller than the panel (then align its top)
			container.scrollTop += Math.min(rect.bottom - containerRect.bottom, rect.top - containerRect.top);
		}
	}

	changeSimulationGrouping = (tab: AnalysisTab, mode: AnalysisGroupingMode) => {
		tab.simulationGroupingMode = mode;
		tab.simulationGroups = mode === 'state' ? tab.stateSimulationGroups : tab.turnSimulationGroups;
		// no scrolling: the grouping controls stay where the user clicked them
		this.showSimulation(tab, 0, 'median');
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
				format: tab.format, ...resolveTeamsFor(tab, parent.id), seed: tab.rootSeed,
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
				onClick={() => { if (!playbackActive) this.showSimulation(tab, index, undefined, 'anchor'); }}
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
		if (!tab || (tab.phase !== 'default' && tab.phase !== 'selection' && tab.phase !== 'preview')) return;
		const target = event.target as HTMLElement;
		// A side's trainer sprite opens that team's teambuilder. The scene tags the sidebars
		// `trainer-near`/`trainer-far` (battle-animations.ts), so no upstream change is needed. Match the
		// sprite itself, not `.trainer`: that wrapper also contains the team icons, which edit one Pokémon.
		const trainer = target.closest<HTMLElement>('.trainersprite')?.closest<HTMLElement>('.trainer');
		if (trainer) {
			if (!tab.snapshot) return;
			this.openTeambuilder(tab, trainer.className.includes('trainer-far') ? 'p2' : 'p1');
			return;
		}
		if (tab.phase === 'preview') return;
		const marker = target.closest<HTMLElement>('.has-tooltip[data-tooltip]');
		const tooltip = marker?.dataset.tooltip;
		if (!tooltip) return;
		const args = tooltip.split('|');
		// the team icons in the sidebar edit that Pokémon; the sprites below choose its action
		if (args[0] === 'analysispokemon' && marker.classList.contains('picon')) {
			this.openPokemonEditorAt(tab, Number(args[1]) === 0 ? 'p1' : 'p2', Number(args[2]));
			return;
		}
		if (args[0] === 'analysispokemon') {
			const sideNumber = Number(args[1]);
			const teamIndex = Number(args[2]);
			if (this.openPlaceholderInTeambuilder(tab, sideNumber === 0 ? 'p1' : 'p2', teamIndex)) return;
			const battleSide = (this.battle as any)?.sides?.[sideNumber];
			const activeIndex = battleSide?.active?.findIndex((pokemon: any) =>
				this.findAnalysisTeamIndex(sideNumber, pokemon) === teamIndex);
			if (activeIndex === undefined || activeIndex < 0) return;
			this.selectMovePokemon(sideNumber === 0 ? 'p1' : 'p2', activeIndex);
		} else if (args[0] === 'activepokemon') {
			const sideNumber = Number(args[1]);
			// the actives sit at the front of the snapshot's roster, so the slot is its index there too
			const slot = Number(args[2]) || 0;
			if (this.openPlaceholderInTeambuilder(tab, sideNumber === 0 ? 'p1' : 'p2', slot)) return;
			this.selectMovePokemon(sideNumber === 0 ? 'p1' : 'p2', slot);
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
		// a setup tab's battle starts at turn 1, with its position already built
		battle?.seekTurn(getReplayStartTurn(tab));
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
		// The import's brought-Pokémon step answers the turn-0 node, not the node being browsed, so it
		// must not draft onto it: the current node is a replay turn, and a one-turn replay's is a leaf.
		if (tab && !tab.importPreview) this.saveLeafDraft(tab);
		this.forceUpdate();
	};

	selectMovePokemon = (side: AnalysisSideID, index: number) => {
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		if (!tab || (tab.phase !== 'default' && tab.phase !== 'selection')) return;
		// nothing to choose once the game is over, and the action menu has no way back from an empty request
		if (tab.nodes[tab.currentNodeId]?.gameOver) return;
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
		const edits = JSON.stringify(tab.nodes[tab.currentNodeId]?.edits || null);
		return [tab.id, tab.currentNodeId, edits, ...this.draft.toInputLog(tab.requests)].join('\n');
	}

	/**
	 * Which of the attacker's calc variants a tooltip shows: while its move menu is open, the Mega/Tera
	 * checkbox state; for a chosen move, that choice's modifier.
	 */
	getCalcMode = (sideNumber: number, slot: number, usage: 'hover' | 'selected'): AnalysisCalcMode => {
		const side = sideNumber === 0 ? 'p1' : 'p2';
		if (usage === 'hover') {
			const { choiceSide } = this.draft;
			const current = this.draft.builders[side]?.current;
			if (!current || choiceSide?.side !== side || choiceSide.index !== slot) return '';
			return current.tera ? 'tera' : current.megax ? 'megax' : current.megay ? 'megay' : current.mega ? 'mega' : '';
		}
		const choice = this.draft.moveChoicesBySlot[side][slot] || '';
		if (/\bterastallize\b/.test(choice)) return 'tera';
		const mega = /\b(megax|megay|mega)\b/.exec(choice);
		return mega ? mega[1] as AnalysisCalcMode : '';
	};

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
				format: tab.format, ...resolveTeamsFor(tab), seed: tab.rootSeed,
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
		this.choiceTooltips = new AnalysisTooltips(this.battle as any, {
			getCalcs: () => this.calcs,
			getCalcMode: this.getCalcMode,
			getSnapshot: () => this.tabs.find(entry => entry.id === this.activeTab)?.snapshot,
		});
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

	override componentDidMount() {
		/*
		 * No sound. The renderer is driven as a replay that is constantly rebuilt, rewound and fast-forwarded
		 * (see componentDidUpdate), so effects fire in bursts while seeking and are cut off mid-play by the
		 * next rebuild — which is also where the browser's "play() request was interrupted" warnings that
		 * lib.js has to ignore come from. There is no PS prefs object on this page, so nothing unsets it.
		 */
		BattleSound.setMute(true);
	}

	override componentDidUpdate() {
		this.applyOutcomeScroll();
		this.syncChoiceTooltips();
		const tab = this.tabs.find(entry => entry.id === this.activeTab);
		this.refreshCalcs(tab);
		if (!tab || !this.battleFrame || !this.battleLogFrame || !tab.log.length || this.battleTabId === tab.id) return;
		this.destroyBattle();
		const $ = (window as any).$;
		if (!$) return;
		this.battle = new AnalysisBattleRenderer({
			id: tab.id as ID,
			$frame: $(this.battleFrame),
			$logFrame: $(this.battleLogFrame),
			// not tab.log: a sandbox tab plays its turn-1 edits as setup, before |turn|1, and an imported
			// replay plays its own history in front of them (see getRenderedLog)
			log: getRenderedLog(tab, getReplayAnchor(tab)),
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
			const { inputLog, clearedSlots } = this.pendingHydration;
			this.pendingHydration = null;
			// skipped during hydration, not cleared after: a choice naming a move slot or switch target
			// that no longer exists would abort the rest of its line (see AnalysisChoiceDraft.hydrate)
			this.draft.hydrate(inputLog, tab.requests, clearedSlots);
			for (const { side, slot } of clearedSlots || []) {
				this.draft.moveChoicesBySlot[side][slot] = null;
				this.draft.switchChoicesBySlot[side][slot] = null;
				const request = tab.requests?.[sideIndex(side)];
				if (request?.active) this.draft.rebuildMoveBuilder(side, request);
			}
			this.updateCurrentNodeSummary(tab);
			if (clearedSlots?.length) this.saveLeafDraft(tab);
			this.forceUpdate();
		}
		if (tab.phase === 'replay') {
			battle.seekTurn(getReplayStartTurn(tab));
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
		if (this.mode === 'replay' && !this.replayURL && !this.replayFileLog) {
			this.startError = 'Paste a replay URL or choose a replay file.';
			this.forceUpdate();
			return;
		}
		if (this.mode === 'analysis' && !this.analysisFile) {
			this.startError = 'Choose an exported analysis file.';
			this.forceUpdate();
			return;
		}
		this.starting = true;
		this.startError = '';
		this.forceUpdate();
		try {
			/*
			 * An imported analysis is the one start path with no position of its own: the file states the
			 * line, and `restoreAnalysisNode` builds the position behind its current node exactly as
			 * selecting that node would. It therefore skips the seeding below, which needs requests the
			 * rebuild has not fetched yet, and which the rebuild does for itself.
			 */
			if (this.mode === 'analysis') {
				const tab = this.analysisTabFromFile(this.analysisFile!);
				this.tabs = [...this.tabs, tab];
				this.activeTab = tab.id;
				await this.restoreAnalysisNode(tab, tab.currentNodeId);
				/*
				 * `restoreAnalysisNode` reports a failed rebuild by setting `startError` rather than
				 * throwing, so the half-built tab has to be taken back out by hand — otherwise a file the
				 * server refuses (an unknown format, a team its validator won't take) leaves an empty tab
				 * open with the error attached to the start form behind it.
				 */
				if (this.startError) {
					this.tabs = this.tabs.filter(entry => entry.id !== tab.id);
					this.activeTab = this.tabs[this.tabs.length - 1]?.id || null;
				} else {
					this.mode = null;
					this.analysisFile = null;
					this.analysisFileName = '';
				}
			} else {
				let tab;
				if (this.mode === 'setup') tab = await this.startSetupAnalysis();
				else if (this.mode === 'replay') tab = await this.startReplayAnalysis();
				else tab = await this.startTeamsAnalysis();
				this.tabs = [...this.tabs, tab];
				this.activeTab = tab.id;
				this.setChoiceBuilders(tab.requests, tab.gameType);
				this.initializeCurrentNodeSummary(tab);
				// An imported replay opens straight into its onboarding pass rather than into the battle.
				if (tab.onboarding) {
					this.teamForm.openPacked(tab.onboarding, tab.team1, tab.format);
				}
				this.mode = null;
			}
		} catch (error: any) {
			this.startError = error.message || 'Unable to start the analysis.';
		} finally {
			this.starting = false;
		}
		this.forceUpdate();
	};

	/**
	 * Saves the team the user has been completing onto the **tab**, not onto a node.
	 *
	 * An imported replay's teams are what every node is rebuilt from, so onboarding edits `tab.team1` and
	 * `tab.team2` directly rather than going through the edit layer. That is also what keeps the node
	 * edits correct: HP rides on each node as a percentage and resolves against whatever max HP the
	 * finished team ends up with.
	 */
	async saveOnboardingTeam(tab: AnalysisTab, next: AnalysisSideID | null) {
		const side = this.teamForm.side;
		if (!side || tab.loading) return;
		const packed = Teams.pack(this.teamForm.collect().sets as any) || '';
		if (!packed) {
			this.editError = 'A team needs at least one Pokémon.';
			this.forceUpdate();
			return;
		}
		if (side === 'p1') tab.team1 = packed;
		else tab.team2 = packed;
		this.editError = '';
		if (next) {
			this.openOnboardingSide(tab, next);
			return;
		}
		await this.finishOnboarding(tab);
	}

	/**
	 * Shows the other side's reconstruction without leaving the onboarding pass.
	 *
	 * Built from the **tab's** packed team, not from the snapshot: onboarding saves straight onto the tab
	 * and doesn't rebuild the battle, so the snapshot is still the position as first loaded and would undo
	 * whatever the user had already saved for this side (user report, 2026-09-19).
	 */
	openOnboardingSide(tab: AnalysisTab, side: AnalysisSideID) {
		tab.onboarding = side;
		this.teamForm.openPacked(side, side === 'p1' ? tab.team1 : tab.team2, tab.format);
		this.forceUpdate();
	}

	/**
	 * Leaves onboarding and opens the analysis, via the brought-Pokémon step where the replay needs one.
	 *
	 * `discard` is Skip, which means "use the reconstruction as it came out of the replay". That includes
	 * undoing a side already committed with Save and Continue, not just the unsaved editor state — and it
	 * takes the roster-order default for the brought-Pokémon question rather than asking it.
	 */
	async finishOnboarding(tab: AnalysisTab, discard = false) {
		if (discard && tab.importedTeams) {
			tab.team1 = tab.importedTeams.p1;
			tab.team2 = tab.importedTeams.p2;
		}
		tab.onboarding = null;
		this.teamForm.close();
		if (!discard && tab.importPreview) {
			await this.openImportPreview(tab);
			return;
		}
		tab.importPreview = null;
		await this.rebuildImportedPosition(tab);
	}

	/**
	 * The imported replay's Team Preview step: which Pokémon each side brought.
	 *
	 * A replay can't tell a Pokémon that was brought but never sent out from one left behind (audit, Q7),
	 * so in a VGC-like the user settles it here. The battle is rebuilt at Team Preview — with the teams as
	 * onboarding left them, so the picker shows the sets the user just completed — and the ones the replay
	 * did show are locked in.
	 */
	async openImportPreview(tab: AnalysisTab) {
		tab.loading = true;
		this.forceUpdate();
		try {
			const data = await runAnalysis({
				format: tab.format, team1: tab.team1, team2: tab.team2, sandbox: true,
			});
			const requestState = this.applyBattleResponse(tab, data);
			tab.phase = requestState === 'teampreview' ? 'preview' : 'default';
			// A format that turns out not to pick a team at all leaves nothing to ask, so don't strand the
			// user on a step with no question: fall through to the analysis.
			if (tab.phase !== 'preview') {
				tab.importPreview = null;
				tab.loading = false;
				await this.rebuildImportedPosition(tab);
				return;
			}
			this.setAnalysisTeams(tab.requests);
			this.setChoiceBuilders(tab.requests, tab.gameType);
			// The locked picks are seeded from the render, not here: creating the battle calls
			// `setChoiceBuilders` again with fresh builders, which would drop anything seeded now.
			this.destroyBattle();
		} catch (error: any) {
			this.startError = error.message || 'Unable to open the Team Preview step.';
		} finally {
			tab.loading = false;
		}
		this.forceUpdate();
	}

	/** Locks the Pokémon the replay proved were brought into the step's builders, in roster order. */
	seedImportPreviewPicks(tab: AnalysisTab) {
		const locked = tab.importPreview;
		if (!locked) return;
		for (const side of ['p1', 'p2'] as const) {
			const builder = this.draft.builders[side];
			if (!builder) continue;
			for (const slot of locked[side]) {
				if (builder.isDone()) break;
				if (!builder.alreadySwitchingIn.includes(slot + 1)) builder.addChoice(`team ${slot + 1}`);
			}
		}
	}

	/** How many of a side's picks are locked, which is where the user's own choices start. */
	importPreviewLockedCount(tab: AnalysisTab, side: AnalysisSideID) {
		return tab.importPreview?.[side].length || 0;
	}

	/**
	 * Answers the brought-Pokémon step and opens the analysis.
	 *
	 * The picks replace the roster-order default the import wrote onto the turn-0 node, editing that node
	 * **in place**: `commitCurrentDraft` would fork it, and the whole replay line hangs off it. Nothing on
	 * the replay nodes needs revisiting, because their Pokémon are keyed by index into `side.team`, which
	 * keeps the full roster in its original order however the picks reorder `side.pokemon`.
	 */
	async confirmImportPreview(tab: AnalysisTab, p1Choice: string, p2Choice: string) {
		const setupNode = getSetupNode(tab);
		if (!setupNode || !p1Choice || !p2Choice || tab.loading) return;
		setupNode.inputLog = [`>p1 ${p1Choice}`, `>p2 ${p2Choice}`];
		tab.importPreview = null;
		tab.phase = 'default';
		await this.rebuildImportedPosition(tab);
	}

	/** Rebuilds the imported replay's current node from the tab's teams and the replay line. */
	async rebuildImportedPosition(tab: AnalysisTab) {
		tab.loading = true;
		this.forceUpdate();
		try {
			const data = await runAnalysis({
				format: tab.format, ...resolveTeamsFor(tab, tab.currentNodeId), seed: tab.rootSeed,
				replayNodes: replayNodesFor(tab, tab.currentNodeId, false),
			});
			this.applyBattleResponse(tab, data);
			// the first node the import opens on needs its replay choices too, and gets here rather than
			// through restoreAnalysisNode
			const node = tab.nodes[tab.currentNodeId];
			const undecided = node && this.fillReplayChoices(tab, node);
			this.pendingHydration = {
				tabId: tab.id, inputLog: [...(node?.inputLog || [])], clearedSlots: undecided,
			};
			this.destroyBattle();
		} catch (error: any) {
			this.startError = error.message || 'Unable to rebuild the position.';
		} finally {
			tab.loading = false;
		}
		this.forceUpdate();
	}

	/** Reads a chosen replay file up front, so a bad one is reported before Open is pressed. */
	async readReplayFile(input: HTMLInputElement) {
		const file = input.files?.[0];
		this.startError = '';
		this.replayFileLog = null;
		this.replayFileName = '';
		if (file) {
			try {
				this.replayFileLog = readReplayFileText(await file.text(), file.name);
				this.replayFileName = file.name;
			} catch (error: any) {
				this.startError = error.message || "Couldn't read that file.";
			}
		}
		this.forceUpdate();
	}

	/** Reads and validates a chosen analysis file up front, so a bad one is reported before Open is pressed. */
	async readAnalysisFile(input: HTMLInputElement) {
		const file = input.files?.[0];
		this.startError = '';
		this.analysisFile = null;
		this.analysisFileName = '';
		if (file) {
			try {
				this.analysisFile = parseAnalysisExport(await file.text());
				this.analysisFileName = file.name;
			} catch (error: any) {
				this.startError = error.message || "Couldn't read that file.";
			}
		}
		this.forceUpdate();
	}

	/**
	 * Import Analysis: rebuild a tab from an exported file (docs/analysis/plan.md, Phase 6).
	 *
	 * The file is a recipe, so there is no reconstruction to write here: the tab is built from what the file
	 * states and the position comes from `restoreAnalysisNode`, the same `/analysis/start` call that
	 * selecting a node already makes. That is why this returns a tab with no position on it — the caller
	 * adds it, then restores its current node.
	 */
	analysisTabFromFile(file: AnalysisExport): AnalysisTab {
		const tab = tabFromAnalysisExport(file, `analysis-${Date.now()}`);
		tab.staleWarning = stalenessWarning(file, this.serverCommit);
		return tab;
	}

	/**
	 * Import Replay: reconstruct both teams and one absolute position per turn, then open the replay as the
	 * main line. The user completes the inferred teams in stage D's onboarding; for now the inferences go
	 * straight in.
	 *
	 * A format the fork doesn't have is refused rather than substituted (audit, QA): `createAnalysisBattle`
	 * throws `Unknown format: <id>`, which the server already turns into a 400, so the refusal falls out of
	 * attempting the import.
	 */
	async startReplayAnalysis(): Promise<AnalysisTab> {
		const log = this.replayFileLog || (await fetchReplayLog(this.replayURL)).log;
		const parsed = parseAnalysisReplay(log);
		if (!parsed.turns.length) throw new Error('That replay has no turns to analyse.');
		const { team1, team2 } = packReplayTeams(parsed);
		if (!team1 || !team2) throw new Error("Couldn't reconstruct both teams from that replay.");

		const inputLog = [
			`>p1 team ${teamPreviewPicks(parsed, 'p1').join(', ')}`,
			`>p2 team ${teamPreviewPicks(parsed, 'p2').join(', ')}`,
		];
		// The tab is a sandbox: inferred sets have no EVs, guessed abilities and often fewer than four
		// moves, so they would fail the validator exactly as a Set Up Position placeholder does.
		/*
		 * Team Preview only. The turn-1 edits deliberately are **not** sent here: the server applies
		 * `replayNodes` before the top-level `inputLog`, so they would land on a battle still sitting at
		 * Team Preview — marking Pokémon active with positions outside `side.slotConditions`, which throws
		 * in `getSwitchRequestData`. The node line carries them in the right order instead, and
		 * `finishOnboarding` rebuilds through it once the teams are settled.
		 */
		const data = await runAnalysis({
			format: parsed.formatId, team1, team2, sandbox: true, inputLog,
		});
		const { nodes, nodeIds } = buildReplayNodes(parsed, inputLog, data.actionSeed || null);
		return {
			id: `analysis-${Date.now()}`,
			title: `${parsed.players.p1} vs. ${parsed.players.p2}`,
			// only when the replay named them: an export puts the trainers in its filename, and
			// "player1-player2" says nothing
			players: parsed.namedPlayers ? { ...parsed.players } : undefined,
			// a replay's format need not be one of FORMATS, so its own tier is the only pretty name we get
			formatName: parsed.formatName,
			format: parsed.formatId,
			log: data.log || [],
			snapshot: data.snapshot,
			editOptions: data.editOptions,
			gameType: data.gameType,
			team1,
			team2,
			sandbox: true,
			requests: data.requests,
			requestState: getRequestState(data.requestState, data.requests),
			phase: 'default',
			onboarding: 'p1',
			importedTeams: { p1: team1, p2: team2 },
			// Only set where the replay leaves the question open; onboarding's Proceed then goes through the
			// brought-Pokémon step instead of straight into the analysis.
			importPreview: replayPreviewStep(parsed),
			// Sandbox because the inferred sets would fail the validator, but not a Set Up Position tab:
			// there are no placeholders to click, so its intro line would be wrong here.
			sandboxIntroDone: true,
			importWarnings: parsed.warnings,
			// The real history, which the renderer plays in front of every reconstructed position on this
			// tab rather than opening each one on a fresh battle's leads (audit Q6).
			replayLog: log,
			nodes,
			currentNodeId: nodeIds[0],
			rootSeed: data.seed,
			simulationCount: 1000,
		};
	}

	/** New Analysis From Teams: two real teams, starting at Team Preview. */
	async startTeamsAnalysis(): Promise<AnalysisTab> {
		const data = await runAnalysis({ format: this.format, team1: this.team1, team2: this.team2 });
		const rootNodeId = `node-${Date.now()}-root`;
		const teamSelectionNodeId = `node-${Date.now()}-0`;
		const requestState = getRequestState(data.requestState, data.requests);
		return {
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
	}

	/**
	 * Set Up Position: start at turn 1 with a placeholder in every active slot, which the user then edits
	 * into the position they wanted with the Phase 2 and 3 tools (docs/analysis/plan.md, Phase 4).
	 *
	 * There is no new battle machinery here. The server builds a placeholder team the format's own rule
	 * table allows, the tab asks it not to validate it (`sandbox`), and Team Preview is answered in default
	 * order on the turn-0 node exactly as the normal flow would — that node is simply hidden, so the tree
	 * starts at Turn 1. Everything downstream (replay records, copy-on-edit, calcs) is unchanged.
	 */
	async startSetupAnalysis(): Promise<AnalysisTab> {
		const setup = await runAnalysisSetup(this.format);
		const picks = [];
		for (let i = 1; i <= setup.count; i++) picks.push(i);
		const inputLog = [`>p1 team ${picks.join(', ')}`, `>p2 team ${picks.join(', ')}`];
		const data = await runAnalysis({
			format: this.format, team1: setup.team1, team2: setup.team2, sandbox: true, inputLog,
		});
		const rootNodeId = `node-${Date.now()}-root`;
		const teamSelectionNodeId = `node-${Date.now()}-0`;
		const firstTurnNodeId = `node-${Date.now()}-1`;
		return {
			id: `analysis-${Date.now()}`,
			title: 'New position',
			format: this.format,
			log: data.log || [],
			snapshot: data.snapshot,
			editOptions: data.editOptions,
			gameType: data.gameType,
			team1: setup.team1,
			team2: setup.team2,
			sandbox: true,
			requests: data.requests,
			requestState: getRequestState(data.requestState, data.requests),
			phase: 'default',
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
					seed: data.actionSeed || null,
					turn: 0,
					inputLog,
				},
				[firstTurnNodeId]: {
					id: firstTurnNodeId,
					parentId: teamSelectionNodeId,
					seed: null,
					turn: 1,
					inputLog: [],
				},
			},
			currentNodeId: firstTurnNodeId,
			rootSeed: data.seed,
			simulationCount: 1000,
		};
	}

	renderHome() {
		return <div class="analysis-home">
			<h1>Battle Analysis</h1>
			<p>Build branches from a battle position, inspect choices, and compare possible next turns.</p>
			<div class="analysis-options">
				<button class="button analysis-option" onClick={() => this.openMode('setup')}>
					<strong>Set Up Position</strong><small>Choose a format and begin from a manual position.</small>
				</button>
				<button class="button analysis-option" onClick={() => this.openMode('analysis')}>
					<strong>Import Analysis</strong><small>Open an analysis file you exported earlier.</small>
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
		if (this.mode === 'analysis') {
			// The file is validated as it is read, so what it says here is already true of it.
			const stale = this.analysisFile ? stalenessWarning(this.analysisFile, this.serverCommit) : '';
			return <form class="analysis-form" onSubmit={onSubmit}>
				<h2>Import Analysis</h2>
				<p>Opens an analysis exported with <strong>Export Analysis</strong>, at the turn it was saved on.</p>
				<label>Analysis file<input
					type="file" accept=".json,application/json"
					onChange={event => void this.readAnalysisFile(event.target as HTMLInputElement)}
				/></label>
				{this.analysisFile && <p class="analysis-field-note">
					Loaded <strong>{this.analysisFileName}</strong>{' '}
					({Object.keys(this.analysisFile.tab.nodes).length} nodes
					{this.analysisFile.source ? ', with its replay' : ''}).
				</p>}
				{/* Said here as well as on the tab, so it can be weighed before the analysis is even opened. */}
				{stale && <p class="message-error">{stale}</p>}
				{this.startError && <p class="message-error">{this.startError}</p>}
				<button class="button" type="submit" disabled={this.starting || !this.analysisFile}>
					{this.starting ? 'Opening…' : 'Open Analysis'}
				</button>
				<button class="button" type="button" onClick={this.openHome}>Cancel</button>
			</form>;
		}
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
				<label>Replay HTML file<input
					type="file" accept=".html,.log,.json"
					onChange={event => void this.readReplayFile(event.target as HTMLInputElement)}
				/></label>
				{/* reading the file is async, so say when it's ready rather than failing on an early click */}
				{this.replayFileLog && <p class="analysis-field-note">
					Loaded <strong>{this.replayFileName}</strong> ({this.replayFileLog.length} lines).
				</p>}
				{this.startError && <p class="message-error">{this.startError}</p>}
				<button class="button" type="submit" disabled={this.starting}>
					{this.starting ? 'Reading replay…' : 'Open Replay Analysis'}
				</button>
				<button class="button" type="button" onClick={this.openHome}>Cancel</button>
			</form>;
		}
		return <form class="analysis-form" onSubmit={onSubmit}>
			<h2>{this.mode === 'teams' ? 'New Analysis From Teams' : 'Set Up Position'}</h2>
			{this.mode === 'setup' && <p>
				Starts at Turn 1 with a placeholder Pokémon on each side of the field. Click one to build it,
				and the trainer sprite to build the rest of that team.
			</p>}
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
			>{this.starting ? 'Starting...' : (this.mode === 'setup' ? 'Set Up Position' : 'Start Analysis')}</button>
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
			return <div class="switchcontrols analysis-info-group analysis-switch-group">
				<h3 class="switchselect analysis-field-side-title">
					Team {side === 'p1' ? 1 : 2} Choose replacement
				</h3>
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
				<p class="analysis-switch-count">{builder.alreadySwitchingIn.length}/{pending} Chosen</p>
			</div>;
		};
		const ready = (['p1', 'p2'] as const).every(side =>
			!tab.requests?.[sideIndex(side)]?.forceSwitch || !!this.draft.builders[side]?.isDone());
		const hasChoices = (['p1', 'p2'] as const).some(side => !this.draft.builders[side]?.isEmpty());
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			<div>
				<button
					class="button" disabled={!hasChoices}
					onClick={() => {
						this.setChoiceBuilders(tab.requests, tab.gameType);
						this.forceUpdate();
					}}
				>Back</button>{' '}
				<button
					class="button" disabled={!ready}
					onClick={() => {
						if (!ready) return;
						if (onSubmit) {
							onSubmit(tab);
						} else {
							void this.submitChoices(
								tab, this.draft.builders.p1?.toString() || 'default',
								this.draft.builders.p2?.toString() || 'default'
							);
						}
					}}
				>Submit replacements</button>
			</div>
			{renderSide('p1')}{renderSide('p2')}
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
		// An imported replay's brought-Pokémon step: the Pokémon the replay showed are already in the
		// builders and can't be taken out. Seeded here rather than when the step opens, because creating
		// the battle rebuilds the builders from the requests and would drop them.
		const importStep = !!tab.importPreview;
		if (importStep) this.seedImportPreviewPicks(tab);
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
			const lockedCount = importStep ? this.importPreviewLockedCount(tab, side) : 0;
			return <div class="switchcontrols analysis-info-group analysis-switch-group">
				<h3 class="switchselect analysis-field-side-title">
					Team {side === 'p1' ? 1 : 2} Choose Pokémon
				</h3>
				<div class="switchmenu">{request.side.pokemon.map((pokemon: any, index: number) => {
					const selected = builder.alreadySwitchingIn.includes(index + 1);
					// A locked Pokémon is one the replay showed on the field, so it was certainly brought.
					const locked = importStep && !!tab.importPreview?.[side].includes(index);
					const name = pokemon.name || pokemon.details || `Pokemon ${index + 1}`;
					return <button
						data-cmd={`/switch ${index + 1}`} class={`has-tooltip${selected ? ' disabled' : ''}`}
						style={selected ? 'opacity:.5' : ''} data-tooltip={`analysispokemon|${sideIndex(side)}|${index}`}
						aria-disabled={selected} aria-pressed={selected}
						title={locked ? 'The replay shows this Pokémon was brought.' : undefined}
						onMouseUp={() => this.selectPreviewPokemon(side, index)}
					><PSIcon pokemon={pokemonLabel(pokemon)} />{name}{locked ? ' (seen)' : ''}</button>;
				})}</div>
				<p class="analysis-switch-count">
					{builder.alreadySwitchingIn.length}/{builder.requestLength()} Chosen
					{lockedCount ? ` (${lockedCount} seen in the replay)` : ''}
				</p>
			</div>;
		};
		const { p1, p2 } = this.draft.builders;
		const ready = !!p1?.isDone() && !!p2?.isDone();
		const lockedTotal = importStep ?
			this.importPreviewLockedCount(tab, 'p1') + this.importPreviewLockedCount(tab, 'p2') : 0;
		const chosen = (p1?.alreadySwitchingIn.length || 0) + (p2?.alreadySwitchingIn.length || 0);
		// Back only clears what the user chose; the locked picks come straight back on the next render.
		const hasChoices = importStep ? chosen > lockedTotal : chosen > 0;
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			{importStep ? <p class="analysis-field-note">
				A replay can't show which Pokémon were brought but never sent out. The ones it did show are
				locked in; choose the rest.
			</p> : null}
			<div>
				<button
					class="button" disabled={!hasChoices}
					onClick={() => {
						this.setChoiceBuilders(tab.requests, tab.gameType);
						if (!importStep) this.saveLeafDraft(tab);
						this.forceUpdate();
					}}
				>Back</button>{' '}
				<button
					class="button" disabled={!ready}
					onClick={() => {
						if (!ready) return;
						if (importStep) void this.confirmImportPreview(tab, p1!.toString(), p2!.toString());
						else void this.submitChoices(tab, p1!.toString(), p2!.toString());
					}}
				>{importStep ? 'Start Analysis' : 'Send out Pokémon'}</button>
			</div>
			{renderSide('p1')}{renderSide('p2')}
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
			{/* browsing the outcomes, with the same icons the replay controls use for the same actions */}
			<div>
				<button
					class="button button-first" disabled={selectedIndex <= 0}
					onClick={() => this.showSimulation(tab, selectedIndex - 1, roll, 'reveal')}
				><i class="fa fa-step-backward" aria-hidden></i><br />Prev</button>
				<button
					class="button button-last" disabled={selectedIndex >= groupCount - 1}
					onClick={() => this.showSimulation(tab, selectedIndex + 1, roll, 'reveal')}
				><i class="fa fa-step-forward" aria-hidden></i><br />Next</button>{' '}
				<button class="button" onClick={() => this.replaySimulationTurn(tab)}>
					<i class="fa fa-repeat" aria-hidden></i><br />Replay Turn
				</button>
			</div>
			<fieldset class="analysis-radio-group"><legend>Damage Rolls</legend>
				{rollOption('min', 'Min')}
				{rollOption('median', 'Median')}
				{rollOption('max', 'Max')}
			</fieldset>
			{/* the two that leave this screen sit below the rolls, away from the browsing controls */}
			<div>
				<button class="button" onClick={() => this.cancelSimulation(tab)}>Cancel</button>{' '}
				<button
					class="button" disabled={tab.loading}
					onClick={() => void this.selectSimulationOutcome(tab)}
				>Select Outcome</button>
			</div>
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
				<button class="button" onClick={() => this.skipOneTurn(tab)}>
					<i class="fa fa-step-forward" aria-hidden></i><br />Skip Turn
				</button>
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
		/*
		 * A Set Up Position tab opens on nothing but placeholders, so until the teambuilder has been opened
		 * once the controls are just the line that says how to start. Showing the turn controls there would
		 * invite you to play a turn between two Pokémon that don't exist yet.
		 */
		if (tab.sandbox && !tab.sandboxIntroDone) {
			return <div class="analysis-choice-controls">
				<p>Click on a placeholder Pokémon to replace it, or click on a trainer to open the teambuilder.</p>
			</div>;
		}
		/*
		 * `choiceSide` can be null here: rebuilding the battle after a save calls setChoiceBuilders, which
		 * resets the draft, and a selection started just before that lands with the phase already set.
		 * Rendering a move menu for no Pokémon leaves an empty controls box with no way out, so fall
		 * through to the normal controls instead.
		 */
		if (tab.phase === 'selection' && this.draft.choiceSide) {
			const { choiceSide } = this.draft;
			const side = choiceSide?.side;
			const slot = choiceSide?.index ?? 0;
			const sidePokemon = side ? tab.requests?.[sideIndex(side)]?.side?.pokemon || [] : [];
			const pokemon = sidePokemon.filter((entry: any) => entry.active)[slot];
			const name = (pokemon?.name || pokemon?.details || `Pokemon ${slot + 1}`).split(',')[0];
			const teamIndex = side ? this.activeTeamIndex(tab, side, slot) : null;
			return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
				<div class="analysis-selection-heading">
					<button
						class="button"
						onClick={() => this.draft.pendingTarget ? this.cancelIntermediateSelection(tab) : this.cancelActionSelection(tab)}
					>Cancel</button>
					{choiceSide && <span>What will <strong>{name}</strong> ({side === 'p1' ? 1 : 2}) do?</span>}
					{side && teamIndex !== null && <button
						class="button analysis-selection-edit"
						onClick={() => this.openPokemonEditorAt(tab, side, teamIndex)}
					>Edit Pokémon</button>}
				</div>
				{requestState === 'switch' ? this.renderSwitchChoices(tab) : this.renderMoveChoices(tab)}
			</div>;
		}
		const currentNode = tab.nodes[tab.currentNodeId];
		// a setup tab's turn-1 node is where its battle begins: its parent is the hidden Team Preview node,
		// and there is no earlier turn to replay or step back to
		const atStart = !currentNode?.parentId || (!!tab.sandbox && (currentNode.turn ?? 0) <= 1);
		const nextNode = Object.values(tab.nodes).find(node => node.parentId === tab.currentNodeId);
		const ready = this.draft.actionChoicesReady(tab.requests, 'p1') && this.draft.actionChoicesReady(tab.requests, 'p2');
		/*
		 * An imported analysis saved under a different server build. It stays until dismissed rather than
		 * being shown only at import: a seed replays the same way only under the same sim code, so the
		 * caveat belongs with the positions it applies to, not with the moment the file was opened.
		 */
		const staleNote = currentNode && tab.staleWarning ? <p class="message-error">
			{tab.staleWarning}{' '}
			<button
				class="button" onClick={() => {
					tab.staleWarning = '';
					this.forceUpdate();
				}}
			>Dismiss</button>
		</p> : null;
		// icons above the labels, reusing the replay controls' so the same action reads the same way
		const turnControls = <div>
			<span
				class="analysis-grouping-help analysis-controls-help" data-help={DEFAULT_CONTROLS_HELP}
				aria-label="What you can click in the battle"
			><i class="fa fa-hand-pointer-o" aria-hidden="true" /> Controls</span>
			<button class="button" disabled={atStart} onClick={() => this.openReplayFromStart(tab)}>
				<i class="fa fa-fast-backward" aria-hidden></i><br />Replay from Start
			</button>{' '}
			<button class="button" disabled={atStart} onClick={() => this.replayPreviousTurn(tab)}>
				<i class="fa fa-repeat" aria-hidden></i><br />Replay Prev Turn
			</button>{' '}
			<button class="button button-first" disabled={atStart} onClick={() => this.previousNode(tab)}>
				<i class="fa fa-step-backward" aria-hidden></i><br />Prev Turn
			</button>
			<button
				class="button button-last" disabled={!nextNode}
				onClick={() => nextNode && this.selectAnalysisNode(tab, nextNode.id)}
			><i class="fa fa-step-forward" aria-hidden></i><br />Next Turn</button>{' '}
			{/* Export sits after the turn controls rather than with Submit/Simulate: it acts on the whole
				analysis, not on this turn. The end-of-game node renders `turnControls` too, so an imported
				replay can be exported from its last node as well. */}
			<button class="button" onClick={() => downloadAnalysisExport(tab, this.serverCommit)}>
				<i class="fa fa-download" aria-hidden></i><br />Export Analysis
			</button>
		</div>;
		/*
		 * The imported replay's final position: the battle is over, so there is no action to choose, nothing
		 * to simulate and nothing worth editing — only the turn controls, to walk back through the game
		 * (user request, 2026-09-19). Next Turn greys itself out, since the end node has no child.
		 */
		if (currentNode?.gameOver) {
			return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
				{staleNote}
				{turnControls}
				<p class="analysis-field-note">
					{currentNode.gameOver.winner ?
						`${currentNode.gameOver.winner} won the battle.` :
						'The battle ended in a tie.'}{' '}
					Go back to an earlier turn to analyse it.
				</p>
			</div>;
		}
		return <div class="analysis-choice-controls" ref={this.setChoiceControlsFrame}>
			{staleNote}
			{turnControls}
			{/* boxed like the field editor's Side groups, so it reads as a panel rather than loose rows */}
			<div class="analysis-info-group analysis-action-summary">
				<span class="analysis-field-side-title">Action Summary</span>
				<AnalysisChoiceSummaryView
					choices={this.getMoveChoiceSummary(tab)} gameType={tab.gameType} tooltips
					onSelect={this.selectMovePokemon}
				/>
			</div>
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
				{/* the panel's own small-caps label and narrow number input, rather than a full-width textbox */}
				<label class="analysis-sim-count">
					<span class="analysis-field-side-title">Simulations</span>
					<input
						class="textbox analysis-number-input" type="number" min="1" step="1"
						value={tab.simulationCount}
						onInput={event => {
							tab.simulationCount = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
							this.forceUpdate();
						}}
					/>
				</label>
			</div>
			{/* `gameOver` is checked above too; the sim never declares a winner here, so requestState is
				still 'move' and this would otherwise offer an edit form for a finished battle */}
			{requestState === 'move' && !currentNode?.gameOver && (currentNode?.turn ?? 0) >= 1 &&
				tab.snapshot && tab.editOptions &&
				(this.editPokemon ?
					<AnalysisPokemonEditor
						state={this.pokemonForm} snapshot={tab.snapshot} target={this.editPokemon}
						disabled={!!tab.loading} error={this.editError}
						onClose={() => { this.editPokemon = null; this.editError = ''; this.forceUpdate(); }}
						onSave={changes => void this.saveEdits(tab, changes)}
					/> :
					<AnalysisFieldEditor
						state={this.fieldForm} snapshot={tab.snapshot} options={tab.editOptions.field}
						showMore={this.showMoreFieldEffects} disabled={!!tab.loading} error={this.editError}
						onToggleShowMore={() => { this.showMoreFieldEffects = !this.showMoreFieldEffects; this.forceUpdate(); }}
						onSave={(changes, sides) => void this.saveEdits(tab, { field: changes, sides })}
					/>)}
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
		/**
		 * The teambuilder takes over the battle window and its controls, but not the battle log, so it gets
		 * the same width as the teambuilder in the normal client. The battle stays mounted and merely
		 * hidden: destroying it would blank the log beside it, and this way Cancel needs no rebuild.
		 */
		const teamSide = this.teamForm.side;
		const teamStyle = `position:absolute;top:0;left:0;width:${battleWidth}px;bottom:0;`;
		return [
			<div class="ps-room ps-room-opaque" style={roomStyle}>
				<div class="analysis-battle-stage" style="height:100%;">
					<div
						class="battle" ref={setBattleFrame} hidden={!!teamSide}
						style={`position:absolute;top:0;left:0;width:${battleWidth}px;height:${battleHeight}px`}
					/>
					{!teamSide && (requestState === 'move' || requestState === 'switch') &&
						<div class="battle-controls" style={controlsStyle} role="complementary" aria-label="Battle Controls">
							<div class="pad">{this.renderBattleControls(tab, requestState)}</div>
						</div>}
					{!teamSide && (requestState === 'teampreview' || tab.requests?.[0]?.teamPreview) &&
						<div class="battle-controls" style={controlsStyle} role="complementary" aria-label="Battle Controls">
							<div class="pad">{this.renderTeamPreviewChoices(tab)}</div>
						</div>}
					{teamSide && <div class="analysis-teambuilder-frame" style={teamStyle}>
						<AnalysisTeambuilder
							state={this.teamForm} side={teamSide} disabled={!!tab.loading} error={this.editError}
							problems={this.editProblems} validated={tab.phase === 'preview'}
							onSave={edit => void this.saveTeamEdits(tab, edit)} onCancel={this.closeTeambuilder}
							onboarding={tab.onboarding ? {
								warnings: tab.importWarnings,
								onSwitchSide: side => void this.saveOnboardingTeam(tab, side),
								onProceed: () => void this.saveOnboardingTeam(tab, null),
								onSkip: () => void this.finishOnboarding(tab, true),
							} : undefined}
						/>
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
							// An import isn't a line to browse until it has been through onboarding and the
							// brought-Pokémon step: leaving either half-done strands the tab in that mode.
							locked={!!tab.onboarding || !!tab.importPreview}
						/>}
					{this.debugMode && <>
						<h2>{tab.simulationGroups ? 'Selected Simulation Result' : 'Selected Node Data'}</h2>
						<pre class="analysis-debug-log">{JSON.stringify(selectedData, null, 2)}</pre>
						<h2>Dropped Edits</h2>
						<pre class="analysis-debug-log">{tab.droppedEdits?.length ?
							tab.droppedEdits.join('\n') : 'None'}</pre>
					</>}
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
			settingsOpen={this.settingsOpen} debugMode={this.debugMode}
			onToggleSettings={() => { this.settingsOpen = !this.settingsOpen; this.forceUpdate(); }}
			onCloseSettings={() => { this.settingsOpen = false; this.forceUpdate(); }}
			onChangeDebugMode={on => {
				this.debugMode = on;
				saveDebugMode(on);
				this.forceUpdate();
			}}
		/>;
		const rooms = activeTab ? this.renderAnalysis(activeTab) : [<div class="analysis-panel">{this.renderHome()}</div>];
		return preact.h(preact.Fragment, null, header, ...rooms) as any;
	}
}

preact.render(<AnalysisApp />, document.getElementById('main')!);
