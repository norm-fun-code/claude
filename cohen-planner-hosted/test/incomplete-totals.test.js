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

// A warning has to be about the number it sits next to. Reaching for a second, older source
// to decide whether the first one is complete produces a flag nobody can clear.
describe('completeness is judged on the reading actually shown', () => {
  const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('does not let a different, persisted sync mark the hero incomplete', () => {
    // monarchSnapshot is a separate sync down a separate code path, saved with the plan.
    // One old partial sync marked every later reading incomplete forever, with no account
    // to point at and no way to clear it — while contributing nothing to the hero's number.
    expect(cockpit).toContain('const partial=available&&(s.complete!==true||d.partial===true);');
    // Checked against code only — the comment explaining this names the variable too.
    const code = cockpit.slice(cockpit.indexOf('function renderCockpit'))
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('monarchSnapshot');
  });

  it('keeps the panel on the same source as the chip that opens it', () => {
    expect(cockpit).toContain('const syncPartial=!!(overview&&overview.partial);');
  });

  it('still fires on a genuine gap in the reading on screen', () => {
    // The chip must survive: an account the provider could not read really does leave the
    // total short, and that is the whole reason the panel exists.
    expect(cockpit).toContain('s.complete!==true');
    expect(cockpit).toContain('d.partial===true');
  });

  it('never prints a list of missing accounts that is empty', () => {
    // "Monarch returned no balance for:" followed by nothing reads as a broken page.
    const portfolio = html.slice(html.indexOf('Only warn about what can actually be named'));
    expect(portfolio).toContain('if(!monarchSnapshot?.partial||!miss.length)return');
  });
});

// A long list that cannot be folded is a long list you scroll past every time.
describe('the accounts list folds', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/cockpit.css', import.meta.url), 'utf8');

  it('reuses the collapse set the settings panel already persists', () => {
    // A second mechanism for the same idea is how two of them end up disagreeing.
    expect(html).toContain("_collapsedSections.has('acct-list')");
    expect(html).toContain("toggleSection('acct-list',true)");
    expect(html).toMatch(/function toggleSection\(key,full\)/);
    expect(html).toContain('full?render():buildControls()');
  });

  it('still answers the question when folded', () => {
    // A section that hides what it was telling you is a section you just have to reopen.
    const sec = html.slice(html.indexOf('class="accounts-toggle"'), html.indexOf('id="acctList"'));
    expect(sec).toContain('account${nShown===1?\'\':\'s\'}');
    expect(sec).toContain('UI.money(sum.netWorth)');
  });

  it('says its state to a screen reader as well as with a chevron', () => {
    expect(html).toContain('aria-expanded="${acctOpen}"');
    expect(html).toContain('aria-controls="acctList"');
    expect(html).toContain("acctOpen?'▾':'▸'");
    expect(css).toContain('.accounts-toggle:focus-visible');
  });

  it('gives the header a thumb-sized target on a phone', () => {
    const m = css.match(/@media\(max-width:760px\)\{\.accounts-toggle\{min-height:(\d+)px/);
    expect(Number(m[1])).toBeGreaterThanOrEqual(44);
  });

  it('opens by default, so nothing vanishes on first sight', () => {
    // `has()` is false for a fresh set, and 'acct-list' is not in the seeded defaults.
    expect(html).toContain("const acctOpen=!_collapsedSections.has('acct-list');");
    const seed = html.match(/JSON\.stringify\(\[([^\]]*)\]\)\)\)/)[1];
    expect(seed).not.toContain('acct-list');
  });
});
