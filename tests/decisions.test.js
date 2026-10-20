'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initDecisions, applyDecision, decisionSnapshot, decisionOutcomes } = require('../lib/decisions.cjs');
const makeRoom = () => ({ hostId:'host', participants:new Map(['host','guest','third'].map(id=>[id,{id,ws:{readyState:1}}])), decisions:initDecisions() });
const create = (r,kind='topic',extra={}) => { applyDecision(r,'host',{type:'decision:create',kind,title:'Choose a direction',options:['Explore','Build','Learn'],...extra});return r.decisions.ballots.at(-1); };
const vote = (r,id,b,value) => applyDecision(r,id,{type:'decision:vote',id:b.id,value});
test('topic votes replace, withdraw and reject duplicate or out-of-range selections',()=>{
 const r=makeRoom(),b=create(r);vote(r,'guest',b,[0]);vote(r,'guest',b,[1]);
 assert.equal(b.votes.size,1);assert.deepEqual(decisionSnapshot(r,'host').ballots[0].values,[0,1,0]);
 assert.throws(()=>vote(r,'guest',b,[0,1]));assert.throws(()=>vote(r,'guest',b,[99]));
 vote(r,'guest',b,null);assert.equal(b.votes.size,0);
 const m=create(r,'topic',{multiple:true});vote(r,'guest',m,[0,2]);assert.throws(()=>vote(r,'guest',m,[0,0]));
 assert.deepEqual(decisionSnapshot(r,'host').ballots[1].values,[1,0,1]);
});
test('ballot electorate is frozen and disconnected newcomers cannot vote',()=>{
 const r=makeRoom();r.participants.get('third').ws.readyState=3;const b=create(r);
 r.participants.set('late',{id:'late',ws:{readyState:1}});
 assert.equal(decisionSnapshot(r,'late').ballots[0].eligibleCount,2);
 assert.equal(decisionSnapshot(r,'late').ballots[0].canVote,false);
 assert.throws(()=>vote(r,'late',b,[0]));assert.throws(()=>vote(r,'third',b,[0]));
 r.participants.get('guest').ws={readyState:1};vote(r,'guest',b,[0]);assert.equal(b.votes.size,1);
});
test('radar means include all criteria and reject incomplete or nonnumeric ratings',()=>{
 const r=makeRoom(),b=create(r,'radar');vote(r,'host',b,[1,2,3]);vote(r,'guest',b,[5,4,1]);
 assert.deepEqual(decisionSnapshot(r,'third').ballots[0].values,[3,3,2]);
 for(const v of [[1,2],[0,3,4],[6,2,3],[1,'3',4],[1,2.5,3]])assert.throws(()=>vote(r,'guest',b,v));
});
test('five-point uncertainty is its own category, never counted as opposition',()=>{
 const r=makeRoom(),b=create(r,'scale');vote(r,'guest',b,[2]);
 assert.deepEqual(decisionSnapshot(r,'host').ballots[0].values,[0,0,1,0,0]);
 assert.equal(b.options[2],'Don’t know');
});
test('snapshot excludes voter identities and other people’s individual responses',()=>{
 const r=makeRoom(),b=create(r);vote(r,'guest',b,[0]);const snap=decisionSnapshot(r,'host').ballots[0];
 assert.equal(snap.mine,null);assert.equal(snap.responded,1);assert.ok(snap.bubbles[0].token);
 assert.equal(JSON.stringify(snap).includes('guest'),false);assert.equal('eligible' in snap,false);assert.equal('votes' in snap,false);
 assert.deepEqual(decisionSnapshot(r,'guest').ballots[0].mine,[0]);
 const token=snap.bubbles[0].token;vote(r,'guest',b,[2]);assert.equal(decisionSnapshot(r,'host').ballots[0].bubbles[0].token,token);
});
test('creator and facilitators manage ballots; closed votes cannot change',()=>{
 const r=makeRoom(),b=create(r);
 assert.throws(()=>applyDecision(r,'guest',{type:'decision:close',id:b.id}));
 applyDecision(r,'host',{type:'thinking:cohost',id:'guest'});
 applyDecision(r,'guest',{type:'decision:conclusion',id:b.id,conclusion:'Build the prototype.'});
 applyDecision(r,'guest',{type:'decision:close',id:b.id});assert.throws(()=>vote(r,'host',b,[0]));
 assert.equal(decisionOutcomes(r).ballotsClosed,1);assert.equal(decisionOutcomes(r).conclusions[0].conclusion,'Build the prototype.');
});
test('check-ins expose only own response while open and publish a single anonymous batch',()=>{
 const r=makeRoom();applyDecision(r,'host',{type:'thinking:start'});
 for(const [id,value] of [['host','clear'],['guest','context'],['third','pause']])applyDecision(r,id,{type:'thinking:respond',round:1,value});
 const before=decisionSnapshot(r,'host');assert.equal(before.published,null);assert.equal(before.myCheckin,'clear');
 assert.equal(JSON.stringify(before).includes('context'),false);assert.equal('responseCount' in before,false);
 applyDecision(r,'host',{type:'thinking:finish'});
 const after=decisionSnapshot(r,'guest');assert.deepEqual(after.published,{total:3,counts:[1,1,1]});assert.equal(after.myCheckin,null);assert.equal(r.decisions.checkins.size,0);
 assert.throws(()=>applyDecision(r,'guest',{type:'thinking:respond',round:1,value:'clear'}));
});
test('small check-ins withhold details; repeated responses and withdrawals are handled safely',()=>{
 const r=makeRoom();applyDecision(r,'host',{type:'thinking:start'});
 for(const value of ['clear','context',null,'pause'])applyDecision(r,'guest',{type:'thinking:respond',round:1,value});
 applyDecision(r,'host',{type:'thinking:finish'});assert.deepEqual(decisionSnapshot(r,'host').published,{withheld:true});
 applyDecision(r,'host',{type:'thinking:start'});assert.equal(decisionSnapshot(r,'host').published,null);
 assert.throws(()=>applyDecision(r,'guest',{type:'thinking:respond',round:1,value:'clear'}));
});
test('only host delegates; both facilitators can change objective and manage check-ins',()=>{
 const r=makeRoom();assert.throws(()=>applyDecision(r,'guest',{type:'thinking:cohost',id:'third'}));
 assert.throws(()=>applyDecision(r,'guest',{type:'thinking:objective',objective:'Change goal'}));
 applyDecision(r,'host',{type:'thinking:cohost',id:'guest'});applyDecision(r,'guest',{type:'thinking:objective',objective:'Agree an owner'});
 applyDecision(r,'guest',{type:'thinking:start'});assert.equal(decisionSnapshot(r,'host').objective,'Agree an owner');
 assert.throws(()=>applyDecision(r,'third',{type:'thinking:finish'}));
 applyDecision(r,'host',{type:'thinking:cohost',id:null});assert.throws(()=>applyDecision(r,'guest',{type:'thinking:finish'}));
});
test('input limits reject malformed ballots and cap session size',()=>{
 const r=makeRoom();for(const options of [['x'],['a','A'],['','b'],Array(7).fill('x')]) assert.throws(()=>create(r,'topic',{options}));
 assert.throws(()=>create(r,'radar',{options:['a','b']}));assert.throws(()=>create(r,'bad'));
 for(let n=0;n<20;n++)create(r);assert.throws(()=>create(r));
});
