/** Ruff, run from `pnpm lint`. See python.mjs for why a missing tool skips. */

import { runPythonModule } from './python.mjs';

runPythonModule(['ruff', 'check', '.'], {
  what: 'ruff, so tools/tre-extract was not linted',
  howToFix: 'cd tools/tre-extract && pip install -e ".[dev]" && ruff check .',
});
