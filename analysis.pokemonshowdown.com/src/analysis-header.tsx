/** @jsx preact.h */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';
import { formatTabLabel, type AnalysisTab } from './analysis-model';
import { AnalysisSettings } from './analysis-settings';

/**
 * The header nav's destinations.
 *
 * Absolute and written out rather than derived from the page's own hostname or from `config/routes.json`.
 * Neither would work here: `routes.json` deliberately still names the official domains in production, so
 * that default sprites keep loading from the real play.pokemonshowdown.com (docs/hosting/overview.md), and
 * deriving from `window.location` gives nothing on `localhost`, where the analysis tool is developed.
 *
 * The dex does this through its own `config/config.js` routes, which it can because it has no sprite
 * dependency to preserve. Two mechanisms for the same nav is a wart; this is the one place to change if
 * the fork's domain ever moves.
 */
const NAV_LINKS = {
	home: 'https://play.digipenshowdown.dynv6.net/',
	dex: 'https://dex.digipenshowdown.dynv6.net/',
	analysis: 'https://analysis.digipenshowdown.dynv6.net/',
	strategy: 'https://smogon.com/dex/',
	forum: 'https://smogon.com/forums/',
	github: 'https://github.com/chchristie/pokemon-showdown-client/tree/master/analysis.pokemonshowdown.com',
};

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
		{/*
			One joined group (`nav-first` … `nav-last`) plus a detached Play button, which is the play
			client's own pattern: `global.css` rounds only those two classes, so Play carries both to be
			round on all four corners. Analysis is `cur` because this is it.
		*/}
		<div class="nav-wrapper"><ul class="nav">
			<li><a class="button nav-first" href={NAV_LINKS.home}>Home</a></li>
			<li><a class="button" href={NAV_LINKS.dex}>Pokédex</a></li>
			<li><a class="button cur" href={NAV_LINKS.analysis}>Analysis</a></li>
			<li><a class="button" href={NAV_LINKS.strategy}>Strategy</a></li>
			<li><a class="button" href={NAV_LINKS.forum}>Forum</a></li>
			<li><a class="button nav-last" href={NAV_LINKS.github}>GitHub</a></li>
			<li><a class="button greenbutton nav-first nav-last" href={NAV_LINKS.home}>Play</a></li>
		</ul></div>
	</div>;
}
