import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/cockpit.css', import.meta.url), 'utf8');
const panel = cockpit.slice(cockpit.indexOf('function cockpitGapPanel'),
                            cockpit.indexOf('// The observation date'));

// "Incomplete" is a word, not information: it says something is wrong without saying what,
// how much, or what to do about it.
describe('the incomplete-totals chip explains itself', () => {
  it('opens rather than only sitting there', () => {
    expect(cockpit).toContain('hero.partial?cockpitGapPanel(s,d)');
    expect(panel).toContain('<details class="cp-gap">');
    expect(panel).toContain('aria-label="Why this total is incomplete"');
  });

  it('says what incomplete costs, in the first line', () => {
    expect(panel).toContain('Your net worth is short by an unknown amount.');
  });

  it('names the accounts instead of leaving the reader to find them', () => {
    expect(panel).toContain('summary&&summary.unknownBalance');
    expect(panel).toContain('${e(a.name||a.id)}');
  });

  it('restates that missing is not zero, where the reader is looking', () => {
    // The single most consequential misreading this whole app is built to prevent.
    expect(panel).toMatch(/counted <em>nowhere<\/em> above — not as zero/);
  });

  it('explains a partial sync too, when no individual account is named', () => {
    expect(panel).toContain('syncPartial');
    expect(panel).toMatch(/last sync did not return every account/);
  });
});

describe('both ways out are offered, and neither invents a number', () => {
  it('offers the two real resolutions per account', () => {
    expect(panel).toContain('confirmAccountBalance(');
    expect(panel).toContain('setAccountHidden(');
    expect(panel).toContain('Enter the balance');
    expect(panel).toContain('Exclude it');
  });

  it('says what each one actually does before it is clicked', () => {
    expect(panel).toMatch(/records it as <em>your<\/em> figure, dated today/);
    expect(panel).toMatch(/supersedes it automatically/);
    expect(panel).toMatch(/never counted as zero/);
  });

  it('has no dismiss that hides the warning while the total stays short', () => {
    // Ignoring is spelled "exclude the account", which changes the total and says so.
    // A plain dismiss would leave a wrong figure with nothing on screen admitting it.
    expect(panel).not.toMatch(/\b(dismiss|snooze|ignore)\b/i);
  });
});

describe('the panel fits on the screen it opens on', () => {
  it('escapes the hero card\'s clipping only while it is open', () => {
    // The card clips to its rounded corners, which would cut the panel off mid-sentence.
    expect(css).toContain('.cp-position:has(.cp-gap[open]){overflow:visible}');
  });

  it('anchors to the hero row on a phone, not to the chip inside it', () => {
    // Anchored to the chip it ran off the right edge; anchored to the chip's right edge it
    // ran the same distance off the left. Spanning the row cannot do either.
    const m = css.slice(css.indexOf('@media(max-width:760px)', css.indexOf('.cp-gap-body')));
    expect(m).toContain('.cp-hero-meta{position:relative}');
    expect(m).toContain('.cp-gap{position:static}');
    expect(m).toContain('.cp-gap-body{left:0;right:0;width:auto;max-width:none}');
  });

  it('gives the actions a thumb-sized target on a phone', () => {
    const m = css.slice(css.indexOf('@media(max-width:760px)', css.indexOf('.cp-gap-body')));
    expect(Number(m.match(/\.cp-gap-body li>button\{[^}]*min-height:(\d+)px/)[1])).toBeGreaterThanOrEqual(36);
  });

  it('is reachable and dismissable by keyboard', () => {
    expect(css).toContain('.cp-gap>summary:focus-visible');
  });
});
