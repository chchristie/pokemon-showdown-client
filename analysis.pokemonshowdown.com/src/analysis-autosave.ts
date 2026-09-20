import {
	buildAnalysisExport, tabFromAnalysisExport, validateAnalysisExport, type AnalysisExport,
} from './analysis-export';
import type { AnalysisSideID, AnalysisTab } from './analysis-model';

/**
 * Autosaving the open tabs, so a reload does not lose work (docs/analysis/plan.md, Phase 6 extra).
 *
 * **This is the export format, one entry per tab.** `buildAnalysisExport` already writes everything that
 * cannot be rebuilt — the teams, the root seed, and per node the seed, the edits and the choices — and
 * `tabFromAnalysisExport` already turns that back into a tab with no position, which the caller rebuilds
 * through the same `/analysis/start` call selecting a node makes. Growing a second serializer here would
 * mean two formats to keep correct, and the export has already been wrong once in a way only a round trip
 * caught (see `AnalysisExportNode`). So: if a tab needs something autosave cannot store, the fix belongs
 * in the export.
 *
 * **The one addition is `ui`**, and it is not analysis content: it is where an *unfinished import* had got
 * to. Export cannot meet that state — its button is unreachable during onboarding and the brought-Pokémon
 * step — but autosave can, because it fires on a timer. Without it, reloading ten minutes into completing
 * a replay's teams would drop you into the analysis with a half-finished roster and the brought-Pokémon
 * question silently answered in roster order.
 *
 * **Everything is guarded.** Reading `localStorage` throws outright in some privacy modes, and writing
 * throws when the quota is reached — an imported replay carries its whole log, so a few of those tabs can
 * fill an origin's ~5 MB. Nothing here ever throws at its caller; a write that will not fit drops the
 * oldest tab and tries again, because losing the oldest tab beats losing all of them.
 */

const AUTOSAVE_KEY = 'analysis-open-tabs';

/** Bumped when a change would stop this reading what an older build wrote. */
export const ANALYSIS_AUTOSAVE_SCHEMA = 1;

/**
 * Where an unfinished replay import had got to. See the note above for why this is the one thing autosave
 * stores that an export does not — it is the state of a *step*, not of the analysis.
 */
export interface AnalysisAutosaveUI {
	onboarding?: AnalysisSideID | null;
	importPreview?: { p1: number[], p2: number[] } | null;
	importedTeams?: { p1: string, p2: string };
	importWarnings?: string[];
}

export interface AnalysisAutosaveEntry {
	id: string;
	file: AnalysisExport;
	ui?: AnalysisAutosaveUI;
}

export interface AnalysisAutosave {
	schema: number;
	savedAt: string;
	activeTabId: string | null;
	tabs: AnalysisAutosaveEntry[];
}

export interface AnalysisAutosaveRestore {
	tabs: AnalysisTab[];
	activeTabId: string | null;
	/**
	 * The server commit each restored tab was saved under, by tab id, for the staleness warning.
	 *
	 * It comes back as data rather than being applied during the restore because the **running** server's
	 * commit is fetched asynchronously at startup and has usually not landed when the tabs are rebuilt. An
	 * import never races it: it happens long after, once the user has clicked something.
	 */
	savedCommits: Record<string, string>;
}

function hasImportState(tab: AnalysisTab) {
	return !!(tab.onboarding || tab.importPreview || tab.importedTeams || tab.importWarnings?.length);
}

export function buildAutosaveEntry(tab: AnalysisTab, serverCommit: string, now = new Date()): AnalysisAutosaveEntry {
	return {
		id: tab.id,
		file: buildAnalysisExport(tab, serverCommit, now),
		...(hasImportState(tab) ? {
			ui: {
				onboarding: tab.onboarding,
				importPreview: tab.importPreview,
				importedTeams: tab.importedTeams,
				importWarnings: tab.importWarnings,
			},
		} : {}),
	};
}

/**
 * The per-entry `exportedAt` an autosave writes, deliberately **fixed**.
 *
 * An autosave's timestamp is the snapshot's own `savedAt`; the entries share it, so a real one per entry
 * would say nothing and would make every snapshot differ from the last by construction — which is exactly
 * what `saveOpenTabs` compares to decide whether the write is worth doing. Nothing reads `exportedAt` back:
 * `tabFromAnalysisExport` ignores it, and it exists for a *file*, where the user can see it.
 */
const AUTOSAVE_ENTRY_DATE = new Date(0);

export function buildAutosave(
	tabs: AnalysisTab[], activeTabId: string | null, serverCommit: string, now = new Date()
): AnalysisAutosave {
	return {
		schema: ANALYSIS_AUTOSAVE_SCHEMA,
		savedAt: now.toISOString(),
		activeTabId,
		tabs: tabs.map(tab => buildAutosaveEntry(tab, serverCommit, AUTOSAVE_ENTRY_DATE)),
	};
}

/**
 * The tab an autosaved entry reopens as, with no position: the caller rebuilds it through
 * `restoreAnalysisNode`, exactly as an imported file does.
 *
 * The **id is kept**, rather than minted fresh the way an import does, so `activeTabId` still names a tab
 * and a reload lands on the same one.
 */
export function tabFromAutosaveEntry(entry: AnalysisAutosaveEntry): AnalysisTab {
	const tab = tabFromAnalysisExport(entry.file, entry.id);
	if (entry.ui) {
		tab.onboarding = entry.ui.onboarding;
		tab.importPreview = entry.ui.importPreview;
		tab.importedTeams = entry.ui.importedTeams;
		tab.importWarnings = entry.ui.importWarnings;
		/*
		 * An import that never finished has not been past the teambuilder, so the sandbox intro line still
		 * applies — `tabFromAnalysisExport` assumes the opposite, which is right for a file (Export is
		 * unreachable before the intro) and wrong here.
		 */
		if (entry.ui.onboarding || entry.ui.importPreview) tab.sandboxIntroDone = false;
	}
	return tab;
}

/*********************************************************
 * Storage
 *********************************************************/

function readRaw() {
	try {
		return window.localStorage.getItem(AUTOSAVE_KEY);
	} catch {
		return null;
	}
}

function writeRaw(text: string) {
	try {
		window.localStorage.setItem(AUTOSAVE_KEY, text);
		return true;
	} catch {
		// quota, or a privacy mode that refuses writes outright; both are the caller's cue to store less
		return false;
	}
}

export function clearOpenTabs() {
	lastWrittenBody = '';
	try {
		window.localStorage.removeItem(AUTOSAVE_KEY);
	} catch {}
}

/**
 * Writes the open tabs, dropping the oldest until the rest fit.
 *
 * Returns the ids actually stored, so a caller can say what was dropped. An empty array means nothing
 * could be written at all, in which case the key is cleared rather than left holding an older, wronger
 * snapshot — a stale entry that reopens work the user has since closed is worse than no entry.
 */
/**
 * What the last successful write held, minus its timestamp, so an unchanged snapshot is not written again.
 *
 * This matters because the caller cannot tell when a tab changed — the tab objects are mutated in place
 * all over `analysis.tsx`, so autosave is driven off renders instead, and a battle animation renders
 * constantly. Comparing costs one `JSON.stringify`; writing costs a synchronous `localStorage` write of
 * everything open, which can be megabytes once a replay import is in the list.
 */
let lastWrittenBody = '';

export function saveOpenTabs(
	tabs: AnalysisTab[], activeTabId: string | null, serverCommit: string, now = new Date()
): string[] {
	if (!tabs.length) {
		/*
		 * Unconditionally, and never "only if we wrote something this page load". That guard looked like a
		 * free optimisation and was a bug: close the last tab before the first write of a fresh page has
		 * landed and the entry survives, so the *next* reload reopens a tab the user had closed — the one
		 * outcome worse than losing the work. `removeItem` on a missing key costs nothing.
		 */
		clearOpenTabs();
		return [];
	}
	const save = buildAutosave(tabs, activeTabId, serverCommit, now);
	const body = JSON.stringify({ activeTabId: save.activeTabId, tabs: save.tabs });
	if (body === lastWrittenBody) return save.tabs.map(entry => entry.id);
	/*
	 * Oldest first, but never the active tab: the tab on screen is the one the user would miss, and it is
	 * also the only one a reload rebuilds eagerly. `tabs` is in tab-bar order, which is creation order
	 * unless the user has dragged them — near enough to "oldest", and it matches what the tab bar shows.
	 */
	while (save.tabs.length) {
		if (writeRaw(JSON.stringify(save))) {
			// only the full snapshot counts as written; a trimmed one must be retried as tabs are closed
			lastWrittenBody = save.tabs.length === tabs.length ? body : '';
			return save.tabs.map(entry => entry.id);
		}
		const dropIndex = save.tabs.findIndex(entry => entry.id !== activeTabId);
		if (dropIndex < 0) break;
		save.tabs.splice(dropIndex, 1);
	}
	clearOpenTabs();
	return [];
}

/**
 * The autosaved tabs, ready to rebuild, or an empty list when there are none or the entry is unreadable.
 *
 * Each entry is validated with the **importer's own checks**, so a restored tab can be handed to
 * `/analysis/start` without the rebuild walking off the end of something. An entry that fails is skipped
 * rather than throwing the whole snapshot away: one corrupt tab should not cost the others. Nothing here
 * throws — an entry that crashes the page on every load is the worst possible outcome, so a snapshot this
 * cannot read is simply discarded.
 */
export function loadOpenTabs(): AnalysisAutosaveRestore {
	const empty: AnalysisAutosaveRestore = { tabs: [], activeTabId: null, savedCommits: {} };
	const text = readRaw();
	if (!text) return empty;
	let save: any;
	try {
		save = JSON.parse(text);
	} catch {
		clearOpenTabs();
		return empty;
	}
	if (!save || typeof save !== 'object' || save.schema > ANALYSIS_AUTOSAVE_SCHEMA || !Array.isArray(save.tabs)) {
		clearOpenTabs();
		return empty;
	}
	const tabs: AnalysisTab[] = [];
	const savedCommits: Record<string, string> = {};
	for (const entry of save.tabs) {
		if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
		try {
			const file = validateAnalysisExport(entry.file);
			tabs.push(tabFromAutosaveEntry(entry as AnalysisAutosaveEntry));
			savedCommits[entry.id] = file.createdWith?.serverCommit || '';
		} catch {}
	}
	if (!tabs.length) {
		clearOpenTabs();
		return empty;
	}
	const activeTabId = typeof save.activeTabId === 'string' && tabs.some(tab => tab.id === save.activeTabId) ?
		save.activeTabId : null;
	return { tabs, activeTabId, savedCommits };
}
