# dsh-web-search-ddg

[中文](README.zh.md) | English

Zero-token DuckDuckGo search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web capability seam (`ctx.web`).

DSH's shipped search route (`deepseek-official`) performs every `web_search` as a **full billed model round trip** on `deepseek-v4-flash` — even when your session model is something else entirely. This plugin replaces that with your **local browser**: it drives Chrome/Edge/Chromium headless against DuckDuckGo's HTML endpoint and parses the result links out of the dumped DOM.

- **Zero model tokens** per search — no API key, no auxiliary model request
- **Zero dependencies** — Node builtins only; no Playwright/Puppeteer download
- **Keeps the shipped provider registered** — switching is a one-line config change, not an uninstall

## Requirements

- A DSH host (≥ `0.1.0-rc`) providing the `ctx.web` seam
- A local Chromium-family browser. Detected automatically on macOS (Chrome, Edge, Chromium) and Linux (`/usr/bin/chromium`, `/usr/bin/google-chrome`); override with [`chromePath`](#configuration)
- Node.js ≥ 18

## Install

In your DSH profile directory (e.g. `~/.dsh/profiles/web`), install the package as an out-of-tree plugin:

```bash
pnpm add dsh-web-search-ddg
```

Then edit the profile's `cordis.patch.yml` to mount it and make it the default search provider. Note that a patch row **replaces the target row's whole config** (no deep merge), so the `web` row must restate every key — the shipped row owns only `searchProvider`:

```yaml
# Select this provider for the model-facing web_search tool.
- id: web
  config:
    searchProvider: ddg-browser

# Mount the plugin (registers provider id `ddg-browser`).
- insert:
    - id: web-search-ddg
      name: dsh-web-search-ddg
```

The shipped `web-search-deepseek` row stays untouched: its provider remains registered and available, so switching back is one line (`searchProvider: deepseek-official`). DSH's selection is a single explicit id, **not** a priority chain — there is no silent fallback by design.

Verify the composed tree without starting the host:

```bash
dsh --profile web --dump-config | grep -A2 searchProvider
```

Restart the host to apply (host-side plugin rows do not hot-reload).

## Configuration

All keys optional; the row config goes to the `insert` entry above.

| Key | Default | Meaning |
| --- | --- | --- |
| `chromePath` | first detected browser | Absolute path to a Chromium-family executable. |
| `timeoutMs` | `20000` | Per-attempt budget. On timeout, buffered DOM output still counts as success (Chrome's `--dump-dom` process often lingers after printing). Two attempts run per search; keep `2 × timeoutMs` under `tool-web`'s `searchTimeoutMs` (DSH ships 60s). |
| `virtualTimeBudgetMs` | `8000` | Chrome's `--virtual-time-budget` — how long the page may settle before the DOM is dumped. |

## Behavior notes

- **Latency is ~10–20s per search.** The DOM dump is usually ready quickly, but the child process frequently fails to exit on its own (background services never quiesce), so results often land at the timeout guard. The guard reads the buffered output, so the search still succeeds — just not fast.
- **DuckDuckGo anomaly pages fail loudly.** When the endpoint serves its anti-bot challenge, the plugin surfaces an explicit error naming the cause and the fallback (`switch searchProvider back to deepseek-official`). It never silently degrades.
- **The headless UA is overridden** with a plain desktop Chrome UA — the endpoint keys on the `HeadlessChrome` marker and blocks it otherwise. If searches start failing everywhere, DuckDuckGo may have tightened detection; bump the UA string in `index.js`.
- Every attempt runs in a throwaway `--user-data-dir` under the OS temp dir, cleaned up best-effort after the process dies (a leaked temp dir never fails a search).

## How it works

1. `spawn` the browser with `--headless --dump-dom --virtual-time-budget` and the UA override against `https://html.duckduckgo.com/html/?q=<query>`
2. Read the serialized DOM from stdout; a kill guard bounds hung pages, and buffered output at timeout is accepted
3. Parse `<a class="result__a">` (titles) and `<a class="result__snippet">` (snippets); both hrefs are `//duckduckgo.com/l/?uddg=<encoded>` redirects, so decode the real target URL from `uddg` and pair title/snippet on it
4. Return `{ sources: [{ url, title?, snippet? }], truncated: false }` through the seam — the model-facing `web_search` tool and result cards work unchanged

## Development

```bash
npm test          # end-to-end: registers on a stub ctx.web and runs one real search
CHROME_PATH=/path/to/browser npm test
TEST_QUERY="something else" npm test
```

## License

[MIT](LICENSE)
