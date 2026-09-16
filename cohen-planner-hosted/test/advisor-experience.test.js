import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/ui.css', import.meta.url), 'utf8');

describe('the current advisor experience', () => {
  it('runs every advisor path on Sonnet 5', () => {
    expect(server).toContain("const ADVISOR_MODEL = 'claude-sonnet-5'");
    expect(server.match(/model: ADVISOR_MODEL/g)).toHaveLength(3);
    expect(server).not.toContain("model: 'claude-sonnet-4-6'");
  });

  it('shows an accessible planning indicator immediately and during tool work', () => {
    expect(html).toContain('function advThinkingMarkup');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('advThinkingMarkup(advToolStatus(payload.tool_call.name))');
    expect(css).toContain('.adv-orb');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
  });
});
