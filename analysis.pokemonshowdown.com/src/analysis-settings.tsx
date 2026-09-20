/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * The header's settings popup, modelled on the one behind play.pokemonshowdown.com's gear button. It reuses
 * the old client's `.userbar` and `.ps-popup` classes, which this page already loads through `client.css`.
 *
 * It holds one setting for now, **Debug Mode**, which reveals the panels that exist for developing the tool
 * rather than for using it: the selected node's raw JSON and the edits the server refused (`droppedEdits`).
 * Those were previously either always on or never shown at all.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';

const DEBUG_MODE_KEY = 'analysis-debug-mode';

/**
 * Reading `localStorage` throws outright in some privacy modes, so every access is guarded and the setting
 * simply falls back to off.
 */
export function loadDebugMode() {
	try {
		return window.localStorage.getItem(DEBUG_MODE_KEY) === '1';
	} catch {
		return false;
	}
}

export function saveDebugMode(on: boolean) {
	try {
		window.localStorage.setItem(DEBUG_MODE_KEY, on ? '1' : '0');
	} catch {}
}

export interface AnalysisSettingsProps {
	debugMode: boolean;
	onChangeDebugMode: (on: boolean) => void;
	onClose: () => void;
}

export class AnalysisSettings extends preact.Component<AnalysisSettingsProps> {
	/** a click anywhere else closes the popup, as the client's own popups do */
	handleDocumentClick = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (!target?.closest?.('.analysis-settings-popup, .analysis-settings-button')) this.props.onClose();
	};

	handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') this.props.onClose();
	};

	override componentDidMount() {
		document.addEventListener('click', this.handleDocumentClick);
		document.addEventListener('keydown', this.handleKeyDown);
	}

	override componentWillUnmount() {
		document.removeEventListener('click', this.handleDocumentClick);
		document.removeEventListener('keydown', this.handleKeyDown);
	}

	override render() {
		return <div class="ps-popup analysis-settings-popup" role="dialog" aria-label="Settings">
			<h3>Settings</h3>
			<p>
				<label class="checkbox">
					<input
						type="checkbox" name="debugmode" checked={this.props.debugMode} data-settings="Debug Mode"
						onChange={event => this.props.onChangeDebugMode((event.target as HTMLInputElement).checked)}
					/> Debug Mode
				</label>
			</p>
			<p class="analysis-settings-note">Shows the selected node's data and any edits the server refused.</p>
		</div>;
	}
}
