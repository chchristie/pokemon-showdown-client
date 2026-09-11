/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';

interface ReplayControlsProps {
	battle: any;
	turnView: boolean | string;
	speed: string;
	onOpenTurn: () => void;
	onCloseTurn: (event?: Event) => void;
	onGoToTurn: (event: Event) => void;
	onChangeSpeed: (event: Event) => void;
}

export function AnalysisReplayControls(props: ReplayControlsProps) {
	const { battle } = props;
	if (props.turnView) {
		const value = props.turnView === true ? undefined : props.turnView;
		return <div class="replay-controls"><section class="section">
			<form onSubmit={props.onGoToTurn}>
				Turn? <input name="turn" autofocus value={value} inputMode="numeric" class="textbox" size={5} /> {' '}
				<button type="submit" class="button"><strong>Go</strong></button> {' '}
				<button type="button" class="button" onClick={props.onCloseTurn}>Cancel</button>
			</form>
		</section></div>;
	}
	const atEnd = !battle || battle.atQueueEnd;
	const atStart = !battle?.started;
	return <div class="replay-controls"><p>
		{battle?.paused ? <button class="button" onClick={() => battle.play()} style={{ width: '5em', marginRight: '3px' }}>
			<i class="fa fa-play" aria-hidden></i><br /><strong>Play</strong>
		</button> : <button class="button" onClick={() => battle?.pause()} style={{ width: '5em', marginRight: '3px' }}>
			<i class="fa fa-pause" aria-hidden></i><br /><strong>Pause</strong>
		</button>} {' '}
		<button class="button button-first" disabled={atStart} onClick={() => battle?.seekTurn(0)}>
			<i class="fa fa-fast-backward" aria-hidden></i><br />First turn
		</button>
		<button class="button button-first" disabled={atStart} style={{ marginLeft: '1px', position: 'relative', zIndex: '1' }} onClick={() => battle?.seekBy(-1)}>
			<i class="fa fa-step-backward" aria-hidden></i><br />Prev turn
		</button>
		<button class="button button-last" disabled={atEnd} style={{ marginRight: '2px' }} onClick={() => battle?.seekBy(1)}>
			<i class="fa fa-step-forward" aria-hidden></i><br />Skip turn
		</button>
		<button class="button button-last" disabled={atEnd} onClick={() => battle?.seekTurn(Infinity)}>
			<i class="fa fa-fast-forward" aria-hidden></i><br />Skip to end
		</button> {' '}
		<button class="button" onClick={props.onOpenTurn}><i class="fa fa-repeat" aria-hidden></i> Go to turn...</button>
	</p><p><label class="optgroup">Speed:<br />
		<select name="speed" class="button" onChange={props.onChangeSpeed} value={props.speed}>
			<option value="hyperfast">Hyperfast</option>
			<option value="fast">Fast</option>
			<option value="normal">Normal</option>
			<option value="slow">Slow</option>
			<option value="reallyslow">Really Slow</option>
		</select>
	</label></p></div>;
}
