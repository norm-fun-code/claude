const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeSnapshot, fromBalanceRecords } = require('../src/services/monarch-planner-snapshot');
test('publishes all accounts including retirement and legitimate zero balances',()=>{
  const s=makeSnapshot([{id:'1',displayName:'401k',currentBalance:100},{id:'2',displayName:'Checking',currentBalance:0}]);
  assert.equal(s.accounts.length,2);assert.equal(s.accounts[1].currentBalance,0);
});
test('rejects incomplete, invalid, empty, and duplicate account snapshots',()=>{
  for(const accounts of [[],[{displayName:'Cash',currentBalance:null}],[{displayName:'Cash',currentBalance:'oops'}],[{displayName:'Cash',currentBalance:1},{displayName:'Cash',currentBalance:2}]])assert.equal(makeSnapshot(accounts),null);
});
test('CSV uses the latest export date, retains liabilities, and does not double-count history',()=>{
  const s=fromBalanceRecords([{Date:'2026-09-01',Account:'Cash',Balance:'100'},{Date:'2026-09-02',Account:'Cash',Balance:'$1,200.50'},{Date:'2026-09-02',Account:'Card',Balance:'-50'}]);
  assert.equal(s.asOf,'2026-09-02T00:00:00.000Z');assert.equal(s.accounts.length,2);assert.equal(s.accounts[0].currentBalance,1200.5);assert.equal(s.accounts[1].currentBalance,-50);
});
test('aggregate-only net worth exports cannot replace account details',()=>{
  assert.equal(fromBalanceRecords([{Date:'2026-09-02','Net Worth':100}]),null);
});
