// DICOM Image Plane Module: position is the center of pixel (0,0).
// Patient LPS -> right-handed Three.js world: right, superior, posterior.
export const add = (a,b) => a.map((v,i)=>v+b[i]);
export const sub = (a,b) => a.map((v,i)=>v-b[i]);
export const scale = (a,n) => a.map(v=>v*n);
export const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
export const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const lpsToWorld = p => [-p[0], p[2], p[1]];
export function validFrame(frame) {
  const arrays=[frame.position,frame.orientation,frame.spacing];
  return arrays.every(a=>Array.isArray(a)&&a.every(Number.isFinite)) && arrays[0].length===3 && arrays[1].length===6 && arrays[2].length===2 && frame.spacing.every(v=>v>0) && frame.rows>0 && frame.columns>0 && Math.abs(dot(frame.orientation.slice(0,3),frame.orientation.slice(3)))<.002 && Math.abs(dot(frame.orientation.slice(0,3),frame.orientation.slice(0,3))-1)<.002 && Math.abs(dot(frame.orientation.slice(3),frame.orientation.slice(3))-1)<.002;
}
export function pixelPosition(frame,column,row) {
  return add(add(frame.position,scale(frame.orientation.slice(0,3),column*frame.spacing[1])),scale(frame.orientation.slice(3),row*frame.spacing[0]));
}
export function corners(frame) {
  return [[-.5,-.5],[frame.columns-.5,-.5],[frame.columns-.5,frame.rows-.5],[-.5,frame.rows-.5]].map(([c,r])=>lpsToWorld(pixelPosition(frame,c,r)));
}
export function center(frame) { return lpsToWorld(pixelPosition(frame,(frame.columns-1)/2,(frame.rows-1)/2)); }
export function normal(frame) { return lpsToWorld(cross(frame.orientation.slice(0,3),frame.orientation.slice(3))); }
export function orientationName(frame) {
  const n=cross(frame.orientation.slice(0,3),frame.orientation.slice(3)).map(Math.abs),i=n.indexOf(Math.max(...n));
  return ['Sagittal · side view','Coronal · front view','Axial · cross-section'][i];
}
export function intersection(a,b) {
  // Clip the infinite plane/plane intersection to BOTH finite image rectangles.
  const ac=corners(a),bc=corners(b),an=normal(a),bn=normal(b),d=cross(an,bn),den=dot(d,d);
  if(den<1e-8) return null;
  const origin=scale(add(scale(cross(bn,d),dot(an,ac[0])),scale(cross(d,an),dot(bn,bc[0]))),1/den);
  let low=-Infinity, high=Infinity;
  for(const c of [ac,bc]) {
    for(const edge of [sub(c[1],c[0]),sub(c[3],c[0])]) {
      const length2=dot(edge,edge),p=dot(sub(origin,c[0]),edge)/length2,v=dot(d,edge)/length2;
      if(Math.abs(v)<1e-10) { if(p < -1e-6 || p > 1+1e-6) return null; }
      else { let t0=-p/v,t1=(1-p)/v; if(t0>t1)[t0,t1]=[t1,t0]; low=Math.max(low,t0);high=Math.min(high,t1); }
    }
  }
  return high-low>1e-6 ? [add(origin,scale(d,low)),add(origin,scale(d,high))] : null;
}
export function contextIndices(count,index,mode) {
  if(mode==='all') return Array.from({length:count},(_,i)=>i);
  if(mode==='0') return [index];
  return [...new Set([index,0,Math.round((count-1)/4),Math.round((count-1)*3/4),count-1])].sort((a,b)=>a-b);
}
