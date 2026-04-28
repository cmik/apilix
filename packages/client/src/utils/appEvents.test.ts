import { describe, it, expect } from 'vitest';
import { INJECT_TEST_SNIPPET } from './appEvents';

describe('appEvents', () => {
  it('INJECT_TEST_SNIPPET has the correct event name', () => {
    expect(INJECT_TEST_SNIPPET).toBe('apilix:inject-test-snippet');
  });
});
