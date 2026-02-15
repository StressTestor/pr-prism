# pr-prism triage report

> this is a real report from a test run against the [openclaw/openclaw](https://github.com/openclaw/openclaw) repo on feb 15, 2026. included here as an example of what `prism report` generates.

**repo:** openclaw/openclaw
**date:** 2026-02-15
**items scanned:** 6254 (3092 PRs, 3162 issues)

## overview

| metric | count |
|--------|-------|
| open PRs scanned | 3092 |
| open issues scanned | 3162 |
| duplicate clusters | 590 |
| items in duplicate clusters | 2500 (40% of total) |
| vision-aligned | 3097 |
| vision-drifting | 3156 |
| vision off-track | 1 |

## duplicate clusters (top 25)

these PRs/issues are similar enough to likely be duplicates. the "best pick" is the highest-quality item in each group.

| # | size | avg similarity | best pick | theme |
|---|------|---------------|-----------|-------|
| 8 | 366 | 66.2% | [#17494](https://github.com/openclaw/openclaw/pull/17494) | Discord channel bindings match sub-agent but session loads d |
| 68 | 51 | 70.2% | [#17493](https://github.com/openclaw/openclaw/pull/17493) | [Bug]: TUI stuck on “hobnobbing / twiddling thumbs” with loc |
| 25 | 50 | 78.0% | [#17370](https://github.com/openclaw/openclaw/pull/17370) | fix(cron): prevent spin loop when timer delay resolves to 0m |
| 33 | 46 | 74.6% | [#2557](https://github.com/openclaw/openclaw/pull/2557) | fix(agents): preserve tool call/result pairing in history li |
| 90 | 34 | 75.6% | [#6193](https://github.com/openclaw/openclaw/pull/6193) | fix(browser): default to openclaw profile instead of chrome  |
| 18 | 33 | 78.1% | [#16752](https://github.com/openclaw/openclaw/pull/16752) | fix: Slack channel read action passes threadId parameter |
| 445 | 33 | 78.0% | [#16888](https://github.com/openclaw/openclaw/pull/16888) | fix(cron): execute missed jobs outside the lock to unblock l |
| 105 | 27 | 76.8% | [#6353](https://github.com/openclaw/openclaw/pull/6353) | fix(agents): detect Anthropic 'exceed context limit' error f |
| 26 | 23 | 79.3% | [#17371](https://github.com/openclaw/openclaw/pull/17371) | fix(heartbeat): always strip HEARTBEAT_OK token from reply t |
| 124 | 19 | 77.8% | [#6702](https://github.com/openclaw/openclaw/pull/6702) | fix(voice-call): mark calls as ended when media stream disco |
| 38 | 18 | 77.4% | [#17469](https://github.com/openclaw/openclaw/pull/17469) | Improve unknown-model errors for provider/model misconfigura |
| 30 | 17 | 77.4% | [#16929](https://github.com/openclaw/openclaw/pull/16929) | security: block access to sensitive directories from within  |
| 224 | 16 | 77.5% | [#9221](https://github.com/openclaw/openclaw/pull/9221) | fix(skills): use skillKey for env config lookup in snapshots |
| 5 | 14 | 77.9% | [#17445](https://github.com/openclaw/openclaw/pull/17445) | fix(pi-embedded): add aggregate timeout to compaction retry  |
| 103 | 14 | 78.6% | [#6463](https://github.com/openclaw/openclaw/pull/6463) | fix(telegram): improve timeout handling and prevent channel  |
| 272 | 13 | 76.7% | [#10844](https://github.com/openclaw/openclaw/pull/10844) | feat: add github-copilot/claude-opus-4.6 model support |
| 386 | 13 | 87.7% | [#15242](https://github.com/openclaw/openclaw/pull/15242) | feat(web-fetch): Add Accept header for Cloudflare Markdown f |
| 58 | 12 | 82.0% | [#4572](https://github.com/openclaw/openclaw/pull/4572) | fix(agents): provide model fallback for compaction safeguard |
| 1 | 11 | 80.2% | [#17453](https://github.com/openclaw/openclaw/pull/17453) | fix(signal): make group reactions deterministic from inbound |
| 86 | 11 | 82.0% | [#6017](https://github.com/openclaw/openclaw/pull/6017) | feat(hooks): add systemPrompt and tools to before_agent_star |
| 102 | 11 | 83.9% | [#6128](https://github.com/openclaw/openclaw/pull/6128) | Fail closed when Telnyx webhook public key is missing (voice |
| 191 | 11 | 80.7% | [#9163](https://github.com/openclaw/openclaw/pull/9163) | Fix: Save Anthropic setup token to config file |
| 247 | 11 | 82.0% | [#5496](https://github.com/openclaw/openclaw/pull/5496) | Fix: Windows path separators stripped in Gateway scheduled t |
| 442 | 11 | 82.7% | [#17482](https://github.com/openclaw/openclaw/pull/17482) | fix(gateway): preserve scopes for shared-auth clients withou |
| 159 | 10 | 80.1% | [#8212](https://github.com/openclaw/openclaw/pull/8212) | fix: resolve multiple tool issues (#8169, #8154, #8096, #815 |

## largest duplicate groups

### cluster #8: Discord channel bindings match sub-agent but session loads default agent's works (366 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#17494](https://github.com/openclaw/openclaw/pull/17494) | joho777 | Discord channel bindings match sub-agent but session loads d | 2026-02-15 |
| [#17485](https://github.com/openclaw/openclaw/pull/17485) | daluzai-source | Gateway writes absolute paths to sessions.json, causing watc | 2026-02-15 |
| [#17480](https://github.com/openclaw/openclaw/pull/17480) | kuoshumed | Compaction never triggers (mode=default, Compactions always  | 2026-02-15 |
| [#17474](https://github.com/openclaw/openclaw/pull/17474) | eduardhempellondon | [Bug]: Telegram bot token returns 401 Unauthorized despite v | 2026-02-15 |
| [#17433](https://github.com/openclaw/openclaw/pull/17433) | widingmarcus-cyber | fix(telegram): omit message_thread_id for private chats to p | 2026-02-15 |
| [#17432](https://github.com/openclaw/openclaw/pull/17432) | clawinho | fix(telegram): skip message_thread_id for private chats in s | 2026-02-15 |
| [#16682](https://github.com/openclaw/openclaw/pull/16682) | BinHPdev | fix: add preferSessionLookupForAnnounceTarget to channel plu | 2026-02-15 |
| [#17251](https://github.com/openclaw/openclaw/pull/17251) | CornBrother0x | fix(cli): spawn new process for daemon restart after update | 2026-02-15 |
| [#17221](https://github.com/openclaw/openclaw/pull/17221) | CornBrother0x | fix(agents): prevent agents from using exec for gateway mana | 2026-02-15 |
| [#16823](https://github.com/openclaw/openclaw/pull/16823) | michaelfehl | Session corruption during tool execution - tool_use/result m | 2026-02-15 |
| [#17421](https://github.com/openclaw/openclaw/pull/17421) | kurko | [Bug]: Inbound messages silently dropped when debounce flush | 2026-02-15 |
| [#2778](https://github.com/openclaw/openclaw/pull/2778) | Lukavyi | fix: message tool media (images, files) sent to General topi | 2026-02-15 |
| [#4999](https://github.com/openclaw/openclaw/pull/4999) | Farfadium | fix(memory-flush): use contextTokens instead of totalTokens  | 2026-02-15 |
| [#5764](https://github.com/openclaw/openclaw/pull/5764) | garnetlyx | fix(telegram): enable streaming in private chats without top | 2026-02-15 |
| [#6192](https://github.com/openclaw/openclaw/pull/6192) | ViffyGwaanl | Telegram: fix DM Topics thread routing | 2026-02-15 |
| ... | | +351 more | |

### cluster #68: [Bug]: TUI stuck on “hobnobbing / twiddling thumbs” with local‑ollama/llama3:lat (51 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#17493](https://github.com/openclaw/openclaw/pull/17493) | mkrejcarek-art | [Bug]: TUI stuck on “hobnobbing / twiddling thumbs” with loc | 2026-02-15 |
| [#11131](https://github.com/openclaw/openclaw/pull/11131) | aureliolk | [Bug]: Docker: CLI container cannot reach gateway (127.0.0.1 | 2026-02-15 |
| [#4782](https://github.com/openclaw/openclaw/pull/4782) | spiceoogway | fix: Auto-discover Ollama models without requiring explicit  | 2026-02-15 |
| [#6698](https://github.com/openclaw/openclaw/pull/6698) | barshopen | feat: Add CLI wrapper for Docker integration and update docu | 2026-02-15 |
| [#7278](https://github.com/openclaw/openclaw/pull/7278) | alltomatos | feat(ollama): optimize local LLM support with auto-discovery | 2026-02-15 |
| [#7133](https://github.com/openclaw/openclaw/pull/7133) | synetalsolutions | feat: Automated Docker setup with environment-based configur | 2026-02-15 |
| [#9660](https://github.com/openclaw/openclaw/pull/9660) | divol89 | fix: auto-default baseUrl for Ollama provider (#9652) | 2026-02-15 |
| [#9999](https://github.com/openclaw/openclaw/pull/9999) | benclarkeio | Docker: fix token mismatch and add dev setup workflow | 2026-02-15 |
| [#10742](https://github.com/openclaw/openclaw/pull/10742) | hillct | Feature/remote ollama - enable autodiscovery ollama models o | 2026-02-15 |
| [#12504](https://github.com/openclaw/openclaw/pull/12504) | bvanderdrift | fix: allow docker cli container to connect to gateway | 2026-02-15 |
| [#13941](https://github.com/openclaw/openclaw/pull/13941) | mine260309 | fix: use openclaw-gateway network for cli | 2026-02-15 |
| [#14061](https://github.com/openclaw/openclaw/pull/14061) | gokusenz | fix(gateway): Docker CLI container gateway connectivity and  | 2026-02-15 |
| [#13857](https://github.com/openclaw/openclaw/pull/13857) | itsGustav | fix: warn when local agent models.json silently overrides ce | 2026-02-15 |
| [#15791](https://github.com/openclaw/openclaw/pull/15791) | ttulttul | Docker: load buildx image and reuse gateway token | 2026-02-15 |
| [#16098](https://github.com/openclaw/openclaw/pull/16098) | claw-sylphx | fix: omit tools param for models without tool support, surfa | 2026-02-15 |
| ... | | +36 more | |

### cluster #25: fix(cron): prevent spin loop when timer delay resolves to 0ms (50 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#17370](https://github.com/openclaw/openclaw/pull/17370) | BinHPdev | fix(cron): prevent spin loop when timer delay resolves to 0m | 2026-02-15 |
| [#5428](https://github.com/openclaw/openclaw/pull/5428) | imshrishk | fix(Cron): prevent one-shot loop on skip | 2026-02-15 |
| [#5179](https://github.com/openclaw/openclaw/pull/5179) | thatdaveb | fix(cron): recover stale running markers | 2026-02-15 |
| [#5624](https://github.com/openclaw/openclaw/pull/5624) | simran122 | add support_human_readable_time_format in cron | 2026-02-15 |
| [#6827](https://github.com/openclaw/openclaw/pull/6827) | fatelei | fix: cron scheduler cleanup orphaned .tmp files on startup | 2026-02-15 |
| [#8034](https://github.com/openclaw/openclaw/pull/8034) | FelixFoster | fix(cron): run past-due one-shot jobs immediately on startup | 2026-02-15 |
| [#7984](https://github.com/openclaw/openclaw/pull/7984) | ThunderDrag | fix undefined variable in cron | 2026-02-15 |
| [#8379](https://github.com/openclaw/openclaw/pull/8379) | Gerrald12312 | fix(cron): handle past-due one-shot 'at' jobs that haven't r | 2026-02-15 |
| [#8578](https://github.com/openclaw/openclaw/pull/8578) | Baoxd123 | fix(cron): add failure limit and exponential backoff for iso | 2026-02-15 |
| [#8744](https://github.com/openclaw/openclaw/pull/8744) | revenuestack | fix(cron): load persisted cron jobs on gateway startup | 2026-02-15 |
| [#8698](https://github.com/openclaw/openclaw/pull/8698) | emmick4 | fix(cron): default enabled to true for new jobs | 2026-02-15 |
| [#8701](https://github.com/openclaw/openclaw/pull/8701) | maximus-claw | fix: default enabled to true for cron jobs created via tool  | 2026-02-15 |
| [#9060](https://github.com/openclaw/openclaw/pull/9060) | vishaltandale00 | Fix: Preserve scheduled cron jobs after gateway restart | 2026-02-15 |
| [#8811](https://github.com/openclaw/openclaw/pull/8811) | hlibr | fix(cron): handle atMs fallback for kind=at jobs | 2026-02-15 |
| [#8825](https://github.com/openclaw/openclaw/pull/8825) | dbottme | fix: prevent cron infinite retry loop with exponential backo | 2026-02-15 |
| ... | | +35 more | |

### cluster #33: fix(agents): preserve tool call/result pairing in history limiting (46 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#2557](https://github.com/openclaw/openclaw/pull/2557) | steve-rodri | fix(agents): preserve tool call/result pairing in history li | 2026-02-15 |
| [#3880](https://github.com/openclaw/openclaw/pull/3880) | SalimBinYousuf1 | fix: drop assistant messages with stopReason 'error' to avoi | 2026-02-15 |
| [#3362](https://github.com/openclaw/openclaw/pull/3362) | samhotchkiss | fix: auto-repair and retry on orphan tool_result errors | 2026-02-15 |
| [#3647](https://github.com/openclaw/openclaw/pull/3647) | nhangen | fix: sanitize tool arguments in session history | 2026-02-15 |
| [#4009](https://github.com/openclaw/openclaw/pull/4009) | drag88 | fix(agent): sanitize messages after orphan user repair | 2026-02-15 |
| [#4057](https://github.com/openclaw/openclaw/pull/4057) | wangchuan3533 | fix: sanitize tool call IDs for Azure OpenAI | 2026-02-15 |
| [#4844](https://github.com/openclaw/openclaw/pull/4844) | lailoo | fix(agents): skip error/aborted assistant messages in transc | 2026-02-15 |
| [#4852](https://github.com/openclaw/openclaw/pull/4852) | lailoo | fix(agents): sanitize tool pairing after compaction and hist | 2026-02-15 |
| [#4700](https://github.com/openclaw/openclaw/pull/4700) | marcelomar21 | fix: deduplicate tool_use IDs and enable sanitization for An | 2026-02-15 |
| [#6687](https://github.com/openclaw/openclaw/pull/6687) | NSEvent | fix(session-repair): strip malformed tool_use blocks to prev | 2026-02-15 |
| [#8117](https://github.com/openclaw/openclaw/pull/8117) | TylonHH | Agents: sanitize tool call ids for OpenAI | 2026-02-15 |
| [#8312](https://github.com/openclaw/openclaw/pull/8312) | ekson73 | fix: add logging and markers for tool result repair | 2026-02-15 |
| [#8270](https://github.com/openclaw/openclaw/pull/8270) | heliosarchitect | fix: support snake_case 'tool_use' in transcript repair (#82 | 2026-02-15 |
| [#8345](https://github.com/openclaw/openclaw/pull/8345) | vishaltandale00 | fix: prevent synthetic error repair from creating tool_resul | 2026-02-15 |
| [#8654](https://github.com/openclaw/openclaw/pull/8654) | dinakars777 | fix(agents): sanitize tool names in session transcript repai | 2026-02-15 |
| ... | | +31 more | |

### cluster #90: fix(browser): default to openclaw profile instead of chrome extension relay (34 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#6193](https://github.com/openclaw/openclaw/pull/6193) | mikezaoldyeck | fix(browser): default to openclaw profile instead of chrome  | 2026-02-15 |
| [#7157](https://github.com/openclaw/openclaw/pull/7157) | AkashaBot | docs(browser): recommend openclaw managed profile as default | 2026-02-15 |
| [#10390](https://github.com/openclaw/openclaw/pull/10390) | Mokoby | fix(chrome-relay): sticky attach + auto-restore after discon | 2026-02-15 |
| [#13568](https://github.com/openclaw/openclaw/pull/13568) | singlag | Fix browser (OpenClaw-managed) launch fail by binding remote | 2026-02-15 |
| [#13942](https://github.com/openclaw/openclaw/pull/13942) | gabepsilva | Fix: chrome-extension: make relay reconnect reliable with on | 2026-02-15 |
| [#14944](https://github.com/openclaw/openclaw/pull/14944) | BenediktSchackenberg | fix(browser): prefer openclaw profile in headless/noSandbox  | 2026-02-15 |
| [#15817](https://github.com/openclaw/openclaw/pull/15817) | derrickburns | fix(chrome-relay): auto-reconnect, MV3 persistence, and keep | 2026-02-15 |
| [#16023](https://github.com/openclaw/openclaw/pull/16023) | codexGW | fix(chrome-relay): resilient reconnect, MV3 persistence, and | 2026-02-15 |
| [#16743](https://github.com/openclaw/openclaw/pull/16743) | jg-noncelogic | fix: auto-reattach browser relay debugger after navigation | 2026-02-15 |
| [#14503](https://github.com/openclaw/openclaw/pull/14503) | sovushik | [Bug]: browser.act intermittently times out ("Can't reach th | 2026-02-15 |
| [#14215](https://github.com/openclaw/openclaw/pull/14215) | Boss45120 | Browser Control Broken | 2026-02-15 |
| [#3941](https://github.com/openclaw/openclaw/pull/3941) | AlbertoSpain | [Bug]: Browser Control Server hangs on /start endpoint (x64  | 2026-02-15 |
| [#15099](https://github.com/openclaw/openclaw/pull/15099) | codexGW | Chrome extension relay: frequent disconnects require manual  | 2026-02-14 |
| [#6175](https://github.com/openclaw/openclaw/pull/6175) | miltondwight | Browser extension relay returns stale tab cache after CDP co | 2026-02-14 |
| [#15666](https://github.com/openclaw/openclaw/pull/15666) | bobbymcassistor-hue | Browser automation click/type hangs: snapshots/evaluate work | 2026-02-13 |
| ... | | +19 more | |

### cluster #18: fix: Slack channel read action passes threadId parameter (33 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#16752](https://github.com/openclaw/openclaw/pull/16752) | BinHPdev | fix: Slack channel read action passes threadId parameter | 2026-02-15 |
| [#2917](https://github.com/openclaw/openclaw/pull/2917) | SocialNerd42069 | Slack: fix thread context + prevent reply spillover | 2026-02-15 |
| [#4749](https://github.com/openclaw/openclaw/pull/4749) | nvonpentz | fix: handle string thread IDs in queue drain for Slack | 2026-02-15 |
| [#5098](https://github.com/openclaw/openclaw/pull/5098) | galligan | fix(slack): forward threadId for message.read | 2026-02-15 |
| [#6071](https://github.com/openclaw/openclaw/pull/6071) | lyra63237 | fix(cli): add --thread-id option to message read command | 2026-02-15 |
| [#5935](https://github.com/openclaw/openclaw/pull/5935) | thisischappy | fix(slack): persist thread starter body across thread messag | 2026-02-15 |
| [#6509](https://github.com/openclaw/openclaw/pull/6509) | morningstar-daemon | fix(slack): pass threadId param in read action | 2026-02-15 |
| [#8764](https://github.com/openclaw/openclaw/pull/8764) | aithne-z | fix(slack): respect replyToMode=off for threading | 2026-02-15 |
| [#10686](https://github.com/openclaw/openclaw/pull/10686) | pablohrcarvalho | fix(slack): use thread-level sessions for channels to preven | 2026-02-15 |
| [#11194](https://github.com/openclaw/openclaw/pull/11194) | Lukavyi | fix(slack): queue drain drops string thread_ts — replies lea | 2026-02-15 |
| [#12244](https://github.com/openclaw/openclaw/pull/12244) | junhoyeo | fix(slack): preserve thread context for DM thread replies | 2026-02-15 |
| [#11934](https://github.com/openclaw/openclaw/pull/11934) | sandieman2 | fix(slack): preserve thread_ts in queue drain and deliveryCo | 2026-02-15 |
| [#12199](https://github.com/openclaw/openclaw/pull/12199) | dbg-vanie | fix(message): add threadId parameter to fetch schema for Sla | 2026-02-15 |
| [#13438](https://github.com/openclaw/openclaw/pull/13438) | sandieman2 | fix(slack): pass threadId through to readSlackMessages in ex | 2026-02-15 |
| [#14720](https://github.com/openclaw/openclaw/pull/14720) | lailoo | fix(slack): pass threadId in plugin read action (#14706) | 2026-02-15 |
| ... | | +18 more | |

### cluster #445: fix(cron): execute missed jobs outside the lock to unblock list/status queries (33 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#16888](https://github.com/openclaw/openclaw/pull/16888) | hou-rong | fix(cron): execute missed jobs outside the lock to unblock l | 2026-02-15 |
| [#16156](https://github.com/openclaw/openclaw/pull/16156) | emreylmaz | [Bug]: Recurring cron jobs (schedule.kind: 'cron') never exe | 2026-02-15 |
| [#17143](https://github.com/openclaw/openclaw/pull/17143) | bgaither4 | Cron runMissedJobs lacks circuit breakers, causes death spir | 2026-02-15 |
| [#14751](https://github.com/openclaw/openclaw/pull/14751) | yvesgagnongesys | Gateway timeout on cron list while cron jobs still execute n | 2026-02-15 |
| [#16887](https://github.com/openclaw/openclaw/pull/16887) | geonha-gorgeous | Bug: cron add with 'at' schedule returns success but doesn't | 2026-02-15 |
| [#16890](https://github.com/openclaw/openclaw/pull/16890) | hou-rong | Cron: WebUI list/status blocked for minutes after gateway re | 2026-02-15 |
| [#16256](https://github.com/openclaw/openclaw/pull/16256) | menidi | Cron job sessions ignore agentId — all runs stored under mai | 2026-02-14 |
| [#13947](https://github.com/openclaw/openclaw/pull/13947) | zhaim | [Bug]: Cron scheduler cannot detect missed executions | 2026-02-14 |
| [#13509](https://github.com/openclaw/openclaw/pull/13509) | ponchoooPenguin | Cron scheduler wakes but never spawns sessions (jobs advance | 2026-02-13 |
| [#13546](https://github.com/openclaw/openclaw/pull/13546) | acknudsen1984 | Cron Scheduler Bug: Isolated Agent Jobs Not Executing | 2026-02-13 |
| [#13954](https://github.com/openclaw/openclaw/pull/13954) | joshuaangulo | Cron scheduler stops firing after rapid gateway restarts | 2026-02-13 |
| [#15048](https://github.com/openclaw/openclaw/pull/15048) | nomadonwheels196 | [Feature Request] Add retention policy for isolated cron ses | 2026-02-13 |
| [#14275](https://github.com/openclaw/openclaw/pull/14275) | fertilejim | [Bug]: Gateway freezes on startup when many overdue cron job | 2026-02-12 |
| [#14642](https://github.com/openclaw/openclaw/pull/14642) | mrz1836 | [Bug]: Cron jobs re-fire on gateway restart/update | 2026-02-12 |
| [#14686](https://github.com/openclaw/openclaw/pull/14686) | jarvisstone | Cron one-shot schedule.kind=at jobs are skipped as disabled  | 2026-02-12 |
| ... | | +18 more | |

### cluster #105: fix(agents): detect Anthropic 'exceed context limit' error for auto-compaction (27 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#6353](https://github.com/openclaw/openclaw/pull/6353) | Glucksberg | fix(agents): detect Anthropic 'exceed context limit' error f | 2026-02-15 |
| [#8661](https://github.com/openclaw/openclaw/pull/8661) | dbottme | fix: display rate limit errors correctly instead of as conte | 2026-02-15 |
| [#9562](https://github.com/openclaw/openclaw/pull/9562) | danilofalcao | fix: detect Kimi K2.5 context overflow error (model token li | 2026-02-15 |
| [#10003](https://github.com/openclaw/openclaw/pull/10003) | maxtongwang | fix: stop misclassifying rate-limit errors as context overfl | 2026-02-15 |
| [#10601](https://github.com/openclaw/openclaw/pull/10601) | DukeDeSouth | fix: prevent FailoverError (rate_limit/billing) from being m | 2026-02-15 |
| [#10612](https://github.com/openclaw/openclaw/pull/10612) | 1kuna | fix: trim leading blank lines on first emitted chunk only (# | 2026-02-15 |
| [#10792](https://github.com/openclaw/openclaw/pull/10792) | arunsanna | Agents: avoid context overflow false positives | 2026-02-15 |
| [#11680](https://github.com/openclaw/openclaw/pull/11680) | lailoo | Agents: guard billing error detection with length check (#11 | 2026-02-15 |
| [#11685](https://github.com/openclaw/openclaw/pull/11685) | lailoo | Agents: scope error rewrites in sanitizeUserFacingText behin | 2026-02-15 |
| [#12052](https://github.com/openclaw/openclaw/pull/12052) | skylarkoo7 | fix: scope error-detection heuristics to error source in san | 2026-02-15 |
| [#12226](https://github.com/openclaw/openclaw/pull/12226) | Yida-Dev | fix: remove billing error false-positive from sanitizeUserFa | 2026-02-15 |
| [#12325](https://github.com/openclaw/openclaw/pull/12325) | jordanstern | fix: trim leading/trailing whitespace from outbound messages | 2026-02-15 |
| [#12273](https://github.com/openclaw/openclaw/pull/12273) | Yida-Dev | fix: prevent billing error false positive on bare '402' in c | 2026-02-15 |
| [#12702](https://github.com/openclaw/openclaw/pull/12702) | zerone0x | fix: prevent sanitizeUserFacingText false-positives on assis | 2026-02-15 |
| [#12777](https://github.com/openclaw/openclaw/pull/12777) | jpaine | fix: prevent false positive billing error detection in sanit | 2026-02-15 |
| ... | | +12 more | |

### cluster #26: fix(heartbeat): always strip HEARTBEAT_OK token from reply text (23 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#17371](https://github.com/openclaw/openclaw/pull/17371) | BinHPdev | fix(heartbeat): always strip HEARTBEAT_OK token from reply t | 2026-02-15 |
| [#9429](https://github.com/openclaw/openclaw/pull/9429) | dbottme | fix: skip session model override for heartbeat runs | 2026-02-15 |
| [#9721](https://github.com/openclaw/openclaw/pull/9721) | divol89 | fix: heartbeat model override not working for per-agent conf | 2026-02-15 |
| [#11661](https://github.com/openclaw/openclaw/pull/11661) | veast | fix: Filter HEARTBEAT_OK from chat.history when showOk is fa | 2026-02-15 |
| [#11647](https://github.com/openclaw/openclaw/pull/11647) | liuxiaopai-ai | fix(webchat): filter HEARTBEAT_OK messages from chat.history | 2026-02-15 |
| [#11859](https://github.com/openclaw/openclaw/pull/11859) | Zjianru | fix: filter HEARTBEAT_OK messages from chat.history when sho | 2026-02-15 |
| [#11889](https://github.com/openclaw/openclaw/pull/11889) | bendyclaw | fix(chat): filter HEARTBEAT_OK messages in chat.history when | 2026-02-15 |
| [#12240](https://github.com/openclaw/openclaw/pull/12240) | Yida-Dev | fix: suppress heartbeat agent events from webchat broadcast | 2026-02-15 |
| [#12837](https://github.com/openclaw/openclaw/pull/12837) | JBrady | fix(heartbeat): suppress HEARTBEAT_OK token delivery | 2026-02-15 |
| [#12786](https://github.com/openclaw/openclaw/pull/12786) | mcaxtr | fix: drop heartbeat runs that arrive while another run is ac | 2026-02-15 |
| [#12774](https://github.com/openclaw/openclaw/pull/12774) | a2093930 | fix: webchat heartbeat should respect showAlerts config | 2026-02-15 |
| [#13016](https://github.com/openclaw/openclaw/pull/13016) | asklee-klawd | fix(heartbeat): ignore session modelOverride when heartbeat. | 2026-02-15 |
| [#15575](https://github.com/openclaw/openclaw/pull/15575) | TsekaLuk | fix(heartbeat): suppress prefixed HEARTBEAT_OK ack replies ( | 2026-02-15 |
| [#16321](https://github.com/openclaw/openclaw/pull/16321) | tdjackey | Fix #12767: suppress HEARTBEAT_OK leakage in Telegram DM rep | 2026-02-15 |
| [#16373](https://github.com/openclaw/openclaw/pull/16373) | luisecab | fix: suppress leaked heartbeat poll prompts in reply deliver | 2026-02-15 |
| ... | | +8 more | |

### cluster #124: fix(voice-call): mark calls as ended when media stream disconnects (19 items)

| # | author | title | updated |
|---|--------|-------|--------|
| [#6702](https://github.com/openclaw/openclaw/pull/6702) | johngnip | fix(voice-call): mark calls as ended when media stream disco | 2026-02-15 |
| [#7704](https://github.com/openclaw/openclaw/pull/7704) | coygeek | fix(voice-call): add authentication to WebSocket media strea | 2026-02-15 |
| [#8297](https://github.com/openclaw/openclaw/pull/8297) | vishaltandale00 | fix(voice-call): prevent empty TwiML for non-in-progress out | 2026-02-15 |
| [#11913](https://github.com/openclaw/openclaw/pull/11913) | jason-alvarez-git | fix(voice-call): pass stream auth token via TwiML Parameter, | 2026-02-15 |
| [#12471](https://github.com/openclaw/openclaw/pull/12471) | Yida-Dev | fix(voice-call): pass stream auth token via TwiML Parameter  | 2026-02-15 |
| [#17264](https://github.com/openclaw/openclaw/pull/17264) | mferraznw | voice-call: duplicate bundled plugin causes stream token rej | 2026-02-15 |
| [#5732](https://github.com/openclaw/openclaw/pull/5732) | phantomgreen75 | voice-call: conversation mode drops call immediately / no au | 2026-02-15 |
| [#13823](https://github.com/openclaw/openclaw/pull/13823) | markclawbot | Voice Call plugin initializes twice per SIGUSR1 restart, cau | 2026-02-13 |
| [#13847](https://github.com/openclaw/openclaw/pull/13847) | LearnedClaw | Voice Call Plugin: Media stream connects but onConnect callb | 2026-02-13 |
| [#14545](https://github.com/openclaw/openclaw/pull/14545) | biggiesmallsbot | voice-call: TTS audio not reaching caller in conversation mo | 2026-02-12 |
| [#4820](https://github.com/openclaw/openclaw/pull/4820) | base698 | voice-call plugin: Streaming returns 404, non-streaming igno | 2026-02-11 |
| [#5131](https://github.com/openclaw/openclaw/pull/5131) | bradlind1 | Voice call plugin accepts calls but never generates/serves T | 2026-02-11 |
| [#8926](https://github.com/openclaw/openclaw/pull/8926) | 0xTrxz | [voice-call] EADDRINUSE on gateway restart — no port conflic | 2026-02-10 |
| [#10950](https://github.com/openclaw/openclaw/pull/10950) | slatem | [Bug]: Voice-call stream token validation fails through reve | 2026-02-10 |
| [#12807](https://github.com/openclaw/openclaw/pull/12807) | Banzai8 | [Bug] voice-call plugin: EADDRINUSE port conflict when initi | 2026-02-10 |
| ... | | +4 more | |

## top 20 ranked PRs

ranked by quality signals: description quality, author track record, recency, CI status, review approvals.

| rank | # | score | author | title |
|------|---|-------|--------|-------|
| 1 | [#11974](https://github.com/openclaw/openclaw/pull/11974) | 0.52 | mcaxtr | [FEATURE] feat: integrate systemd WatchdogSec for gateway ha |
| 2 | [#8427](https://github.com/openclaw/openclaw/pull/8427) | 0.52 | mcaxtr | [FEATURE] feat(spool): add spool event dispatch system with  |
| 3 | [#9657](https://github.com/openclaw/openclaw/pull/9657) | 0.52 | mcaxtr | fix(doctor): warn when sandbox mode enabled without Docker |
| 4 | [#10102](https://github.com/openclaw/openclaw/pull/10102) | 0.52 | mcaxtr | fix: handle file_path alias in verbose tool display |
| 5 | [#10487](https://github.com/openclaw/openclaw/pull/10487) | 0.52 | mcaxtr | fix(line): use snapshot configured flag in collectStatusIssu |
| 6 | [#10643](https://github.com/openclaw/openclaw/pull/10643) | 0.52 | mcaxtr | fix(slack): classify D-prefix DMs correctly when channel_typ |
| 7 | [#11270](https://github.com/openclaw/openclaw/pull/11270) | 0.52 | mcaxtr | fix(agents): strip oversized images from session to prevent  |
| 8 | [#11494](https://github.com/openclaw/openclaw/pull/11494) | 0.52 | mcaxtr | fix(bluebubbles): skip typing indicator for tapback messages |
| 9 | [#11529](https://github.com/openclaw/openclaw/pull/11529) | 0.52 | mcaxtr | fix(wizard): strip shell-style backslash escapes from worksp |
| 10 | [#11613](https://github.com/openclaw/openclaw/pull/11613) | 0.52 | mcaxtr | fix: clear stale model metadata on /new and /reset |
| 11 | [#12015](https://github.com/openclaw/openclaw/pull/12015) | 0.52 | mcaxtr | fix(tts): handle undefined error.message in provider fallbac |
| 12 | [#12048](https://github.com/openclaw/openclaw/pull/12048) | 0.52 | mcaxtr | fix: deduplicate config warnings to log once instead of on e |
| 13 | [#12060](https://github.com/openclaw/openclaw/pull/12060) | 0.52 | mcaxtr | fix(gateway): return 404 for missing static assets instead o |
| 14 | [#12103](https://github.com/openclaw/openclaw/pull/12103) | 0.52 | mcaxtr | fix: add missing zod dependency to 7 extensions |
| 15 | [#12195](https://github.com/openclaw/openclaw/pull/12195) | 0.52 | mcaxtr | fix(agents): sync config fallback for lookupContextTokens co |
| 16 | [#12204](https://github.com/openclaw/openclaw/pull/12204) | 0.52 | mcaxtr | fix(discord): resolve numeric guildId/channelId pairs in cha |
| 17 | [#12191](https://github.com/openclaw/openclaw/pull/12191) | 0.52 | mcaxtr | fix: guard against undefined model.input in display and scan |
| 18 | [#12209](https://github.com/openclaw/openclaw/pull/12209) | 0.52 | mcaxtr | fix(skills): refresh stale skill snapshot after gateway rest |
| 19 | [#12248](https://github.com/openclaw/openclaw/pull/12248) | 0.52 | mcaxtr | fix: wire streaming config field through resolveExtraParams  |
| 20 | [#12257](https://github.com/openclaw/openclaw/pull/12257) | 0.52 | mcaxtr | fix(mattermost): default table mode to 'off' for native Mark |

## vision alignment

checked against the project's README for alignment with stated goals.

- **aligned:** 3097 items match the project vision
- **drifting:** 3156 items are loosely related
- **off-vision:** 1 items don't match the project direction

---
*generated by [pr-prism](https://github.com/StressTestor/pr-prism)*
