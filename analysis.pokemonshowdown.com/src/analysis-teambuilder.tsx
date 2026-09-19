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
		return { sets: packed, from };
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
		const sideProblems = problems?.[side === 'p1' ? 'team1' : 'team2'] || [];
		const otherProblems = problems?.[side === 'p1' ? 'team2' : 'team1'] || [];
		return <div class="analysis-teambuilder">
			<div class="analysis-teambuilder-heading">
				<strong>Edit {label}</strong>
				<div class="analysis-field-actions">
					<button
						class="analysis-field-button btn-single" disabled={disabled}
						onClick={() => this.props.onSave(state.collect())}
					>Save</button>
					<button
						class="analysis-field-button btn-single" disabled={disabled}
						onClick={this.props.onCancel}
					>Cancel</button>
				</div>
			</div>
			<p class="analysis-field-note">
				{validated ?
					'The team must be legal for the format.' :
					"Changes apply from this turn on, and aren't validated against the format's rules."}
			</p>
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
				<TeamEditor
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
