/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * Field state edit form (docs/analysis/plan.md, Phase 2a): weather, terrain, pseudo-weather, and each
 * side's conditions at the current decision point. Styled after calc.pokemonshowdown.com's field panel:
 * segmented buttons, where selecting the active button again clears it.
 *
 * The form starts from the node's snapshot (after its saved edits) and reports only what the user
 * changed; the app merges that into the node's edits and the server drops entries that change nothing.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import type {
	AnalysisConditionEdit, AnalysisEffectSnapshot, AnalysisFieldEffectOption, AnalysisFieldStateEdit,
	AnalysisSideID, AnalysisSnapshot,
} from './analysis-model';

/** One effect's form value: `null` when off. Durations are the input's raw text while editing. */
interface FieldEffectValue {
	id: string;
	duration: string;
	layers?: number;
}

/** `weather`, `terrain`, a pseudo-weather id, or `p1:id` / `p2:id` for side conditions */
type FieldEffectKey = string;

type FieldForm = { [key: FieldEffectKey]: FieldEffectValue | null };

const PRIMAL_WEATHER_NAMES: { [id: string]: string } = {
	desolateland: 'Harsh Sunshine', primordialsea: 'Heavy Rain', deltastream: 'Strong Winds',
};
const SIDES: AnalysisSideID[] = ['p1', 'p2'];

/** where a toggle's turns input goes relative to its button */
type FieldToggleLayout = 'stacked' | 'input-after' | 'input-before';

function effectValue(effect: AnalysisEffectSnapshot | null | undefined): FieldEffectValue | null {
	if (!effect) return null;
	const layers = effect.data?.layers;
	return {
		id: effect.id,
		duration: effect.duration ? `${effect.duration}` : '',
		layers: typeof layers === 'number' ? layers : undefined,
	};
}

/** calc-site classes that join a row of buttons */
function buttonPosition(index: number, count: number) {
	return index === 0 ? 'btn-left' : index === count - 1 ? 'btn-right' : 'btn-mid';
}

function findEffect(effects: AnalysisEffectSnapshot[] | undefined, id: string) {
	for (const effect of effects || []) {
		if (effect.id === id) return effectValue(effect);
	}
	return null;
}

/** The `edits.sides` half of a field-form save: only the counts the user actually changed. */
export function getSideStateChanges(initial: FieldForm, form: FieldForm) {
	const before = (initial as any).fainted || {};
	const after = (form as any).fainted || {};
	const sides: { p1?: { totalFainted: number }, p2?: { totalFainted: number } } = {};
	for (const side of SIDES) {
		if (after[side] === before[side]) continue;
		const count = Number(after[side]);
		if (!Number.isInteger(count) || count < 0 || count > 100) return null;
		sides[side] = { totalFainted: count };
	}
	return Object.keys(sides).length ? sides : undefined;
}

function optionKey(option: AnalysisFieldEffectOption, side?: AnalysisSideID) {
	if (option.kind === 'weather' || option.kind === 'terrain') return option.kind;
	return side ? `${side}:${option.id}` : option.id;
}

/** The form values shown for a snapshot. */
export function getFieldForm(snapshot: AnalysisSnapshot, options: AnalysisFieldEffectOption[]): FieldForm {
	const form: FieldForm = {
		weather: effectValue(snapshot.field.weather),
		terrain: effectValue(snapshot.field.terrain),
	};
	// Not a field effect, but per-side state with nowhere else to live: Last Respects and Supreme Overlord
	// read it, and a reconstructed position has nobody fainted (user request, 2026-09-19).
	form.fainted = {
		p1: `${snapshot.sides[0]?.totalFainted ?? 0}`,
		p2: `${snapshot.sides[1]?.totalFainted ?? 0}`,
	} as any;
	// plain loops: the client build rejects closures that capture loop variables
	for (const option of options) {
		if (option.kind === 'pseudoWeather') {
			form[option.id] = findEffect(snapshot.field.pseudoWeather, option.id);
		} else if (option.kind === 'sideCondition') {
			for (let sideNumber = 0; sideNumber < SIDES.length; sideNumber++) {
				form[`${SIDES[sideNumber]}:${option.id}`] = findEffect(snapshot.sides[sideNumber]?.sideConditions, option.id);
			}
		}
	}
	return form;
}

function parseDuration(value: FieldEffectValue, option: AnalysisFieldEffectOption | undefined) {
	if (!option?.duration) return undefined;
	const duration = Number(value.duration);
	return Number.isInteger(duration) && duration >= 1 && duration <= 99 ? duration : NaN;
}

function sameValue(a: FieldEffectValue | null, b: FieldEffectValue | null, option?: AnalysisFieldEffectOption) {
	if (!a || !b) return a === b;
	return a.id === b.id && (a.layers || 0) === (b.layers || 0) && parseDuration(a, option) === parseDuration(b, option);
}

/**
 * The edits that turn `initial` into `form`, or null if a turns input is invalid. Unchanged effects are
 * left out, so saving keeps other edits made at this node.
 */
export function getFieldFormChanges(
	initial: FieldForm, form: FieldForm, options: AnalysisFieldEffectOption[]
): AnalysisFieldStateEdit | null {
	const changes: AnalysisFieldStateEdit = {};
	let valid = true;
	const toEdit = (value: FieldEffectValue, option: AnalysisFieldEffectOption | undefined) => {
		const edit: AnalysisConditionEdit = {};
		const duration = parseDuration(value, option);
		if (duration !== undefined && isNaN(duration)) valid = false;
		if (duration) edit.duration = duration;
		if (value.layers) edit.layers = value.layers;
		return edit;
	};
	const optionById = (id: string) => options.find(option => option.id === id);
	for (const kind of ['weather', 'terrain'] as const) {
		const value = form[kind];
		if (sameValue(initial[kind], value, value ? optionById(value.id) : undefined)) continue;
		changes[kind] = value ? { id: value.id, ...toEdit(value, optionById(value.id)) } : null;
	}
	for (const option of options) {
		if (option.kind === 'pseudoWeather') {
			const value = form[option.id];
			if (sameValue(initial[option.id], value, option)) continue;
			(changes.pseudoWeather ||= {})[option.id] = value ? toEdit(value, option) : null;
		} else if (option.kind === 'sideCondition') {
			for (const side of SIDES) {
				const key = `${side}:${option.id}`;
				if (sameValue(initial[key], form[key], option)) continue;
				const sides = (changes.sides ||= {});
				(sides[side] ||= {})[option.id] = form[key] ? toEdit(form[key], option) : null;
			}
		}
	}
	return valid ? changes : null;
}

/**
 * Owned by the app rather than the component, so unsaved changes survive the controls re-rendering (e.g.
 * while choosing an action). A new snapshot (navigation, saving) discards them.
 */
export class AnalysisFieldFormState {
	snapshot: AnalysisSnapshot | null = null;
	initial: FieldForm = {};
	form: FieldForm = {};
}

/**
 * Merges the form's changes into a node's existing field edits. Changes win; other saved edits are kept.
 */
export function mergeFieldEdits(existing: AnalysisFieldStateEdit | undefined, changes: AnalysisFieldStateEdit) {
	const merged: AnalysisFieldStateEdit = JSON.parse(JSON.stringify(existing || {}));
	if (changes.weather !== undefined) merged.weather = changes.weather;
	if (changes.terrain !== undefined) merged.terrain = changes.terrain;
	for (const [id, value] of Object.entries(changes.pseudoWeather || {})) {
		(merged.pseudoWeather ||= {})[id] = value;
	}
	for (const side of SIDES) {
		for (const [id, value] of Object.entries(changes.sides?.[side] || {})) {
			((merged.sides ||= {})[side] ||= {})[id] = value;
		}
	}
	return merged;
}

export class AnalysisFieldEditor extends preact.Component<{
	state: AnalysisFieldFormState,
	snapshot: AnalysisSnapshot,
	options: AnalysisFieldEffectOption[],
	showMore: boolean,
	disabled: boolean,
	onToggleShowMore: () => void,
	error?: string,
	onSave: (
		changes: AnalysisFieldStateEdit,
		sides?: { p1?: { totalFainted: number }, p2?: { totalFainted: number } },
	) => void,
}> {
	resetIfNeeded() {
		const { state } = this.props;
		if (state.snapshot === this.props.snapshot) return;
		state.snapshot = this.props.snapshot;
		state.initial = getFieldForm(this.props.snapshot, this.props.options);
		state.form = { ...state.initial };
	}

	setValue(key: FieldEffectKey, value: FieldEffectValue | null) {
		this.props.state.form = { ...this.props.state.form, [key]: value };
		this.forceUpdate();
	}

	/** Turning an effect on restores its value from the snapshot if it had one, else the standard duration. */
	enable(key: FieldEffectKey, option: AnalysisFieldEffectOption, layers?: number) {
		const initial = this.props.state.initial[key];
		const value = initial?.id === option.id ?
			{ ...initial } :
			{ id: option.id, duration: option.duration ? `${option.duration}` : '' };
		if (layers) value.layers = layers;
		this.setValue(key, value);
	}

	renderTurns(key: FieldEffectKey, option: AnalysisFieldEffectOption | undefined) {
		const value = this.props.state.form[key];
		// inactive effects show their standard duration, greyed out
		const active = !!value && !!option?.duration;
		const invalid = active && isNaN(parseDuration(value, option)!);
		const classes = `textbox analysis-field-turns${invalid ? ' analysis-field-invalid' : ''}`;
		return <input
			type="number" min="1" max="99" step="1" class={classes}
			title="Turns remaining, including this turn" aria-label={`${option?.name || key} turns remaining`}
			value={active ? value.duration : `${option?.duration || ''}`} disabled={!active || this.props.disabled}
			data-field-turns={key}
			onInput={event => {
				if (value) this.setValue(key, { ...value, duration: (event.target as HTMLInputElement).value });
			}}
		/>;
	}

	/** `position` places a lone button within a row of joined buttons (see renderToggleRows). */
	renderButtons(
		buttons: { label: string, selected: boolean, onClick: () => void, effect: string }[], position?: string
	) {
		return <span class="analysis-field-segmented">{buttons.map((button, index) => {
			position = buttons.length > 1 ? buttonPosition(index, buttons.length) : position || 'btn-single';
			return <button
				type="button" class={`analysis-field-button ${position}${button.selected ? ' selected' : ''}`}
				aria-pressed={button.selected} disabled={this.props.disabled} onClick={button.onClick}
				data-field-effect={button.effect} data-label={button.label}
			>{button.label}</button>;
		})}</span>;
	}

	/** Weather or terrain: one segmented row plus the selected effect's turns. */
	renderExclusiveGroup(key: 'weather' | 'terrain', options: AnalysisFieldEffectOption[]) {
		const value = this.props.state.form[key];
		const primalName = key === 'weather' && value ? PRIMAL_WEATHER_NAMES[value.id] : undefined;
		if (primalName) {
			return <div class="analysis-field-item">
				<span class="analysis-field-note">{primalName} (from an ability; can't be edited)</span>
			</div>;
		}
		const selected = options.find(option => option.id === value?.id);
		return <div class="analysis-field-item">
			{this.renderButtons(options.map(option => ({
				label: option.label,
				selected: option.id === value?.id,
				effect: `${key}:${option.id}`,
				onClick: () => option.id === value?.id ? this.setValue(key, null) : this.enable(key, option),
			})))}
			{this.renderTurns(key, selected || options.find(option => option.duration))}
		</div>;
	}

	/**
	 * An on/off effect, or `3 Spikes | 2 | 1 | 0` for layered hazards. The turns input goes below the button
	 * (`stacked`), or beside it: after the button, or before it for Team 2's right-aligned column.
	 */
	renderToggle(
		option: AnalysisFieldEffectOption, side: AnalysisSideID | undefined, layout: FieldToggleLayout, position?: string
	) {
		const key = optionKey(option, side);
		const value = this.props.state.form[key];
		if (option.maxLayers) {
			const layerCounts = Array.from({ length: option.maxLayers + 1 }, (_, index) => option.maxLayers! - index);
			return <div class="analysis-field-item">
				{this.renderButtons(layerCounts.map((layers, index) => ({
					label: index === 0 ? `${layers} ${option.label}` : `${layers}`,
					selected: (value?.layers || 0) === layers,
					effect: `${key}:${layers}`,
					onClick: () => layers && value?.layers !== layers ? this.enable(key, option, layers) : this.setValue(key, null),
				})))}
			</div>;
		}
		const turns = option.duration ? this.renderTurns(key, option) : null;
		return <div class={`analysis-field-item${layout === 'stacked' ? ' analysis-field-stacked' : ''}`}>
			{layout === 'input-before' && turns}
			{this.renderButtons([{
				label: option.label,
				selected: !!value,
				effect: key,
				onClick: () => value ? this.setValue(key, null) : this.enable(key, option),
			}], position)}
			{layout !== 'input-before' && turns}
		</div>;
	}

	/**
	 * Lines of toggles: options sharing a `row` go on one line as joined buttons with their inputs stacked
	 * below, unless only one of them is visible.
	 */
	renderToggleRows(options: AnalysisFieldEffectOption[], side?: AnalysisSideID) {
		const rows: AnalysisFieldEffectOption[][] = [];
		for (const option of options) {
			const previous = rows[rows.length - 1];
			if (option.row && previous?.[0].row === option.row) {
				previous.push(option);
			} else {
				rows.push([option]);
			}
		}
		const inline: FieldToggleLayout = side === 'p2' ? 'input-before' : 'input-after';
		return rows.map(row => row.length > 1 ?
			<div class="analysis-field-row analysis-field-joined">
				{row.map((option, index) => this.renderToggle(option, side, 'stacked', buttonPosition(index, row.length)))}
			</div> :
			<div class="analysis-field-row">{this.renderToggle(row[0], side, inline)}</div>);
	}

	/** How many Pokémon have fainted on this side, which Last Respects and Supreme Overlord read. */
	renderFaintedInput(side: AnalysisSideID) {
		const form = this.props.state.form as any;
		const value = form.fainted?.[side] ?? '0';
		const count = Number(value);
		const valid = Number.isInteger(count) && count >= 0 && count <= 100;
		return <div class="analysis-field-row analysis-field-fainted">
			<label>Number Fainted</label>
			<input
				type="number" min="0" max="100" value={value} disabled={this.props.disabled}
				aria-label={`Side ${side === 'p1' ? 1 : 2} Number Fainted`}
				class={`textbox analysis-field-turns${valid ? '' : ' analysis-field-invalid'}`}
				onInput={event => {
					const next = { ...(form.fainted || {}) };
					next[side] = (event.target as HTMLInputElement).value;
					form.fainted = next;
					this.forceUpdate();
				}}
			/>
		</div>;
	}

	override render() {
		this.resetIfNeeded();
		const { options, showMore, disabled } = this.props;
		const visible = options.filter(option => showMore || option.common);
		const changes = getFieldFormChanges(this.props.state.initial, this.props.state.form, options);
		const sideState = getSideStateChanges(this.props.state.initial, this.props.state.form);
		const changed = !changes || Object.keys(changes).length > 0 || sideState === null || !!sideState;
		const groupOptions = (kind: 'weather' | 'terrain') => options.filter(option => option.kind === kind);
		const sideOptions = visible.filter(option => option.kind === 'sideCondition');
		return <div class="analysis-field-editor">
			<div class="analysis-field-heading">
				<strong>Edit Field</strong>
				<div class="analysis-field-actions">
					<button
						type="button" class="button" disabled={disabled || !changed || !changes || sideState === null}
						onClick={() => { if (changes && sideState !== null) this.props.onSave(changes, sideState); }}
					>Save</button>
					<button
						type="button" class="button" disabled={disabled || !changed}
						onClick={() => { this.props.state.form = { ...this.props.state.initial }; this.forceUpdate(); }}
					>Cancel</button>
					{options.some(option => !option.common) && <button
						type="button" class="button" onClick={this.props.onToggleShowMore}
					>{showMore ? 'Show less' : 'Show more'}</button>}
				</div>
			</div>
			{this.props.error && <p class="message-error">{this.props.error}</p>}
			{/* boxed like the Pokémon panel's info groups: the field, then one per side */}
			<div class="analysis-info-group analysis-field-rows">
				{groupOptions('weather').length > 0 && this.renderExclusiveGroup('weather', groupOptions('weather'))}
				{groupOptions('terrain').length > 0 && this.renderExclusiveGroup('terrain', groupOptions('terrain'))}
				{this.renderToggleRows(visible.filter(option => option.kind === 'pseudoWeather'))}
			</div>
			<div class="analysis-field-sides">
				{SIDES.map((side, sideNumber) => <div
					class={`analysis-info-group analysis-field-side analysis-field-side-${side}`}
				>
					<span class="analysis-field-side-title">Side {sideNumber + 1}</span>
					{this.renderToggleRows(sideOptions, side)}
					{/*
						Uncommon, so it sits behind Show more: it only matters for an imported replay, or for
						setting up a Last Respects / Supreme Overlord position by hand.
					*/}
					{showMore && this.renderFaintedInput(side)}
				</div>)}
			</div>
		</div>;
	}
}
