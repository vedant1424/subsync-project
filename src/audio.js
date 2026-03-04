const WORKER_CODE = `
let segs=[],inSpeech=false,speechStart=0,smoothE=0,subGaps=[];
let lastMatchTime = 0;

self.onmessage=function(e){
  if(e.data.type==='init'){subGaps=e.data.subtitleGaps||[];segs=[];inSpeech=false;smoothE=0;return;}
  if(e.data.type==='pcm'){
    const pcm=e.data.data,ts=e.data.ts;
    let en=0; for(let i=0;i<pcm.length;i++) en+=pcm[i]*pcm[i];
    en=Math.sqrt(en/pcm.length);
    smoothE=0.88*smoothE+0.12*en;
    const thr=Math.max(0.012,smoothE*1.9),now=en>thr;
    if(now&&!inSpeech){inSpeech=true;speechStart=ts;}
    else if(!now&&inSpeech){
      inSpeech=false;
      const dur=ts-speechStart;
      if(dur>=0.18){
        segs.push({start:speechStart,end:ts});
        if(segs.length>400)segs.shift();
        if(segs.length>=10)tryMatch();
      }
    }
  }
};

function tryMatch(){
  const nowTime = Date.now();
  if(nowTime - lastMatchTime < 3000) return; // Throttling (Issue 5)
  lastMatchTime = nowTime;

  if(!subGaps.length||segs.length<8)return;
  const ag=[];for(let i=1;i<segs.length;i++)ag.push(segs[i].start-segs[i-1].end);
  const win=Math.min(40,Math.min(ag.length,subGaps.length));
  if(win<6)return;
  const aw=ag.slice(-win);
  let bestCost=Infinity,bestOff=0;
  for(let off=0;off<=subGaps.length-win;off++){
    const r=dtw(aw,subGaps.slice(off,off+win));
    if(r<bestCost){bestCost=r;bestOff=off;}
  }
  const avg=bestCost/win,mr=Math.max(0,1-avg/2);
  const cands=[];
  if(mr>0.6){
    for(let i=0;i<Math.min(6,win);i++){
      const si=segs.length-win+i;
      if(si>=0)cands.push({subGapIndex:bestOff+i,audioTime:(segs[si].start+segs[si].end)/2,source:'auto'});
    }
  }
  self.postMessage({type:'match',confidence:mr,avgRelativeError:avg,bestOffset:bestOff,candidateAnchors:cands});
}

function dtw(a,b){
  try {
    const n=a.length,m=b.length;
    // Increased band (Issue 13)
    const band=Math.max(5,Math.floor(Math.max(n,m)*0.4));
    const INF=1e9;
    const dp=Array.from({length:n+1},()=>new Float32Array(m+1).fill(INF));
    dp[0][0]=0;
    for(let i=1;i<=n;i++){
      for(let j=Math.max(1,i-band);j<=Math.min(m,i+band);j++){
        const c=Math.abs(Math.log((a[i-1]||0.001))-Math.log((b[j-1]||0.001)));
        dp[i][j]=c+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
      }
    }
    if (!isFinite(dp[n][m])) return INF;
    return dp[n][m];
  } catch(e) {
    self.postMessage({type:'error', message: e.toString()});
    return 1e9;
  }
}
`;

export function createWorker() {
  try {
    return new Worker(
      URL.createObjectURL(
        new Blob([WORKER_CODE], { type: "text/javascript" })
      )
    );
  } catch (e) {
    return null;
  }
}

export function initAudioCapture(v, state) {
  if (state.audioCtx) return;

  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = state.audioCtx.createMediaElementSource(v);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 2048;
    src.connect(state.analyser);
    state.analyser.connect(state.audioCtx.destination);

    state.pcmIntervalId = setInterval(() => {
      if (!state.analyser || !state.vadWorker || !state.video || state.video.paused) return;
      const buf = new Float32Array(state.analyser.fftSize);
      state.analyser.getFloatTimeDomainData(buf);
      state.vadWorker.postMessage({
        type: "pcm",
        data: buf,
        ts: state.video.currentTime,
        chunkDuration:
          state.analyser.fftSize / (state.audioCtx.sampleRate || 44100)
      });
    }, 180);
  } catch (e) {
    console.warn("[SubSync] Audio capture failed:", e);
  }
}
