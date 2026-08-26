/**
 * dsh-web-search-ddg — zero-token web search providers for the DeepSeek
 * Harness (DSH) web capability seam (`ctx.web`).
 *
 * Registers the search provider `ddg-browser`. Two engines run in a fallback
 * chain, first success wins:
 *
 *   1. `bing`    — plain fetch against Bing's HTML endpoint. No browser, no
 *                  API key, sub-second latency. Redirect links carry the real
 *                  target in a base64url `u=a1…` parameter.
 *   2. `duckduckgo` — drives the machine's own Chrome/Edge headless against
 *                  DuckDuckGo's HTML endpoint and parses the dumped DOM. Used
 *                  when Bing fails (blocked, markup change, network).
 *
 * Neither engine makes an auxiliary model request — unlike DSH's shipped
 * `deepseek-official` provider, whose every search is a full billed model
 * round trip, a search here costs zero model tokens.
 *
 * Cordis function plugin: `inject: ['web']`, no config schema, zero
 * dependencies (Node builtins only). Config (all optional):
 * { engines, chromePath, timeoutMs, virtualTimeBudgetMs }.
 *
 * @module dsh-web-search-ddg
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inject = ['web'];

/** Registry id under `ctx.web`; select it with `web.searchProvider`. */
export const PROVIDER_ID = 'ddg-browser';

/** Engine execution order; first successful engine answers. */
const DEFAULT_ENGINES = ['bing', 'duckduckgo'];

//#region shared helpers

const DESKTOP_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const ENTITIES = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#x27;': "'",
	'&#39;': "'",
	'&nbsp;': ' ',
};

/** Decode common entities; leave anything else verbatim. */
function decodeEntities(text) {
	return text
		.replace(/&#x(\w+);/g, (_, hex) => {
			try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
		})
		.replace(/&#(\d+);/g, (_, dec) => {
			try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
		})
		.replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** Tag-stripping text extraction: drops <b>/<span>/… then decodes entities. */
function textContent(html) {
	return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Fetch an HTML page as desktop Chrome; non-2xx resolves, transport rejects. */
async function fetchHtml(url, extraHeaders, signal) {
	const response = await fetch(url, {
		headers: {
			'user-agent': DESKTOP_UA,
			'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'accept-language': 'en-US,en;q=0.9',
			...extraHeaders,
		},
		// Cap each fetch at 15s so a hung connect cannot eat the whole tool
		// budget; combined with the caller's signal where supported.
		signal: combineSignals(signal, 15_000),
	});
	return await response.text();
}

/** Caller signal plus an optional timeout, composed where Node supports it. */
function combineSignals(signal, timeoutMs) {
	const signals = [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean);
	if (signals.length === 2 && typeof AbortSignal.any === 'function') {
		return AbortSignal.any(signals);
	}
	return signals[0] ?? undefined;
}

//#endregion

//#region bing engine — plain fetch, no browser

const BING_TITLE_RE = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

/** Unwrap a Bing redirect (`/ck/a?…&u=a1<base64url>`) into the target URL. */
function unwrapBingRedirect(href) {
	const match = /[?&]u=a1([^&]+)/.exec(href ?? '');
	if (!match) return null;
	try {
		const decoded = Buffer.from(decodeURIComponent(match[1]), 'base64url').toString('utf-8');
		return /^https?:\/\//.test(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

/**
 * Parse a Bing results page into seam sources: each `b_algo` block contributes
 * its heading anchor (redirect-unwrapped URL + title) and its first paragraph
 * snippet. Consecutive-duplicate URLs are dropped.
 */
export function parseBingResults(html) {
	const sources = [];
	for (const match of html.matchAll(BING_TITLE_RE)) {
		const [, href, titleHtml] = match;
		const unescaped = decodeEntities(href);
		const url = unwrapBingRedirect(unescaped) ??
			(/^https?:\/\//.test(unescaped) ? unescaped : null);
		if (!url) continue;
		const rest = html.slice(match.index + match[0].length, match.index + match[0].length + 4000);
		const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(rest);
		sources.push({
			url,
			title: textContent(titleHtml) || undefined,
			snippet: (snippetMatch ? textContent(snippetMatch[1]) : undefined) || undefined,
		});
	}
	const seen = new Set();
	return sources.filter((s) => !seen.has(s.url) && seen.add(s.url));
}

/**
 * Create a Bing searcher owning its own cookie session. Without a bootstrapped
 * cookie jar, Bing serves degraded results that ignore most of the query
 * (observed: a multi-word query answered as its first word only); visiting
 * the homepage once and replaying those cookies restores real results.
 */
export function createBingSearcher() {
	let cookies;
	let bootstrapped = false;

	async function ensureCookies(signal) {
		if (bootstrapped) return cookies;
		const response = await fetch('https://www.bing.com/', {
			headers: { 'user-agent': DESKTOP_UA, accept: 'text/html' },
			signal,
		});
		const pairs = [];
		for (const cookie of response.headers.getSetCookie?.() ?? []) {
			const pair = cookie.split(';')[0];
			if (pair.includes('=')) pairs.push(pair.trim());
		}
		cookies = pairs.length > 0 ? pairs.join('; ') : undefined;
		bootstrapped = true;
		return cookies;
	}

	return {
		invalidate() {
			bootstrapped = false;
			cookies = undefined;
		},
		async search(request, signal) {
			await ensureCookies(signal);
			const url =
				'https://www.bing.com/search?q=' + encodeURIComponent(request.query) +
				'&mkt=en-US&setlang=en';
			let html = await fetchHtml(url, { cookie: cookies }, signal);
			let sources = parseBingResults(html);
			if (sources.length === 0) {
				// Degraded/stale session — bootstrap fresh cookies and retry once.
				this.invalidate();
				await ensureCookies(signal);
				html = await fetchHtml(url, { cookie: cookies }, signal);
				sources = parseBingResults(html);
			}
			if (sources.length === 0) {
				throw new Error('ddg-browser: Bing returned no parsable results');
			}
			return { sources, truncated: false };
		},
	};
}

//#endregion

//#region duckduckgo engine — local headless browser

/** Browser candidates, first existing executable wins (config overrides). */
const BROWSER_CANDIDATES = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/chromium',
	'/usr/bin/google-chrome',
];

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_VIRTUAL_BUDGET_MS = 8_000;
/**
 * Browser attempts per search. Empirically the endpoint is flaky: identical
 * requests intermittently stall (a hung subresource freezes virtual time, so
 * Chrome never reaches its budget and never exits). One retry clears it.
 */
const DDG_ATTEMPTS = 2;

/** DuckDuckGo anomaly/challenge marker — present when the page is a block. */
const ANOMALY_MARKER = 'duckduckgo.com/anomaly';

/**
 * Chrome's own error page when the connection to the engine is cut (an
 * IP-level block renders as `ERR_CONNECTION_CLOSED` inside a valid dump).
 */
const CONNECTION_BLOCKED_RE =
	/ERR_CONNECTION\w*|ERR_NAME\w*|无法访问此网站|Unable to connect|This site can’t be reached/;

/** Match every `<a class="…result__a…" href=…>title</a>` (attribute order varies). */
const TITLE_ANCHOR_RE =
	/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
/** Snippet anchors carry the same href; join happens on the decoded URL. */
const SNIPPET_ANCHOR_RE =
	/<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/** Pull the target URL out of a `//duckduckgo.com/l/?uddg=<encoded>` href. */
function targetUrlFromHref(href) {
	const match = /[?&]uddg=([^&"]+)/.exec(href ?? '');
	if (!match) return null;
	try {
		const url = decodeURIComponent(match[1]);
		return /^https?:\/\//.test(url) ? url : null;
	} catch {
		return null;
	}
}

/**
 * Parse the dumped DuckDuckGo HTML page into seam sources.
 * Titles and snippets are separate anchors; both hrefs carry the target URL
 * in `uddg`, so pair on it and dedupe.
 */
export function parseResults(html) {
	const byUrl = new Map();
	for (const [, href, titleHtml] of html.matchAll(TITLE_ANCHOR_RE)) {
		const url = targetUrlFromHref(href);
		if (!url || byUrl.has(url)) continue;
		byUrl.set(url, { url, title: textContent(titleHtml), snippet: undefined });
	}
	for (const [, href, snippetHtml] of html.matchAll(SNIPPET_ANCHOR_RE)) {
		const url = targetUrlFromHref(href);
		const entry = url && byUrl.get(url);
		if (entry && entry.snippet === undefined) {
			entry.snippet = textContent(snippetHtml);
		}
	}
	return [...byUrl.values()].map((entry) => ({
		url: entry.url,
		title: entry.title || undefined,
		snippet: entry.snippet || undefined,
	}));
}

/**
 * Run the browser headless against `url` and resolve its dumped DOM.
 * Chrome's `--dump-dom` prints the serialized DOM once the virtual-time
 * budget elapses, but the process often lingers afterwards (background
 * services never quiesce), so a timeout with buffered output still counts
 * as success — only a timeout with nothing dumped is a real failure.
 */
function dumpDom(browserPath, url, { timeoutMs, virtualBudgetMs, signal }) {
	return new Promise((resolve, reject) => {
		const profileDir = mkdtempSync(join(tmpdir(), 'dsh-ddg-browser-'));
		const args = [
			'--headless',
			'--disable-gpu',
			'--no-first-run',
			'--user-agent=' + DESKTOP_UA,
			'--user-data-dir=' + profileDir,
			'--virtual-time-budget=' + String(virtualBudgetMs),
			'--dump-dom',
			url,
		];
		const child = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

		let stdout = '';
		let settled = false;
		const cleanup = () => {
			// Best-effort: right after SIGKILL, Chrome's profile files can still
			// be settling, making rmSync throw ENOTEMPTY. Retry once, then leak —
			// the temp dir is disposable; a leaked profile must never fail a
			// search that already succeeded.
			try {
				rmSync(profileDir, { recursive: true, force: true });
			} catch {
				setTimeout(() => {
					try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
				}, 250).unref?.();
			}
		};
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			signal?.removeEventListener('abort', onAbort);
			cleanup();
			fn(value);
		};
		const onAbort = () => {
			child.kill('SIGKILL');
			settle(reject, new Error('ddg-browser search aborted'));
		};
		const killTimer = setTimeout(() => {
			child.kill('SIGKILL');
			if (stdout.length > 0) {
				// DOM already dumped; the lingering process is not a search failure.
				settle(resolve, stdout);
			} else {
				settle(reject, new Error(`ddg-browser: browser did not finish within ${timeoutMs}ms`));
			}
		}, timeoutMs);

		signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.on('error', (err) => settle(reject, err));
		child.on('close', () => settle(resolve, stdout));
	});
}

async function searchDuckDuckGo(request, { chromePath, timeoutMs, virtualBudgetMs }, signal) {
	if (!chromePath || !existsSync(chromePath)) {
		throw new Error('ddg-browser: no local browser found for the DuckDuckGo engine');
	}
	if (signal?.aborted) throw new Error('ddg-browser search aborted');
	const url =
		'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(request.query);
	let lastFailure = null;
	for (let attempt = 1; attempt <= DDG_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new Error('ddg-browser search aborted');
		let html;
		try {
			html = await dumpDom(chromePath, url, { timeoutMs, virtualBudgetMs, signal });
		} catch (err) {
			// Abort is caller intent — never retried.
			if (signal?.aborted) throw err;
			lastFailure = err;
			continue;
		}
		const sources = parseResults(html);
		if (sources.length > 0) return { sources, truncated: false };
		if (html.includes(ANOMALY_MARKER)) {
			lastFailure = new Error(
				'ddg-browser: DuckDuckGo served an anomaly/challenge page'
			);
			continue;
		}
		if (CONNECTION_BLOCKED_RE.test(html)) {
			lastFailure = new Error(
				'ddg-browser: browser could not reach DuckDuckGo ' +
				'(connection reset — the IP may be rate-limited; retry later)'
			);
			continue;
		}
		// Page loaded but parsed to nothing — treat as a parse-level miss.
		lastFailure = new Error('ddg-browser: DuckDuckGo page contained no parsable links');
	}
	throw lastFailure ?? new Error('ddg-browser: DuckDuckGo search failed');
}

//#endregion

/**
 * Plugin entry: register the `ddg-browser` search provider on `ctx.web`.
 * Engines run in `config.engines` order (default `bing → duckduckgo`); the
 * first engine that returns results answers. A failure is reported only when
 * every engine misses.
 *
 * @param ctx - plugin context carrying `web` (the DSH web capability seam).
 * @param config - { engines?, chromePath?, timeoutMs?, virtualTimeBudgetMs? }.
 */
export function apply(ctx, config = {}) {
	const engines = Array.isArray(config.engines) && config.engines.length > 0
		? config.engines
		: DEFAULT_ENGINES;
	const browserPath =
		config.chromePath ?? BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? '';
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const virtualBudgetMs = config.virtualTimeBudgetMs ?? DEFAULT_VIRTUAL_BUDGET_MS;
	const ddgOptions = { chromePath: browserPath, timeoutMs, virtualBudgetMs };
	const bingSearcher = createBingSearcher();

	ctx.web.registerSearchProvider({
		id: PROVIDER_ID,
		/** Cheap local check only — no network, per the seam's contract. */
		available() {
			return engines.includes('bing') || (browserPath !== '' && existsSync(browserPath));
		},
		async search(request, signal) {
			if (signal?.aborted) throw new Error('ddg-browser search aborted');
			const failures = [];
			for (const engine of engines) {
				if (signal?.aborted) throw new Error('ddg-browser search aborted');
				try {
					if (engine === 'bing') {
						return await bingSearcher.search(request, signal);
					}
					if (engine === 'duckduckgo') {
						return await searchDuckDuckGo(request, ddgOptions, signal);
					}
					failures.push(new Error(`ddg-browser: unknown engine "${engine}"`));
				} catch (err) {
					// Abort is caller intent — never fall through to another engine.
					if (signal?.aborted) throw err;
					failures.push(err);
				}
			}
			const summary = failures.map((f) => f.message).join('; ');
			throw new Error(
				`ddg-browser: all search engines failed (${summary}). ` +
				'Switch searchProvider back to deepseek-official if this persists.'
			);
		},
	});
}
