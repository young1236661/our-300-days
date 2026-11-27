let detector;
self.onmessage=async ({data})=>{
  if(data.type==='init'){
    try{const runtime=await import('./runtime.mjs?startup=3');detector=await runtime.createDetector({onDownloaded:()=>self.postMessage({type:'downloaded'})});self.postMessage({type:'ready'});}
    catch(e){self.postMessage({type:'error',message:String(e?.message||e)});}
  }else if(data.type==='frame'){
    try{const result=detector.detectForVideo(data.bitmap,data.time);
      self.postMessage({type:'result',points:result.landmarks[0]||null,time:data.time});
    }catch(e){self.postMessage({type:'error',message:String(e?.message||e)});}
    finally{data.bitmap.close();}
  }else if(data.type==='close'){detector?.close();self.close();}
};
