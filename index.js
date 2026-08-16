/**
 * dsh-web-search-ddg — zero-token DuckDuckGo search provider for the
 * DeepSeek Harness (DSH) web capability seam (`ctx.web`).
 *
 * Registers the search provider `ddg-browser`: it drives the machine's own
 * Chrome/Edge/Chromium in headless mode against DuckDuckGo's HTML endpoint
 * and parses result links out of the dumped DOM. No API key, no auxiliary
 * model request — unlike DSH's shipped `deepseek-official` provider, whose
 * every search is a full billed model round trip, a search here costs zero
 * model tokens.
 *
 * Cordis function plugin: `inject: ['web']`, no config schema, zero
 * dependencies (Node builtins only). Config (all optional):
 * { chromePath, timeoutMs, virtualTimeBudgetMs }.
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

/** Browser candidates, first existing executable wins (config overrides). */
const BROWSER_CANDIDATES = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/chromium',
	'/usr/bin/google-chrome',
];

/**
 * A normal-desktop Chrome UA. The headless build announces itself as
 * `HeadlessChrome`, which DuckDuckGo's anomaly page keys on; overriding it
 * with a plain UA is what makes the HTML endpoint return real results.
 */
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_VIRTUAL_BUDGET_MS = 8_000;
/**
 * Attempts per search. Empirically the HTML endpoint is flaky: identical
 * requests intermittently stall (a hung subresource freezes virtual time, so
 * Chrome never reaches its budget and never exits). One retry clears it.
 * Worst case ATTEMPTS × timeoutMs must stay under `tool-web`'s
 * `searchTimeoutMs` (DSH ships 60s for the model-backed route).
 */
const ATTEMPTS = 2;

/** DuckDuckGo anomaly/challenge marker — present when the page is a block. */
const ANOMALY_MARKER = 'duckduckgo.com/anomaly';

//#region HTML parsing

const ENTITIES = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#x27;': "'",
	'&#39;': "'",
	'&nbsp;': ' ',
};

/** Decode the handful of entities DDG emits; leave anything else verbatim. */
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

/** Match every `<a class="…result__a…" href=…>title</a>` (attribute order varies). */
const TITLE_ANCHOR_RE =
	/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
/** Snippet anchors carry the same href; join happens on the decoded URL. */
const SNIPPET_ANCHOR_RE =
	/<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

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

//#endregion

//#region headless browser driver

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
			'--user-agent=' + USER_AGENT,
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

//#endregion

/**
 * Plugin entry: register the `ddg-browser` search provider on `ctx.web`.
 *
 * @param ctx - plugin context carrying `web` (the DSH web capability seam).
 * @param config - { chromePath?, timeoutMs?, virtualTimeBudgetMs? }.
 */
export function apply(ctx, config = {}) {
	const browserPath =
		config.chromePath ?? BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? '';
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const virtualBudgetMs = config.virtualTimeBudgetMs ?? DEFAULT_VIRTUAL_BUDGET_MS;

	ctx.web.registerSearchProvider({
		id: PROVIDER_ID,
		/** Cheap local check only — no network, per the seam's contract. */
		available() {
			return browserPath !== '' && existsSync(browserPath);
		},
		async search(request, signal) {
			if (signal?.aborted) throw new Error('ddg-browser search aborted');
			const url =
				'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(request.query);
			let lastFailure = null;
			for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
				if (signal?.aborted) throw new Error('ddg-browser search aborted');
				let html;
				try {
					html = await dumpDom(browserPath, url, { timeoutMs, virtualBudgetMs, signal });
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
						'ddg-browser: DuckDuckGo served an anomaly/challenge page; ' +
						'retry, change the query, or switch searchProvider back to deepseek-official'
					);
					continue;
				}
				// Page loaded but parsed to nothing — treat as a parse-level miss.
				lastFailure = new Error('ddg-browser: result page contained no parsable links');
			}
			throw lastFailure ?? new Error('ddg-browser: search failed');
		},
	});
}
