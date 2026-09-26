import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = Number(process.env.PORT || 8080);
const SUPABASE_URL=process.env.SUPABASE_URL||'https://gcascgfsogtvgtzjnnhb.supabase.co';
const SUPABASE_SECRET_KEY=process.env.SUPABASE_SECRET_KEY||'';
const SUPABASE_BUCKET=process.env.SUPABASE_BUCKET||'finesse-flow-exports';

function auth(req,res,next){
  const required=process.env.WORKER_TOKEN;
  if(!required) return res.status(503).json({error:'WORKER_TOKEN is not configured'});
  const supplied=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(supplied!==required) return res.status(401).json({error:'Unauthorized'});
  next();
}

function run(cmd,args,cwd){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe']});
    let out='',err=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d);
    p.on('error',reject); p.on('close',code=>code===0?resolve({out,err}):reject(new Error(`${cmd} exited ${code}: ${err.slice(-4000)}`)));
  });
}
async function download(url,dest){
  const r=await fetch(url); if(!r.ok) throw new Error(`Clip download failed ${r.status}`);
  const buf=Buffer.from(await r.arrayBuffer()); if(!buf.length) throw new Error('Downloaded clip is empty');
  await fs.writeFile(dest,buf);
}
function safeText(s=''){return String(s).replaceAll('\\','\\\\').replaceAll(':','\\:').replaceAll("'","\\'");}

app.get('/health', async (_req,res)=>{
  try{const {out}=await run('ffmpeg',['-version']);res.json({ok:true,ffmpeg:out.split('\n')[0]});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/assemble',auth,async(req,res)=>{
  const job=req.body;
  if(!job?.projectId || !Array.isArray(job.clips) || !job.clips.length) return res.status(400).json({error:'Invalid assembly payload'});
  const id=crypto.randomUUID(); const dir=await fs.mkdtemp(path.join(os.tmpdir(),`ff-${id}-`));
  try{
    const clips=[];
    for(let i=0;i<job.clips.length;i++){
      const file=path.join(dir,`clip-${i}.mp4`); await download(job.clips[i].url,file); clips.push(file);
    }
    const normalized=[];
    const portrait=job.canvas==='9:16'; const square=job.canvas==='1:1';
    const size=portrait?'720:1280':square?'1080:1080':'1280:720';
    for(let i=0;i<clips.length;i++){
      const file=path.join(dir,`norm-${i}.mp4`);
      await run('ffmpeg',['-y','-i',clips[i],'-vf',`scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2:black,fps=30`,'-an','-c:v','libx264','-preset','veryfast','-crf','20',file],dir);
      normalized.push(file);
    }
    const list=path.join(dir,'concat.txt');
    await fs.writeFile(list,normalized.map(f=>`file '${f.replaceAll("'","'\\''")}'`).join('\n'));
    const joined=path.join(dir,'joined.mp4');
    await run('ffmpeg',['-y','-f','concat','-safe','0','-i',list,'-c','copy',joined],dir);
    const final=path.join(dir,'final.mp4');
    const website=safeText(job.branding?.website||'ShopHouseOfFinesse.com');
    const end=Math.max(1,Number(job.edit?.endCardSeconds||2));
    const filter=`drawtext=text='HOUSE OF FINESSE':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h-150:enable='gte(t,duration-${end})',drawtext=text='${website}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=h-95:enable='gte(t,duration-${end})'`;
    // drawtext may be unavailable in some FFmpeg builds; fall back to clean joined video.
    try{await run('ffmpeg',['-y','-i',joined,'-vf',filter,'-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-movflags','+faststart',final],dir);}
    catch{await fs.copyFile(joined,final);}
    const bytes=(await fs.stat(final)).size;
    if(!SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEY is not configured');
    const supabase=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const objectPath=`projects/${job.projectId}/${Date.now()}-final.mp4`;
    const fileBuffer=await fs.readFile(final);
    const {error:uploadError}=await supabase.storage.from(SUPABASE_BUCKET).upload(objectPath,fileBuffer,{contentType:'video/mp4',upsert:false});
    if(uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);
    const {data:publicData}=supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
    const finalVideoUrl=publicData.publicUrl;
    if(!finalVideoUrl) throw new Error('Supabase did not return a public video URL');
    const callbackBase=(process.env.FINESSE_FLOW_CALLBACK_BASE||'').replace(/\/$/,'');
    if(callbackBase){
      const headers={'content-type':'application/json'};
      if(process.env.FINESSE_FLOW_CALLBACK_TOKEN) headers.authorization=`Bearer ${process.env.FINESSE_FLOW_CALLBACK_TOKEN}`;
      const callback=await fetch(`${callbackBase}/api/jobs/${encodeURIComponent(job.projectId)}/assembly-complete`,{method:'POST',headers,body:JSON.stringify({finalVideoUrl})});
      if(!callback.ok) throw new Error(`Finesse Flow callback failed ${callback.status}: ${(await callback.text()).slice(0,500)}`);
    }
    const result={jobId:id,projectId:job.projectId,status:'COMPLETED',bytes,objectPath,finalVideoUrl};
    res.status(200).json(result);
  }catch(e){res.status(500).json({error:e.message});}
  finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
});

app.listen(PORT,()=>console.log(`Finesse Flow media worker listening on ${PORT}`));
