/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * A multi-select combobox: a text box you type in to filter a dropdown, with the current selection shown
 * inside the box as chips you can remove. Written for the Pokémon panel's volatiles row (docs/analysis/plan.md,
 * Phase 2b-2), where a plain `<select multiple>` would be unreadable and a row of ~28 toggle buttons would be
 * the largest thing in the panel for a field that is usually empty.
 *
 * The client has no combobox of its own, so this follows the W3C ARIA Authoring Practices combobox pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/): DOM focus stays on the text box the whole time and the
 * highlighted option is tracked with `aria-activedescendant`, so typing and arrowing work together.
 *
 * Two conventions beyond the APG, because every multi-select has them: Backspace on an empty box removes the
 * last chip, and Enter leaves the popup open so several can be added in a row.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';

export interface AnalysisMultiSelectOption {
	/** unique; what `value` holds and `onChange` reports, not necessarily an effect id */
	key: string;
	label: string;
	/** extra words the filter matches, for effects better known by another name */
	search?: string;
	/** why this can't be picked, shown on hover; a value already selected can still be removed */
	disabled?: string;
}

export interface AnalysisMultiSelectProps {
	value: string[];
	options: AnalysisMultiSelectOption[];
	onChange: (value: string[]) => void;
	/** distinguishes this instance's option ids, which `aria-activedescendant` has to name */
	idPrefix: string;
	label: string;
	placeholder?: string;
	disabled?: boolean;
}

export class AnalysisMultiSelect extends preact.Component<AnalysisMultiSelectProps> {
	/** the filter text, which is deliberately not part of the edit form: it is discarded on blur */
	filter = '';
	open = false;
	/** index into `visibleOptions()`, the "virtual focus"; -1 when nothing is highlighted */
	active = -1;
	input: HTMLInputElement | null = null;
	list: HTMLUListElement | null = null;

	visibleOptions() {
		const filter = this.filter.trim().toLowerCase();
		if (!filter) return this.props.options;
		return this.props.options.filter(option =>
			option.label.toLowerCase().includes(filter) || (option.search || '').toLowerCase().includes(filter));
	}

	/**
	 * Chips are ordered by the option registry rather than by when each was picked, so they stay put as the
	 * selection changes. Backspace then removes the rightmost chip, which is the one it looks like it removes.
	 */
	selectedOptions() {
		return this.props.options.filter(option => this.props.value.includes(option.key));
	}

	setOpen(open: boolean, active = -1) {
		this.open = open;
		this.active = active;
		if (!open) this.filter = '';
		this.forceUpdate();
	}

	toggle(key: string) {
		const { value, onChange, options } = this.props;
		if (value.includes(key)) {
			onChange(value.filter(other => other !== key));
		} else {
			// an unavailable option can still be removed, so the guard only blocks adding
			if (options.find(option => option.key === key)?.disabled) return;
			onChange([...value, key]);
		}
		// the popup stays open and the filter clears, so the next one can be typed straight away
		this.filter = '';
		this.active = -1;
		this.forceUpdate();
	}

	focusInput = () => {
		this.input?.focus();
	};

	handleInput = (event: Event) => {
		this.filter = (event.target as HTMLInputElement).value;
		this.open = true;
		this.active = -1;
		this.forceUpdate();
	};

	handleKeyDown = (event: KeyboardEvent) => {
		const options = this.visibleOptions();
		const move = (index: number) => {
			event.preventDefault();
			this.open = true;
			this.active = Math.max(0, Math.min(options.length - 1, index));
			this.forceUpdate();
		};
		switch (event.key) {
		case 'ArrowDown':
			if (event.altKey) {
				// Alt+Down opens the popup without highlighting anything, as the APG specifies
				if (!this.open) this.setOpen(true);
				event.preventDefault();
				return;
			}
			move(this.open ? this.active + 1 : 0);
			return;
		case 'ArrowUp':
			move(this.open ? this.active - 1 : options.length - 1);
			return;
		case 'Home':
			if (this.open) move(0);
			return;
		case 'End':
			if (this.open) move(options.length - 1);
			return;
		case 'Enter':
			if (this.open && options[this.active]) {
				event.preventDefault();
				this.toggle(options[this.active].key);
			}
			return;
		case 'Escape':
			event.preventDefault();
			if (this.open) {
				this.setOpen(false);
			} else if (this.filter) {
				this.filter = '';
				this.forceUpdate();
			}
			return;
		case 'Backspace': {
			// only when the box is empty, so it doesn't eat an ordinary character delete
			if (this.filter) return;
			const selected = this.selectedOptions();
			if (selected.length) this.toggle(selected[selected.length - 1].key);
			return;
		}
		case 'Tab':
			if (this.open) this.setOpen(false);
		}
	};

	override componentDidUpdate() {
		// keep the highlighted option in view while arrowing through a list longer than the popup
		const active = this.list?.querySelector('.analysis-multiselect-option.active') as HTMLElement | null;
		active?.scrollIntoView({ block: 'nearest' });
	}

	override render() {
		const { value, idPrefix, label, placeholder, disabled } = this.props;
		const options = this.visibleOptions();
		const listId = `${idPrefix}-listbox`;
		const activeId = this.open && options[this.active] ? `${idPrefix}-option-${options[this.active].key}` : undefined;
		return <div class="analysis-multiselect">
			{/* clicking anywhere in the box focuses the text input, as a native field would */}
			<div
				class={`textbox analysis-multiselect-box${disabled ? ' analysis-multiselect-disabled' : ''}`}
				onClick={this.focusInput}
			>
				{this.selectedOptions().map(option => <span class="analysis-multiselect-chip" key={option.key}>
					{option.label}
					<button
						type="button" class="analysis-multiselect-remove" disabled={disabled}
						aria-label={`Remove ${option.label}`} data-multiselect-remove={option.key}
						// keep focus in the text box, so removing a chip doesn't close the popup
						onMouseDown={(event: MouseEvent) => event.preventDefault()}
						onClick={() => {
							this.toggle(option.key);
							this.focusInput();
						}}
					>×</button>
				</span>)}
				<input
					type="text" class="analysis-multiselect-input" role="combobox" autocomplete="off"
					value={this.filter} disabled={disabled} placeholder={value.length ? '' : placeholder}
					aria-label={label} aria-autocomplete="list" aria-expanded={this.open} aria-controls={listId}
					aria-activedescendant={activeId} data-multiselect={label}
					ref={element => { this.input = element as HTMLInputElement | null; }}
					onInput={this.handleInput} onKeyDown={this.handleKeyDown}
					onFocus={() => this.setOpen(true)} onBlur={() => this.setOpen(false)}
				/>
			</div>
			{this.open && <ul
				class="analysis-multiselect-list" id={listId} role="listbox" aria-multiselectable="true"
				aria-label={label} ref={element => { this.list = element as HTMLUListElement | null; }}
				// mousedown would blur the input and close this list before the click landed
				onMouseDown={(event: MouseEvent) => event.preventDefault()}
			>
				{!options.length && <li class="analysis-multiselect-empty" role="presentation">No matches</li>}
				{options.map((option, index) => {
					const selected = value.includes(option.key);
					// a selected option stays clickable so it can be removed, even once it became unavailable
					const reason = selected ? undefined : option.disabled;
					return <li
						key={option.key} id={`${idPrefix}-option-${option.key}`} role="option"
						class={`analysis-multiselect-option${index === this.active ? ' active' : ''}` +
							`${reason ? ' analysis-multiselect-blocked' : ''}`}
						aria-selected={selected} aria-disabled={reason ? true : undefined}
						title={reason ? `${option.label}: ${reason}` : undefined}
						data-active={index === this.active ? '' : undefined}
						data-multiselect-option={option.key} onClick={() => this.toggle(option.key)}
					>{option.label}{reason && <span class="analysis-multiselect-reason">{reason}</span>}</li>;
				})}
			</ul>}
		</div>;
	}
}
