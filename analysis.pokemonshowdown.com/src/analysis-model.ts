import type { Dex } from '../../play.pokemonshowdown.com/src/battle-dex';

export type StartMode = 'setup' | 'teams' | 'replay' | 'analysis';

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
	/** per-side state that isn't a side condition; side conditions live under `field.sides` */
	sides?: { p1?: AnalysisSideStateEdit, p2?: AnalysisSideStateEdit };
	field?: AnalysisFieldStateEdit;
}

export interface AnalysisPokemonStateEdit {
	hp?: number;
	/**
	 * HP as a percentage, resolved against the Pokémon's live max HP when the edit applies. A replay only
	 * ever shows percentages and never reveals the EVs and IVs max HP depends on, so an imported position
	 * stores this and stays correct however the user later edits the team. `hp` wins if both are given.
	 */
	hpPercent?: number;
	/**
	 * Current item and ability, as opposed to the set's: a Pokémon that ate its berry still holds it on its
	 * team, and Trace or a Mega Evolution changes the ability without changing the set. `''` removes.
	 */
	item?: string;
	ability?: string;
	/**
	 * PP by move id, not by slot: a slot's move can change, and an edit naming a move that is no longer
	 * there is simply irrelevant rather than something to invalidate.
	 */
	pp?: { [moveid: string]: number };
	/**
	 * PP **spent**, subtracted from the move's real max PP by the server — the same trick as `hpPercent`.
	 * A replay says how many times a move was used, never how many uses it had; only the sim knows that,
	 * since a mod may replace the formula outright (Champions does). `pp` wins where both name a move.
	 */
	ppUsed?: { [moveid: string]: number };
	status?: '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';
	toxicStage?: number;
	sleepTurns?: number;
	/** current types, which moves like Soak and Reflect Type change mid-battle */
	types?: string[];
	terastallized?: boolean;
	megaEvolved?: boolean;
	boosts?: AnalysisBoostsTable;
	volatiles?: { [id: string]: null | { [param: string]: number | string | boolean } };
	/**
	 * History the protocol can't express. A reconstructed position is a fresh battle at turn 1, so without
	 * these every Pokémon looks like it just switched in and Fake Out succeeds from one that has been out
	 * all game. See docs/analysis/replay-import-audit.md.
	 */
	activeTurns?: number;
	activeMoveActions?: number;
	/** hits taken, for Rage Fist; unlike the others this survives switching out */
	timesAttacked?: number;
	/** move id, for Encore, Disable, Torment and the Gigaton Hammer lockout */
	lastMove?: string;
	/** consecutive successful Protect-likes; the server converts to the sim's 3, 9, 27… counter */
	stallCount?: number;
}

/** Per-side state that isn't a side condition. Mirrors AnalysisSideStateEdit in tools/analysis-state.ts. */
export interface AnalysisSideStateEdit {
	/** Pokémon fainted on this side, for Last Respects and Supreme Overlord */
	totalFainted?: number;
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

/**
 * What one active slot did on a turn, as the replay shows it — a Pokémon and a move or a switch, rather
 * than the move *slot* and roster position a choice is written in.
 *
 * It has to stay in this form until the position it belongs to has been rebuilt: `move 2` means whatever
 * sits in slot 2 of the finished team, which onboarding and later set edits can change. `replayInputLog`
 * resolves it against the real request, once there is one.
 */
export interface AnalysisReplayAction {
	side: AnalysisSideID;
	slot: number;
	/** the species in that slot when the turn began */
	pokemon: string;
	moveId?: string;
	moveName?: string;
	/** the species that came in, when the slot's action was a switch */
	switchTo?: string;
	/** the position the move named (`p2a`), which a doubles target is resolved from */
	targetPosition?: string;
	targetPokemon?: string;
	terastallize?: boolean;
	mega?: boolean;
}

export interface AnalysisNode {
	id: string;
	parentId: string | null;
	seed: string | null;
	turn: number;
	inputLog: string[];
	/**
	 * A node imported from a replay. Its `edits` describe the **whole** position absolutely, so it is
	 * rebuilt from itself rather than by replaying its ancestors, and its `inputLog` holds the choices
	 * inferred from the replay for display only — they are never executed. Simulated children replay from
	 * it normally. See docs/analysis/replay-import-audit.md.
	 */
	kind?: 'replay';
	/**
	 * The **reconstruction**: the absolute position the replay showed at this turn, as the parser read it.
	 * It is deliberately separate from `edits`, which stays what the *user* has changed here, because the
	 * two are shown quite differently — the reconstruction is how the position came to exist and is applied
	 * invisibly (see `getRenderedLog`), while a user's edit is a thing that happens at the start of this
	 * turn and should be seen happening. Never modified after import.
	 */
	importedEdits?: AnalysisEdits;
	/**
	 * What the replay shows each side doing on this turn, kept in terms of Pokémon and moves rather than
	 * the slot numbers a choice is written in. It becomes this node's `inputLog` the first time the
	 * position behind it is built (`replayInputLog`), because `move 2` means whatever sits in slot 2 of the
	 * team the user finished, which onboarding and later set edits can both change.
	 */
	replayActions?: AnalysisReplayAction[];
	/**
	 * The imported replay's final position, after the last turn resolved — there is nothing left to choose
	 * here, so the controls are only the turn navigation. `winner` is empty for a tie. It shares a turn
	 * number with the turn that decided the game, which is why it has an id of its own.
	 */
	gameOver?: { winner: string };
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
	/** hits taken, which Rage Fist reads */
	timesAttacked: number;
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
	/** Pokémon fainted on this side, which Last Respects and Supreme Overlord read */
	totalFainted: number;
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
	 * An imported replay's onboarding pass: which side's reconstructed team the user is completing before
	 * the analysis opens. `null` once they have finished or skipped. See docs/analysis/replay-import-audit.md.
	 */
	onboarding?: AnalysisSideID | null;
	/** what the replay could not determine, shown above the reconstructed team during onboarding */
	importWarnings?: string[];
	/**
	 * An imported VGC-style replay's Team Preview step: the roster slots (0-based) the replay proved each
	 * side brought, which are locked in while the user picks the rest. Set on import when the question needs
	 * asking at all (`replayPreviewStep`), cleared once it has been answered or skipped.
	 */
	importPreview?: { p1: number[], p2: number[] } | null;
	/**
	 * The teams exactly as the replay was reconstructed into them, kept so **Skip** can go back to them:
	 * Skip means "use the inferences", so it also undoes a side already committed with Save and Continue.
	 */
	importedTeams?: { p1: string, p2: string };
	/**
	 * The imported replay's own log, kept so the renderer can play the real history in front of a
	 * reconstructed position instead of a fresh battle's opening (see `getRenderedLog`). It is the replay
	 * exactly as it was fetched or read from the file, and is never sent anywhere.
	 */
	replayLog?: string[];
	/**
	 * The two trainers, when the imported replay named them both. Only an export reads them, to put the
	 * trainers in its filename (see analysis-export.ts); the tab title is built once at import.
	 */
	players?: { p1: string, p2: string };
	/**
	 * The imported replay's own tier, as its display name ("[Gen 9] OU"). Kept because a replay's format
	 * need not be one of `FORMATS` — that list is the four the pickers offer — so an export has nowhere
	 * else to read a pretty name for its filename. Unset on a tab started from the pickers, where a
	 * `FORMATS` lookup answers.
	 */
	formatName?: string;
	/**
	 * Set on an imported analysis whose file was saved under a different server build. Shown once above the
	 * turn controls and dismissible, rather than only at the moment of import: a file opened weeks later
	 * should still say where it came from. See `stalenessWarning`.
	 */
	staleWarning?: string;
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
 * Upstream `battle.resetRNG` announces itself, and the determinism model reseeds at the start of every node
 * (see replayAnalysisRecords), so this lands in the log once per node and says nothing about the battle.
 * `sim/battle.ts` is an upstream file, so it is dropped here rather than suppressed at the source.
 */
export const RNG_RESET_LINE = "|message|The battle's RNG was reset.";

export function stripAnalysisNoise(log: string[]) {
	return log.filter(line => line !== RNG_RESET_LINE);
}

/**
 * Room chatter a replay carries around the battle itself. None of it is state, and joins and leaves in
 * particular are pure noise in an analysis log. Chat (`c`) is deliberately **kept**: it is what the players
 * actually said, and hiding parts of an imported replay is not this tool's habit.
 */
const REPLAY_ROOM_COMMANDS = ['j', 'J', 'join', 'l', 'L', 'leave', 'n', 'N', 'name', 'inactive', 'inactiveoff',
	'askreg', 'debug'];

function isReplayRoomLine(line: string) {
	return REPLAY_ROOM_COMMANDS.includes(line.split('|')[1]);
}

/** `|turn|3` → `|turn|8` for an offset of 5. Every other line passes through untouched. */
export function renumberAnalysisTurns(log: string[], offset: number) {
	if (!offset) return log;
	return log.map(line => (line.startsWith('|turn|') ? `|turn|${Number(line.split('|')[2]) + offset}` : line));
}

/**
 * Marks a line from the reconstruction's edit block as a **resync**: a statement of how the position
 * already stands, rather than a report of something that just happened. `AnalysisBattleRenderer` acts on
 * the distinction, skipping whatever the replay's own history has already established.
 *
 * The edit layer writes its lines as a delta against the position the sim happened to start from, which for
 * a reconstruction is a fresh battle's Team Preview leads. Spliced in front of the replay's own history that
 * assumption is simply false, and `switch`/`swap` resolve **positionally** in the renderer — so an untouched
 * `|swap|p1b: Sinistcha|0` moved whoever the replay had left in `p1b`, and the `|switch|` after it put a
 * second copy of that Pokémon on the field (measured: Ceruledge in both of p1's slots).
 */
function markAnalysisResync(line: string) {
	return `${line}|[analysisresync]`;
}

/**
 * Brackets a block the renderer applies but never shows (`AnalysisBattleRenderer`). Marking the lines alone
 * isn't enough: `-sethp` animates a heal or a hit whatever its keywords say, and the exact HP a
 * reconstruction sets never quite matches the percentage a replay showed, so the whole block is muted.
 */
export const ANALYSIS_RESYNC_START = '|-message|analysisresync|start|[silent]';
export const ANALYSIS_RESYNC_END = '|-message|analysisresync|end|[silent]';

/**
 * The replay history to play in front of a reconstructed position, for a tab imported from a replay.
 *
 * `anchor` is the deepest replay node on the path (`getReplayAnchor`): the turn the position was rebuilt
 * from, and therefore the turn the real history has to run up to. The history stops **just before** that
 * turn's `|turn|` line, so the reconstruction's edit block can sit where a node's edits belong — at the
 * start of its own turn, before it is announced.
 *
 * The end-of-game node is the one exception: it has no `|turn|` line of its own (it shares a turn number
 * with the turn that decided the game), so its history is the whole replay, result included.
 */
function getReplaySplice(tab: AnalysisTab, anchor: AnalysisNode | null | undefined) {
	if (!anchor || !tab.replayLog?.length) return null;
	// The end-of-game node shares its turn number with the turn that decided the game, so it has no `|turn|`
	// line of its own to stop in front of: its history is the whole replay, result included.
	if (anchor.gameOver) {
		return {
			history: tab.replayLog.filter(line => !isReplayRoomLine(line)),
			turnLine: [],
			turnOffset: anchor.turn - 1,
		};
	}
	const marker = `|turn|${anchor.turn}`;
	const index = tab.replayLog.indexOf(marker);
	// A turn the replay never announced has no history to show; fall back to the reconstruction's own log.
	if (index < 0) return null;
	return {
		history: tab.replayLog.slice(0, index).filter(line => !isReplayRoomLine(line)),
		turnLine: [marker],
		// the reconstruction's `|turn|1` *is* this turn, so its later turns count on from here
		turnOffset: anchor.turn - 1,
	};
}

/**
 * The log the renderer should play, which for a sandbox tab is not quite the log the server sent.
 *
 * **Set Up Position.** A setup tab's turn-1 edits *are* the position: watching them apply — a roster resync,
 * HP jumping, a Bulbasaur turning into a Garchomp — is setup noise, not battle history. The sim emits them
 * straight after `|turn|1`, because a node's edits apply at the start of its turn, so anything that starts
 * playing at turn 1 (Submit Choices, Simulate, Replay Prev Turn from turn 2) animates them first. Hoisting
 * that block above `|turn|1` makes it part of the battle's silent setup instead, and leaves `|turn|1` marking
 * the real start of play. Only turn 1 is hoisted; later turns' edits are ordinary history.
 *
 * **Import Replay** (audit Q6) does the same thing one step further: the block is hoisted above a `|turn|`
 * line taken from the **replay's own log**, with everything the replay did before that turn in front of it.
 * So a reconstruction stops opening on a fresh battle's Team Preview leads — entry abilities and all, an
 * "Incineroar's Intimidate!" on turn 1 of a position where that never happened — and replaying from the
 * start reads as one continuous replay that happens to diverge wherever the user took over.
 *
 * Nothing else has to change for either, because **every seek is by turn number**: the reconstruction's own
 * turns are renumbered onto the replay's, so `seekTurn(N)` lands on the built position and `seekTurn(N - 1)`
 * on the last thing that really happened before it.
 *
 * **The two kinds of edit part company here** (user request, 2026-09-19). A replay node sends the
 * reconstruction and the user's own edits as two records (`replayNodesFor`), so the sim emits two blocks.
 * The reconstruction is *how this position came to exist* — against the replay's history it restates what
 * already happened, so it is bracketed as a resync and applied without a word or an animation. A user's
 * edit is *a thing that happens at the start of this turn*, so it stays where the sim put it, after the
 * `|turn|` line, and is seen happening exactly as on any other node.
 */
export function getRenderedLog(tab: AnalysisTab, anchor?: AnalysisNode | null) {
	const log = stripAnalysisNoise(tab.log);
	if (!tab.sandbox) return log;
	const splice = getReplaySplice(tab, anchor);
	const turnIndex = log.findIndex(line => line === '|turn|1');
	if (turnIndex < 0) return log;
	// an edit block runs to its `Analysis edits:` summary, the last line the edit layer emits for a record
	const blockEnds: number[] = [];
	for (let i = turnIndex + 1; i < log.length; i++) {
		if (log[i].startsWith('|turn|')) break;
		if (log[i].startsWith('|-message|Analysis edits:')) blockEnds.push(i);
	}
	const end = blockEnds.length ? blockEnds[blockEnds.length - 1] : -1;
	// A node with no edits has no block to hoist, and a setup tab's log is then already in the right order.
	if (end < 0 && !splice) return log;
	if (!splice) {
		return [
			...log.slice(0, turnIndex), ...log.slice(turnIndex + 1, end + 1), log[turnIndex],
			...log.slice(end + 1),
		];
	}
	// The first block is the reconstruction; anything after it belongs to the user and stays visible.
	const resyncEnd = blockEnds.length ? blockEnds[0] : turnIndex;
	const resync = log.slice(turnIndex + 1, resyncEnd).map(markAnalysisResync);
	const userEdits = log.slice(resyncEnd + 1, end + 1);
	const tail = log.slice((end < 0 ? turnIndex : end) + 1);
	/*
	 * The summary line is dropped — it describes how the position was reconstructed, not anything that
	 * happens on this turn — but turns remaining ride on it as a keyword and the protocol can say them
	 * nowhere else, so they move onto the closing bracket rather than being lost with it.
	 */
	const durations = blockEnds.length ?
		/\|\[analysisdurations\][^|]*/.exec(log[resyncEnd])?.[0] || '' : '';
	return [
		...splice.history,
		...(resync.length ? [ANALYSIS_RESYNC_START, ...resync, ANALYSIS_RESYNC_END + durations] : []),
		...splice.turnLine,
		...userEdits,
		...renumberAnalysisTurns(tail, splice.turnOffset),
	];
}

/**
 * The same treatment for lines appended to a live renderer rather than rebuilt into a new one
 * (`continuePlayback`), which is the one path that adds to a battle instead of replacing it.
 */
export function getRenderedLogTail(tab: AnalysisTab, anchor: AnalysisNode | null | undefined, lines: string[]) {
	const splice = getReplaySplice(tab, anchor);
	return renumberAnalysisTurns(stripAnalysisNoise(lines), splice?.turnOffset || 0);
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
	{ id: 'imprison', name: 'Imprison' },
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
	/*
	 * The boosted stat isn't offered: the sim picks it with `getBestStat`, which is already the answer for
	 * this Pokémon's stats, and the `-start` line it emits carries the stat so the sprite reads
	 * "Protosynthesis: Atk". Outside sun / Electric Terrain the server attributes these to a Booster
	 * Energy, because the ability would otherwise take the volatile straight back (see `needsBooster`).
	 */
	{ id: 'protosynthesis', name: 'Protosynthesis', minGen: 9 },
	{ id: 'quarkdrive', name: 'Quark Drive', minGen: 9 },
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
	{ id: 'taunt', name: 'Taunt' },
	{ id: 'yawn', name: 'Yawn' },
];
