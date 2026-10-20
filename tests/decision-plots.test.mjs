import {test} from 'node:test';
import assert from 'node:assert/strict';
import {radarPoints,bubblePositions,ballotExport} from '../quorum/decisions.mjs';
test('radar zero values sit at the center and maximum values share one radius',()=>{
 assert.deepEqual(radarPoints([0,0,0]),[[250,155],[250,155],[250,155]]);
 for(const [x,y] of radarPoints([5,5,5,5,5,5])) assert.ok(Math.abs(Math.hypot(x-250,y-155)-98)<1e-8);
});
test('a changed vote moves the same bubble between choice clusters',()=>{
 const b={options:['A','B','C'],bubbles:[{token:'secret-token',choices:[0]}]};
 const before=bubblePositions(b)[0];b.bubbles[0].choices=[2];const after=bubblePositions(b)[0];
 assert.equal(before.key,after.key);assert.notDeepEqual([before.x,before.y],[after.x,after.y]);
});
test('multi-choice bubbles occupy their selected clusters without duplicating keys',()=>{
 const points=bubblePositions({options:['A','B'],bubbles:[{token:'a',choices:[0,1]},{token:'b',choices:[0]}]});
 assert.equal(points.length,3);assert.equal(new Set(points.map(p=>p.key)).size,3);
 assert.equal(points[0].choice,0);assert.equal(points[1].choice,1);
});
test('exports contain aggregate outcomes, never voter tokens or personal votes',()=>{
 const b={title:'Next?',kind:'topic',options:['A','B'],values:[1,2],open:false,eligibleCount:3,responded:3,conclusion:'Try B',bubbles:[{token:'private'}],mine:[0]};
 const out=ballotExport(b);assert.equal(out.status,'Closed');assert.equal(out.conclusion,'Try B');assert.equal('bubbles' in out,false);assert.equal('mine' in out,false);
});
