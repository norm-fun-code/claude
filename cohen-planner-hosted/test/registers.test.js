import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// The three registers exist so a reader can feel the difference between an observed
// balance, a projection and a finding. Blending them is how a 2051 estimate gets read as
// a fact about today — which is the one misreading this whole product is built to prevent.
describe('The three registers',()=>{
  const src=fs.readFileSync(new URL('../public/cockpit.js',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');

  it('names all three tenses on the page',()=>{
    for(const [tense,label] of [
      ['now','Where you stand'],
      ['ahead','Where you are heading'],
      ['attention','What needs you'],
    ]){
      expect(src,tense).toContain(`data-tense="${tense}"`);
      expect(src,tense).toContain(label);
    }
  });

  it('says the middle register is a projection, in the register head itself',()=>{
    // Not buried in a footnote under the chart, where it is read after the number.
    expect(src).toContain('Projected from your plan. Not a forecast.');
  });

  it('ties each register edge to the provenance colour it corresponds to',()=>{
    // The rail beside "where you stand" is the same blue as the observed chip, so the
    // register and every chip inside it are making the same claim in the same colour.
    expect(css).toContain('.cp-register[data-tense=now]{--tense:var(--prov-observed)}');
    expect(css).toContain('.cp-register[data-tense=ahead]{--tense:var(--prov-projected)}');
    expect(css).toContain('.cp-register[data-tense=attention]{--tense:var(--warn)}');
  });

  it('keeps warm colour inside the attention register only',()=>{
    // Amber everywhere means amber nowhere. Every cockpit rule that reaches for it must
    // be scoped to the one register that earns it.
    const warm=css.split('\n')
      .filter(l=>l.trim().startsWith('.cp-')&&/var\(--warn\)/.test(l));
    expect(warm.length).toBeGreaterThan(0);
    for(const rule of warm)expect(rule,rule.trim()).toMatch(/data-tense=attention/);
  });

  it('drops the card eyebrows the register labels made redundant',()=>{
    // Two labels for the same thing, one above the other, is how a page starts to feel
    // like it was assembled rather than designed.
    expect(src).not.toContain('CURRENT PLAN / PROJECTION');
    expect(src).not.toContain('SIGNALS / REVIEW');
  });

  it('opens and closes every register it opens',()=>{
    const opens=(src.match(/<section class="cp-register"/g)||[]).length;
    expect(opens).toBe(3);
    // A register left unclosed swallows the rest of the page, which is exactly the class
    // of bug that broke this file once already.
    const sections=(src.match(/<section/g)||[]).length;
    const closes=(src.match(/<\/section>/g)||[]).length;
    expect(closes).toBe(sections);
  });
});
