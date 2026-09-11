import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cockpit = fs.readFileSync(new URL('../public/cockpit.css', import.meta.url), 'utf8');
const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');

// The app is dark. What survives from the light theme is not a stylistic leftover — a white
// panel carrying dark-theme grey text renders as a smear, and that is what the settings
// panel had become.
describe('no light-theme surfaces remain', () => {
  it('has dropped the blanket glass rule that painted the settings panel white', () => {
    expect(inline).not.toMatch(/\.panel,\.cc,\.kpi,\.sc,\.tabs,\.tw\{/);
    // .panel keeps its own token-based styling, which the blanket rule had been overriding.
    expect(inline).toMatch(/\.panel\{background:var\(--s1\);border:1px solid var\(--bd\)/);
  });

  it('gives the command palette and story cards dark surfaces of their own', () => {
    // Both are reachable and neither had an override, because the blanket rule was
    // painting over them.
    for (const sel of ['.cmdk-panel{', '.story-card{', '.story-close,.story-nav button{'])
      expect(cockpit, sel).toContain(sel);
  });

  it('draws the slider track in light-on-dark, not near-black', () => {
    // A track at rgba(10,37,64,.11) is invisible on the dark panel, which is why the
    // sliders read as thumbs floating in empty space.
    const tracks = inline.match(/\.sr input\[type=range\]::(-webkit-slider-runnable-track|-moz-range-track)\{[^}]*\}/g);
    expect(tracks).toHaveLength(2);
    for (const t of tracks) {
      expect(t, t).not.toMatch(/rgba\(10,\s*37,\s*64/);
      expect(t, t).toMatch(/rgba\(167,190,221/);
    }
  });

  it('makes scrollbars and loading skeletons visible against the dark page', () => {
    expect(cockpit).toMatch(/\*\{scrollbar-color:rgba\(167,190,221/);
    expect(cockpit).toMatch(/::-webkit-scrollbar-thumb\{background:rgba\(167,190,221/);
    expect(cockpit).toMatch(/\.skel\{background:linear-gradient\([^)]*rgba\(167,190,221/);
  });
});

// backdrop-filter creates a containing block, which is what trapped position:fixed inside
// #chartArea and opened the conversations sheet 1,200px below the fold on a phone.
describe('backdrop-filter is not left on layout containers', () => {
  it('is cleared from the containers the glass rule used to put it on', () => {
    for (const sel of ['.glass-card{backdrop-filter:none', '.cmdk-panel', '.story-card'])
      expect(cockpit, sel).toContain(sel);
    expect(cockpit).toMatch(/\.cmdk-panel\{[^}]*backdrop-filter:none/);
    expect(cockpit).toMatch(/\.story-card\{[^}]*backdrop-filter:none/);
  });

  it('still keeps it off the view wrapper, which is where it bit first', () => {
    const ui = fs.readFileSync(new URL('../public/ui.css', import.meta.url), 'utf8');
    expect(ui).toMatch(/#chartArea\{[^}]*backdrop-filter:none/);
  });
});
