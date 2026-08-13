export interface MetricSummary { count:number; failures:number; p50Ms:number; p95Ms:number; averageMs:number; }
export class LatencyMetric {
  readonly #samples:number[]=[];#failures=0;
  constructor(readonly maxSamples=1000){}
  record(ms:number,ok=true):void{if(Number.isFinite(ms)&&ms>=0)this.#samples.push(ms);if(this.#samples.length>this.maxSamples)this.#samples.splice(0,this.#samples.length-this.maxSamples);if(!ok)this.#failures+=1;}
  summary():MetricSummary{const sorted=[...this.#samples].sort((a,b)=>a-b);const percentile=(p:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))]!:0;const sum=sorted.reduce((a,b)=>a+b,0);return{count:sorted.length,failures:this.#failures,p50Ms:percentile(.5),p95Ms:percentile(.95),averageMs:sorted.length?Math.round(sum/sorted.length):0};}
}
export class CacheMetric {hits=0;misses=0;hit():void{this.hits+=1;}miss():void{this.misses+=1;}snapshot():{hits:number;misses:number;ratio:number}{const total=this.hits+this.misses;return{hits:this.hits,misses:this.misses,ratio:total?this.hits/total:0};}}
