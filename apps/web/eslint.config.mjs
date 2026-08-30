import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint rules for the web app.
 *
 * There was no config here at all, and the `lint` script ran `next lint`, which
 * in Next 15 is deprecated and, without a config, opens an interactive prompt
 * and exits non-zero. So linting has never actually run on this project -- it
 * looked like a passing step that had simply never linted anything.
 *
 * That mattered: two bugs in the city planner were missing hook dependencies.
 * A memoised ground-click handler read `pendingProp` without listing it, so it
 * closed over the value from before anything was picked and placing a
 * decoration silently did nothing; and `applyDocument` read the prop catalogue
 * with an empty dependency list, which would have dropped every decoration on
 * load. Both were invisible to the type checker and to the tests, and both are
 * exactly what `react-hooks/exhaustive-deps` reports.
 *
 * That rule is an ERROR here rather than the usual warning. A warning in a
 * script nobody watches is the state we were already in.
 */

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'next-env.d.ts'],
  },
  ...compat.extends('next/core-web-vitals'),
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The whole reason this config exists.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
];

export default config;
