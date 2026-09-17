/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * Pokémon state edit form (docs/analysis/plan.md, Phase 2b-1): HP, PP, status, boosts, Terastallization,
 * Mega Evolution and which Pokémon is active. It replaces the field form while a Pokémon is selected.
 *
 * Like the field form, it starts from the node's snapshot (after any saved edits) and reports only what the
 * user changed; the app merges that into the node's edits and the server drops entries that change nothing.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type {
	AnalysisEdits, AnalysisPokemonSnapshot, AnalysisPokemonStateEdit, AnalysisSideID, AnalysisSnapshot,
} from './analysis-model';

const STATUSES: { id: '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox', label: string }[] = [
	{ id: '', label: 'Healthy' }, { id: 'brn', label: 'Burn' }, { id: 'par', label: 'Paralysis' },
	{ id: 'slp', label: 'Sleep' }, { id: 'frz', label: 'Freeze' }, { id: 'psn', label: 'Poison' },
	{ id: 'tox', label: 'Toxic' },
];
const BOOSTS: { id: keyof PokemonForm['boosts'], label: string }[] = [
	{ id: 'atk', label: 'Atk' }, { id: 'def', label: 'Def' }, { id: 'spa', label: 'SpA' },
	{ id: 'spd', label: 'SpD' }, { id: 'spe', label: 'Spe' }, { id: 'accuracy', label: 'Acc' },
	{ id: 'evasion', label: 'Eva' },
];
const BOOST_LEVELS = [6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6];

/** Which Pokémon the form is editing, by its slot in the original team (stable across switches). */
export interface AnalysisPokemonTarget {
	side: AnalysisSideID;
	teamSlot: number;
}

/** Numbers are kept as the inputs' raw text while editing. */
interface PokemonForm {
	hp: string;
	status: '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';
	toxicStage: string;
	sleepTurns: string;
	pp: string[];
	boosts: { atk: number, def: number, spa: number, spd: number, spe: number, accuracy: number, evasion: number };
	terastallized: boolean;
	megaEvolved: boolean;
	/** active slot to send this Pokémon out to, when the user picked one */
	activeSlot: number | null;
}

/** Owned by the app, so unsaved changes survive re-renders; reset when the snapshot or the Pokémon changes. */
export class AnalysisPokemonFormState {
	snapshot: AnalysisSnapshot | null = null;
	target: AnalysisPokemonTarget | null = null;
	initial: PokemonForm | null = null;
	form: PokemonForm | null = null;
}

function toNumber(text: string) {
	const value = Math.trunc(Number(text));
	return Number.isFinite(value) && text.trim() !== '' ? value : NaN;
}

export function getPokemonForm(pokemon: AnalysisPokemonSnapshot): PokemonForm {
	const boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
	for (const boost of BOOSTS) boosts[boost.id] = pokemon.boosts[boost.id] || 0;
	return {
		hp: `${pokemon.hp}`,
		status: (pokemon.status || '') as PokemonForm['status'],
		toxicStage: `${pokemon.toxicStage ?? 0}`,
		sleepTurns: `${pokemon.sleepTurns ?? 3}`,
		pp: pokemon.moves.map(move => `${move.pp}`),
		boosts,
		terastallized: !!pokemon.terastallized,
		megaEvolved: pokemon.megaEvolved,
		activeSlot: null,
	};
}

/** The edits that turn `initial` into `form`, or null if a number input is invalid. */
export function getPokemonFormChanges(
	target: AnalysisPokemonTarget, pokemon: AnalysisPokemonSnapshot, initial: PokemonForm, form: PokemonForm
): AnalysisEdits | null {
	const edit: AnalysisPokemonStateEdit = {};
	const hp = toNumber(form.hp);
	if (isNaN(hp) || hp < 1 || hp > pokemon.maxhp) return null;
	if (form.hp !== initial.hp) edit.hp = hp;
	if (form.status !== initial.status) edit.status = form.status;
	if (form.status === 'tox') {
		const stage = toNumber(form.toxicStage);
		if (isNaN(stage) || stage < 0) return null;
		if (form.toxicStage !== initial.toxicStage || edit.status !== undefined) edit.toxicStage = stage;
	}
	if (form.status === 'slp') {
		const sleepTurns = toNumber(form.sleepTurns);
		if (isNaN(sleepTurns) || sleepTurns < 1) return null;
		if (form.sleepTurns !== initial.sleepTurns || edit.status !== undefined) edit.sleepTurns = sleepTurns;
	}
	const pp: (number | null)[] = [];
	let ppChanged = false;
	for (let slot = 0; slot < form.pp.length; slot++) {
		const value = toNumber(form.pp[slot]);
		if (isNaN(value) || value < 0 || value > (pokemon.moves[slot]?.maxpp ?? 0)) return null;
		const changed = form.pp[slot] !== initial.pp[slot];
		pp.push(changed ? value : null);
		ppChanged ||= changed;
	}
	if (ppChanged) edit.pp = pp;
	for (const boost of BOOSTS) {
		if (form.boosts[boost.id] === initial.boosts[boost.id]) continue;
		(edit.boosts ||= {})[boost.id] = form.boosts[boost.id];
	}
	if (form.terastallized && !initial.terastallized) edit.terastallized = true;
	if (form.megaEvolved && !initial.megaEvolved) edit.megaEvolved = true;

	const changes: AnalysisEdits = {};
	if (Object.keys(edit).length) changes.pokemon = { [`${target.side}:${target.teamSlot}`]: edit };
	if (form.activeSlot !== null) changes.active = { [target.side]: activeSlots(form.activeSlot, target.teamSlot) };
	return changes;
}

/** `active` is one team slot per active position; only the position being set is filled in. */
function activeSlots(position: number, teamSlot: number) {
	const slots: (number | null)[] = [];
	for (let index = 0; index < position; index++) slots.push(null);
	slots.push(teamSlot);
	return slots;
}

/** Merges a Pokémon's changes into the node's existing edits. Changes win; other saved edits are kept. */
export function mergePokemonEdits(existing: AnalysisEdits, changes: AnalysisEdits) {
	const merged: AnalysisEdits = { ...existing };
	if (changes.pokemon) {
		merged.pokemon = { ...merged.pokemon };
		for (const [key, edit] of Object.entries(changes.pokemon)) {
			const previous = merged.pokemon[key];
			const combined = { ...previous, ...edit };
			// boosts and PP are per stat and per move slot, so a later save must not drop earlier ones
			if (previous?.boosts || edit.boosts) combined.boosts = { ...previous?.boosts, ...edit.boosts };
			if (previous?.pp || edit.pp) combined.pp = mergePP(previous?.pp, edit.pp);
			merged.pokemon[key] = combined;
		}
	}
	if (changes.active) {
		merged.active = { ...merged.active };
		for (const side of ['p1', 'p2'] as const) {
			const slots = changes.active[side];
			if (!slots) continue;
			const sideSlots = [...(merged.active[side] || [])];
			for (let slot = 0; slot < slots.length; slot++) {
				if (slots[slot] !== null && slots[slot] !== undefined) sideSlots[slot] = slots[slot];
			}
			merged.active[side] = sideSlots;
		}
	}
	return merged;
}

function mergePP(previous: (number | null)[] | undefined, changes: (number | null)[] | undefined) {
	const merged = [...(previous || [])];
	for (let slot = 0; slot < (changes?.length || 0); slot++) {
		const value = changes![slot];
		if (value !== null && value !== undefined) merged[slot] = value;
	}
	return merged;
}

export class AnalysisPokemonEditor extends preact.Component<{
	state: AnalysisPokemonFormState,
	snapshot: AnalysisSnapshot,
	target: AnalysisPokemonTarget,
	disabled: boolean,
	error?: string,
	onSave: (changes: AnalysisEdits) => void,
	onClose: () => void,
}> {
	pokemon() {
		const { target, snapshot } = this.props;
		const team = snapshot.sides[target.side === 'p1' ? 0 : 1]?.pokemon || [];
		for (const pokemon of team) {
			if (pokemon.teamSlot === target.teamSlot) return pokemon;
		}
		return undefined;
	}

	resetIfNeeded(pokemon: AnalysisPokemonSnapshot) {
		const { state, snapshot, target } = this.props;
		if (state.snapshot === snapshot && state.target?.side === target.side && state.target.teamSlot === target.teamSlot) {
			return;
		}
		state.snapshot = snapshot;
		state.target = target;
		state.initial = getPokemonForm(pokemon);
		state.form = { ...state.initial, boosts: { ...state.initial.boosts }, pp: [...state.initial.pp] };
	}

	update(changes: Partial<PokemonForm>) {
		const { state } = this.props;
		state.form = { ...state.form!, ...changes };
		this.forceUpdate();
	}

	numberInput(value: string, onInput: (text: string) => void, extra: { max?: number, label: string, valid: boolean }) {
		return <input
			type="number" min="0" max={extra.max} step="1" aria-label={extra.label} title={extra.label}
			class={`textbox analysis-field-turns${extra.valid ? '' : ' analysis-field-invalid'}`}
			value={value} disabled={this.props.disabled} data-pokemon-field={extra.label}
			onInput={event => onInput((event.target as HTMLInputElement).value)}
		/>;
	}

	renderHP(pokemon: AnalysisPokemonSnapshot, form: PokemonForm) {
		const hp = toNumber(form.hp);
		const valid = !isNaN(hp) && hp >= 1 && hp <= pokemon.maxhp;
		const percent = valid ? `${Math.round(1000 * hp / pokemon.maxhp) / 10}` : '';
		return <div class="analysis-field-row">
			<div class="analysis-field-item">
				<span>HP</span>
				{this.numberInput(form.hp, text => this.update({ hp: text }), { max: pokemon.maxhp, label: 'HP', valid })}
				<span>/ {pokemon.maxhp}</span>
				{this.numberInput(percent, text => {
					const value = Number(text);
					if (!text.trim() || isNaN(value)) return;
					this.update({ hp: `${Math.min(pokemon.maxhp, Math.max(1, Math.round(value * pokemon.maxhp / 100)))}` });
				}, { max: 100, label: 'HP percent', valid })}
				<span>%</span>
			</div>
		</div>;
	}

	renderStatus(form: PokemonForm) {
		return <div class="analysis-field-row">
			<div class="analysis-field-item">
				<span class="analysis-field-segmented">{STATUSES.map((status, index) => <button
					type="button" data-label={status.label} data-field-effect={`status:${status.id || 'none'}`}
					class={`analysis-field-button ${index === 0 ? 'btn-left' : index === STATUSES.length - 1 ? 'btn-right' : 'btn-mid'}` +
						(form.status === status.id ? ' selected' : '')}
					aria-pressed={form.status === status.id} disabled={this.props.disabled}
					onClick={() => this.update({ status: status.id })}
				>{status.label}</button>)}</span>
				{form.status === 'tox' && <>
					{this.numberInput(form.toxicStage, text => this.update({ toxicStage: text }), {
						max: 15, label: 'Toxic stage', valid: !isNaN(toNumber(form.toxicStage)),
					})}
					<span>stage</span>
				</>}
				{form.status === 'slp' && <>
					{this.numberInput(form.sleepTurns, text => this.update({ sleepTurns: text }), {
						max: 9, label: 'Sleep turns', valid: toNumber(form.sleepTurns) >= 1,
					})}
					<span>turns</span>
				</>}
			</div>
		</div>;
	}

	renderPP(pokemon: AnalysisPokemonSnapshot, form: PokemonForm) {
		return <div class="analysis-field-row">{pokemon.moves.map((move, slot) => <div class="analysis-field-item">
			<span>{move.name}</span>
			{this.numberInput(form.pp[slot] ?? '', text => {
				const pp = [...form.pp];
				pp[slot] = text;
				this.update({ pp });
			}, { max: move.maxpp, label: `${move.name} PP`, valid: toNumber(form.pp[slot]) >= 0 })}
			<span>/ {move.maxpp}</span>
		</div>)}</div>;
	}

	renderBoosts(form: PokemonForm) {
		return <div class="analysis-field-row">{BOOSTS.map(boost => <div class="analysis-field-item">
			<span>{boost.label}</span>
			<select
				class="select analysis-boost-select" value={`${form.boosts[boost.id]}`} disabled={this.props.disabled}
				aria-label={`${boost.label} boost`} data-pokemon-boost={boost.id}
				onChange={event => this.update({
					boosts: { ...form.boosts, [boost.id]: Number((event.target as HTMLSelectElement).value) },
				})}
			>{BOOST_LEVELS.map(level => <option value={`${level}`}>{level > 0 ? `+${level}` : `${level}`}</option>)}</select>
		</div>)}</div>;
	}

	/** Terastallization and Mega Evolution are one-way, and sending a benched Pokémon out picks a slot. */
	renderActions(pokemon: AnalysisPokemonSnapshot, form: PokemonForm) {
		const { snapshot, target, disabled } = this.props;
		const slots = snapshot.sides[target.side === 'p1' ? 0 : 1]?.active.length || 1;
		const toggle = (key: 'terastallized' | 'megaEvolved', label: string, available: boolean, done: boolean) => {
			if (!available && !done) return null;
			const title = done ? `Already applied; edit an earlier turn to undo it` : label;
			return <button
				type="button" class={`analysis-field-button btn-single${form[key] ? ' selected' : ''}`}
				data-label={label} data-field-effect={key} title={title} aria-pressed={form[key]}
				disabled={disabled || done} onClick={() => this.update({ [key]: !form[key] })}
			>{label}</button>;
		};
		// .map, not a loop: the client build rejects closures that capture loop variables
		const sendOutSlots = pokemon.isActive || pokemon.fainted ? [] : Array.from({ length: slots }, (_, slot) => slot);
		const sendOut = sendOutSlots.map(slot => {
			const label = slots > 1 ? `Send out: Slot ${slot + 1}` : 'Send out';
			return <button
				type="button" data-label={label} data-field-effect={`active:${slot}`}
				class={`analysis-field-button btn-single${form.activeSlot === slot ? ' selected' : ''}`}
				disabled={disabled} aria-pressed={form.activeSlot === slot}
				onClick={() => this.update({ activeSlot: form.activeSlot === slot ? null : slot })}
			>{label}</button>;
		});
		return <div class="analysis-field-row">
			{sendOut}
			{toggle('terastallized', `Terastallize (${pokemon.teraType})`, pokemon.canTerastallize, !!pokemon.terastallized)}
			{toggle('megaEvolved', 'Mega Evolve', pokemon.canMegaEvo, pokemon.megaEvolved)}
		</div>;
	}

	override render() {
		const pokemon = this.pokemon();
		if (!pokemon) return null;
		this.resetIfNeeded(pokemon);
		const { state, target, disabled } = this.props;
		const form = state.form!;
		const changes = getPokemonFormChanges(target, pokemon, state.initial!, form);
		const changed = !changes || !!changes.pokemon || !!changes.active;
		const teamNumber = target.side === 'p1' ? 1 : 2;
		return <div class="analysis-field-editor">
			<div class="analysis-field-heading">
				<strong>Edit {pokemon.name} (Team {teamNumber})</strong>
				<div class="analysis-field-actions">
					<button
						type="button" class="button" disabled={disabled || !changed || !changes}
						onClick={() => { if (changes) this.props.onSave(changes); }}
					>Save</button>
					<button type="button" class="button" disabled={disabled} onClick={this.props.onClose}>Cancel</button>
				</div>
			</div>
			{this.props.error && <p class="message-error">{this.props.error}</p>}
			{pokemon.fainted ?
				<p class="analysis-field-note">{pokemon.name} has fainted. Reviving it isn't supported yet.</p> :
				<>
					{this.renderHP(pokemon, form)}
					{this.renderStatus(form)}
					{this.renderPP(pokemon, form)}
					{pokemon.isActive && this.renderBoosts(form)}
					{this.renderActions(pokemon, form)}
				</>}
		</div>;
	}
}
