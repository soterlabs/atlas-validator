#!/usr/bin/env -S npx tsx
/**
 * Tests for the document-order assertion.
 *
 * WHY BLACK-BOX, AND WHY NO TEST FRAMEWORK. This repo has no test infrastructure — its only
 * execution check runs the validator against its own README and discards the exit code with
 * `|| true`. Adding vitest/jest here would be a larger change than the feature. This drives
 * the real CLI on real fixtures and asserts on exit codes and output, which is what CI and
 * contributors actually experience, and it needs nothing that is not already installed.
 *
 * WHAT IS BEING PROTECTED. Until the Atlas was consolidated into a small number of composed
 * files, a document's position was its filesystem path, so it could not be out of order and
 * nothing had to check. Now order is just where text sits, and the failure is silent: every
 * document can be individually valid while the sequence is wrong. The PR #257 post-mortem
 * asked for exactly this assertion and it was never implemented.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(HERE, '..', 'validate-atlas-markdown.ts');
const TSX = path.join(HERE, '..', 'node_modules', '.bin', 'tsx');

let failures = 0;

function run(markdown: string): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-order-'));
  const file = path.join(dir, 'atlas.md');
  fs.writeFileSync(file, markdown);
  try {
    const out = execFileSync(TSX, [VALIDATOR, file], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const doc = (level: number, no: string, name: string, type: string, uuid: string): string =>
  `${'#'.repeat(level)} ${no} - ${name} [${type}]  <!-- UUID: ${uuid} -->\n\nBody.\n\n`;

const U = (n: number): string =>
  `0000000${n}-0000-4000-8000-00000000000${n % 10}`.replace(/^0{0,0}/, '');

// A minimal but structurally valid Atlas: Scope > Article > Section, Section, Section.
const ordered =
  doc(1, 'A', 'Sky Atlas', 'Scope', U(1)) +
  doc(2, 'A.1', 'The Governance Scope', 'Scope', U(2)) +
  doc(3, 'A.1.1', 'Spirit', 'Article', U(3)) +
  doc(4, 'A.1.1.1', 'First', 'Section', U(4)) +
  doc(4, 'A.1.1.2', 'Second', 'Section', U(5)) +
  doc(4, 'A.1.1.3', 'Third', 'Section', U(6));

console.log('\nDocument order assertion\n');

{
  const r = run(ordered);
  check('correctly ordered documents pass', !/Document out of order/.test(r.out), r.out.slice(0, 300));
}

{
  // Swap two siblings. Every document is individually valid; only the sequence is wrong.
  const swapped =
    doc(1, 'A', 'Sky Atlas', 'Scope', U(1)) +
    doc(2, 'A.1', 'The Governance Scope', 'Scope', U(2)) +
    doc(3, 'A.1.1', 'Spirit', 'Article', U(3)) +
    doc(4, 'A.1.1.2', 'Second', 'Section', U(5)) +
    doc(4, 'A.1.1.1', 'First', 'Section', U(4)) +
    doc(4, 'A.1.1.3', 'Third', 'Section', U(6));
  const r = run(swapped);
  check('swapped siblings are reported', /Document out of order/.test(r.out), r.out.slice(0, 300));
  check('swapped siblings fail the build', r.code === 1, `exit code was ${r.code}`);
  check(
    'the message names both the found and expected document',
    /A\.1\.1\.2/.test(r.out) && /A\.1\.1\.1/.test(r.out),
    r.out.slice(0, 300)
  );
}

{
  // ⛔ THE REGRESSION THAT MATTERS MOST. A naive "document numbers must ascend" rule reports
  // 410 false errors on the real Atlas, because a phantom segment — a number that exists only
  // as a path to deeper documents, like the `.0.` in `A.1.1.0.3.1` — sorts AFTER its real
  // siblings. If this test starts failing, someone has replaced the rule with a plain sort and
  // every Annotation, Action Tenet and Scenario in the Atlas will be reported as misplaced.
  const withPhantom =
    doc(1, 'A', 'Sky Atlas', 'Scope', U(1)) +
    doc(2, 'A.1', 'The Governance Scope', 'Scope', U(2)) +
    doc(3, 'A.1.1', 'Spirit', 'Article', U(3)) +
    doc(4, 'A.1.1.1', 'First', 'Section', U(4)) +
    doc(4, 'A.1.1.2', 'Second', 'Section', U(5)) +
    doc(5, 'A.1.1.0.3.1', 'An Annotation', 'Annotation', U(7));
  const r = run(withPhantom);
  check(
    'phantom-segment documents sort after real siblings, not before',
    !/Document out of order/.test(r.out),
    r.out.slice(0, 400)
  );
}

{
  // Needed Research is placed by the document it attaches to, not by its own number, so it
  // must be exempt. Post-consolidation an NR's position IS its target.
  const withNR =
    doc(1, 'A', 'Sky Atlas', 'Scope', U(1)) +
    doc(2, 'A.1', 'The Governance Scope', 'Scope', U(2)) +
    doc(3, 'A.1.1', 'Spirit', 'Article', U(3)) +
    doc(4, 'A.1.1.1', 'First', 'Section', U(4)) +
    `##### NR-9 - An Open Question [Needed Research]  <!-- UUID: ${U(8)} -->\n\n**Content**:\n\nBody.\n\n` +
    doc(4, 'A.1.1.2', 'Second', 'Section', U(5));
  const r = run(withNR);
  check(
    'Needed Research between two documents is not reported as misordered',
    !/Document out of order/.test(r.out),
    r.out.slice(0, 400)
  );
}

console.log(
  failures === 0 ? '\nAll order assertions passed.\n' : `\n${failures} assertion(s) failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
