import { describe, it, expect } from 'vitest';
const T=require('../public/planner-time.js');
const YearEnd=require('../public/year-end.js');
const Migrate=require('../public/plan-migrate.js');
describe('Eastern calendar independent of the browser or server timezone',()=>{
  it('keeps late evening in the closing month and year',()=>{
    expect(T.day('2026-10-01T02:39:00Z')).toBe('2026-09-30');
    expect(T.year('2027-01-01T04:59:59Z')).toBe(2026);
    expect(T.year('2027-01-01T05:00:00Z')).toBe(2027);
    expect(T.month('2026-10-01T02:39:00Z')).toBe(8);
    expect(YearEnd.rollForwardDue({planStartYear:2026},'2027-01-01T04:59:59Z')).toBeNull();
    expect(YearEnd.rollForwardDue({planStartYear:2026},'2027-01-01T05:00:00Z').currentYear).toBe(2027);
  });
  it('uses Eastern daylight and standard time on both sides of the DST transitions',()=>{
    expect(T.formatTime('2026-03-08T06:59:00Z')).toContain('1:59 AM EST');
    expect(T.formatTime('2026-03-08T07:00:00Z')).toContain('3:00 AM EDT');
    expect(T.formatTime('2026-11-01T05:30:00Z')).toContain('1:30 AM EDT');
    expect(T.formatTime('2026-11-01T06:30:00Z')).toContain('1:30 AM EST');
  });
  it('preserves date-only records and stamps opening balances with the Eastern day',()=>{
    expect(T.day('2026-01-01')).toBe('2026-01-01');
    expect(T.formatDate('2026-01-01',{month:'short',day:'numeric'})).toBe('Jan 1');
    expect(T.formatDate('2026-10-01',{month:'long',year:'numeric'})).toBe('October 2026');
    expect(Migrate.migrateObservedOn({planStartYear:2026},'2026-10-01T02:39:00Z').observedOn).toBe('2026-09-30');
  });
});
