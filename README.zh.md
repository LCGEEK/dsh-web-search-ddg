# dsh-web-search-ddg

English | [中文](README.zh.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）web 能力 seam（`ctx.web`）提供的零 token DuckDuckGo 搜索提供方。

DSH 自带的搜索路由（`deepseek-official`）把每次 `web_search` 执行为一次 **`deepseek-v4-flash` 上的完整计费模型请求**——即使你会话模型选的是别的。本插件用你的**本地浏览器**替换它：以 headless 模式驱动 Chrome/Edge/Chromium 抓取 DuckDuckGo 的 HTML 端点，并从 dump 出的 DOM 中解析结果链接。

- 每次搜索**零模型 token**——不需要 API key，不产生辅助模型请求
- **零依赖**——只用 Node 内置模块；不需要下载 Playwright/Puppeteer
- **保留自带提供方的注册**——切换只是一行配置，不用卸载

## 环境要求

- 提供 `ctx.web` seam 的 DSH 宿主（≥ `0.1.0-rc`）
- 本地 Chromium 系浏览器。macOS（Chrome、Edge、Chromium）与 Linux（`/usr/bin/chromium`、`/usr/bin/google-chrome`）自动探测；可用 [`chromePath`](#配置) 覆盖
- Node.js ≥ 18

## 安装

在你的 DSH profile 目录（如 `~/.dsh/profiles/web`）中，作为树外插件安装：

```bash
pnpm add dsh-web-search-ddg
```

然后编辑 profile 的 `cordis.patch.yml`，挂载插件并将其设为默认搜索提供方。注意 patch 行会**整体替换目标行的 config**（无深度合并），因此 `web` 行必须重述其拥有的全部键——自带行只拥有 `searchProvider`：

```yaml
# 为面向模型的 web_search 工具选择本提供方。
- id: web
  config:
    searchProvider: ddg-browser

# 挂载插件（注册提供方 id `ddg-browser`）。
- insert:
    - id: web-search-ddg
      name: dsh-web-search-ddg
```

自带的 `web-search-deepseek` 行保持不动：其提供方仍注册且可用，切回只需一行（`searchProvider: deepseek-official`）。DSH 的选择是单一显式 id，**不是**优先级链——设计上就没有静默回退。

不启动宿主即可验证组合后的配置树：

```bash
dsh --profile web --dump-config | grep -A2 searchProvider
```

重启宿主后生效（host 侧插件行不热更新）。

## 配置

所有键均可选；配置写在上面 `insert` 条目里。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `chromePath` | 第一个探测到的浏览器 | Chromium 系可执行文件的绝对路径。 |
| `timeoutMs` | `20000` | 单次尝试预算。超时时已缓冲的 DOM 输出仍算成功（Chrome 的 `--dump-dom` 进程打印后经常不退出）。每次搜索共两次尝试；保持 `2 × timeoutMs` 小于 `tool-web` 的 `searchTimeoutMs`（DSH 默认 60s）。 |
| `virtualTimeBudgetMs` | `8000` | Chrome 的 `--virtual-time-budget`——dump DOM 前页面允许的沉寂时长。 |

## 行为说明

- **每次搜索延迟约 10–20 秒。** DOM 通常很快就绪，但子进程经常不自行退出（后台服务不会静默），因此结果常在超时兜底时拿到。兜底会读取缓冲输出，搜索仍然成功——只是不快。
- **DuckDuckGo 挑战页会显式报错。** 端点返回反爬挑战时，插件抛出明确错误，说明原因与回退方式（`switch searchProvider back to deepseek-official`）。绝不静默降级。
- **headless UA 被覆盖**为普通桌面 Chrome UA——端点识别 `HeadlessChrome` 标记并据此拦截。如果搜索开始普遍失败，可能是 DuckDuckGo 收紧了检测；更新 `index.js` 中的 UA 字符串。
- 每次尝试都在 OS 临时目录下的一次性 `--user-data-dir` 中运行，进程结束后尽力清理（泄漏的临时目录绝不会导致搜索失败）。

## 工作原理

1. 以 `--headless --dump-dom --virtual-time-budget` 和 UA 覆盖 `spawn` 浏览器，访问 `https://html.duckduckgo.com/html/?q=<query>`
2. 从 stdout 读取序列化 DOM；kill 兜底约束挂起的页面，超时时已缓冲的输出会被采纳
3. 解析 `<a class="result__a">`（标题）与 `<a class="result__snippet">`（摘要）；两类 href 都是 `//duckduckgo.com/l/?uddg=<encoded>` 跳转，因此从 `uddg` 解码真实目标 URL，并按它配对标题/摘要
4. 通过 seam 返回 `{ sources: [{ url, title?, snippet? }], truncated: false }`——面向模型的 `web_search` 工具与结果卡片无需任何改动

## 开发

```bash
npm test          # 端到端：注册到 stub ctx.web 并跑一次真实搜索
CHROME_PATH=/path/to/browser npm test
TEST_QUERY="换个查询" npm test
```

## 许可证

[MIT](LICENSE)
