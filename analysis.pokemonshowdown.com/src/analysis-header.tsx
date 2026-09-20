/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { formatTabLabel, type AnalysisTab } from './analysis-model';
import { AnalysisSettings } from './analysis-settings';

interface AnalysisHeaderProps {
	tabs: AnalysisTab[];
	activeTab: AnalysisTab | undefined;
	onOpenHome: () => void;
	onActivateTab: (tabId: string) => void;
	onCloseTab: (event: Event, tabId: string) => void;
	onDragStart: (event: DragEvent, tabId: string) => void;
	onDragEnter: (event: DragEvent, tabId: string) => void;
	onDragEnd: () => void;
	settingsOpen: boolean;
	debugMode: boolean;
	onToggleSettings: () => void;
	onChangeDebugMode: (on: boolean) => void;
	onCloseSettings: () => void;
}

export function AnalysisHeader(props: AnalysisHeaderProps) {
	return <div id="header" class="header" role="navigation">
		{/* the gear sits where play.pokemonshowdown.com puts it, in the old client's top-right userbar */}
		<div class="userbar">
			<button
				class="icon button analysis-settings-button" aria-label="Settings" aria-haspopup="dialog"
				aria-expanded={props.settingsOpen} onClick={props.onToggleSettings}
			><i class="fa fa-cog" aria-hidden></i></button>
			{props.settingsOpen && <AnalysisSettings
				debugMode={props.debugMode} onChangeDebugMode={props.onChangeDebugMode}
				onClose={props.onCloseSettings}
			/>}
		</div>
		<div class="maintabbarbottom"></div>
		<div class="tabbar maintabbar"><div class="inner">
			<ul class="maintabbar-left" role="tablist">
				<li class="home-li"><a
					class={`roomtab button${!props.activeTab ? ' cur' : ''}`} href="/" role="tab" aria-selected={!props.activeTab ? 'true' : 'false'} onClick={event => {
						event.preventDefault();
						props.onOpenHome();
					}}
				>Home</a></li>
				{props.tabs.map(tab => <li key={tab.id}>
					<a
						class={`roomtab button closable${props.activeTab?.id === tab.id ? ' cur' : ''}`}
						href={`/${tab.id}`}
						draggable={true}
						role="tab"
						aria-selected={props.activeTab?.id === tab.id ? 'true' : 'false'}
						onClick={event => { event.preventDefault(); props.onActivateTab(tab.id); }}
						onDragStart={event => props.onDragStart(event, tab.id)}
						onDragEnter={event => props.onDragEnter(event, tab.id)}
						onDragEnd={props.onDragEnd}
					>
						{/* the format above the title, as play.pokemonshowdown.com labels a battle room */}
						<i class="text">{formatTabLabel(tab.format, tab.formatName)}</i><span>{tab.title}</span>
					</a>
					<button class="closebutton" name="closeRoom" value={tab.id} aria-label="Close" onClick={event => props.onCloseTab(event, tab.id)}>
						<i class="fa fa-times-circle" aria-hidden></i>
					</button>
				</li>)}
			</ul>
		</div></div>
		<div class="nav-wrapper"><ul class="nav">
			<li><a class="button nav-first" href="//pokemonshowdown.com/">Pokemon Showdown</a></li>
			<li><a class="button cur" href="/">Analysis</a></li>
			<li><a class="button nav-last" href="//replay.pokemonshowdown.com/">Replay</a></li>
			<li><a class="button greenbutton nav-first nav-last" href="//play.pokemonshowdown.com/">Play</a></li>
		</ul></div>
	</div>;
}
