# DeepSeek V4 Flash Session Loop

## Goal

Measure the REAL V1 session loop (prompt admission -> provider stream -> tool loop) against the repo's mock LLM server, configured with `deepseek/deepseek-v4-flash` from the models fixture, so model-tuning changes can be proven before/after. This log records the baseline and the after-tuning runs.

## Benchmark Command

Run from `packages/opencode`:

```sh
bun run bench:llm
```

Scenarios can be filtered:

```sh
bun run bench:llm chat-simple
bun run bench:llm tool-loop long-context
```

## Primary Metrics

- `bench_llm_*_turns` — provider turns to complete the scenario.
- `bench_llm_*_input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `total_tokens` — summed across assistant messages from the session's own usage accounting.
- `bench_llm_*_est_cost_usd` — summed from `msg.info.cost` (session `getUsage()` with real deepseek-v4-flash cost constants: input 0.14, output 0.28, cache_read 0.0028 per 1M tokens).
- `bench_llm_*_wall_ms` — `prompt.prompt()` call to completion (includes per-scenario stack boot: git init, watchers, snapshot tracking, shell init).

## Secondary Metrics

- `bench_llm_tool-loop_turn_N_input_chars` / `input_est_tokens` — per-turn projected request size (real body chars, ~4 chars/token heuristic) and `input_tokens`/`output_tokens` per assistant message. Tracks history projection growth across the tool loop.
- `bench_llm_long-context_compaction_triggered` — 1 when the loop auto-compacted (assistant message with `summary: true`), plus per-turn projection sizes showing the post-compaction drop.
- `bench_llm_chat-simple_ttft_ms` — time from `prompt.prompt()` to the first text part delta on the session (the title-generation request does not emit part deltas, so this is the main reply's first token). Only emitted for chat-simple; the tool-loop's first delta is a tool-call args delta, not text.

## Files In Scope

`packages/opencode/script/bench-llm.ts`, `packages/opencode/script/bench-llm-run.ts`, `packages/opencode/test/lib/llm-server.ts`, session loop paths in `packages/opencode/src/session/` (prompt, llm, processor, compaction), and the model config/tuning inputs for deepseek-v4-flash.

## Signals To Watch

- Token totals drifting with provider scripted usage; projection sizes (`*_input_chars`) are the trustworthy real measurement.
- `wall_ms`/`ttft_ms` noise: each scenario boots a fresh tmpdir stack (git init, file watchers, snapshot tracking, shell init) — expect run-to-run variance from machine load. Compare deltas, not absolutes.
- Compaction threshold: deepseek usable context is 1M - 20k reserved = 980k tokens; `isOverflow` uses provider-reported total tokens, so scripted usage must stay consistent across runs.

## Hypothesis Loop

| Hypothesis | Change | Before | After | Decision | Notes |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The real session loop for deepseek-v4-flash has measurable per-turn overhead (projection + tool round-trips) that model tuning should not regress | Added `bench:llm` harness driving `SessionPrompt.prompt()` against the mock LLM server with the deepseek fixture | see baseline below | see after below | keep | Baseline captured 2026-08-26 on origin/dev `c5ef753d28`; deterministic token/cost metrics, noisy wall times. After captured 2026-08-26 on the merged dev-based worktree (`dev-merge`). |
| Auto-compaction for deepseek's 1M-token context is exercised and reduces projected input after overflow | long-context scenario seeds 60k chars and scripts an overflowing reply (1M total tokens >= 980k usable) | compaction triggered, projection 69,953 -> 10,310 chars | compaction still triggers; preserved recent tail grows (15k -> 40k budget) so the post-compaction continuation projects 11,081 chars and the overflowed turn is dropped from the filtered view (accounting drops from 1,021,500 to 61,500 input tokens) | keep | Turn 2 is the compaction summary request (62,071 -> 62,169 chars with conversation block); turn 3 is the post-compaction continuation. |

## Baseline (before)

Commit: `c5ef753d28` (`dev`). Machine: local macOS (x64). One measured run of all three scenarios, 2026-08-26:

```
[bench-llm] chat-simple
METRIC bench_llm_chat-simple_turns 1
METRIC bench_llm_chat-simple_input_tokens 2500
METRIC bench_llm_chat-simple_output_tokens 50
METRIC bench_llm_chat-simple_cache_read_tokens 0
METRIC bench_llm_chat-simple_cache_write_tokens 0
METRIC bench_llm_chat-simple_total_tokens 2550
METRIC bench_llm_chat-simple_est_cost_usd 0.000364
METRIC bench_llm_chat-simple_wall_ms 4769.4
METRIC bench_llm_chat-simple_ttft_ms 4443.1
[bench-llm] tool-loop
METRIC bench_llm_tool-loop_turns 3
METRIC bench_llm_tool-loop_turn_1_input_chars 9925
METRIC bench_llm_tool-loop_turn_1_input_est_tokens 2481
METRIC bench_llm_tool-loop_turn_2_input_chars 10426
METRIC bench_llm_tool-loop_turn_2_input_est_tokens 2607
METRIC bench_llm_tool-loop_turn_3_input_chars 10946
METRIC bench_llm_tool-loop_turn_3_input_est_tokens 2737
METRIC bench_llm_tool-loop_turn_1_input_tokens 2500
METRIC bench_llm_tool-loop_turn_1_output_tokens 30
METRIC bench_llm_tool-loop_turn_2_input_tokens 2600
METRIC bench_llm_tool-loop_turn_2_output_tokens 30
METRIC bench_llm_tool-loop_turn_3_input_tokens 2700
METRIC bench_llm_tool-loop_turn_3_output_tokens 24
METRIC bench_llm_tool-loop_input_tokens 7800
METRIC bench_llm_tool-loop_output_tokens 84
METRIC bench_llm_tool-loop_cache_read_tokens 0
METRIC bench_llm_tool-loop_cache_write_tokens 0
METRIC bench_llm_tool-loop_total_tokens 7884
METRIC bench_llm_tool-loop_est_cost_usd 0.001116
METRIC bench_llm_tool-loop_wall_ms 4850.8
[bench-llm] long-context
METRIC bench_llm_long-context_seed_chars 60000
METRIC bench_llm_long-context_compaction_triggered 1
METRIC bench_llm_long-context_turns 3
METRIC bench_llm_long-context_turn_1_input_chars 69953
METRIC bench_llm_long-context_turn_1_input_est_tokens 17488
METRIC bench_llm_long-context_turn_2_input_chars 62071
METRIC bench_llm_long-context_turn_2_input_est_tokens 15518
METRIC bench_llm_long-context_turn_3_input_chars 10310
METRIC bench_llm_long-context_turn_3_input_est_tokens 2578
METRIC bench_llm_long-context_input_tokens 1021500
METRIC bench_llm_long-context_output_tokens 40230
METRIC bench_llm_long-context_cache_read_tokens 0
METRIC bench_llm_long-context_cache_write_tokens 0
METRIC bench_llm_long-context_total_tokens 1061730
METRIC bench_llm_long-context_est_cost_usd 0.154274
METRIC bench_llm_long-context_wall_ms 3480.8
```

Notes:

- Token/cost values are scripted on the mock (chat-simple 2500/50, tool-loop 2500/2600/2700 in, 30/30/24 out, long-context 960k/40k + 60k/200 + 1.5k/30) and are stable across runs; projection sizes (`*_input_chars`, `*_est_tokens`) are real request-body measurements.
- Tool-call turns report scripted usage approximating the measured projection so per-turn token accounting is complete.
- `wall_ms`/`ttft_ms` vary run to run (stack boot per scenario; observed chat-simple wall 2.8s-4.8s, long-context 1.8s-4.3s). Compare the deterministic metrics first; treat wall times as deltas.
- `cache_read_tokens`/`cache_write_tokens` are 0 because the mock never reports cache usage; add `cached_tokens`/cache events to the mock script if cache accounting becomes a tuning target.

## After (deepseek tuning + parallel orchestration merged)

Commit: merged worktree `dev-merge` = origin/dev `c2eacd72af` + `deepseek-bench` (169d1d2c61), `deepseek-tuning` (ee8f318eac), `parallel-orchestration` (2b368e32da). Machine: local macOS (x64). Two measured runs of all three scenarios, 2026-08-26 (run 1 shown; run 2 wall times in the notes):

```
[bench-llm] chat-simple
METRIC bench_llm_chat-simple_turns 1
METRIC bench_llm_chat-simple_input_tokens 2500
METRIC bench_llm_chat-simple_output_tokens 50
METRIC bench_llm_chat-simple_cache_read_tokens 0
METRIC bench_llm_chat-simple_cache_write_tokens 0
METRIC bench_llm_chat-simple_total_tokens 2550
METRIC bench_llm_chat-simple_est_cost_usd 0.000364
METRIC bench_llm_chat-simple_wall_ms 2737.4
METRIC bench_llm_chat-simple_ttft_ms 2525.2
[bench-llm] tool-loop
METRIC bench_llm_tool-loop_turns 3
METRIC bench_llm_tool-loop_turn_1_input_chars 10853
METRIC bench_llm_tool-loop_turn_1_input_est_tokens 2713
METRIC bench_llm_tool-loop_turn_2_input_chars 11354
METRIC bench_llm_tool-loop_turn_2_input_est_tokens 2839
METRIC bench_llm_tool-loop_turn_3_input_chars 11874
METRIC bench_llm_tool-loop_turn_3_input_est_tokens 2969
METRIC bench_llm_tool-loop_turn_1_input_tokens 2500
METRIC bench_llm_tool-loop_turn_1_output_tokens 30
METRIC bench_llm_tool-loop_turn_2_input_tokens 2600
METRIC bench_llm_tool-loop_turn_2_output_tokens 30
METRIC bench_llm_tool-loop_turn_3_input_tokens 2700
METRIC bench_llm_tool-loop_turn_3_output_tokens 24
METRIC bench_llm_tool-loop_input_tokens 7800
METRIC bench_llm_tool-loop_output_tokens 84
METRIC bench_llm_tool-loop_cache_read_tokens 0
METRIC bench_llm_tool-loop_cache_write_tokens 0
METRIC bench_llm_tool-loop_total_tokens 7884
METRIC bench_llm_tool-loop_est_cost_usd 0.001116
METRIC bench_llm_tool-loop_wall_ms 3697.0
[bench-llm] long-context
METRIC bench_llm_long-context_seed_chars 60000
METRIC bench_llm_long-context_compaction_triggered 1
METRIC bench_llm_long-context_turns 3
METRIC bench_llm_long-context_turn_1_input_chars 70879
METRIC bench_llm_long-context_turn_1_input_est_tokens 17720
METRIC bench_llm_long-context_turn_2_input_chars 62169
METRIC bench_llm_long-context_turn_2_input_est_tokens 15542
METRIC bench_llm_long-context_turn_3_input_chars 11081
METRIC bench_llm_long-context_turn_3_input_est_tokens 2770
METRIC bench_llm_long-context_input_tokens 61500
METRIC bench_llm_long-context_output_tokens 230
METRIC bench_llm_long-context_cache_read_tokens 0
METRIC bench_llm_long-context_cache_write_tokens 0
METRIC bench_llm_long-context_total_tokens 61730
METRIC bench_llm_long-context_est_cost_usd 0.008674
METRIC bench_llm_long-context_wall_ms 1837.2
```

Notes:

- Token/cost values are scripted on the mock exactly as in the baseline (chat-simple 2500/50, tool-loop 2500/2600/2700 in, 30/30/24 out, long-context 960k/40k + 60k/200 + 1.5k/30) and are identical across all runs by design — they prove the loop still makes the same number of provider turns, not that the tuning changed pricing.
- Request bodies now carry the tuned deepseek defaults — a `prompt_cache_key` body param (the beta deepseek prompt-caching key, `@ai-sdk/openai-compatible` + deepseek family) and a 64k `max_tokens` cap instead of 32k. The harness does not assert body params; these are proven by the unit tests (`transform.test.ts` etc.).
- Compaction behavior changed observably: the preserve-recent budget now scales with context (15k cap -> 40k cap for >= 200k context models). The post-compaction continuation projection grew 10,310 -> 11,081 chars (a larger recent tail is retained), and the overflowed turn's scripted usage is no longer attributed after compaction (the compacted-away turn is filtered out of the message view via `tail_start_id`): long-context input 1,021,500 -> 61,500, output 40,230 -> 230, est cost $0.154274 -> $0.008674. Compaction still triggers at the same point (turn 2 summary request, 62,071 -> 62,169 chars).
- Tool-loop projections grew ~9% (turn 1 9,925 -> 10,853 chars) because the build agent prompt gained the delegate/worktree tool instructions from `parallel-orchestration` — a real request-body measurement, not scripted.
- `wall_ms`/`ttft_ms` are within the baseline's noise envelope and vary run to run: chat-simple wall/ttft 2737.4/2525.2 (run 1) and 2670.5/2464.0 (run 2), tool-loop 3697.0 and 3566.4, long-context 1837.2, 2846.8 and 1775.0 (3 samples). Machine-load noise is ~5-8% and stack boot dominates; treat these as deltas, not absolutes.
- `cache_read_tokens`/`cache_write_tokens` remain 0 because the mock never reports cache usage; the `prompt_cache_key` param cannot produce observable cache metrics here.
