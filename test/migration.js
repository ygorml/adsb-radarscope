// Stored settings from an older release must still load into the right state.
//
// This is the failure mode that hides: nothing errors, the app just quietly
// comes up configured differently from how the user left it. 0.0.3 replaced
// positionFileEnabled/showOwnShip with receiverType/showReceiverMarker, so a
// 0.0.2 install that was tracking a POSITION file has to come back as a ship.
const fs=require('fs'),path=require('path');
const {JSDOM,VirtualConsole}=require('jsdom');
const ROOT=path.join(__dirname,'..');
const PROBE="\n window.__t={state,PositionManager,CONFIG};\n";
function boot(saved){
  const vc=new VirtualConsole();
  const noise=[];
  vc.on('jsdomError',e=>noise.push(e.message));
  vc.on('error',(...a)=>noise.push(a.join(' ')));
  ['warn','log'].forEach(e=>vc.on(e,()=>{}));
  const dom=new JSDOM(fs.readFileSync(path.join(ROOT,'index.html'),'utf8')
    .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/g,''),
    {url:'http://localhost:8000/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
     beforeParse(w){
       w.fetch=()=>Promise.reject(new Error('offline'));
       w.HTMLCanvasElement.prototype.getContext=function(){const n=()=>()=>{};return{canvas:this,
         save:n(),restore:n(),beginPath:n(),closePath:n(),moveTo:n(),lineTo:n(),arc:n(),rect:n(),
         fill:n(),stroke:n(),fillRect:n(),clearRect:n(),fillText:n(),translate:n(),rotate:n(),
         setLineDash:n(),quadraticCurveTo:n(),putImageData:n(),measureText:()=>({width:6}),
         getImageData:(x,y,a,b)=>({width:a,height:b,data:new Uint8ClampedArray(4)})};};
       w.AudioContext=function(){return{currentTime:0,destination:{},
         createOscillator:()=>({connect(){},start(){},stop(){},frequency:{setValueAtTime(){}}}),
         createGain:()=>({connect(){},gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}}})};};
       w.OffscreenCanvas=undefined; w.__frames=[];
       w.requestAnimationFrame=cb=>w.__frames.push(cb); w.cancelAnimationFrame=()=>{};
     }});
  const {window}=dom,doc=window.document;
  window.localStorage.setItem('adsbScope_settings',JSON.stringify(saved));
  const c=doc.getElementById('canvas-container');
  Object.defineProperty(c,'clientWidth',{value:800,configurable:true});
  Object.defineProperty(c,'clientHeight',{value:600,configurable:true});
  for(const f of ['config.js','app.js']){
    let src=fs.readFileSync(path.join(ROOT,f),'utf8');
    if(f==='app.js'){const i=src.lastIndexOf('})();'); src=src.slice(0,i)+PROBE+src.slice(i);}
    const s=doc.createElement('script'); s.textContent=src; doc.body.appendChild(s);
  }
  return e=>window.eval(`(function(){try{return ${e}}catch(x){return '__ERR__'+x.message}})()`);
}
(async()=>{
  console.log('\n'+'='.repeat(70));
  console.log('SETTINGS MIGRATION — older stored settings load correctly');
  console.log('='.repeat(70));
  const cases=[
    ['0.0.2 tracking a file -> ship', {homeLat:12.34,homeLon:0,positionFileEnabled:true,showOwnShip:true}, 'ship', true],
    ['0.0.2 not tracking -> static',  {homeLat:0,homeLon:0,positionFileEnabled:false},                  'static', true],
    ['0.0.2 marker hidden is kept',   {homeLat:0,homeLon:0,positionFileEnabled:true,showOwnShip:false}, 'ship', false],
    ['0.0.3 explicit type wins',      {homeLat:0,homeLon:0,receiverType:'car',positionFileEnabled:false},'car', true],
  ];
  let pass=0;
  for(const [name,saved,type,marker] of cases){
    const g=boot(saved);
    await new Promise(r=>setTimeout(r,300));   // let DOMContentLoaded fire
    const t=g('window.__t.state.receiverType'), m=g('window.__t.state.showReceiverMarker');
    const ok = t===type && m===marker;
    if(ok) pass++;
    console.log(` ${ok?'PASS':'*FAIL'}  ${name}\n         -> ${t}, marker ${m}`);
  }
  console.log(`\n${pass}/${cases.length} migration cases`);
  process.exit(pass===cases.length?0:1);
})();
