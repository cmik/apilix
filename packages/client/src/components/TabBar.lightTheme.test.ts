import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The scroll buttons use a dark tailwind gradient; light theme only repaints them
// through the .tab-scroll-fade-* overrides in index.css, so both sides must stay wired.
const src = readFileSync(resolve(__dirname, 'TabBar.tsx'), 'utf8');
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

describe('TabBar scroll buttons light theme', () => {
  it.each([
    ['left', 'Scroll tabs left'],
    ['right', 'Scroll tabs right'],
  ])('%s button carries the theme-aware fade class', (side, title) => {
    const m = src.match(new RegExp(`<button[\\s\\S]*?className="([^"]*)"\\s+title="${title}"`, 's'));
    expect(m).not.toBeNull();
    expect(m![1]).toContain(`tab-scroll-fade-${side}`);
  });

  it('index.css overrides gradient and disabled colour in light theme', () => {
    expect(css).toMatch(/html\.light \.tab-scroll-fade-left\s*\{/);
    expect(css).toMatch(/html\.light \.tab-scroll-fade-right\s*\{/);
    expect(css).toMatch(/html\.light \.tab-scroll-fade-left:disabled/);
  });
});
