// main.ts — the harness driver for this entry (site-generator-speed-01).
//
// The harness runs `node /bot/main.ts` (Node 22). The driver reads every case from
// /input/cases.json — a JSON array of {id, input} — answers each case on its own with run()
// from ./solve.js, and writes the answers, one per case in the cases' order, to
// /output/answers.json. Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output.
//
// Before solve.js is imported, V8's incremental marking is switched off, as the house baseline
// runs its entry and the rules allow an entry to tune V8's flags likewise.
//
// After writing, check the file is there and non-empty — a cheap guard that a failed or
// truncated write is caught here, in this run, rather than by the scorer. It prints one line
// per case to stderr (its id and how many output files its answer holds), so a run leaves a
// trace of what it did. (Deliberately no re-parse of answers.json: on the scored set that file
// is megabytes, and re-parsing it would cost CPU the heat counts.)

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) {
  const answer = run(c.input) as Record<string, string>;
  answers.push(answer);
  console.error(`case ${c.id}: ${Object.keys(answer).length} files`);
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));

// Check the write landed: the file exists and is non-empty.
const written = statSync(join(OUTPUT_DIR, 'answers.json'));
if (written.size === 0) {
  throw new Error('answers.json was written empty');
}
console.error(`wrote ${cases.length} answers to ${join(OUTPUT_DIR, 'answers.json')}`);
