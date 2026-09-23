import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/ui.css', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('the current advisor experience', () => {
  it('runs every advisor path on one model', () => {
    expect(server).toContain("const ADVISOR_MODEL = 'claude-opus-5-5'");
    expect(server.match(/model: ADVISOR_MODEL/g)).toHaveLength(3);
    expect(server).not.toContain("model: 'claude-sonnet-4-6'");
    expect(server).not.toContain("'claude-sonnet-5'");
  });

  it('sets effort explicitly, because this model defaults to medium', () => {
    // Opus 5.5 is the one model whose default effort is `medium` rather than `high`. Left
    // unset, the advisor would be the least thorough route in the app.
    expect(server).toContain("const ADVISOR_EFFORT = { effort: 'high' };");
    expect(server.match(/output_config: ADVISOR_EFFORT/g)).toHaveLength(3);
  });

  it('leaves room inside max_tokens for thinking it cannot switch off', () => {
    // Thinking is always on for this model and is charged against max_tokens; at the 4000
    // this ran on before, a long answer after a few tool calls truncated mid-sentence.
    const n = Number(server.match(/const ADVISOR_MAX_TOKENS = (\d+);/)[1]);
    expect(n).toBeGreaterThanOrEqual(16000);
    expect(server.match(/max_tokens: ADVISOR_MAX_TOKENS/g)).toHaveLength(3);
  });

  it('uses an SDK new enough to preserve adaptive-thinking signatures', () => {
    // A minimum, not an exact pin: the next routine bump should not fail this.
    const [maj, min] = pkg.dependencies['@anthropic-ai/sdk'].replace(/^\^/, '').split('.').map(Number);
    expect(maj > 0 || min >= 126).toBe(true);
  });

  it('shows an accessible planning indicator immediately and during tool work', () => {
    expect(html).toContain('function advThinkingMarkup');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('advThinkingMarkup(advToolStatus(payload.tool_call.name))');
    expect(css).toContain('.adv-orb');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
  });
});
