# Test evidence

Everything here was produced on Nov 20, 2026 (PST) by running the code in this repository. Times inside the files are UTC.

| File | What it shows |
|---|---|
| [`unit-tests.txt`](unit-tests.txt) | `npm test`: 47 of 47 pass, no network |
| [`planted-fakes.txt`](planted-fakes.txt) | The evidence checker against live pages: 10 of 10 planted fakes rejected, 9 of 9 real quotes passed. Raw rows are in `scripts/planted-fakes.result.json` |
| [`kill-scout-mission.txt`](kill-scout-mission.txt) | A full mission with the News scout killed mid-run: it is relaunched and the mission finishes. Also shows the Boat VM being created and stopped, and the Claude analysis step |
| [`phone/bridge-tool-calls.txt`](phone/bridge-tool-calls.txt) | Every request the bridge received on its tool endpoint, including the ones it refused |
| [`phone/call-*.txt`](phone/) | Transcripts of the four real phone calls, as written by Vapi's speech-to-text |
| [`missions/`](missions/) | The full record of every mission below: brief, each step's result, events, findings, decision and memo |

## Missions

| Started (UTC) | Mission | Verdict | For | Against | Dropped | Boat VM | Scout killed | Claude analysis | State |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-21T00:40:40 | nvda-demo | Mixed | 7 | 5 | 0 | no | yes | no | done |
| 2026-11-21T00:41:16 | nvda-capex | Supports | 11 | 5 | 0 | no | yes | no | done |
| 2026-11-21T00:45:07 | nvda-mwportf4 | Supports | 11 | 3 | 0 | no | no | no | done |
| 2026-11-21T00:52:22 | nvda-boat-1 | Supports | 12 | 4 | 0 | yes | no | no | done |
| 2026-11-21T00:52:47 | nvda-boat-2 | Supports | 12 | 4 | 0 | yes | no | no | done |
| 2026-11-21T00:53:12 | nvda-mwpp275i | Supports | 11 | 3 | 0 | yes | no | no | done |
| 2026-11-21T00:58:45 | nvda-mwpp9bxk | Supports | 8 | 4 | 0 | yes | no | no | done |
| 2026-11-21T00:59:59 | arm-mwppaxnf | Mixed | 5 | 3 | 0 | yes | no | no | done |
| 2026-11-21T01:00:23 | amd-mwppbfwl | Supports | 10 | 3 | 0 | yes | no | no | done |
| 2026-11-21T01:01:34 | amd-mwppcyy4 | Supports | 7 | 1 | 0 | yes | no | no | done |
| 2026-11-21T01:06:54 | amd-analysis-check | Supports | 7 | 2 | 0 | yes | no | yes | done |
| 2026-11-21T01:13:23 | nvda-mwpps5dk | Contradicts | 1 | 8 | 0 | yes | no | yes | done |
| 2026-11-21T01:14:42 | nvda-mwpptuuv | Mixed | 3 | 5 | 0 | yes | no | yes | done |
| 2026-11-21T01:17:07 | nvda-kill-demo | Mixed | 9 | 5 | 0 | yes | yes | yes | done |

- All 14 missions reached a verdict.
- The Fundamentals scout ran on a Boat VM in all 11 missions started after that was wired in.
- A scout was killed mid-run in 3 missions, and all 3 finished.
- The checker rejected 0 of 182 claims in these missions. The scouts quote pages word for word, so there was nothing for it to reject; `planted-fakes.txt` is the test of the checker.
- Missions for AMD and ARM ran on headlines only, because the Fundamentals scout returned no claims for them.

## What phone testing found

The phone calls found three problems, each visible in `phone/`:

1. **Call at 00:54 UTC.** The caller's number was not on the allowlist, so the bridge refused the tool calls (HTTP 403). The voice agent then claimed a mission had started and made up a name for it. The agent's instructions now forbid inventing a mission or a result.
2. **Call at 01:11 UTC.** The bridge was restarted with a stale allowlist and refused the caller again. This time the agent said plainly that it could not start the mission. The bridge now starts from `.env` only (`npm start`).
3. **Call at 01:13 UTC.** Missions started and the verdict was read back, but the caller questioned the answer ("Are you checking the right data?"). Most evidence in that mission came from news headlines, and the verdict depends on how the question is phrased. This is not fixed.

Phone numbers are cut to their last four digits. About 30 seconds of unrelated conversation was removed from the first transcript.
