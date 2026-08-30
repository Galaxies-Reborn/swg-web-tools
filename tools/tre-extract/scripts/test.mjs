/** pytest, run from `pnpm test`. See python.mjs for why a missing tool skips. */

import { runPythonModule } from './python.mjs';

runPythonModule(['pytest', '-q'], {
  what: 'pytest, so the asset pipeline tests did not run',
  howToFix: 'cd tools/tre-extract && pip install -e ".[dev]" && pytest',
});
