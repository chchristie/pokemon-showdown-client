'use strict';

/**
 * DigiPen fork: everything `build-indexes` needs to know about the custom content mods.
 *
 * `build-indexes` is an upstream file and the fork's worst merge conflict surface, so the mod logic
 * lives here and is called from the smallest hooks the build loop allows. Adding a mod means adding
 * an entry to the server's `data/custom-mods.ts` — nothing in this file or in `build-indexes`
 * should need to change.
 *
 * The build loop identifies each pass by a `genIdent`. Upstream's are numbers, and a lot of code
 * reads them by suffix (`.1` for National Dex, `.5` for VGC, and so on). The custom mods use their
 * **table name** as the identifier instead: a string never matches any of those numeric tests, so
 * no mod pass can collide with an upstream one, and no magic numbers have to be allocated by hand.
 */

const { CustomMods, getCustomModTiers } = require('../caches/pokemon-showdown/dist/data/custom-mods');

/**
 * The format flavours each mod gets a teambuilder table for. These line up with the eight formats
 * generated in the server's `config/custom-formats.ts`:
 *   singles — the mod-only `Singles` format
 *   natdex  — `National Dex` and `National Dex Ubers`
 *   vgc     — the five VGC formats, which draw from the National Dex
 */
const FLAVORS = ['singles', 'natdex', 'vgc'];

/** One teambuilder table per mod per flavour. `id` is both the table name and the loop's pass key. */
const CustomModTables = [];
for (const mod of CustomMods) {
	for (const flavor of FLAVORS) {
		CustomModTables.push({
			mod,
			flavor,
			label: mod.label,
			tiers: getCustomModTiers(mod.label),
			id: `gen9${mod.prefix}${flavor === 'singles' ? '' : flavor}`,
			isDoubles: flavor === 'vgc',
		});
	}
}

const tablesById = new Map(CustomModTables.map(table => [table.id, table]));

/** The custom mod pass being built, or undefined for an ordinary gen pass. */
function customModTable(genIdent) {
	return tablesById.get(genIdent);
}

/** Every tier name the custom mods introduce, to be merged into the `formatSlices` whitelist. */
function customModTierNames() {
	const names = {};
	for (const table of CustomModTables) {
		for (const tier of Object.values(table.tiers)) names[tier] = 1;
	}
	return names;
}

/** Which teambuilder section a species belongs to, for one custom mod pass. */
function customModSpeciesTier(table, species, baseSpecies) {
	const isModSpecies = species.isNonstandard === table.label;

	// The mod-only formats ban everything else outright.
	if (table.flavor === 'singles') return isModSpecies ? species.tier : 'Illegal';

	if (table.flavor === 'natdex') return isModSpecies ? species.tier : species.natDexTier;

	// VGC draws from the National Dex and groups by what counts against the restricted limit, so a
	// mod Pokémon tagged Mythical or Restricted sorts with the others rather than into its own
	// section.
	if (baseSpecies.tags.includes('Mythical')) return 'Mythical';
	if (baseSpecies.tags.includes('Restricted Legendary')) return 'Restricted';
	if (isModSpecies) return species.tier;
	if (species.natDexTier === 'Illegal' || species.natDexTier === 'Unreleased') return 'Illegal';
	if (species.natDexTier === 'NFE') return 'NFE';
	if (species.natDexTier === 'LC') return 'LC';
	return 'Regular';
}

/** Section order for one custom mod pass: the mod's own tiers interleaved with the standard ones. */
function customModTierOrder(table) {
	const { fe, nfe, lc } = table.tiers;
	if (table.flavor === 'singles') return [fe, nfe, lc];
	if (table.flavor === 'natdex') {
		return [
			fe, 'AG', 'Uber', '(Uber)',
			'OU', '(OU)', 'UUBL', 'UU', 'RUBL', 'RU', 'NUBL', 'NU', 'PUBL', 'PU', 'ZUBL', 'ZU', 'New',
			nfe, 'NFE', lc, 'LC', 'Unreleased',
		];
	}
	return ['Mythical', 'Restricted', fe, 'Regular', nfe, 'NFE', lc, 'LC'];
}

/** Header text for one of a mod's own sections, or null if this isn't one. */
function customModTierHeader(table, tier) {
	if (tier === table.tiers.nfe) return `${table.label} NFEs`;
	if (tier === table.tiers.lc) return `${table.label} LCs`;
	return null;
}

/** Point a mod's slices at a sensible neighbour when the pass produced no Pokémon for them. */
function customModFormatSlices(table, formatSlices) {
	const { fe, nfe, lc } = table.tiers;
	if (formatSlices[fe] === undefined) formatSlices[fe] = 0;
	if (formatSlices[nfe] === undefined) formatSlices[nfe] = formatSlices['NFE'] ?? formatSlices[fe];
	if (formatSlices[lc] === undefined) formatSlices[lc] = formatSlices['LC'] ?? formatSlices[nfe];
}

/**
 * The moves a mod adds to a base-game Pokémon's movepool.
 *
 * The server merges a mod's learnset additions onto the inherited movepool (see the server's
 * `data/custom-mod-init.ts`), so a mod's learnset for a base-game Pokémon is now the *whole*
 * movepool. Only the difference belongs in the client's tables: writing the whole thing back would
 * stamp every one of that Pokémon's moves with this mod's source flag.
 */
function customModLearnsetAdditions(Dex, modId, speciesId) {
	const modLearnset = Dex.mod(modId).data.Learnsets[speciesId]?.learnset;
	if (!modLearnset) return null;
	const baseLearnset = Dex.data.Learnsets[speciesId]?.learnset;
	if (!baseLearnset) return modLearnset;
	const additions = {};
	for (const moveid in modLearnset) {
		if (!baseLearnset[moveid]) additions[moveid] = modLearnset[moveid];
	}
	return additions;
}

/**
 * The short label shown next to a Pokémon's icon in the teambuilder.
 *
 * The section headers already say which are the mod's, so the per-row label uses the familiar tier
 * name instead of repeating the mod's. Base-game Pokémon keep whatever the pass gave them, which
 * for the National Dex flavours is their National Dex tier.
 */
function customModOverrideTier(table, species, currentTier) {
	if (species.isNonstandard !== table.label) return currentTier;
	const { nfe, lc } = table.tiers;
	if (species.tier === nfe) return 'NFE';
	if (species.tier === lc) return 'LC';
	return table.flavor === 'vgc' ? 'DOU' : 'OU';
}

/**
 * Whether a nonstandard item belongs in one custom mod pass's item list.
 *
 * Every generated format runs `NatDex Mod` and adds `+Future`, so Past and Future items — mega
 * stones, Z-crystals, the Champions mega stones — are legal in all of them, including the mod-only
 * ones. What is not legal is another mod's exclusive items.
 */
function customModAllowsItem(table, item) {
	const tag = item.isNonstandard;
	if (!tag) return true;
	if (tag === table.label) return true;
	if (customModOf(item)) return false;
	return tag === 'Past' || tag === 'Future' || tag === 'Unobtainable';
}

/** Run `fn(mod)` for every custom content mod. */
function forEachCustomMod(fn) {
	for (const mod of CustomMods) fn(mod);
}

/** The four data tables a mod can add entries to, and the search-index word for each. */
const DATA_KINDS = [
	{ table: 'Pokedex', word: 'pokemon', getter: 'species' },
	{ table: 'Moves', word: 'move', getter: 'moves' },
	{ table: 'Abilities', word: 'ability', getter: 'abilities' },
	{ table: 'Items', word: 'item', getter: 'items' },
];

/**
 * Run `fn(id, entry, kind, mod)` for every entry a custom mod adds that the base game does not have.
 *
 * A mod's `data.*` tables include everything it inherited, so anything already in the base dex has
 * to be skipped — injecting those would overwrite real base-game entries.
 */
function forEachNewCustomModEntry(Dex, fn) {
	for (const mod of CustomMods) {
		const modDex = Dex.mod(mod.id);
		for (const kind of DATA_KINDS) {
			for (const id in modDex.data[kind.table]) {
				if (Dex.data[kind.table][id]) continue;
				fn(id, modDex[kind.getter].get(id), kind, mod);
			}
		}
	}
}

/** True when this species/move/item/ability belongs to a custom mod rather than the base game. */
function customModOf(thing) {
	return CustomMods.find(mod => thing.isNonstandard === mod.label);
}

module.exports = {
	CustomMods,
	CustomModTables,
	customModTable,
	customModTierNames,
	customModSpeciesTier,
	customModTierOrder,
	customModTierHeader,
	customModFormatSlices,
	customModOverrideTier,
	customModAllowsItem,
	customModLearnsetAdditions,
	forEachCustomMod,
	forEachNewCustomModEntry,
	DATA_KINDS,
	customModOf,
};

/**
 * Inject every custom mod's own entries into a client data table.
 *
 * All four tables work the same way: an entry the base game already has gets the mod's display-only
 * overlay fields copied onto it, and an entry only the mod has is created from scratch, tagged with
 * that mod's label so `battle-dex-search` can filter it out of other formats.
 *
 * `overlay` lists the fields copied onto an existing entry; `build` makes a new entry.
 */
function injectCustomModEntries(Dex, target, kind, { overlay, build }) {
	for (const mod of CustomMods) {
		const modDex = Dex.mod(mod.id);
		for (const id in modDex.data[kind.table]) {
			const entry = modDex[kind.getter].get(id);
			// A mod's data tables include everything it inherited, so anything already present is a
			// base-game or earlier-mod entry: overlay it rather than replacing it, which would strip
			// fields like baseSpecies, forme and evos.
			if (target[id]) {
				overlay(target[id], entry);
				continue;
			}
			target[id] = build(entry, mod, modDex);
			overlay(target[id], entry);
		}
	}
}

/** Display-only fields a mod may add to any kind of entry. */
function overlayCommon(target, entry) {
	if (entry.modified) target.modified = entry.modified;
	if (entry.dexEntry) target.dexEntry = entry.dexEntry;
	if (entry.contributors && entry.contributors.length) target.contributors = entry.contributors;
}

/** Display-only fields a mod may add to a species. */
function overlaySpecies(target, species) {
	if (species.customSprite) target.customSprite = true;
	if (species.customIcon !== undefined) target.customIcon = species.customIcon;
	if (species.modified) target.modified = species.modified;
	if (species.title) target.title = species.title;
	if (species.dexEntry) target.dexEntry = species.dexEntry;
	if (species.habitat) target.habitat = species.habitat;
	if (species.notes) target.notes = species.notes;
	if (species.contributors && species.contributors.length) target.contributors = species.contributors;
	if (species.artSource && (species.artSource.artist || species.artSource.url)) {
		target.artSource = { artist: species.artSource.artist, url: species.artSource.url };
	}
}

function buildSpecies(species) {
	const entry = {
		num: species.num,
		name: species.name,
		types: species.types,
		baseStats: species.baseStats,
		abilities: { 0: species.abilities[0] },
		heightm: species.heightm,
		weightkg: species.weightkg,
		color: species.color,
		eggGroups: species.eggGroups,
		isNonstandard: species.isNonstandard,
	};
	if (species.gender) entry.gender = species.gender;
	if (species.abilities[1]) entry.abilities[1] = species.abilities[1];
	if (species.abilities.H) entry.abilities.H = species.abilities.H;
	if (species.baseSpecies && species.baseSpecies !== species.name) entry.baseSpecies = species.baseSpecies;
	if (species.forme) entry.forme = species.forme;
	if (species.prevo) entry.prevo = species.prevo;
	if (species.evos && species.evos.length) entry.evos = species.evos;
	if (species.evoType) entry.evoType = species.evoType;
	if (species.evoLevel) entry.evoLevel = species.evoLevel;
	if (species.evoMove) entry.evoMove = species.evoMove;
	if (species.evoItem) entry.evoItem = species.evoItem;
	if (species.evoCondition) entry.evoCondition = species.evoCondition;
	if (species.requiredItem) entry.requiredItem = species.requiredItem;
	if (species.otherFormes && species.otherFormes.length) entry.otherFormes = species.otherFormes;
	if (species.formeOrder && species.formeOrder.length) entry.formeOrder = species.formeOrder;
	// Derived from the evolution line by the server, not written in formats-data.
	if (species.tier) entry.tier = species.tier;
	return entry;
}

function buildMove(move, mod) {
	const entry = {
		num: move.num,
		accuracy: move.accuracy,
		basePower: move.basePower,
		category: move.category,
		name: move.name,
		pp: move.pp,
		priority: move.priority,
		flags: move.flags,
		type: move.type,
		target: move.target,
		isNonstandard: mod.label,
	};
	if (move.desc) entry.desc = move.desc;
	if (move.shortDesc) entry.shortDesc = move.shortDesc;
	return entry;
}

function buildItem(item, mod) {
	const entry = { num: item.num, name: item.name, isNonstandard: mod.label };
	if (item.spritenum) entry.spritenum = item.spritenum;
	if (item.desc) entry.desc = item.desc;
	if (item.shortDesc) entry.shortDesc = item.shortDesc;
	if (item.megaStone) entry.megaStone = item.megaStone;
	if (item.megaEvolves) entry.megaEvolves = item.megaEvolves;
	if (item.itemUser) entry.itemUser = item.itemUser;
	return entry;
}

function buildAbility(ability, mod) {
	const entry = { num: ability.num, name: ability.name, isNonstandard: mod.label };
	if (ability.desc) entry.desc = ability.desc;
	if (ability.shortDesc) entry.shortDesc = ability.shortDesc;
	return entry;
}

const INJECTORS = {
	Pokedex: { kind: DATA_KINDS[0], overlay: overlaySpecies, build: buildSpecies },
	Moves: { kind: DATA_KINDS[1], overlay: overlayCommon, build: buildMove },
	Abilities: { kind: DATA_KINDS[2], overlay: overlayCommon, build: buildAbility },
	Items: { kind: DATA_KINDS[3], overlay: overlayCommon, build: buildItem },
};

/** Inject every custom mod's entries into one of the client's four data tables. */
function injectCustomMods(Dex, target, tableName) {
	const spec = INJECTORS[tableName];
	injectCustomModEntries(Dex, target, spec.kind, spec);
}

module.exports.injectCustomMods = injectCustomMods;
