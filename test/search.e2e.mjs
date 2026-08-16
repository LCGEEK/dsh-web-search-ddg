/**
 * End-to-end test: registers the provider against a stub `ctx.web` and runs
 * one real search through the local headless browser.
 *
 * Requires: a local Chromium-family browser (or CHROME_PATH env) and network
 * access to html.duckduckgo.com. Exits non-zero on failure.
 */
import { apply, PROVIDER_ID } from '../index.js';

const registered = [];
apply({ web: { registerSearchProvider: (p) => registered.push(p) } }, {
	chromePath: process.env.CHROME_PATH,
});
const provider = registered[0];
if (!provider || provider.id !== PROVIDER_ID) {
	console.error('FAIL: provider not registered');
	process.exit(1);
}
if (!provider.available()) {
	console.error('FAIL: provider unavailable — no browser found; set CHROME_PATH');
	process.exit(1);
}

console.log(`provider: ${provider.id} | available: ${provider.available()}`);
const started = Date.now();
const result = await provider.search({
	query: process.env.TEST_QUERY ?? 'deepseek api pricing',
	maxResults: 8,
});
console.log(`elapsed: ${Date.now() - started}ms | sources: ${result.sources.length}`);

if (result.sources.length === 0) {
	console.error('FAIL: no sources returned');
	process.exit(1);
}
for (const source of result.sources) {
	console.log(`- ${source.title ?? source.url}`);
	console.log(`  ${source.url}`);
}
console.log('PASS');
