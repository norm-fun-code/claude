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

// The advisor was the last screen speaking its own language. These lock the parts of
// that conversion that are easy to undo by accident.
describe('The advisor speaks the planner\'s language',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');
  const fn=html.slice(html.indexOf('function renderAdvisorTab'),html.indexOf('function advRenderMessages'));

  it('opens the way every other screen does',()=>{
    expect(fn).toContain('class="ui-head');
    expect(fn).toContain('ADVISOR');
    expect(fn).toContain('Think it through.');
  });

  it('names what it is working from, before anything it says',()=>{
    // The advisor is the one surface where the reader cannot see the underlying data.
    expect(fn).toContain("UI.prov('projected','your plan')");
    expect(fn).toMatch(/same engine as the rest of the app/);
  });

  it('has exactly one primary action',()=>{
    // It previously had three filled buttons: Send, Optimize and a gradient starter.
    expect((fn.match(/ui-btn-primary/g)||[]).length).toBe(1);
    expect(fn).not.toMatch(/linear-gradient\(135deg,var\(--accent\),var\(--p\)\)/);
  });

  it('keeps no emoji in the advisor chrome',()=>{
    const shell=html.slice(html.indexOf('function renderAdvisorTab'),
      html.indexOf('function advAddMessage'));
    expect(shell).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('drops the legacy light-theme glass from the advisor containers',()=>{
    // A leftover .adv,.adv-wrap in the glass rule painted a white panel over the header.
    expect(html).not.toMatch(/\.panel,\.cc,\.kpi,\.sc,\.tabs,\.tw,\.adv,\.adv-wrap\{/);
    expect(html).not.toMatch(/\.adv-msg\.ai \.adv-bubble\{background:rgba\(255,255,255/);
  });

  it('shows the conversation rail only once there is a conversation in it',()=>{
    // An empty 300px column saying "no conversations yet" is the most expensive way to
    // say nothing.
    expect(fn).toContain('nChats?');
    expect(fn).toContain('id="advRail" hidden');
  });

  it('renders a tool call as evidence rather than chrome',()=>{
    expect(css).toMatch(/\.adv-tool\{/);
    expect(html).toContain('class="adv-tool"');
    expect(html).not.toContain('tc-icon');
  });

  it('gives the assistant prose room instead of a bubble and an avatar',()=>{
    expect(css).toContain('.adv-avatar{display:none}');
    expect(css).toMatch(/\.adv-msg\.ai \.adv-bubble\{max-width:74ch;background:none/);
  });
});

// On a phone the conversations rail is a sheet. Getting this wrong is invisible in a
// desktop browser and total on a phone: the drawer opens perfectly, 1,200px below the
// fold, and the button looks dead.
describe('The conversations sheet on a phone',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');

  it('anchors the sheet to the screen, not to a container below the fold',()=>{
    const m=css.slice(css.indexOf('@media(max-width:900px){',css.indexOf('.adv-scrim')));
    expect(m).toMatch(/\.adv-rail\{position:fixed/);
    expect(m).not.toMatch(/\.adv-rail\{position:absolute/);
  });

  it('never leaves an animation transform behind, which would trap position:fixed',()=>{
    // A finished animation ending on transform:none computes to the identity matrix under
    // `both`, and an identity matrix DOES create a containing block. `backwards` does not.
    expect(css).toMatch(/\.ui-rise\{animation:[^}]*backwards\}/);
    expect(css).not.toMatch(/\.ui-rise\{animation:[^}]*\bboth\b/);
    expect(html).toMatch(/\.reveal\{animation:[^}]*backwards\}/);
    expect(html).toMatch(/\.tab-fade\{animation:[^}]*backwards\}/);
  });

  it('clears the inherited glass blur from the view wrapper',()=>{
    // backdrop-filter also creates a containing block for fixed children.
    expect(css).toMatch(/#chartArea\{[^}]*backdrop-filter:none/);
  });

  it('sits above the bottom navigation rather than under it',()=>{
    const scrimZ=Number((css.match(/\.adv-scrim\{[^}]*z-index:(\d+)/)||[])[1]);
    const railZ=Number((css.match(/\.adv-rail\{position:fixed;z-index:(\d+)/)||[])[1]);
    expect(scrimZ).toBeGreaterThan(60);     // above .tabs and the more-menu
    expect(railZ).toBeGreaterThan(scrimZ);
  });

  it('can be dismissed three ways, and locks the page behind it',()=>{
    expect(html).toContain('onclick="advToggleRail()"');          // the scrim
    expect(html).toMatch(/e\.key!=='Escape'/);                     // Escape
    expect(html).toContain("document.body.classList.toggle('adv-sheet-open',open)");
    expect(css).toContain('body.adv-sheet-open{overflow:hidden}');
  });

  it('has exactly one advToggleRailMobile, since the later declaration wins',()=>{
    // A stale copy toggling a .mob-show class that no longer exists silently shadowed the
    // real one — function declarations hoist, and the last definition is the one that runs.
    expect((html.match(/function advToggleRailMobile\(/g)||[]).length).toBe(1);
    expect(html).not.toContain("classList.toggle('mob-show')");
  });
});
