import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const tab = html.slice(html.indexOf('function renderSensitivityTab'), html.indexOf('function sensiUpdateDelta'));

// The tornado chart was the last surface on the old light-theme styling and the old money rule:
// navy labels on a dark card, "$10000K" ticks in a monospace face, and a sign that vanished.
describe('the key levers chart', () => {
  it('formats the axis with the one money rule, in dollars not thousands', () => {
    expect(tab).toContain("ticks:{callback:v=>v===0?'$0':UI.money(v,{signed:true})");
    expect(tab).not.toMatch(/\/1000\)\)/);          // no pre-division into thousands
    expect(tab).not.toContain('K`,font');
  });

  it('keeps the minus sign on downside figures', () => {
    // `${v>=0?'+':''}$${Math.abs(v)}K` printed a $1.2M loss as "$1234K".
    expect(tab).not.toContain('Math.abs(v)}K');
    expect(tab).toContain('UI.money(ctx.raw,{exact:true,signed:true})');
  });

  it('draws its labels in the dark theme', () => {
    expect(tab).toContain("color:'#eef3fc'");
    expect(tab).not.toContain("color:'#0a2540'");
    expect(tab).not.toContain("rgba(10,37,64,.05)");
  });

  it('sets numbers in the page face, not a console one', () => {
    expect(tab).not.toContain("'SF Mono'");
  });
});
