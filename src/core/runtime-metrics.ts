import { CacheMetric, LatencyMetric } from './metrics.js';

export class RuntimeMetrics {
  readonly ai = new LatencyMetric();
  readonly embedding = new LatencyMetric();
  readonly rerank = new LatencyMetric();
  readonly worldCache = new CacheMetric();
  readonly deviceCache = new CacheMetric();
  snapshot():Record<string,unknown>{return{ai:this.ai.summary(),embedding:this.embedding.summary(),rerank:this.rerank.summary(),cache:{world:this.worldCache.snapshot(),device:this.deviceCache.snapshot()}};}
}
export const runtimeMetrics=new RuntimeMetrics();
