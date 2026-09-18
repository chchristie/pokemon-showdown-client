/** @jsx preact.h */
/** @jsxFrag preact.Fragment */
/**
 * Standalone replacements for the handful of play-client globals `battle-team-editor.js` expects
 * (docs/analysis/plan.md Phase 3).
 *
 * The teambuilder's own files (`battle-team-editor.js`, `battle-dex-search.js`,
 * `battle-searchresults.js`) have no top-level side effects and load fine on their own, but they
 * reference `PSModel`, `PSIcon`, `PSView` and `Net` as bare globals. The files that define those
 * (`client-core.js`, `panels.js`, `client-main.js`, `client-connection.js`) can't be loaded here:
 * their top-level code builds `PS`, opens a socket and reads the user's saved teams.
 *
 * `teams.pokemonshowdown.com/src/utils.tsx` solves the same problem the same way. `PS` itself is
 * deliberately left undefined: every access the editor makes on a live path is `window.PS?.`-guarded,
 * and the three bare `PS.teams` references are in `TeamEditorState.pasteTeam`, which only the
 * teambuilder's team *list* calls, and which this page never renders.
 *
 * These are declared at the top level on purpose: the client's Babel config strips imports, so every
 * top-level declaration in `src/` becomes a page global under exactly this name. `PSModel` has to be
 * defined before `battle-team-editor.js` loads, because `class extends PSModel` runs at load time;
 * `index.template.html` orders the script tags accordingly.
 */
import preact from '../../play.pokemonshowdown.com/js/lib/preact';

declare const Dex: any;

/** @see PSSubscription in play.pokemonshowdown.com/src/client-core.ts */
export class PSSubscription {
	observable: any;
	listener: (value: any) => void;
	constructor(observable: any, listener: (value: any) => void) {
		this.observable = observable;
		this.listener = listener;
	}
	unsubscribe() {
		const index = this.observable.subscriptions.indexOf(this);
		if (index >= 0) this.observable.subscriptions.splice(index, 1);
	}
}

/** @see PSModel in play.pokemonshowdown.com/src/client-core.ts — only the parts the editor uses */
export class PSModel {
	subscriptions: PSSubscription[] = [];
	subscribe(listener: (value: any) => void) {
		const subscription = new PSSubscription(this, listener);
		this.subscriptions.push(subscription);
		return subscription;
	}
	subscribeAndRun(listener: (value: any) => void, value?: any) {
		const subscription = this.subscribe(listener);
		subscription.listener(value);
		return subscription;
	}
	update(value?: any) {
		for (const subscription of this.subscriptions) subscription.listener(value);
	}
}

/**
 * `PSIcon` from play.pokemonshowdown.com/src/panels.tsx, which only ever reads `Dex`. The full
 * signature is kept: the teambuilder uses the pokemon, item, type, category and gender forms, and
 * this is the one definition the whole page shares.
 */
export function PSIcon(props: any) {
	if ('pokemon' in props) {
		return <span class="picon" style={Dex.getPokemonIcon(props.pokemon)} />;
	}
	if ('item' in props) {
		return <span class="itemicon" style={Dex.getItemIcon(props.item)} />;
	}
	if ('type' in props) {
		const type = Dex.types.get(props.type).name || '???';
		if (props.new) {
			return <span class={`typeicon typeicon-${type}${props.tera ? ' tera' : ''}`}>{type}</span>;
		}
		return <img
			src={`${Dex.resourcePrefix}sprites/types/${type.replace(/\?/g, '%3f')}.png`} alt={type}
			height="14" width="32" class={`pixelated${props.b ? ' b' : ''}`} style="vertical-align:middle"
		/>;
	}
	if ('category' in props) {
		const category = String(props.category).toLowerCase();
		const known = ['physical', 'special', 'status'].includes(category);
		const name = known ? category.charAt(0).toUpperCase() + category.slice(1) : 'undefined';
		return <img
			src={`${Dex.resourcePrefix}sprites/categories/${name}.png`} alt={name}
			height="14" width="32" class="pixelated" style="vertical-align:middle"
		/>;
	}
	if ('gender' in props) {
		return <img
			src={`${Dex.resourcePrefix}sprites/misc/gender-${props.gender.toLowerCase()}.png`}
			width={18} height={18} alt={props.gender} style="margin-top: -1px; filter: grayscale(30%)"
		/>;
	}
	return null;
}

/** The three `PSView` statics the editor calls, copied from panels.tsx. */
export const PSView = {
	hasTapped: false,
	politeFocus(elem: HTMLElement | null | undefined, polite = true) {
		try {
			elem?.focus({ preventScroll: polite });
		} catch {
			elem?.focus();
		}
	},
	prefersReducedMotion() {
		return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	},
};

/**
 * `Net` from client-connection.ts, reduced to the promise-of-a-string shape the editor uses for
 * sample sets and pokepast.es imports (both call sites `JSON.parse` the result themselves). Neither
 * URL is served from this origin, so both are expected to fail; both `.catch()`, and the editor
 * degrades to "no sample sets".
 */
export function Net(uri: string) {
	return {
		get: (options?: any) => netRequest(uri, { ...options, method: 'GET' }),
		post: (options?: any, body?: any) => netRequest(uri, { ...options, method: 'POST', body }),
	};
}

function netRequest(uri: string, options: any) {
	return new Promise<string>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(options.method || 'GET', uri, true);
		xhr.onreadystatechange = () => {
			if (xhr.readyState !== 4) return;
			if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
			else reject(new Error(`${xhr.status}: ${xhr.statusText}`));
		};
		xhr.onerror = () => reject(new Error('Network request failed'));
		try {
			xhr.send(options.body || undefined);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
