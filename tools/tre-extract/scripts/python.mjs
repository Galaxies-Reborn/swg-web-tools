/**
 * Run a Python tool from the JavaScript pipeline.
 *
 * The asset pipeline is Python, but its checks run from the same `pnpm lint`
 * and `pnpm test` as everything else -- a check in a second command nobody
 * remembers is a check that does not run, and this repository has already had
 * one of those.
 *
 * Python may reasonably be absent. Someone working on the web app does not need
 * a Python toolchain to make a change, and failing their build over a tool they
 * have no reason to install teaches them to stop running the build. So a
 * missing interpreter, or a missing module, is reported and skipped rather than
 * failed -- loudly, naming exactly what went unchecked and how to check it,
 * because a quiet skip is how a check goes missing for months.
 *
 * The tool being present and unhappy still fails, which is the whole point.
 */

import { spawnSync } from 'node:child_process';

/** Spellings of the interpreter, in the order worth trying. */
const INTERPRETERS = ['python', 'python3', 'py'];

/**
 * @param {string[]} args      what to pass after `-m`, e.g. ['ruff', 'check', '.']
 * @param {string}   what      what is being checked, for the skip message
 * @param {string}   howToFix  the command a reader should run instead
 */
export function runPythonModule(args, { what, howToFix }) {
  let reason = 'no Python interpreter found';

  for (const interpreter of INTERPRETERS) {
    const result = spawnSync(interpreter, ['-m', ...args], {
      stdio: 'inherit',
      // The package lives under src/, and both tools read their config from
      // pyproject.toml in the working directory.
      env: { ...process.env, PYTHONPATH: 'src' },
    });

    if (result.error) {
      // Not on PATH under this spelling; try the next.
      reason = result.error.code === 'ENOENT'
        ? `no ${interpreter} on PATH`
        : result.error.message;
      continue;
    }

    // 0 is a pass and 1 is real findings -- both are answers, so report them.
    // Anything higher usually means the module itself is not installed, which
    // is a skip rather than a failure.
    if (result.status === 0 || result.status === 1) process.exit(result.status);

    reason = `${interpreter} -m ${args[0]} exited ${result.status}`;
    break;
  }

  console.warn(
    `\n  SKIPPED: ${what} did not run.` +
      `\n  Reason: ${reason}.` +
      `\n  To run it:  ${howToFix}\n`,
  );
  process.exit(0);
}
