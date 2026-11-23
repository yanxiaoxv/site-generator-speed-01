# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/yanxiaoxv/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/yanxiaoxv/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

`solve.js` is a dependency-free ES module whose `run(input)` returns, for every input,
exactly what makefun-site 1.0.0 returns: the output tree of the site — each page's
`index.html`, the paginated index and tag pages, `build-report.txt` and each static file —
byte for byte. It follows makefun-site's own rules, as its README states and its code runs
them: the strict front matter (seven keys, exact refusal reasons), its Markdown subset
(fences, ATX headings with ids, thematic breaks, blockquotes, flat lists, paragraphs;
code spans, strong, emphasis, links and backslash escapes inline — no raw HTML, no setext,
no tables, no reference links), its template dialect (`{{ }}`, `{{{ }}}`,
`{% for %}` / `{% if %}` / `{% include %}`, standalone-tag lines), its slug rule (NFKD,
combining marks dropped, cut to 64) and its report (sorted lines, then the built counts).

## How it is fast

- Markdown is lexed and rendered in one pass over the body's lines: no token objects, no
  second walk. Blocks are dispatched on the first character, so a paragraph line costs one
  character test instead of six regexes.
- Its inline renderer scans with an index and writes plain runs through a single escape call
  into one shared parts array; strong, emphasis and links render into the same array over
  their ranges, with no substring and no intermediate string each.
- Templates are parsed once per build and rendered into a parts array joined once; scopes are
  a small frame stack, and a for loop reuses one frame object per activation, its element and
  loop record rewritten per item, instead of one scope object per item.
- Slugs are cached per build (tag names and titles repeat), words are counted by a single
  manual scan instead of a match array, and front matter is scanned by line index instead of
  split + join. Nothing is kept between `run()` calls, so each case is answered alone.

## Verification (practice set, kit's `grade-local --driver process`)

- `passed: 1`, `cases_passed: 3/3` — every answer identical to makefun-site 1.0.0 and to the
  kit's `expected.json` (276 / 350 / 509 files per case).
- Fuzz: 200 randomly generated sites in the kit generator's own palette (drafts, refused
  front matter, broken links, colliding and non-ASCII slugs, shadowed statics, broken
  templates, unclosed fences and spans) — all identical to the reference build, and two runs
  of the same input identical.
- Timing, one run at a time, trimmed mean (drop 2 fastest / 2 slowest): `run()` only, house
  baseline 651 ms vs this entry 229 ms on the 3-case set — **2.84x**; whole driver
  (`main.ts` end to end: read and parse `cases.json`, answer, serialize `answers.json`),
  house baseline 1.32 s vs this entry 0.83 s — **1.59x**, the rest being the JSON and
  interpreter costs both drivers pay.

## Run it

```sh
node main.ts
```

The harness runs `node /bot/main.ts` (Node 22): it reads every case from `/input/cases.json`,
answers each with `run()` from `./solve.js`, and writes the answers to
`/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
stand in for `/input` and `/output`.

## Layout

- `solve.js` — the generator (`run(input)`), the whole entry.
- `main.ts` — the harness driver.
- `package.json` — `{ "type": "module" }`, so `solve.js` loads as an ES module.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
