/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * Pokémon edit panel (docs/analysis/plan.md, Phase 2b-1 and Phase 3), laid out like the damage
 * calculator's `poke-info`: boxed "info groups" stacked down the panel. It replaces the field form while a
 * Pokémon is selected.
 *
 * It edits two different things through one form:
 *
 * - **Battle state** (HP, PP, status, boosts, Terastallization, which Pokémon is active) becomes
 *   `edits.pokemon` / `edits.active`, applied by the server's Pokémon layer.
 * - **The set** (forme, gender, level, tera type, nature, ability, item, moves, EVs/IVs) becomes a
 *   `edits.teams` entry for that side, applied by the team layer, which mutates the set in place and so
 *   keeps the Pokémon's team slot. Composition is never changed here: the roster is sent back exactly as
 *   the snapshot had it, with only this Pokémon's set replaced. Use the teambuilder to add or remove.
 *
 * As with the field form, it starts from the node's snapshot (after any saved edits) and reports only what
 * the user changed; the server drops entries that change nothing.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { toID } from '../../play.pokemonshowdown.com/src/battle-dex';
import {
	ANALYSIS_VOLATILES, type AnalysisEdits, type AnalysisPokemonSnapshot, type AnalysisPokemonStateEdit,
	type AnalysisSideID, type AnalysisSnapshot, type AnalysisTeamEdit, type AnalysisVolatileContext,
} from './analysis-model';
import { AnalysisMultiSelect, type AnalysisMultiSelectOption } from './analysis-multiselect';

declare const Dex: any;
declare const BattleNatures: any;
declare const BattleStatNames: any;
declare const DexSearch: any;

type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
const STAT_IDS: StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABELS: { [stat in StatID]: string } = {
	hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
};
/** boosts shown in the stat table; accuracy and evasion get their own row, as in the calc */
const BOOSTED_STATS: StatID[] = ['atk', 'def', 'spa', 'spd', 'spe'];
const EXTRA_BOOSTS: { id: 'accuracy' | 'evasion', label: string }[] = [
	{ id: 'accuracy', label: 'Accuracy' }, { id: 'evasion', label: 'Evasion' },
];
const BOOST_LEVELS = [6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6];
const STATUSES: { id: PokemonForm['status'], label: string }[] = [
	{ id: '', label: 'Healthy' }, { id: 'brn', label: 'Burn' }, { id: 'par', label: 'Paralysis' },
	{ id: 'slp', label: 'Sleep' }, { id: 'frz', label: 'Freeze' }, { id: 'psn', label: 'Poison' },
	{ id: 'tox', label: 'Badly Poisoned' },
];
/** the toxic counter, shown as the calc does: N/16 of max HP lost at the end of the turn */
const TOXIC_STAGES = Array.from({ length: 15 }, (_, index) => index + 1);

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
	/** option keys from `volatileOptions`, not bare ids: source-linked ones carry the foe slot */
	volatiles: string[];
	terastallized: boolean;
	megaEvolved: boolean;
	/** active slot to send this Pokémon out to, when the user picked one */
	activeSlot: number | null;
	// set fields
	species: string;
	gender: string;
	/** current types (battle state, not the set): Soak and friends change these mid-battle */
	types: string[];
	level: string;
	teraType: string;
	nature: string;
	ability: string;
	/**
	 * The **current**, while-active ability, as opposed to the set's — what Trace, Skill Swap or a Mega
	 * Evolution leaves behind. Empty means "same as the set". Only active Pokémon can have one.
	 */
	currentAbility: string;
	/** hits taken, for Rage Fist; only offered when the Pokémon actually has the move */
	timesAttacked: string;
	item: string;
	moves: string[];
	evs: { [stat in StatID]: string };
	ivs: { [stat in StatID]: string };
}

/** Owned by the app, so unsaved changes survive re-renders; reset when the snapshot or the Pokémon changes. */
export class AnalysisPokemonFormState {
	snapshot: AnalysisSnapshot | null = null;
	target: AnalysisPokemonTarget | null = null;
	initial: PokemonForm | null = null;
	form: PokemonForm | null = null;
}

/** The calc shows an unboosted stat as `--` rather than `0`. */
function boostLabel(level: number) {
	if (level > 0) return `+${level}`;
	return level < 0 ? `${level}` : '--';
}

function toNumber(text: string) {
	const value = Math.trunc(Number(text));
	return Number.isFinite(value) && text.trim() !== '' ? value : NaN;
}

function statTable(source: any, fallback: number) {
	const table = {} as { [stat in StatID]: string };
	for (const stat of STAT_IDS) {
		const value = source?.[stat];
		table[stat] = `${typeof value === 'number' ? value : fallback}`;
	}
	return table;
}

/**
 * The option key for a volatile the Pokémon already has. Source-linked ones are keyed by the foe slot they
 * came from, so the right "Leech Seed (Slot 2)" comes back selected.
 */
function volatileKey(id: string, sourceSlot: string | undefined, doubles: boolean) {
	const info = ANALYSIS_VOLATILES.find(entry => entry.id === id);
	if (!info?.perFoeSlot || !doubles) return id;
	const slot = sourceSlot?.slice(-1);
	return `${id}#${slot === 'b' ? 1 : 0}`;
}

export function getPokemonForm(pokemon: AnalysisPokemonSnapshot, doubles = false): PokemonForm {
	const boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
	for (const stat of [...BOOSTED_STATS, 'accuracy', 'evasion'] as (keyof PokemonForm['boosts'])[]) {
		boosts[stat] = pokemon.boosts[stat] || 0;
	}
	const set = pokemon.set;
	return {
		hp: `${pokemon.hp}`,
		status: (pokemon.status || '') as PokemonForm['status'],
		toxicStage: `${pokemon.toxicStage || 1}`,
		sleepTurns: `${pokemon.sleepTurns ?? 3}`,
		pp: pokemon.moves.map(move => `${move.pp}`),
		boosts,
		volatiles: pokemon.volatiles.map(effect => volatileKey(effect.id, effect.sourceSlot, doubles)),
		terastallized: !!pokemon.terastallized,
		megaEvolved: pokemon.megaEvolved,
		activeSlot: null,
		species: set.species || pokemon.species,
		gender: set.gender || 'N',
		types: [...pokemon.types],
		level: `${set.level || pokemon.level}`,
		teraType: set.teraType || pokemon.teraType || '',
		nature: set.nature || 'Serious',
		ability: set.ability || pokemon.ability,
		// A current ability that already differs from the set is an in-battle change (Trace, a Mega), so
		// the dropdown should show it as such rather than silently rewriting the set to match.
		currentAbility: toID(pokemon.ability) !== toID(set.ability || pokemon.ability) ? pokemon.ability : '',
		timesAttacked: `${pokemon.timesAttacked ?? 0}`,
		item: set.item || '',
		moves: pokemon.moves.map(move => move.name),
		evs: statTable(set.evs, 0),
		ivs: statTable(set.ivs, 31),
	};
}

/** The set fields this panel can change; composition and nicknames are not among them. */
function setChanged(initial: PokemonForm, form: PokemonForm) {
	if (form.species !== initial.species || form.gender !== initial.gender) return true;
	if (form.level !== initial.level || form.teraType !== initial.teraType) return true;
	if (form.nature !== initial.nature || form.ability !== initial.ability || form.item !== initial.item) return true;
	if (form.moves.join(',') !== initial.moves.join(',')) return true;
	for (const stat of STAT_IDS) {
		if (form.evs[stat] !== initial.evs[stat] || form.ivs[stat] !== initial.ivs[stat]) return true;
	}
	return false;
}

/**
 * The whole side's roster with only this Pokémon's set replaced. Every entry keeps the slot it came from,
 * so the team layer mutates the sets in place and no team slot moves.
 */
function buildTeamEdit(
	snapshot: AnalysisSnapshot, target: AnalysisPokemonTarget, set: any
): AnalysisTeamEdit {
	const side = snapshot.sides[target.side === 'p1' ? 0 : 1];
	const roster = side?.pokemon || [];
	return {
		sets: roster.map(entry => entry.teamSlot === target.teamSlot ? set : entry.set),
		from: roster.map(entry => entry.teamSlot),
	};
}

/** The edits that turn `initial` into `form`, or null if an input is invalid. */
export function getPokemonFormChanges(
	target: AnalysisPokemonTarget, pokemon: AnalysisPokemonSnapshot, initial: PokemonForm, form: PokemonForm,
	snapshot: AnalysisSnapshot
): AnalysisEdits | null {
	const edit: AnalysisPokemonStateEdit = {};
	// 0 faints a benched Pokémon; an active one is clamped to 1 so the form can't KO whoever is on the field
	const hp = toNumber(form.hp);
	if (isNaN(hp) || hp < (pokemon.isActive ? 1 : 0) || hp > pokemon.maxhp) return null;
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
	/*
	 * PP is keyed by move id, so a move change and its new PP can be saved together: the edit names the
	 * move it belongs to rather than a slot whose contents may have changed underneath it.
	 */
	const pp: { [moveid: string]: number } = {};
	for (let slot = 0; slot < form.pp.length; slot++) {
		const name = form.moves[slot];
		if (!name) continue;
		const value = toNumber(form.pp[slot]);
		if (isNaN(value) || value < 0) return null;
		const moveChanged = name !== initial.moves[slot];
		// a move the user just picked is compared against its own full PP, not the old move's value
		const baseline = moveChanged ? `${maxPPFor(dexFor(snapshot), name)}` : initial.pp[slot];
		if (form.pp[slot] === baseline) continue;
		const moveid = moveIdOf(snapshot, name);
		if (!moveid) continue;
		pp[moveid] = value;
	}
	if (Object.keys(pp).length) edit.pp = pp;
	for (const stat of [...BOOSTED_STATS, 'accuracy', 'evasion'] as (keyof PokemonForm['boosts'])[]) {
		if (form.boosts[stat] === initial.boosts[stat]) continue;
		(edit.boosts ||= {})[stat] = form.boosts[stat];
	}
	const volatiles = volatileChanges(initial.volatiles, form.volatiles);
	if (volatiles) edit.volatiles = volatiles;
	if (form.types.join('/') !== initial.types.join('/')) {
		if (!form.types.filter(Boolean).length) return null;
		edit.types = form.types.filter(Boolean);
	}
	// both directions: unchecking removes this node's own Terastallization edit (the server refuses one
	// that came from an earlier node, since no protocol line takes it back)
	if (form.terastallized !== initial.terastallized) edit.terastallized = form.terastallized;
	if (form.megaEvolved && !initial.megaEvolved) edit.megaEvolved = true;
	// The while-active ability is state, not a set change: picking from the dropdown's second group sets
	// this instead of rewriting the team (see the audit's "Agreed design").
	if (form.currentAbility !== initial.currentAbility) {
		edit.ability = form.currentAbility || form.ability;
	}
	if (form.timesAttacked !== initial.timesAttacked) {
		const hits = toNumber(form.timesAttacked);
		if (isNaN(hits) || hits < 0) return null;
		edit.timesAttacked = hits;
	}

	const changes: AnalysisEdits = {};
	if (Object.keys(edit).length) changes.pokemon = { [`${target.side}:${target.teamSlot}`]: edit };
	if (form.activeSlot !== null) changes.active = { [target.side]: activeSlots(form.activeSlot, target.teamSlot) };

	if (setChanged(initial, form)) {
		const level = toNumber(form.level);
		if (isNaN(level) || level < 1 || level > 9999) return null;
		const evs = {} as { [stat in StatID]: number };
		const ivs = {} as { [stat in StatID]: number };
		for (const stat of STAT_IDS) {
			const ev = toNumber(form.evs[stat]);
			const iv = toNumber(form.ivs[stat]);
			const maxPoints = (snapshot.formatId || '').includes('champions') ? 32 : 255;
			if (isNaN(ev) || ev < 0 || ev > maxPoints || isNaN(iv) || iv < 0 || iv > 31) return null;
			evs[stat] = ev;
			ivs[stat] = iv;
		}
		if (!form.moves.some(Boolean)) return null;
		const set = {
			...pokemon.set,
			species: form.species,
			gender: form.gender,
			level,
			teraType: form.teraType || undefined,
			nature: form.nature,
			ability: form.ability,
			item: form.item,
			moves: form.moves.filter(Boolean),
			evs,
			ivs,
		};
		changes.teams = { [target.side]: buildTeamEdit(snapshot, target, set) };
	}
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
			// volatiles are per effect, so a later save must not drop an earlier one
			if (previous?.volatiles || edit.volatiles) {
				combined.volatiles = { ...previous?.volatiles, ...edit.volatiles };
			}
			merged.pokemon[key] = combined;
		}
	}
	// a team edit is the whole roster, so a later save for a side replaces the earlier one outright
	if (changes.teams) merged.teams = { ...merged.teams, ...changes.teams };
	// per-side state is one value per side, so the same rule applies
	if (changes.sides) merged.sides = { ...merged.sides, ...changes.sides };
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

function mergePP(
	previous: { [moveid: string]: number } | undefined, changes: { [moveid: string]: number } | undefined
) {
	return { ...previous, ...changes };
}

/*********************************************************
 * Dropdown options, from the same data the teambuilder uses
 *********************************************************/

/** The move's id, for keying a PP edit. */
function moveIdOf(snapshot: AnalysisSnapshot, name: string) {
	return dexFor(snapshot).moves.get(name)?.id || '';
}

function isDoubles(snapshot: AnalysisSnapshot) {
	return snapshot.gameType !== 'singles';
}

/**
 * The volatile list for this Pokémon, with source-linked effects expanded to one option per foe slot in
 * doubles (in singles there is only one possible source, so they stay single options).
 *
 * Options the sim would refuse are listed but disabled with the reason, because `droppedEdits` is never
 * shown: without this they would look like they worked. The check reads the *form*, so changing Status to
 * Sleep enables Nightmare straight away, before anything is saved.
 */
function volatileOptions(snapshot: AnalysisSnapshot, form: PokemonForm): AnalysisMultiSelectOption[] {
	const doubles = isDoubles(snapshot);
	const selected = form.volatiles.map(key => key.split('#')[0]);
	const context: AnalysisVolatileContext = {
		status: form.status, ability: form.ability, item: form.item, types: form.types, selected, gen: snapshot.gen,
	};
	// mapped and concatenated rather than nested loops: the client build refuses a closure over a loop variable
	const groups = ANALYSIS_VOLATILES.filter(info =>
		!(info.minGen && snapshot.gen < info.minGen) && !(info.maxGen && snapshot.gen > info.maxGen)
	).map((info): AnalysisMultiSelectOption[] => {
		const blocker = info.exclusiveWith && selected.includes(info.exclusiveWith) ?
			ANALYSIS_VOLATILES.find(entry => entry.id === info.exclusiveWith) : null;
		const disabled = info.unavailable?.(context) ||
			(blocker ? `it can't be combined with ${blocker.name}` : undefined);
		if (!info.perFoeSlot || !doubles) return [{ key: info.id, label: info.name, search: info.id, disabled }];
		return [0, 1].map(slot => ({
			key: `${info.id}#${slot}`, label: `${info.name} (Slot ${slot + 1})`, search: info.id, disabled,
		}));
	});
	return ([] as AnalysisMultiSelectOption[]).concat(...groups);
}

/**
 * Only the volatiles that changed: added ones carry their source slot, removed ones are `null`. Sending the
 * whole set would make every save look like a change and defeat "revert to the original value removes the
 * edit". A source-linked volatile whose *slot* changed is sent as an add, which the server re-sources.
 */
function volatileChanges(initial: string[], form: string[]) {
	const edit: NonNullable<AnalysisPokemonStateEdit['volatiles']> = {};
	for (const key of form) {
		if (initial.includes(key)) continue;
		const [id, slot] = key.split('#');
		edit[id] = slot === undefined ? {} : { source: Number(slot) };
	}
	for (const key of initial) {
		if (form.includes(key)) continue;
		const id = key.split('#')[0];
		// a slot change is an add, not a removal: the add above already replaced it
		if (!(id in edit)) edit[id] = null;
	}
	return Object.keys(edit).length ? edit : undefined;
}

function dexFor(snapshot: AnalysisSnapshot) {
	try {
		return Dex.forFormat(snapshot.formatId);
	} catch {
		return Dex;
	}
}

/** Only the abilities this species actually has (the user's rule, not the calc's full list). */
export function abilityOptions(dex: any, species: string): string[] {
	const abilities = dex.species.get(species)?.abilities || {};
	const names: string[] = [];
	for (const slot of ['0', '1', 'H', 'S']) {
		const name = abilities[slot];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * The species' forme family, plus the Mega forme its item unlocks. Picking the Mega forme is how the calc
 * Mega Evolves, so the panel turns that selection into the `megaEvolved` state edit rather than a set change.
 */
export function formeOptions(dex: any, pokemon: AnalysisPokemonSnapshot, item: string): string[] {
	const base = dex.species.get(pokemon.set.species || pokemon.species);
	const baseSpecies = dex.species.get(base?.baseSpecies || base?.name);
	const names: string[] = [];
	const add = (name: string) => {
		if (name && !names.includes(name)) names.push(name);
	};
	add(baseSpecies?.name);
	for (const forme of baseSpecies?.otherFormes || []) {
		const species = dex.species.get(forme);
		// Mega formes belong here: picking one is how the calc Mega Evolves. Other battle-only formes
		// (Primal, Ultra Burst) aren't reachable from this panel.
		if (species?.isMega) {
			add(species.name);
			continue;
		}
		if (species?.isPrimal || species?.battleOnly) continue;
		add(species?.name);
	}
	add(base?.name);
	const megaSpecies = megaFormeFor(dex, item, base?.name || '');
	if (megaSpecies) add(megaSpecies);
	return names;
}

/**
 * The Mega forme a held stone unlocks, if any. The client stores `megaStone` as a map from the base
 * species to its Mega forme (`{Charizard: 'Charizard-Mega-X'}`), not as a plain string.
 */
export function megaFormeFor(dex: any, item: string, species: string) {
	const mega = dex.items.get(item)?.megaStone;
	if (!mega) return '';
	if (typeof mega === 'string') return mega;
	const base = dex.species.get(species)?.baseSpecies || species;
	return mega[base] || mega[species] || Object.values(mega)[0] as string || '';
}

/**
 * Legal items for the format and legal moves for the species, from `DexSearch` — the same lists the
 * teambuilder's search shows, so DigiPen, FNAF and Champions data all come out right (it picks the
 * per-format item table and merges the mod's learnset additions). The results are search rows,
 * `['item', id]` and `['move', id]` mixed with `['header', ...]` and a leading `['sortmove', '']`.
 *
 * Building the move list walks the species' whole learnset chain, so results are cached: the panel
 * re-renders on every keystroke.
 */
const OPTION_CACHE = new Map<string, string[]>();

function searchOptions(type: 'item' | 'move' | 'ability', formatId: string, set: any, cacheKey: string): string[] {
	const cached = OPTION_CACHE.get(cacheKey);
	if (cached) return cached;
	const names: string[] = [];
	try {
		const search = new DexSearch();
		search.setType(type, formatId, set);
		search.find('');
		const dex = search.dex || Dex;
		for (const row of search.results || []) {
			if (row[0] !== type || !row[1]) continue;
			let name;
			if (type === 'item') name = dex.items.get(row[1])?.name;
			else if (type === 'ability') name = dex.abilities.get(row[1])?.name;
			else name = dex.moves.get(row[1])?.name;
			if (name && !names.includes(name)) names.push(name);
		}
	} catch {
		// a missing search table shouldn't take the whole form down; the current value still shows
	}
	OPTION_CACHE.set(cacheKey, names);
	return names;
}

export function itemOptions(formatId: string, set: any): string[] {
	return searchOptions('item', formatId, set, `item|${formatId}`);
}

export function moveOptions(formatId: string, set: any): string[] {
	return searchOptions('move', formatId, set, `move|${formatId}|${set?.species || ''}`);
}

/**
 * Every ability the format has, alphabetically — what Skill Swap or Trace could have left on an active
 * Pokémon. Sourced from `DexSearch` like items and moves, so mod abilities are included.
 */
export function abilityListOptions(formatId: string): string[] {
	// Deliberately no species: `DexSearch` filters abilities to the set's own when given one, which is the
	// opposite of what this list is for — Skill Swap and Trace can leave anything on an active Pokémon.
	return [...searchOptions('ability', formatId, {}, `ability|${formatId}`)].sort();
}

/** Natures with their stat changes, as the teambuilder labels them. */
/** A move's PP with full PP Ups, which is what the sim gives a freshly built move slot. */
export function maxPPFor(dex: any, move: string) {
	const data = dex.moves.get(move);
	if (!data?.exists) return 0;
	const pp = data.pp || 0;
	return data.noPPBoosts || data.id === 'trumpcard' ? pp : Math.floor(pp * 8 / 5);
}

export function natureOptions(): { id: string, label: string }[] {
	const natures = typeof BattleNatures === 'undefined' ? null : BattleNatures;
	if (!natures) return [{ id: 'Serious', label: 'Serious' }];
	return Object.entries(natures).map(([name, nature]: [string, any]) => ({
		id: name,
		label: nature?.plus ?
			`${name} (+${BattleStatNames[nature.plus]}, -${BattleStatNames[nature.minus]})` : name,
	}));
}

function natureModifier(nature: string, stat: StatID) {
	const data = typeof BattleNatures === 'undefined' ? null : BattleNatures?.[nature];
	if (!data || stat === 'hp') return 1;
	if (data.plus === stat) return 1.1;
	if (data.minus === stat) return 0.9;
	return 1;
}

/**
 * The standard gen 3+ stat formula, so the table's totals follow the EVs, IVs and nature as they're typed.
 * Champions spends stat points instead of EVs, each worth 8 EVs, with IVs always perfect — the same
 * conversion the teambuilder makes (`if (this.isChampions) ev *= 8;`).
 */
export function computeStat(
	stat: StatID, base: number, ev: number, iv: number, level: number, nature: string
) {
	if (stat === 'hp') {
		if (base === 1) return 1; // Shedinja
		return Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + level + 10;
	}
	const raw = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5;
	return Math.floor(raw * natureModifier(nature, stat));
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
		state.initial = getPokemonForm(pokemon, isDoubles(snapshot));
		state.form = {
			...state.initial,
			boosts: { ...state.initial.boosts },
			volatiles: [...state.initial.volatiles],
			pp: [...state.initial.pp],
			moves: [...state.initial.moves],
			types: [...state.initial.types],
			evs: { ...state.initial.evs },
			ivs: { ...state.initial.ivs },
		};
	}

	update(changes: Partial<PokemonForm>) {
		const { state } = this.props;
		state.form = { ...state.form!, ...changes };
		this.forceUpdate();
	}

	numberInput(
		value: string, onInput: (text: string) => void,
		extra: { max?: number, label: string, valid: boolean, className?: string }
	) {
		return <input
			type="number" min="0" max={extra.max} step="1" aria-label={extra.label} title={extra.label}
			class={`textbox ${extra.className || 'analysis-field-turns'}${extra.valid ? '' : ' analysis-field-invalid'}`}
			value={value} disabled={this.props.disabled} data-pokemon-field={extra.label}
			onInput={event => onInput((event.target as HTMLInputElement).value)}
		/>;
	}

	select(
		value: string, options: (string | { id: string, label: string })[], onChange: (value: string) => void,
		extra: { label: string, allowEmpty?: string }
	) {
		const entries = options.map(option => typeof option === 'string' ? { id: option, label: option } : option);
		// an unknown current value still has to be selectable, or changing something else would lose it
		if (value && !entries.some(entry => entry.id === value)) entries.unshift({ id: value, label: value });
		return <select
			class="select" value={value} disabled={this.props.disabled}
			aria-label={extra.label} data-pokemon-select={extra.label}
			onChange={event => onChange((event.target as HTMLSelectElement).value)}
		>
			{extra.allowEmpty !== undefined && <option value="">{extra.allowEmpty}</option>}
			{entries.map(entry => <option value={entry.id}>{entry.label}</option>)}
		</select>;
	}

	/**
	 * The ability picker. A **benched** Pokémon gets its own abilities only, editing the set as before —
	 * nothing can have Skill Swapped a Pokémon that isn't on the field.
	 *
	 * An **active** one gets two groups (user request, 2026-09-19), because Skill Swap, Trace and Mega
	 * Evolution can give it anything. **Which group you pick from decides what is written**: its own
	 * abilities set the *set's* ability, as before; anything from the full list sets only the current,
	 * while-active ability, since "this was Traced into Intimidate" is not a claim about its team.
	 */
	abilitySelect(form: PokemonForm, dex: any, snapshot: AnalysisSnapshot, isActive: boolean) {
		const own = abilityOptions(dex, form.species);
		if (!isActive) {
			return this.select(form.ability, own, value => this.update({ ability: value, currentAbility: '' }), {
				label: 'Ability',
			});
		}
		const all = abilityListOptions(snapshot.formatId);
		// `current:` marks the second group, so an ability that appears in both stays unambiguous.
		const value = form.currentAbility ? `current:${toID(form.currentAbility)}` : form.ability;
		const onChange = (picked: string) => {
			if (picked.startsWith('current:')) {
				const name = all.find(entry => toID(entry) === picked.slice(8)) || '';
				this.update({ currentAbility: name });
			} else {
				this.update({ ability: picked, currentAbility: '' });
			}
		};
		return <select
			class="select" value={value} disabled={this.props.disabled}
			aria-label="Ability" data-pokemon-select="Ability"
			onChange={event => onChange((event.target as HTMLSelectElement).value)}
		>
			<optgroup label={`${form.species}'s abilities`}>
				{own.map(name => <option value={name}>{name}</option>)}
			</optgroup>
			<optgroup label="Set as its current ability">
				{all.map(name => <option value={`current:${toID(name)}`}>{name}</option>)}
			</optgroup>
		</select>;
	}

	/**
	 * Set Active, and nothing else: Tera and Mega live in the top group, as in the calc. Clicking it saves
	 * straight away — the same thing as picking it and pressing Save — since there is nothing to configure
	 * about it and the Pokémon stops being benched the moment it applies.
	 */
	renderActions(pokemon: AnalysisPokemonSnapshot, form: PokemonForm) {
		const { state, snapshot, target, disabled } = this.props;
		const slots = snapshot.sides[target.side === 'p1' ? 0 : 1]?.active.length || 1;
		// .map, not a loop: the client build rejects closures that capture loop variables
		// a fainted Pokémon can be sent out when the same save revives it; the server applies the HP with it
		const dead = toNumber(form.hp) <= 0;
		const slotList = pokemon.isActive || dead ? [] : Array.from({ length: slots }, (_, slot) => slot);
		if (!slotList.length) return null;
		return <div class="analysis-poke-actions">{slotList.map(slot => {
			const label = slots > 1 ? `Set Active: Slot ${slot + 1}` : 'Set Active';
			return <button
				type="button" data-label={label} data-field-effect={`active:${slot}`}
				class="analysis-field-button btn-single" disabled={disabled}
				onClick={() => {
					const next = { ...form, activeSlot: slot };
					state.form = next;
					const changes = getPokemonFormChanges(target, pokemon, state.initial!, next, snapshot);
					// an invalid field elsewhere in the form blocks the save; leave it picked so Save can retry
					if (changes) this.props.onSave(changes);
					else this.forceUpdate();
				}}
			>{label}</button>;
		})}</div>;
	}

	/** One field per row: types, forme, tera, level. Labels share a column so the inputs line up. */
	renderIdentity(pokemon: AnalysisPokemonSnapshot, form: PokemonForm, dex: any) {
		const { snapshot, disabled } = this.props;
		// Champions has no Terastallization, and neither does a format whose rules clause removes it
		const canTera = snapshot.rules?.terastallization && !(snapshot.formatId || '').includes('champions');
		const teraApplied = !!pokemon.terastallized;
		const teraTitle = teraApplied ? 'Uncheck to take this Terastallization back' : 'Terastallize this turn';
		const megaSpecies = megaFormeFor(dex, form.item, form.species);
		const formes = formeOptions(dex, pokemon, form.item);
		const typeList: string[] = dex.types?.all?.().map((type: any) => type.name).filter(Boolean) || [];
		const setType = (index: number, value: string) => {
			const types = [...form.types];
			types[index] = value;
			this.update({ types: types.filter(Boolean) });
		};
		return <div class="analysis-info-group">
			<div class="analysis-info-line">
				<label>Type</label>
				<span class="analysis-info-value">
					{this.select(form.types[0] || '', typeList, value => setType(0, value), { label: 'Type 1' })}
					{this.select(form.types[1] || '', typeList, value => setType(1, value), {
						label: 'Type 2', allowEmpty: '(none)',
					})}
				</span>
			</div>
			<div class="analysis-info-line">
				<label>Forme</label>
				<span class="analysis-info-value">
					{this.select(form.megaEvolved && megaSpecies ? megaSpecies : form.species, formes, value => {
						// picking the Mega forme Mega Evolves, the way the calc's forme dropdown does
						if (megaSpecies && value === megaSpecies) this.update({ megaEvolved: true });
						else this.update({ species: value, megaEvolved: false });
					}, { label: 'Forme' })}
				</span>
			</div>
			{canTera && <div class="analysis-info-line">
				<label>Tera</label>
				<span class="analysis-info-value">
					{this.select(form.teraType, typeList, value => this.update({ teraType: value }), { label: 'Tera Type' })}
					<label class="analysis-info-checkbox" title={teraTitle}>
						<input
							type="checkbox" checked={form.terastallized} data-pokemon-field="Terastallized"
							disabled={disabled}
							onChange={event => this.update({ terastallized: (event.target as HTMLInputElement).checked })}
						/> Terastallized
					</label>
				</span>
			</div>}
			<div class="analysis-info-line">
				<label>Level</label>
				<span class="analysis-info-value">
					{this.numberInput(form.level, text => this.update({ level: text }), {
						max: 100, label: 'Level', valid: toNumber(form.level) >= 1, className: 'analysis-number-input',
					})}
				</span>
			</div>
		</div>;
	}

	/** Base stats as text, EV/IV inputs, boost dropdowns, and a live total. */
	renderStats(pokemon: AnalysisPokemonSnapshot, form: PokemonForm, dex: any) {
		const { snapshot } = this.props;
		const species = dex.species.get(form.species);
		const baseStats = species?.baseStats || {};
		const isChampions = (snapshot.formatId || '').includes('champions');
		const pointLabel = isChampions ? 'SPs' : 'EVs';
		// Champions spends 32 stat points per stat rather than 252 EVs (battle-team-editor.tsx)
		const maxPoints = isChampions ? 32 : 255;
		const level = toNumber(form.level);
		const saved: { [stat in StatID]: number } = {
			hp: pokemon.maxhp, atk: pokemon.stats.atk, def: pokemon.stats.def,
			spa: pokemon.stats.spa, spd: pokemon.stats.spd, spe: pokemon.stats.spe,
		};
		return <div class="analysis-info-group">
			<table class="analysis-stat-table">
				<tr>
					<th>Stat</th><th>Base</th><th>{pointLabel}</th>
					{!isChampions && <th>IVs</th>}
					{pokemon.isActive && <th>Boost</th>}
					<th>Total</th>
				</tr>
				{STAT_IDS.map(stat => {
					const base = baseStats[stat] ?? 0;
					const ev = toNumber(form.evs[stat]);
					const iv = toNumber(form.ivs[stat]);
					// Champions spends stat points worth 8 EVs each, with IVs always perfect
					const total = isNaN(ev) || isNaN(level) || (!isChampions && isNaN(iv)) ? saved[stat] :
						computeStat(stat, base, isChampions ? ev * 8 : ev, isChampions ? 31 : iv, level, form.nature);
					return <tr>
						<td>{STAT_LABELS[stat]}</td>
						<td class="analysis-stat-base">{base}</td>
						<td>{this.numberInput(form.evs[stat], text => this.update({ evs: { ...form.evs, [stat]: text } }), {
							max: maxPoints, label: `${STAT_LABELS[stat]} ${pointLabel}`, valid: ev >= 0 && ev <= maxPoints,
							className: 'analysis-stat-input',
						})}</td>
						{!isChampions && <td>
							{this.numberInput(form.ivs[stat], text => this.update({ ivs: { ...form.ivs, [stat]: text } }), {
								max: 31, label: `${STAT_LABELS[stat]} IVs`, valid: iv >= 0 && iv <= 31,
								className: 'analysis-stat-input',
							})}
						</td>}
						{pokemon.isActive && <td>{stat === 'hp' ? '—' : this.boostSelect(form, stat as any)}</td>}
						<td class="analysis-stat-total">{total}</td>
					</tr>;
				})}
			</table>
			{pokemon.isActive && <div class="analysis-info-row">{EXTRA_BOOSTS.map(boost => <div class="analysis-info-field">
				<label>{boost.label}</label>
				{this.boostSelect(form, boost.id)}
			</div>)}</div>}
		</div>;
	}

	boostSelect(form: PokemonForm, stat: keyof PokemonForm['boosts']) {
		return <select
			class="select analysis-boost-select" value={`${form.boosts[stat]}`} disabled={this.props.disabled}
			aria-label={`${stat} boost`} data-pokemon-boost={stat}
			onChange={event => this.update({
				boosts: { ...form.boosts, [stat]: Number((event.target as HTMLSelectElement).value) },
			})}
		>{BOOST_LEVELS.map(level => <option value={`${level}`}>{boostLabel(level)}</option>)}</select>;
	}

	/**
	 * Nature, ability, item and status in a 2x2 block, then volatiles on a full-width row below it (active
	 * Pokémon only), so the volatiles combobox gets the panel's whole width.
	 */
	renderSelectors(
		pokemon: AnalysisPokemonSnapshot, form: PokemonForm, dex: any, items: string[], snapshot: AnalysisSnapshot
	) {
		const row = (label: string, control: any) => <div class="analysis-info-line">
			<label>{label}</label>
			<span class="analysis-info-value">{control}</span>
		</div>;
		return <div class="analysis-info-group">
			<div class="analysis-info-grid">
				{row('Nature', this.select(form.nature, natureOptions(), value => this.update({ nature: value }), {
					label: 'Nature',
				}))}
				{row('Ability', this.abilitySelect(form, dex, snapshot, pokemon.isActive))}
				{row('Item', this.select(form.item, items, value => this.update({ item: value }), {
					label: 'Item', allowEmpty: '(none)',
				}))}
				{row('Status', <>
					<select
						class="select" value={form.status} disabled={this.props.disabled}
						aria-label="Status" data-pokemon-select="Status"
						onChange={event => this.update({
							status: (event.target as HTMLSelectElement).value as PokemonForm['status'],
						})}
					>{STATUSES.map(status => <option value={status.id}>{status.label}</option>)}</select>
					{/* the toxic counter only ticks while the Pokémon is on the field */}
					{form.status === 'tox' && pokemon.isActive && <select
						class="select analysis-toxic-select" value={form.toxicStage} disabled={this.props.disabled}
						aria-label="Toxic counter" data-pokemon-select="Toxic counter"
						onChange={event => this.update({ toxicStage: (event.target as HTMLSelectElement).value })}
					>{TOXIC_STAGES.map(stage => <option value={`${stage}`}>{stage}/16</option>)}</select>}
					{form.status === 'slp' && this.numberInput(form.sleepTurns, text => this.update({ sleepTurns: text }), {
						max: 9, label: 'Sleep turns', valid: toNumber(form.sleepTurns) >= 1, className: 'analysis-stat-input',
					})}
				</>)}
			</div>
			{/* volatiles are only meaningful on the field, and the wide row gives the combobox the full panel */}
			{pokemon.isActive && <div class="analysis-info-line">
				<label>Volatiles</label>
				<span class="analysis-info-value">
					<AnalysisMultiSelect
						value={form.volatiles} options={volatileOptions(snapshot, form)}
						onChange={volatiles => this.update({ volatiles })}
						idPrefix="analysis-volatiles" label="Volatiles" placeholder="Add a volatile…"
						disabled={this.props.disabled}
					/>
				</span>
			</div>}
		</div>;
	}

	renderHP(pokemon: AnalysisPokemonSnapshot, form: PokemonForm) {
		const hp = toNumber(form.hp);
		const valid = !isNaN(hp) && hp >= (pokemon.isActive ? 1 : 0) && hp <= pokemon.maxhp;
		const percent = valid ? `${Math.round(1000 * hp / pokemon.maxhp) / 10}` : '';
		return <div class="analysis-info-group">
			<div class="analysis-info-line">
				<label>Current HP</label>
				<span class="analysis-info-value">
					{this.numberInput(form.hp, text => this.update({ hp: text }), {
						max: pokemon.maxhp, label: 'HP', valid, className: 'analysis-number-input',
					})}
					<span>/ {pokemon.maxhp} (</span>
					{this.numberInput(percent, text => {
						const value = Number(text);
						if (!text.trim() || isNaN(value)) return;
						const lowest = pokemon.isActive ? 1 : 0;
						this.update({ hp: `${Math.min(pokemon.maxhp, Math.max(lowest, Math.round(value * pokemon.maxhp / 100)))}` });
					}, { max: 100, label: 'HP percent', valid, className: 'analysis-number-input' })}
					<span>%)</span>
				</span>
			</div>
		</div>;
	}

	/**
	 * One row per move: which move it is, then `X / Y PP` with X editable.
	 *
	 * Always at least four rows, so a Pokémon that has fewer than four moves can be given the rest. That
	 * is the normal case on a Set Up Position tab, whose placeholders start with none at all; empty slots
	 * are dropped from the saved set (see getPokemonFormChanges).
	 */
	renderMoves(pokemon: AnalysisPokemonSnapshot, form: PokemonForm, dex: any, moveList: string[]) {
		const slots = Array.from({ length: Math.max(form.moves.length, 4) }, (_, slot) => slot);
		return <div class="analysis-info-group">{slots.map(slot => {
			const name = form.moves[slot] || '';
			const changed = name !== (this.props.state.initial?.moves[slot] || '');
			// a move the user just picked isn't in the snapshot yet, so its max PP comes from the dex
			const maxpp = changed ? maxPPFor(dex, name) : pokemon.moves[slot]?.maxpp ?? 0;
			const pp = toNumber(form.pp[slot] ?? '');
			return <div class="analysis-move-row">
				{this.select(name, moveList, value => {
					const moves = [...form.moves];
					moves[slot] = value;
					const nextPP = [...form.pp];
					// a newly chosen move starts at full PP
					nextPP[slot] = `${maxPPFor(dex, value)}`;
					this.update({ moves, pp: nextPP });
				}, { label: `Move ${slot + 1}`, allowEmpty: '(none)' })}
				{/*
					Rage Fist's power comes from how many hits the Pokémon has taken, which a rebuilt battle
					has no way to know — so it gets an input, beside the move it belongs to (user request,
					2026-09-19). Every other history counter is restored by the replay parser and never shown.
				*/}
				{toID(name) === 'ragefist' && <span class="analysis-move-hits">
					{this.numberInput(form.timesAttacked, text => this.update({ timesAttacked: text }), {
						label: 'Times Attacked', className: 'analysis-stat-input',
						valid: toNumber(form.timesAttacked) >= 0,
					})}
					<span>hits taken</span>
				</span>}
				<span class="analysis-move-pp">
					{this.numberInput(form.pp[slot] ?? '', text => {
						const nextPP = [...form.pp];
						nextPP[slot] = text;
						this.update({ pp: nextPP });
					}, {
						max: maxpp || undefined, label: `${name || `Move ${slot + 1}`} PP`,
						valid: pp >= 0 && (!maxpp || pp <= maxpp), className: 'analysis-stat-input',
					})}
					<span>/ {maxpp} PP</span>
				</span>
			</div>;
		})}</div>;
	}

	override render() {
		const pokemon = this.pokemon();
		if (!pokemon) return null;
		this.resetIfNeeded(pokemon);
		const { state, target, snapshot, disabled } = this.props;
		const form = state.form!;
		const dex = dexFor(snapshot);
		const changes = getPokemonFormChanges(target, pokemon, state.initial!, form, snapshot);
		const changed = !changes || !!changes.pokemon || !!changes.active || !!changes.teams;
		const teamNumber = target.side === 'p1' ? 1 : 2;
		// the set as the search expects it, so item ordering and move legality match the teambuilder
		const searchSet = { ...pokemon.set, species: form.species, ability: form.ability, moves: form.moves };
		const items = itemOptions(snapshot.formatId, searchSet);
		const moves = moveOptions(snapshot.formatId, searchSet);
		return <div class="analysis-field-editor analysis-poke-info">
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
			{/*
			  * A fainted Pokémon still gets the whole form, because HP 0 is now something the form itself can
			  * set: without this, a stray 0 would be unremovable, since the panel is the only way to take the
			  * edit off again. Setting HP above 0 revives it.
			  */}
			{this.renderActions(pokemon, form)}
			{this.renderIdentity(pokemon, form, dex)}
			{this.renderHP(pokemon, form)}
			{this.renderStats(pokemon, form, dex)}
			{this.renderSelectors(pokemon, form, dex, items, snapshot)}
			{this.renderMoves(pokemon, form, dex, moves)}
		</div>;
	}
}
