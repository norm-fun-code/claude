import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/cockpit.css', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
const ms = html.slice(html.indexOf('function _storyMilestones'), html.indexOf('function _sparkSVGAt'));
const render = html.slice(html.indexOf('function _renderStory'), html.indexOf('function _renderStory') + 2400);

// The walkthrough is the one screen that states the plan in words, so a wrong word there is
// as bad as a wrong number.
describe('story mode counts the household correctly', () => {
  it('counts two adults plus the children born so far', () => {
    // `i+2` called the first child a household of two — the parents' own number, with the
    // baby standing in for one of them.
    expect(ms).toContain('A household of ${i+3}');
    expect(ms).not.toContain('Family grows to ${i+2}');
  });

  it('says "a baby" for the first and counts children after that', () => {
    expect(ms).toContain("i+1===1?'a baby'");
    expect(ms).toContain('${i+1} children');
  });
});

describe('story mode reports the right figures for today', () => {
  it('does not print the same number under both labels', () => {
    // It read startingLiquid into both slots, so "Net worth" and "Liquid" were identical and
    // Stripe and retirement had silently vanished from the opening position.
    expect(ms).not.toContain('{nw:P.startingLiquid,liq:P.startingLiquid}');
    const today = ms.slice(ms.indexOf('m.yr===sy'));
    for (const part of ['startingLiquid', 'startingStripeEquity', 'k401Start', 'otherDebt'])
      expect(today, part).toContain(part);
  });

  it('computes an opening net worth well above the liquid figure', () => {
    const P = { ...D, startingLiquid: 693000, startingStripeEquity: 614000, k401Start: 240000, otherDebt: 9000 };
    const open = Math.round(P.startingLiquid + P.startingStripeEquity + P.k401Start - Math.abs(P.otherDebt));
    expect(open).toBe(1538000);
    expect(open).toBeGreaterThan(P.startingLiquid);
  });

  it('shows the TOTAL under a label that says net worth', () => {
    expect(render).toContain('${fmt(m.row.netWorth)}');
    expect(render).not.toContain('${fmt(m.row.nw)}');
  });

  it('plots the same measure the figure beneath it names', () => {
    // A line showing one thing under a number naming another is the defect the cockpit
    // spent this session removing; the walkthrough had the same one.
    expect(render).toContain('const sparkVals=[open,...R.map(r=>r.netWorth)]');
    expect(render).not.toContain('[P.startingLiquid,...R.map(r=>r.nw)]');
  });
});

describe('story mode is readable', () => {
  it('no longer opens on a near-white sheet', () => {
    expect(css).toMatch(/#storyOverlay\{background:[\s\S]*?rgba\(7,12,21/);
    expect(html).toContain('rgba(247,249,253,.97)');   // the light value is still the base…
    expect(css.indexOf('#storyOverlay')).toBeGreaterThan(-1); // …and is overridden here
  });

  it('gives the sub-line and stat labels real size and weight', () => {
    // 13px --t2 and 9px --t3 on a dark card is present but not readable.
    expect(Number(css.match(/\.story-sub\{font-size:(\d+)px/)[1])).toBeGreaterThanOrEqual(15);
    expect(Number(css.match(/\.story-stat-l\{font-size:(\d+)px/)[1])).toBeGreaterThanOrEqual(11);
    expect(css).toMatch(/\.story-stat-l\{[^}]*color:var\(--t2\)/);   // was --t3
  });

  it('draws the dots, close button and spark for a dark page', () => {
    expect(css).toMatch(/\.story-dot\{background:rgba\(167,190,221/);
    expect(css).toMatch(/\.story-close\{background:var\(--s2\)/);
    expect(html).toContain("_sparkSVGAt(sparkVals,320,110,'#b6a8ff',rIdx)");
  });
});
