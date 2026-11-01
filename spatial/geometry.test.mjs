import test from 'node:test';
import assert from 'node:assert/strict';
import {validFrame,pixelPosition,corners,center,normal,orientationName,intersection,contextIndices,dot,sub} from './geometry.mjs';
const axial={id:'a',position:[10,20,30],orientation:[1,0,0,0,1,0],spacing:[2,3],rows:5,columns:4};
const close=(a,b)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-5,`${a} != ${b}`));};
test('anisotropic spacing and half-pixel edges preserve physical dimensions and handedness',()=>{
  assert.ok(validFrame(axial));close(pixelPosition(axial,3,4),[19,28,30]);close(center(axial),[-14.5,30,24]);
  const c=corners(axial);close(c[0],[-8.5,30,19]);close(c[2],[-20.5,30,29]);close(normal(axial),[0,1,0]);assert.equal(orientationName(axial),'Axial · cross-section');
});
test('oblique slices retain recorded tilt instead of snapping to an axis',()=>{
  const t=.4,f={...axial,orientation:[1,0,0,0,Math.cos(t),Math.sin(t)]};
  close(pixelPosition(f,2,3),[16,20+6*Math.cos(t),30+6*Math.sin(t)]);assert.ok(validFrame(f));
  const n=normal(f),c=corners(f);for(const p of c)assert.ok(Math.abs(dot(n,sub(p,c[0])))<1e-6);
});
test('intersection is clipped to both image rectangles',()=>{
  const a={...axial,position:[0,0,0],rows:11,columns:11,spacing:[1,1]};
  const b={...a,position:[5,0,-5],orientation:[0,1,0,0,0,1]};
  const line=intersection(a,b);assert.ok(line);line.sort((p,q)=>p[2]-q[2]);close(line[0],[-5,0,-.5]);close(line[1],[-5,0,10.5]);
  assert.equal(intersection(a,{...b,position:[50,0,-5]}),null);
  assert.equal(intersection(a,{...a,position:[0,0,2]}),null);
  assert.equal(intersection(a,a),null);
});
test('context sampling includes the selected slice, honors every-slice mode, and has no duplicate frames',()=>{
  assert.deepEqual(contextIndices(17,8,'2'),[0,4,8,12,16]);assert.deepEqual(contextIndices(2,1,'2'),[0,1]);assert.equal(contextIndices(38,14,'all').length,38);assert.deepEqual(contextIndices(17,3,'0'),[3]);
});
test('missing or invalid geometry is rejected rather than placed at an invented origin',()=>{
  assert.equal(validFrame({...axial,position:[]}),false);assert.equal(validFrame({...axial,spacing:[0,1]}),false);assert.equal(validFrame({...axial,orientation:[1,0,0,1,0,0]}),false);
});
