/**
 * DigiPen fork: the custom content ("fakemon") mods, as the browser sees them.
 *
 * The list itself is the server's `data/custom-mods.ts`, shipped to the client by `build-indexes`
 * on `BattleTeambuilderTable.customMods`. Nothing here is per-mod: adding a mod to that file is
 * what teaches the client about it.
 *
 * This file is part of the `battledata.js` bundle, which every page loads before `battle.js` and
 * `battle-dex-search.js`, so both can use it.
 */

interface CustomModInfo {
	/** Mod id, i.e. the folder under the server's `data/mods/`. */
	id: string;
	/** Short label: the `isNonstandard` value its own content carries, and its tier stem. */
	label: string;
	/** Full name, for the format dropdown's section labels. */
	fullName: string;
	/** Format-id and tag prefix. */
	prefix: string;
}

/**
 * Which pool a format draws from. Every mod gets one teambuilder table per flavour, and the eight
 * generated formats map onto them by name — no per-format special cases, which is what used to go
 * wrong whenever a format was added and its `case` forgotten.
 */
type CustomModFlavor = 'singles' | 'natdex' | 'vgc';

/**
 * Just enough of a species and a dex for the checks below. This file is a script rather than a
 * module — its declarations have to be globals for the other client sources to see them — so it
 * cannot import `Dex.Species` or `ModdedDex` and describes what it needs structurally instead.
 */
interface CustomModSpeciesLike {
	name: string;
	baseSpecies?: string;
	tags?: readonly string[];
}
interface CustomModDexLike {
	species: { get: (name: string) => CustomModSpeciesLike };
}

interface CustomModFormat {
	mod: CustomModInfo;
	flavor: CustomModFlavor;
	/** The teambuilder table holding this format's Pokemon, items and learnset additions. */
	table: string;
	/** `formatid` with the mod's prefix removed, for any further parsing the caller wants. */
	rest: string;
}

const BattleCustomMods = new class {
	/** The mods the server shipped to this client. */
	all(): CustomModInfo[] {
		return (window as any).BattleTeambuilderTable?.customMods || [];
	}

	/** The mod whose own content carries this `isNonstandard` value, if any. */
	byLabel(label: string | null | undefined): CustomModInfo | null {
		if (!label) return null;
		return this.all().find(mod => mod.label === label) || null;
	}

	/** The mod a format belongs to, and which of its tables that format uses. */
	forFormat(formatid: string): CustomModFormat | null {
		let id = formatid;
		if (id.startsWith('gen9')) id = id.slice(4);
		for (const mod of this.all()) {
			if (!id.startsWith(mod.prefix)) continue;
			const rest = id.slice(mod.prefix.length);
			return { mod, flavor: this.flavorOf(rest), table: this.tableFor(mod, this.flavorOf(rest)), rest };
		}
		return null;
	}

	/**
	 * The mod a battle is being played in. Battles identify their format by display name
	 * (`[Gen 9 FNAF] Singles`) rather than by id.
	 */
	forTier(tier: string): CustomModInfo | null {
		if (!tier) return null;
		return this.all().find(mod => tier.includes(mod.label)) || null;
	}

	/** Derived from the format name, so a new format of an existing shape needs no code change. */
	flavorOf(rest: string): CustomModFlavor {
		if (rest.startsWith('vgc') || rest.startsWith('bss') || rest.startsWith('battlestadium')) return 'vgc';
		if (rest.includes('nationaldex') || rest.includes('natdex') || rest.startsWith('nd')) return 'natdex';
		return 'singles';
	}

	tableFor(mod: CustomModInfo, flavor: CustomModFlavor): string {
		return `gen9${mod.prefix}${flavor === 'singles' ? '' : flavor}`;
	}

	/** A mod's three tier names, in teambuilder order. Mirrors the server's `getCustomModTiers`. */
	tiers(mod: CustomModInfo) {
		return { fe: mod.label, nfe: `${mod.label} NFE`, lc: `${mod.label} LC` };
	}

	/**
	 * Pokemon a mod's National Dex format bans but its National Dex Ubers allows, so the
	 * teambuilder list matches what the validator accepts.
	 *
	 * Mirrors the banlist in the server's `config/custom-formats.ts`. Arceus is tagged Mythical
	 * rather than Restricted Legendary, so it has to be named; banning it there covers every forme,
	 * hence the check against the base species here.
	 */
	nationalDexBanned(species: CustomModSpeciesLike, dex: CustomModDexLike): boolean {
		const baseName = species.baseSpecies || species.name;
		if (baseName === 'Arceus') return true;
		if (species.tags?.includes('Restricted Legendary')) return true;
		// Unlike the server's dex, the client's does not copy a base species' tags onto its formes,
		// so Calyrex-Shadow and Rayquaza-Mega carry no tags of their own. Look the base species up,
		// the same way the VGC restricted check in battle-dex-search.ts does.
		const base = dex.species.get(baseName);
		return !!base.tags?.includes('Restricted Legendary');
	}

	/** True when this entry is one mod's exclusive content. */
	isModContent(entry: { isNonstandard?: string | null } | null | undefined): boolean {
		return !!entry && !!this.byLabel(entry.isNonstandard);
	}

	/**
	 * Whether a move, item or ability belongs in a given format's lists.
	 *
	 * A mod's own content shows only in that mod's formats; everything else is left to the caller's
	 * ordinary rules.
	 */
	allowsEntry(entry: { isNonstandard?: string | null }, current: CustomModFormat | null): boolean {
		const owner = this.byLabel(entry.isNonstandard);
		if (!owner) return true;
		return !!current && current.mod.id === owner.id;
	}
}();

/**
 * Battle sprites that have no art yet fall back to the unknown-species sprite.
 *
 * Icons and teambuilder sprites are CSS backgrounds, so they can stack a fallback layer and need no
 * script. Battle sprites are `<img>` elements built in five different places in
 * `battle-animations.ts`, so rather than edit each one, a single capture-phase listener catches the
 * load failure. `error` does not bubble from an image, but it can still be caught on the way down.
 */
if (typeof document !== 'undefined' && document.addEventListener) {
	document.addEventListener('error', e => {
		const img = e.target as HTMLImageElement | null;
		if (img?.tagName !== 'IMG' || img.dataset.customArtFallback) return;
		const dex = (window as any).Dex;
		if (!dex?.resourcePrefixCustom || !img.src.startsWith(dex.resourcePrefixCustom)) return;
		// Marked so a missing fallback cannot loop.
		img.dataset.customArtFallback = '1';
		img.src = `${dex.resourcePrefix}sprites/gen5/0.png`;
	}, true);
}

declare const require: any;
declare const global: any;

// Same as battle-dex.ts: under Node (the client's tests) the bundle's top-level bindings are
// module-scoped, so the ones other files expect as globals have to be published explicitly.
if (typeof require === 'function') {
	global.BattleCustomMods = BattleCustomMods;
}
