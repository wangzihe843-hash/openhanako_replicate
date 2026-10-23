// Appended after the repository's original setup file; no test hooks or awaits.
import { createRequire } from 'node:module';
createRequire(import.meta.url)('./events.cjs').mark('test-import:start');
