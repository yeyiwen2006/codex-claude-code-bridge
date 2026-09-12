import assert from 'node:assert/strict';
// Opt-in: overwrites the Windows clipboard with generated test images.
// Requires Python with Pillow. Never runs as part of node --test.
import { readFile, writeFile, readdir, mkdir, mkdtemp, realpath, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {captureWindowsClipboard, addClipboardImages, clearQueuedImages} from '../../server/lib/image-queue.mjs';
if(process.platform!=='win32') throw Error('This opt-in validation requires Windows.');
if(!process.argv.includes('--overwrite-clipboard')) throw Error('Pass --overwrite-clipboard only with authorization to replace the system clipboard.');
const scripts=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(scripts,'../..');
const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'bridge-clipboard-release-')));
const python=process.env.BRIDGE_QA_PYTHON||'python';
const dataRoot=path.join(root,'boundary-data');
await mkdir(dataRoot,{recursive:true});
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const checks=[];
const cleanupErrors=[];
let infrastructureError=null;
async function setClipboard(mode,sourceName='opaque.png',files=[]){
  await writeFile(path.join(root,'fixture.json'),JSON.stringify({sourceImage:path.join(root,sourceName),fileDrop:files.map(f=>path.join(root,f))}),'utf8');
  execFileSync(ps,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.join(scripts,'windows-set-clipboard.ps1'),'-Mode',mode,'-FixturePath',path.join(root,'fixture.json')],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','ignore','pipe']});
}
async function record(name,operation){
  const result={name,passed:false};
  try { Object.assign(result,await operation()); result.passed=true; }
  catch(error){ result.error=error.code==='ERR_ASSERTION'?'assertion':'native-test-failed'; process.exitCode=1; }
  checks.push(result);
  await writeFile(path.join(root,'native-boundaries-report.json'),JSON.stringify({checks},null,2),'utf8');
  console.log(JSON.stringify(result));
}
try {
execFileSync(python,[path.join(scripts,'windows-clipboard-fixtures.py'),root],{encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','ignore','pipe']});
for(const [label,mode,sourceName] of [['bitmap-all-pixels','Bitmap','opaque.png'],['transparent-png-all-pixels','PNG','transparent.png']]) {
  await record(label,async()=>{
    await setClipboard(mode,sourceName);
    const capture=await captureWindowsClipboard(path.join(root,label));
    const pixels=JSON.parse(execFileSync(python,[path.join(scripts,'windows-image-compare.py'),path.join(root,sourceName),capture.items[0].path],{encoding:'utf8',windowsHide:true,timeout:15000}));
    assert.equal(pixels.allPixelsEqual,true);
    if(mode==='PNG') assert.ok((await readFile(path.join(root,sourceName))).equals(await readFile(capture.items[0].path)));
    return {sourceFormat:capture.items[0].sourceFormat,byteExact:capture.items[0].byteExact,...pixels};
  });
}
const cases=[
  {name:'mixed-png-jpeg-gif-webp',files:['opaque.png','sample.jpg','sample.gif','sample.webp'],count:4},
  {name:'exact-count-20',files:Array.from({length:20},(_,i)=>`count-${String(i).padStart(2,'0')}.png`),count:20},
  {name:'reject-count-21',files:Array.from({length:21},(_,i)=>`count-${String(i).padStart(2,'0')}.png`),error:/20/},
  {name:'exact-single-25mib',files:['exact-single.png'],count:1},
  {name:'reject-single-over-25mib',files:['over-single.png'],error:/25/},
  {name:'reject-total-over-100mib',files:Array.from({length:5},(_,i)=>`total-${i}.png`),error:/100/},
];
for(const c of cases){
  await record(c.name,async()=>{
    await setClipboard('FileDrop','opaque.png',c.files);
    const state={images:[],lastClipboardSequence:null};
    const sessionId='boundary-'+c.name;
    try {
    if(c.error){
      await assert.rejects(addClipboardImages(state,dataRoot,sessionId),c.error);
      assert.equal(state.images.length,0);
      assert.equal((await readdir(path.join(dataRoot,'images',sessionId))).length,0);
      return {rejected:true,queueUnchanged:true,failedBatchCleaned:true};
    }
    const images=await addClipboardImages(state,dataRoot,sessionId);
    assert.equal(images.length,c.count);
    for(let i=0;i<images.length;i++) assert.ok((await readFile(path.join(root,c.files[i]))).equals(await readFile(images[i].storedPath)));
    const bytes=images.reduce((sum,x)=>sum+x.sizeBytes,0);
    const mediaTypes=images.map(x=>x.mediaType);
    return {count:images.length,bytes,mediaTypes,allFilesByteEqual:true,queueCleaned:true};
    } finally {
      if(state.images.length) await clearQueuedImages(state,dataRoot,sessionId);
      assert.equal(state.images.length,0);
    }
  });
}
} catch {
  infrastructureError='validation-infrastructure-failed';
  process.exitCode=1;
} finally {
// Keep cleanup independent of the final clipboard operation and test assertions.
try {
  await setClipboard('FileDrop','opaque.png',['opaque.png','transparent.png']);
} catch {
  cleanupErrors.push('final-clipboard-update-failed');
  process.exitCode=1;
}
for(const name of ['over-single.png','exact-single.png',...Array.from({length:5},(_,i)=>`total-${i}.png`)]) {
  const file=path.resolve(root,name);
  assert.equal(path.dirname(file),root);
  try { await unlink(file); } catch(error) {
    if(error.code!=='ENOENT') {
      cleanupErrors.push('generated-fixture-cleanup-failed');
      process.exitCode=1;
    }
  }
}
await mkdir(path.join(repository,'artifacts'),{recursive:true});
const report={checks,infrastructureError,cleanupErrors,allPassed:checks.length===8&&checks.every(c=>c.passed)&&!infrastructureError&&!cleanupErrors.length};
await writeFile(path.join(repository,'artifacts','windows-clipboard.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({allPassed:report.allPassed,cleanupErrors,infrastructureError}));
}
