/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * The teambuilder panel (docs/analysis/plan.md Phase 3): edits one side's whole team at a node.
 *
 * It wraps the play client's `TeamEditor` rather than reimplementing one. That component edits a
 * `Team`'s `packedTeam` in place, so this file's job is the two things it doesn't do:
 *
 * 1. **Building a `Team`** out of the node's snapshot, and
 * 2. **Tracking which set is which.** Edits name a Pokémon by `teamSlot`, its index in the original
 *    team, and the server needs to know which slot each saved set came from or it can't tell a reorder
 *    from a delete-and-add. `TeamEditor` re-unpacks `packedTeam` into fresh objects, so the slots are
 *    tagged on the editor's own set objects after it loads (it mutates and splices those in place, so
 *    they survive editing) and matched by species as a fallback for sets it re-created, e.g. through
 *    the Import/Export tab.
 *
 * The globals `TeamEditor` needs but the play client would normally provide are in
 * analysis-ps-shims.tsx.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { Teams } from '../../play.pokemonshowdown.com/src/battle-teams';
import { TeamEditor } from '../../play.pokemonshowdown.com/src/battle-team-editor';
import { toID } from '../../play.pokemonshowdown.com/src/battle-dex';
import type { AnalysisSideID, AnalysisSnapshot, AnalysisTeamEdit } from './analysis-model';

/** the slot a set came from, stashed on the editor's own set objects (see the file comment) */
const SLOT_KEY = '__analysisTeamSlot';

/**
 * A Set Up Position placeholder's nickname (server `getPlaceholderName`): "Placeholder", or "Placeholder N"
 * where a side has more than one.
 *
 * Matched rather than plumbed through from the setup response, because the set being checked may have come
 * back from the server through any number of edits since, and the name is the only thing that survives all
 * of them intact.
 */
const PLACEHOLDER_NAME = /^Placeholder(?: \d+)?$/;

/** Lines-tooltip summary for a team set at Team Preview, which the server never reports back. */
export function summarizeTeam(sets: any[]) {
	return [`Team: ${sets.map(set => set.species || set.name).join(', ') || '(empty)'}`];
}

/**
 * Lives on the app, so the panel keeps its editing state while the app re-renders around it, the way
 * the field and Pokémon forms do.
 */
export class AnalysisTeamFormState {
	side: AnalysisSideID | null = null;
	/** a `Teams.Team` for TeamEditor; it edits `packedTeam` in place */
	team: any = null;
	/** team slot per set, in the order the editor first loaded them */
	slots: number[] = [];
	/** species per entry of `slots`, for the fallback match in `collect` */
	originalSpecies: string[] = [];
	editor: any = null;
	dirty = false;
	/**
	 * Whether the onboarding pass is listing what the replay couldn't determine. Deliberately not reset by
	 * `open`/`openPacked`: having asked to see the gaps, the user shouldn't have to ask again on the other
	 * team.
	 */
	showWarnings = false;
	/**
	 * A set to open focused, as its index in the editor's own list. Set Up Position uses it so that clicking
	 * a placeholder lands on the same view as clicking the trainer sprite and then that Pokémon's species.
	 */
	pendingFocusIndex: number | null = null;

	/** Rebuilds the panel for one side from the node's snapshot. */
	open(side: AnalysisSideID, snapshot: AnalysisSnapshot, format: string, focusTeamSlot?: number) {
		const sideSnapshot = snapshot.sides[side === 'p1' ? 0 : 1];
		const roster = sideSnapshot?.pokemon || [];
		this.side = side;
		this.slots = roster.map(pokemon => pokemon.teamSlot);
		this.originalSpecies = roster.map(pokemon => pokemon.set.species || pokemon.species);
		this.editor = null;
		this.dirty = false;
		const focusIndex = focusTeamSlot === undefined ? -1 : this.slots.indexOf(focusTeamSlot);
		this.pendingFocusIndex = focusIndex >= 0 ? focusIndex : null;
		this.team = {
			name: sideSnapshot?.name || (side === 'p1' ? 'Team 1' : 'Team 2'),
			format: toID(format),
			folder: '',
			packedTeam: Teams.pack(roster.map(pokemon => pokemon.set)),
			iconCache: null,
			key: `analysis-${side}`,
			isBox: false,
		};
	}

	/**
	 * Rebuilds the panel from a **packed team** rather than from a node's snapshot.
	 *
	 * The import onboarding pass needs this: it writes each side's team straight onto the tab and never
	 * rebuilds the battle while it is open, so the snapshot still describes the position as it was first
	 * loaded. Reopening from the snapshot therefore threw away everything the user had just saved.
	 */
	openPacked(side: AnalysisSideID, packedTeam: string, format: string) {
		const sets = Teams.unpack(packedTeam) || [];
		this.side = side;
		// No node slots are involved here: onboarding replaces the tab's team wholesale rather than going
		// through the team edit layer, so `collect`'s `from` mapping is never read.
		this.slots = sets.map((_set: any, index: number) => index);
		this.originalSpecies = sets.map((set: any) => set.species || set.name);
		this.editor = null;
		this.dirty = false;
		this.pendingFocusIndex = null;
		this.team = {
			name: side === 'p1' ? 'Team 1' : 'Team 2',
			format: toID(format),
			folder: '',
			packedTeam,
			iconCache: null,
			key: `analysis-${side}`,
			isBox: false,
		};
	}

	close() {
		this.side = null;
		this.team = null;
		this.editor = null;
		this.slots = [];
		this.originalSpecies = [];
		this.dirty = false;
		this.pendingFocusIndex = null;
	}

	/** Tags the editor's set objects the first time it hands us its state. */
	attach(editor: any) {
		this.editor = editor;
		const sets = editor?.sets || [];
		for (let i = 0; i < sets.length; i++) {
			if (sets[i] && this.slots[i] !== undefined) sets[i][SLOT_KEY] = this.slots[i];
		}
	}

	/**
	 * The roster to save: every set with the slot it came from, or `null` if it's new. Tags come first;
	 * anything the editor re-created from scratch is matched to a leftover slot by species, so an
	 * Import/Export round trip doesn't read as "deleted everything and added six new Pokémon".
	 */
	collect(): AnalysisTeamEdit {
		const sets = (this.editor?.sets || []).filter(Boolean);
		const used = new Set<number>();
		const from: (number | null)[] = sets.map((set: any) => {
			const slot = set[SLOT_KEY];
			if (typeof slot !== 'number' || used.has(slot)) return null;
			used.add(slot);
			return slot;
		});
		for (let i = 0; i < sets.length; i++) {
			if (from[i] !== null) continue;
			const species = toID(sets[i].species || sets[i].name);
			for (let slot = 0; slot < this.slots.length; slot++) {
				const candidate = this.slots[slot];
				if (used.has(candidate) || toID(this.originalSpecies[slot]) !== species) continue;
				used.add(candidate);
				from[i] = candidate;
				break;
			}
		}
		// the packed form is what the user actually sees in the editor
		const packed = Teams.unpack(Teams.pack(sets)) || [];
		this.dropReplacedPlaceholderNames(packed, from);
		return { sets: packed, from };
	}

	/**
	 * Clears the nickname of any placeholder whose species the user has swapped out.
	 *
	 * "Placeholder" is a real nickname, so upstream's editor keeps it across a species change — it only
	 * drops a name that equals the old species (`changeSpecies` in battle-team-editor.tsx). Left alone that
	 * would hand you a Garchomp still called Placeholder, where replacing one has always given you a
	 * Garchomp called Garchomp. An empty name is what the server's `normalizeSet` turns into the base
	 * species, which is also how it renders an un-nicknamed set.
	 *
	 * Only a *replaced* placeholder is renamed: keeping the starting species and merely giving it moves
	 * leaves the nickname, because at that point the user has chosen that Pokémon and can rename it.
	 */
	dropReplacedPlaceholderNames(sets: any[], from: (number | null)[]) {
		for (let i = 0; i < sets.length; i++) {
			if (!PLACEHOLDER_NAME.test(sets[i]?.name || '')) continue;
			const slot = from[i] === null ? -1 : this.slots.indexOf(from[i]!);
			// a set with no slot is newly added, so it never was one of the placeholders
			if (slot < 0 || toID(this.originalSpecies[slot]) === toID(sets[i].species)) continue;
			sets[i].name = '';
		}
	}
}

export class AnalysisTeambuilder extends preact.Component<{
	state: AnalysisTeamFormState,
	side: AnalysisSideID,
	disabled?: boolean,
	error?: string,
	/** validator problems from a refused Team Preview team (see saveTeamPreviewTeam) */
	problems?: { team1: string[], team2: string[] } | null,
	/** at Team Preview the team is validated, because it's the team the battle is built from */
	validated?: boolean,
	onSave: (edit: AnalysisTeamEdit) => void,
	onCancel: () => void,
	/**
	 * The import onboarding pass, which replaces Save/Cancel with its own row: switch between the two
	 * reconstructed teams, save and move on, or skip and accept the inferences as they stand.
	 */
	onboarding?: {
		warnings?: string[],
		onSwitchSide: (side: AnalysisSideID) => void,
		onProceed: () => void,
		onSkip: () => void,
	},
}> {
	/**
	 * Opens a set focused, by focusing its species textbox the way a click would (`setFocusTextbox` in
	 * `battle-team-editor.tsx`). Driving the editor's own markup keeps that upstream file untouched.
	 * Cleared before focusing, because entering the focused view re-renders this component.
	 */
	applyPendingFocus() {
		const { state } = this.props;
		const index = state.pendingFocusIndex;
		if (index === null || !this.base) return;
		state.pendingFocusIndex = null;
		const field = this.base
			.querySelector<HTMLInputElement>(`input.set-field[data-focus="set-${index}-pokemon"]`);
		field?.focus();
	}

	override componentDidMount() {
		this.applyPendingFocus();
	}

	override componentDidUpdate() {
		this.applyPendingFocus();
	}

	override render() {
		const { state, side, disabled, error, problems, validated } = this.props;
		if (!state.team) return null;
		const label = side === 'p1' ? 'Team 1' : 'Team 2';
		const { onboarding } = this.props;
		const sideProblems = problems?.[side === 'p1' ? 'team1' : 'team2'] || [];
		const otherProblems = problems?.[side === 'p1' ? 'team2' : 'team1'] || [];
		return <div class="analysis-teambuilder">
			<div class="analysis-teambuilder-heading">
				<strong>{onboarding ? `Reconstructed ${label}` : `Edit ${label}`}</strong>
				<div class="analysis-field-actions">
					{onboarding ? <>
						<button
							class="analysis-field-button btn-left" disabled={disabled || side === 'p1'}
							onClick={() => onboarding.onSwitchSide('p1')}
						>Team 1</button>
						<button
							class="analysis-field-button btn-right" disabled={disabled || side === 'p2'}
							onClick={() => onboarding.onSwitchSide('p2')}
						>Team 2</button>
						{/*
							One proceed button on either side, not a linear p1→p2 walk: switching sides already
							saves, so the only real choice is "use my edits" or "use the reconstruction".
							It doesn't name where it goes, because that varies: a VGC replay that didn't show
							every brought Pokémon lands on the brought-Pokémon step first.
						*/}
						<button
							class="analysis-field-button btn-single" disabled={disabled}
							onClick={onboarding.onProceed}
						>Save and Continue</button>
						<button
							class="analysis-field-button btn-single" disabled={disabled}
							onClick={onboarding.onSkip}
						>Skip to Analysis</button>
					</> : <>
						<button
							class="analysis-field-button btn-single" disabled={disabled}
							onClick={() => this.props.onSave(state.collect())}
						>Save</button>
						<button
							class="analysis-field-button btn-single" disabled={disabled}
							onClick={this.props.onCancel}
						>Cancel</button>
					</>}
				</div>
			</div>
			{onboarding ? <p class="analysis-field-note">
				This is a reconstruction of {label}, inferred from the replay log. You can fill in what's
				missing now — a replay never reveals EVs, IVs or nature, and moves, items and abilities are
				only known if they came up. You can edit this team later.
			</p> : <p class="analysis-field-note">
				{validated ?
					'The team must be legal for the format.' :
					"Changes apply from this turn on, and aren't validated against the format's rules."}
			</p>}
			{/*
				What the replay couldn't tell us, folded away: it is a per-Pokémon list that grows with the
				roster, and on a non-open-sheet replay nearly every line of it says the same thing. The
				summary above already tells the user what kind of gaps to expect.
			*/}
			{onboarding?.warnings?.length ? <p class="analysis-field-note">
				<button
					type="button" class="button"
					onClick={() => { state.showWarnings = !state.showWarnings; this.forceUpdate(); }}
				>
					{state.showWarnings ? 'Hide details' : `Show more details (${onboarding.warnings.length})`}
				</button>
			</p> : null}
			{onboarding?.warnings?.length && state.showWarnings ?
				<ul class="analysis-teambuilder-problems analysis-field-note">
					{onboarding.warnings.map(warning => <li>{warning}</li>)}
				</ul> : null}
			{error ? <p class="analysis-field-invalid analysis-teambuilder-error">{error}</p> : null}
			{sideProblems.length || otherProblems.length ? <div class="analysis-field-invalid analysis-teambuilder-error">
				<strong>This team can't be used:</strong>
				<ul class="analysis-teambuilder-problems">
					{sideProblems.map(problem => <li>{problem}</li>)}
					{otherProblems.map(problem => <li>{side === 'p1' ? 'Team 2' : 'Team 1'}: {problem}</li>)}
				</ul>
				<em>Fix it here and save again, or press Cancel to discard the changes.</em>
			</div> : null}
			{/*
				This has to be a positioned box with a real height: the editor's focused view
				(`.team-focus-editor`, and `.set-searchresults` inside it) is `position: absolute` with
				`top/bottom: 0`, so it fills the nearest positioned ancestor. In the play client that's the
				full-height room panel; here it's this div. Letting it fall through to a content-sized
				`.teameditor` collapses the focused view to nothing.
			*/}
			<div class="analysis-teambuilder-editor">
				{/*
					Keyed by side so switching between the two reconstructions **remounts** the editor.
					`TeamEditor` unpacks `packedTeam` once and hands back its state through `editorRef`, so a
					reused instance keeps showing the old team and leaves `state.editor` null — which then
					makes `collect()` return nothing and a save look like an empty team.
				*/}
				<TeamEditor
					key={side}
					team={state.team}
					onChange={() => {
						state.dirty = true;
						this.forceUpdate();
					}}
					editorRef={(editor: any) => state.attach(editor)}
				/>
			</div>
		</div>;
	}
}
