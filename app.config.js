'use strict';

const rootProjectError =
  '[M10-03] Invalid Expo/EAS project root: the repository root is not a publishable app. Run Expo and EAS identity, config, or build commands from mobile/; mobile/ is the only supported project root.';

process.stderr.write(`${rootProjectError}\n`);
throw new Error(rootProjectError);
