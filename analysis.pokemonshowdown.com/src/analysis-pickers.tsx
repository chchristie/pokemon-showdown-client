/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * The start form's format and team pickers, laid out like play.pokemonshowdown.com's own
 * (user request, 2026-09-20).
 *
 * **The client's panels could not be reused, but its layout is.** `FormatDropdownPanel` and
 * `TeamDropdownPanel` are `PSRoomPanel`s: the base class calls `PS.isVisible(room)` just to decide whether
 * to re-render, they are opened by routing (`data-href="/formatdropdown"` joins a room) and closed through
 * `chooseParentValue`, which writes back via `room.parentElem`. `PS` is a ~1,200-line singleton that owns
 * layout, routing, history, prefs and the teams store, and lays out `document.body` itself; this page has
 * its own shell, so Phase 3 chose not to boot a second one (test/teambuilder.js asserts `PS` stays
 * undefined).
 *
 * None of that applies to the **markup**, which is what the menus actually look like. `.options` with its
 * 220px floated columns, `.options h3`, `.ps-popup`, `.select.formatselect`, `.select.teamselect` and the
 * `.teamdropdown`/`.team` list are all in `client.css` and `client2.css`, which this page already loads —
 * so these menus are built from the same classes and read the same way.
 *
 * Two deliberate differences from the client's:
 * - **Sections collapse** (user request). The client's don't; its columns are short enough not to need it.
 * - **No starred formats.** Starring lives in `PS.prefs`, which this page has no equivalent of.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { Teams } from '../../play.pokemonshowdown.com/src/battle-teams';
import { toID } from '../../play.pokemonshowdown.com/src/battle-dex';
import { formatDisplayName, type AnalysisFormat, type LocalTeam } from './analysis-model';
import { PSIcon } from './analysis-ps-shims';

/** Closes a popup on an outside click or Escape, as the client's own popups do. */
abstract class PopupControl<P, S extends { open: boolean }> extends preact.Component<P, S> {
	/** the class marking this control's own markup, so a click inside it doesn't close it */
	abstract ownSelector: string;

	handleDocumentClick = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (!target?.closest?.(this.ownSelector)) this.closePopup();
	};

	handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') this.closePopup();
	};

	closePopup() {
		if (this.state.open) this.setState({ open: false } as Partial<S> as S);
	}

	override componentDidMount() {
		document.addEventListener('click', this.handleDocumentClick);
		document.addEventListener('keydown', this.handleKeyDown);
	}

	override componentWillUnmount() {
		document.removeEventListener('click', this.handleDocumentClick);
		document.removeEventListener('keydown', this.handleKeyDown);
	}
}

export interface AnalysisFormatPickerProps {
	formats: AnalysisFormat[];
	value: string;
	onChange: (format: string) => void;
	disabled?: boolean;
}

interface FormatPickerState {
	open: boolean;
	search: string;
	/** generation filter (`gen9`), as the client's row of gen buttons does; '' is all */
	gen: string;
	/** sections the user has folded away, by name */
	collapsed: { [section: string]: boolean };
}

/**
 * How wide one column of the format menu really is: `.options .option` is 220px in `client2.css` and
 * `.options` adds 2px of padding a side.
 *
 * The client's own menu sizes at a flat 225px a column, which is a pixel over and has nothing else to pay
 * for. This popup does, hence `POPUP_CHROME`.
 */
const COLUMN_WIDTH = 224;

/**
 * What the popup costs on top of its columns: 8px of padding a side, plus room for its own vertical
 * scrollbar, plus slack.
 *
 * The scrollbar is the part that is easy to miss and the reason the four-column menu wrapped. The popup is
 * `max-height: 70vh; overflow-y: auto`, so the format list always has one — but it is an **overlay**
 * scrollbar (0-2px) in headless Chrome and on a trackpad Mac, and a classic one (15-17px) with a mouse or
 * with "always show scrollbars". Sized for the classic case, since the overlay case simply has room spare.
 */
const POPUP_CHROME = 16 + 18 + 8;

/** One column of the menu: every section that declared this `column`, in list order. */
interface FormatColumn {
	/** the column number `formats.ts` assigned, which is what orders the menu */
	column: number;
	sections: { name: string, formats: AnalysisFormat[] }[];
}

export class AnalysisFormatPicker extends PopupControl<AnalysisFormatPickerProps, FormatPickerState> {
	ownSelector = '.analysis-picker-format';
	override state: FormatPickerState = { open: false, search: '', gen: '', collapsed: {} };

	select = (format: string) => {
		this.setState({ open: false, search: '' });
		this.props.onChange(format);
	};

	toggleSection = (section: string) => {
		this.setState({ collapsed: { ...this.state.collapsed, [section]: !this.state.collapsed[section] } });
	};

	/**
	 * Buckets formats by the `column` number `formats.ts` assigns them, then by section within each.
	 *
	 * **Bucketed by number and sorted, not grouped by runs.** The new play client
	 * (`panel-teamdropdown.tsx`) starts a fresh column whenever `column` *changes* as it walks the list,
	 * which is only right while the list happens to be in column order — and it is not. `mergeFormatLists`
	 * appends the fork's custom sections at the **end** of the list, so `custom-formats.ts`'s `column: 1`
	 * sections arrive after `formats.ts`'s columns 2–4 and a run-based walk emits them as a trailing
	 * column. That put DigiPen and FNAF at the far right instead of first.
	 *
	 * The **old** client is the one to follow here, and it is also what this fork serves
	 * (`testclient-old.html`): `client-mainmenu.js` appends into `bufs[format.column]` and renders the
	 * buffers in index order, so where a section sits in the list never affects which column it lands in.
	 * That is what `formats.ts` describes too — *"New sections will be added to the bottom of the specified
	 * column."*
	 *
	 * Filtering happens first, so a search collapses the menu down to as many columns as still have
	 * anything in them.
	 */
	buildColumns(): FormatColumn[] {
		const searchID = toID(this.state.search);
		const { gen } = this.state;
		/*
		 * The array is what is returned; the map is only the lookup. Collecting into both rather than
		 * spreading `byColumn.values()` at the end is not a style choice — **the client build compiles
		 * `[...map.values()]` to `[].concat(map.values())`**, which wraps the iterator as a single element
		 * instead of spreading it, and the menu renders one undefined column. It fails at runtime, not at
		 * build time. See "Client build gotchas" in docs/analysis/handoff.md.
		 */
		const columns: FormatColumn[] = [];
		const byColumn = new Map<number, FormatColumn>();
		for (const format of this.props.formats) {
			// matched on the id, as the client does, so "gen9ou" and "Gen 9 OU" both find it
			if (searchID && !toID(format.name).includes(searchID)) continue;
			if (gen && !format.id.startsWith(gen)) continue;
			let column = byColumn.get(format.column);
			if (!column) {
				column = { column: format.column, sections: [] };
				byColumn.set(format.column, column);
				columns.push(column);
			}
			/*
			 * Matched against the last section in *this* column rather than the previous format, so a
			 * section split across the list still reads as one heading instead of two identical ones.
			 */
			const last = column.sections[column.sections.length - 1];
			if (last?.name === format.section) last.formats.push(format);
			else column.sections.push({ name: format.section, formats: [format] });
		}
		return columns.sort((a, b) => a.column - b.column);
	}

	renderGenButtons() {
		const gens = ['9', '8', '7', '6', '5', '4', '3', '2', '1'];
		return gens.map((gen, index) => {
			const id = `gen${gen}`;
			const position = index === 0 ? 'button-first' : index === gens.length - 1 ? 'button-last' : 'button-middle';
			return <button
				key={id} type="button" value={id}
				class={`button ${position}${this.state.gen === id ? ' cur' : ''}`}
				onClick={() => this.setState({ gen: this.state.gen === id ? '' : id })}
			>{index === 0 ? `Gen ${gen}` : gen}</button>;
		});
	}

	override render() {
		const { value, disabled } = this.props;
		const columns = this.buildColumns();
		const width = Math.min(Math.max(columns.length, 2.1) * COLUMN_WIDTH + POPUP_CHROME, window.innerWidth - 40);
		return <span class="analysis-picker analysis-picker-format">
			<button
				type="button" class="select formatselect" disabled={disabled}
				aria-haspopup="dialog" aria-expanded={this.state.open}
				onClick={() => this.setState({ open: !this.state.open, search: '' })}
			>{formatDisplayName(value)}</button>
			{this.state.open && <div
				class="ps-popup analysis-picker-popup analysis-format-popup" role="dialog" aria-label="Choose a format"
				style={`width: ${width}px`}
			>
				<div class="analysis-picker-searchrow">
					<input
						class="textbox" type="search" placeholder="Search formats" autocomplete="off" autofocus
						value={this.state.search}
						onInput={event => this.setState({ search: (event.target as HTMLInputElement).value })}
					/>
					<span class="analysis-picker-gens">{this.renderGenButtons()}</span>
				</div>
				<div class="analysis-picker-columns">
					{columns.map((column, index) => <ul class="options" key={index} data-column={column.column}>
						{column.sections.map(section => <>
							<li key={`h-${section.name}`}>
								{/* the client's headings are inert; these fold, which long columns want */}
								<h3>
									<button
										type="button" class="analysis-picker-section"
										aria-expanded={!this.state.collapsed[section.name]}
										onClick={() => this.toggleSection(section.name)}
									>
										<i
											class={`fa fa-caret-${this.state.collapsed[section.name] ? 'right' : 'down'}`}
											aria-hidden="true"
										></i> {section.name}
									</button>
								</h3>
							</li>
							{!this.state.collapsed[section.name] && section.formats.map(format => <li key={format.id}>
								<button
									type="button" data-format={format.id}
									class={`option${format.id === value ? ' cur' : ''}`}
									onClick={() => this.select(format.id)}
								>{format.name.replace('[Gen 9] ', '').replace('[Gen 9 ', '[').replace('[Gen 8 ', '[')}</button>
							</li>)}
						</>)}
					</ul>)}
					{!columns.length && <p class="analysis-field-note">
						<em>No formats{!!this.state.search && ` matching "${this.state.search}"`} found</em>
					</p>}
					<div style="clear: both"></div>
				</div>
			</div>}
		</span>;
	}
}

export interface AnalysisTeamPickerProps {
	/** already narrowed to the teams legal for the chosen format */
	teams: LocalTeam[];
	value: string;
	onChange: (packedTeam: string) => void;
	disabled?: boolean;
	label: string;
}

/**
 * The team's name over its six icons.
 *
 * These go **straight into** the element that is the box — the `.teamselect` button, or a `.team` in the
 * list — never into a `.team` nested inside another box. `client.css` styles `.teamselect strong` and
 * `.teamselect small` directly, so the wrapper buys nothing, and `.select, .team` is itself a bordered
 * 230x32 box: the client gets away with nesting one only because `.teamselect .team` pulls the inner box
 * onto the outer's border with `margin: -1px 0 0 -6px; width: 226px`, which holds solely while the outer
 * is exactly 230px wide. Ours stretches to the form, so the inner box fell short on two edges and was
 * clipped on the other two.
 */
function teamBoxContents(team: LocalTeam | null, empty: string) {
	if (!team) return [<strong>{empty}</strong>, <small>&nbsp;</small>];
	const species = team.packedTeam ? Teams.unpackSpeciesOnly(team.packedTeam) : [];
	return [
		<strong>{team.name}</strong>,
		<small>{species.map(pokemon => <PSIcon pokemon={pokemon} />)}</small>,
	];
}

export class AnalysisTeamPicker extends PopupControl<AnalysisTeamPickerProps, { open: boolean }> {
	ownSelector = '.analysis-picker-team';
	override state = { open: false };

	select = (packedTeam: string) => {
		this.setState({ open: false });
		this.props.onChange(packedTeam);
	};

	override render() {
		const { teams, value, disabled, label } = this.props;
		const selected = teams.find(team => team.packedTeam === value) || null;
		const empty = teams.length ? 'Select a team' : 'No teams for this format';
		return <span class="analysis-picker analysis-picker-team">
			<button
				type="button" class="select teamselect" disabled={disabled || !teams.length}
				aria-haspopup="listbox" aria-expanded={this.state.open} aria-label={label}
				onClick={() => this.setState({ open: !this.state.open })}
			>{teamBoxContents(selected, empty)}</button>
			{this.state.open && <div class="ps-popup analysis-picker-popup" role="dialog" aria-label={label}>
				{/* the client's own team list: `.teamdropdown` of `.team` boxes, each a button */}
				<ul class="teamdropdown">
					{teams.map(team => <li key={team.packedTeam}>
						<button
							type="button" class={`team${team.packedTeam === value ? ' cur' : ''}`}
							onClick={() => this.select(team.packedTeam)}
						>{teamBoxContents(team, '')}</button>
					</li>)}
				</ul>
			</div>}
		</span>;
	}
}
