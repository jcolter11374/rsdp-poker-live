// Runs before every web test file. Screen tests (marked "// @vitest-environment jsdom") get a fresh page after
// each test; the rest run in node with no page, so this does nothing for them and loads nothing extra.
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}
