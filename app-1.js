const app=document.getElementById('app');
const REG=DATA.regions, BOOKS=DATA.books;
const COLORS={presence:'#63c5b7',mastery:'#e4924d',clarity:'#6f96db',connection:'#d874a0',wealth:'#d3b653',craft:'#8977cf',vitality:'#5bb66c',meaning:'#c17d4f',frontier:'#54a9d2'};
const POS={presence:[-18,0,-17],mastery:[0,0,-21],clarity:[19,0,-16],connection:[-23,0,0],meaning:[0,0,0],wealth:[23,0,1],vitality:[-18,0,18],craft:[0,0,22],frontier:[19,0,17]};
const ICON={presence:'◌',mastery:'▲',clarity:'◉',connection:'♡',wealth:'◆',craft:'♜',vitality:'❧',meaning:'✦',frontier:'✧'};
let THREE,renderer,scene,camera,raycaster,pointer,worldGroup,clock;
let cameraTarget,camYaw=.55,camPitch=.72,camDist=52,travel=null,selectedRegion=null,selectedLandmark=null,twilight=true;
let drag={down:false,x:0,y:0,lastX:0,lastY:0,moved:0},pinchDist=0;
const clickable=[];
const $=s=>document.querySelector(s); const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const countRegion=id=>BOOKS.filter(b=>b.region===id).length;
const landmarks=id=>[...new Set(BOOKS.filter(b=>b.region===id).map(b=>b.landmark))];
function hexNum(h){return parseInt(h.slice(1),16)}
function showFallback(msg){$('#fallback').hidden=false;$('#fallback h2').textContent='3D world unavailable';$('#fallback p').textContent=msg;$('#loading').textContent='3D engine unavailable';$('#loading').classList.add('error')}
function makeLabel(text,color='#ffffff',sub=''){
  const c=document.createElement('canvas'),ctx=c.getContext('2d');c.width=512;c.height=128;ctx.clearRect(0,0,512,128);ctx.textAlign='center';ctx.shadowColor='rgba(0,0,0,.75)';ctx.shadowBlur=16;ctx.fillStyle=color;ctx.font='600 34px Georgia';ctx.fillText(text,256,52);if(sub){ctx.fillStyle='rgba(235,242,248,.72)';ctx.font='500 18px Inter, sans-serif';ctx.fillText(sub,256,83)}
  const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;const mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthWrite:false});const sp=new THREE.Sprite(mat);sp.scale.set(8,2,1);return sp;
}
function mat(color,rough=.75,metal=.05,emissive=0){return new THREE.MeshStandardMaterial({color:hexNum(color),roughness:rough,metalness:metal,flatShading:true,emissive:emissive?hexNum(color):0,emissiveIntensity:emissive})}
function rockIsland(id,pos){
  const g=new THREE.Group();g.position.set(...pos);g.userData={type:'region',region:id};
  const c=COLORS[id];
  const base=new THREE.Mesh(new THREE.CylinderGeometry(7.4,8.7,2.7,14,1,false),mat('#263241',.95));base.position.y=-1.2;base.rotation.y=Math.random();g.add(base);
  const top=new THREE.Mesh(new THREE.CylinderGeometry(7.2,7.5,.8,14,1,false),mat(c,.92));top.position.y=.45;top.rotation.y=base.rotation.y;g.add(top);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(6.9,.18,6,28),new THREE.MeshBasicMaterial({color:hexNum(c),transparent:true,opacity:.28}));rim.rotation.x=Math.PI/2;rim.position.y=.9;g.add(rim);
  [base,top].forEach(x=>clickable.push(x));
  const label=makeLabel(REG[id].name,'#f5f1e5',REG[id].tagline);label.position.set(0,5.8,0);g.add(label);
  buildCenterpiece(g,id,c);
  buildLandmarks(g,id,c);
  scatterNature(g,id,c);
  worldGroup.add(g);return g;
}
function meshBox(w,h,d,color){return new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat(color,.65))}
function cone(r,h,color){return new THREE.Mesh(new THREE.ConeGeometry(r,h,7),mat(color,.85))}
function cyl(r,h,color){return new THREE.Mesh(new THREE.CylinderGeometry(r,r,h,10),mat(color,.75))}
function buildCenterpiece(g,id,c){const center=new THREE.Group();center.position.y=.9;center.userData={type:'region',region:id};
  if(id==='presence'){
    const p=meshBox(4,.45,3.4,'#d7d3c4');p.position.y=.2;center.add(p);for(const x of [-1.3,0,1.3]){const col=cyl(.18,2.2,'#e4dfd1');col.position.set(x,1.4,0);center.add(col)}const roof=cone(3.1,1.35,c);roof.position.y=3.05;roof.rotation.y=Math.PI/4;center.add(roof);
  }else if(id==='mastery'){
    const m=cone(3.8,6,'#515965');m.position.set(0,2.3,0);center.add(m);const forge=meshBox(2.2,1.5,1.7,'#3b2d29');forge.position.set(0,1.15,2);center.add(forge);const glow=meshBox(1.3,.25,1.1,'#ff8a3d');glow.material.emissive.set(0xff5b22);glow.material.emissiveIntensity=2.2;glow.position.set(0,1.95,2);center.add(glow);
  }else if(id==='clarity'){
    const b=cyl(2.8,1,'#d8dce5');b.position.y=.6;center.add(b);const dome=new THREE.Mesh(new THREE.SphereGeometry(2.6,12,8,0,Math.PI*2,0,Math.PI/2),new THREE.MeshStandardMaterial({color:0x91aee8,transparent:true,opacity:.62,roughness:.2,metalness:.2,side:THREE.DoubleSide}));dome.position.y=1.1;center.add(dome);const lens=cyl(.42,3.2,c);lens.rotation.z=Math.PI/3;lens.position.set(0,2.7,0);center.add(lens);
  }else if(id==='connection'){
    const dock=meshBox(1,.25,7,'#6e503d');dock.position.set(0,.5,3);center.add(dock);for(const x of [-2.2,2.2]){const t=cyl(.6,2.2,'#805b48');t.position.set(x,1.5,0);center.add(t);const crown=new THREE.Mesh(new THREE.SphereGeometry(1.45,8,6),mat(c,.95));crown.position.set(x,3,0);center.add(crown)}
  }else if(id==='wealth'){
    for(let i=-1;i<=1;i++){const stall=meshBox(2,1.4,1.8,'#6b5538');stall.position.set(i*2.2,1,0);center.add(stall);const awn=cone(1.5,1.2,c);awn.position.set(i*2.2,2.15,0);center.add(awn)}const vault=meshBox(2.5,2,2.2,'#bda85c');vault.position.set(0,1.2,-2.7);center.add(vault);
  }else if(id==='craft'){
    const keep=meshBox(3.6,3.6,3.6,'#858596');keep.position.y=2;center.add(keep);for(const x of [-2.4,2.4])for(const z of [-2.4,2.4]){const t=cyl(.7,4.7,'#747685');t.position.set(x,2.35,z);center.add(t);const cap=cone(1,1.6,c);cap.position.set(x,5.45,z);center.add(cap)}
  }else if(id==='vitality'){
    const trunk=cyl(.7,4.5,'#77533f');trunk.position.y=2.5;center.add(trunk);for(const p of [[0,5,0],[-1.5,4.7,.7],[1.5,4.6,-.6],[0,4.8,1.5]]){const crown=new THREE.Mesh(new THREE.IcosahedronGeometry(1.7,1),mat(c,.95));crown.position.set(...p);center.add(crown)}
  }else if(id==='meaning'){
    const ring=new THREE.Mesh(new THREE.TorusGeometry(2.6,.22,6,24),mat('#8a755f',.9));ring.rotation.x=Math.PI/2;ring.position.y=.55;center.add(ring);for(let i=0;i<5;i++){const a=i/5*Math.PI*2,stone=meshBox(.65,2.4,.65,'#8b8c8b');stone.position.set(Math.cos(a)*2.7,1.45,Math.sin(a)*2.7);stone.rotation.y=-a;center.add(stone)}const flame=cone(.55,1.5,'#f2b05f');flame.material.emissive.set(0xff8b35);flame.material.emissiveIntensity=2.5;flame.position.y=1.2;flame.userData.flame=true;center.add(flame);
  }else if(id==='frontier'){
    for(let i=0;i<7;i++){const a=i/7*Math.PI*2,r=1.2+(i%3)*.9,h=2.4+(i%4)*1.1;const sp=cone(.65,h,i%2?c:'#a5d8eb');sp.position.set(Math.cos(a)*r,h/2+.6,Math.sin(a)*r);sp.material.metalness=.25;sp.material.roughness=.28;center.add(sp)}
  }g.add(center)}
function scatterNature(g,id,c){
  const count= id==='frontier'?5:10;for(let i=0;i<count;i++){const a=Math.random()*Math.PI*2,r=4.5+Math.random()*1.8;const x=Math.cos(a)*r,z=Math.sin(a)*r;if(['presence','vitality','connection'].includes(id)){const t=cyl(.16,1.2,'#5a4639');t.position.set(x,1.55,z);g.add(t);const crown=cone(.7,1.8,id==='vitality'?c:'#4c8a68');crown.position.set(x,2.65,z);g.add(crown)}else{const stone=new THREE.Mesh(new THREE.DodecahedronGeometry(.35+Math.random()*.4,0),mat(i%2?c:'#66707c',.95));stone.position.set(x,1.25,z);stone.rotation.set(Math.random(),Math.random(),Math.random());g.add(stone)}}
}
function landmarkShape(i,c,id){const root=new THREE.Group();const pedestal=cyl(.48,.35,'#d8d3c6');pedestal.position.y=.2;root.add(pedestal);let m;if(id==='presence'){m=cone(.45,1.4,c)}else if(id==='mastery'){m=meshBox(.72,.72,.72,c);m.rotation.set(.4,.5,.2)}else if(id==='clarity'){m=new THREE.Mesh(new THREE.OctahedronGeometry(.65),mat(c,.25,.15,.3))}else if(id==='connection'){m=new THREE.Mesh(new THREE.TorusKnotGeometry(.38,.11,40,6),mat(c,.4,.15))}else if(id==='wealth'){m=new THREE.Mesh(new THREE.DodecahedronGeometry(.62,0),mat(c,.25,.65))}else if(id==='craft'){m=cone(.5,1.6,c)}else if(id==='vitality'){m=new THREE.Mesh(new THREE.IcosahedronGeometry(.7,1),mat(c,.85))}else if(id==='meaning'){m=new THREE.Mesh(new THREE.TetrahedronGeometry(.72,0),mat(c,.8))}else{m=new THREE.Mesh(new THREE.OctahedronGeometry(.75),mat(c,.15,.55,.5))}m.position.y=1.1;root.add(m);root.userData.floatSeed=Math.random()*10;return root}
function buildLandmarks(g,id,c){const lm=landmarks(id).slice(0,5);lm.forEach((name,i)=>{const a=(i/lm.length)*Math.PI*2+.45,r=4.3;const marker=landmarkShape(i,c,id);marker.position.set(Math.cos(a)*r,1,Math.sin(a)*r);marker.userData={type:'landmark',region:id,landmark:name,floatSeed:Math.random()*10};marker.traverse(o=>{if(o.isMesh){o.userData={type:'landmark',region:id,landmark:name};clickable.push(o)}});g.add(marker)})}
