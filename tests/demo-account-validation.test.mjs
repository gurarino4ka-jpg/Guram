import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDemoAccountSnapshot } from '../monitor/demo-account-validation.mjs';
import { ReadOnlyTransportError } from '../monitor/readonly-transport.mjs';

const now=Date.parse('2026-11-11T06:00:00.000Z');
const valid=()=>({accountId:'demo_123',environment:'demo',currency:'USD',balance:1200.50,asOf:'2026-11-11T05:59:30.000Z'});
test('accepts a recent explicit demo snapshot without mutation',()=>{
  const input=valid();
  const output=parseDemoAccountSnapshot(input,{now});
  assert.deepEqual(output,input);
  assert.equal(Object.isFrozen(output),true);
  assert.notEqual(output,input);
});
test('rejects live account, invalid balances, ambiguous identities and timestamps',()=>{
  const changes=[
    {environment:'live'}, {environment:'paper'}, {environment:null},
    {balance:-1},{balance:NaN},{balance:Infinity},{balance:'1200'},
    {accountId:'../live'},{accountId:''},{currency:'usd'},
    {asOf:'2026-11-10T05:00:00.000Z'},
    {asOf:'2026-11-11T06:10:00.000Z'},
    {asOf:'not a timestamp'},
    {extra:'unknown'},
  ];
  for(const patch of changes) {
    assert.throws(()=>parseDemoAccountSnapshot({...valid(),...patch},{now}),ReadOnlyTransportError,JSON.stringify(patch));
  }
  assert.throws(()=>parseDemoAccountSnapshot(null,{now}),ReadOnlyTransportError);
  assert.throws(()=>parseDemoAccountSnapshot([],{now}),ReadOnlyTransportError);
});
