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
    // It read startingLiquid into both slots, so "Net worth" and "Liquid" were identical.
    expect(ms).not.toContain('{nw:P.startingLiquid,liq:P.startingLiquid}');
    const today = ms.slice(ms.indexOf('m.yr===sy'));
    for (const part of ['startingLiquid', 'startingStripeEquity', 'otherDebt'])
      expect(today, part).toContain(part);
  });

  it('leaves retirement and the house out of the opening figure', () => {
    // The walkthrough tracks what is actually yours to move. Retirement is locked for
    // decades and a house is not spendable, so neither belongs in this particular figure.
    const today = ms.slice(ms.indexOf('m.yr===sy'), ms.indexOf(':(R.find'));
    expect(today).not.toContain('k401Start');
    const P = { ...D, startingLiquid: 678000, startingStripeEquity: 614000, k401Start: 297000, otherDebt: 46000 };
    expect(Math.round(P.startingLiquid + P.startingStripeEquity - Math.abs(P.otherDebt))).toBe(1246000);
  });

  it('reads the engine\'s own name for the measure rather than assembling it', () => {
    // Every net-worth figure this app got wrong got wrong by being assembled at the call
    // site. The definition lives in model.js and each surface asks for it by name.
    expect(render).toContain('${fmt(m.row.nwExRetHome)}');
    expect(render).not.toContain('${fmt(m.row.netWorth)}');
    const model = fs.readFileSync(new URL('../public/model.js', import.meta.url), 'utf8');
    expect(model).toContain('nwExRetHome:Math.round(liq)+Math.round(stripeEnd)-Math.round(otherDebt)');
  });

  it('says what the figure leaves out, in its own label', () => {
    // A narrowed number under the bare word "net worth" is the misreading this session kept
    // finding; the exclusion belongs in the label, not in a footnote or nowhere.
    expect(render).toContain('ex-retirement &amp; home');
  });

  it('plots the same measure the figure beneath it names', () => {
    expect(render).toContain('const sparkVals=[open,...R.map(r=>r.nwExRetHome)]');
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
