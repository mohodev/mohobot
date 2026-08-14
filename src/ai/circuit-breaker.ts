export type CircuitState='closed'|'open'|'half-open';
export interface CircuitOptions{failureThreshold?:number;openMs?:number;now?:()=>number;}
export interface CircuitSnapshot{state:CircuitState;consecutiveFailures:number;openedAt?:number;retryAt?:number;lastSuccessAt?:number;lastFailureAt?:number;lastFailureKind?:string;}
export class CircuitOpenError extends Error{constructor(){super('provider circuit is open');this.name='CircuitOpenError';}}
export class CircuitBreaker{
 readonly #threshold:number;readonly #openMs:number;readonly #now:()=>number;#state:CircuitState='closed';#failures=0;#openedAt?:number;#lastSuccessAt?:number;#lastFailureAt?:number;#lastFailureKind?:string;#halfOpenBusy=false;
 constructor(options:CircuitOptions={}){this.#threshold=options.failureThreshold??3;this.#openMs=options.openMs??30_000;this.#now=options.now??Date.now;if(!Number.isInteger(this.#threshold)||this.#threshold<1)throw new Error('failureThreshold must be positive');if(!Number.isFinite(this.#openMs)||this.#openMs<1)throw new Error('openMs must be positive');}
 acquire():boolean{if(this.#state==='open'){if(this.#now()-(this.#openedAt??0)<this.#openMs)return false;this.#state='half-open';}if(this.#state==='half-open'){if(this.#halfOpenBusy)return false;this.#halfOpenBusy=true;}return true;}
 success():void{this.#state='closed';this.#failures=0;this.#halfOpenBusy=false;this.#lastSuccessAt=this.#now();}
 failure(kind:string):void{this.#lastFailureAt=this.#now();this.#lastFailureKind=kind;this.#halfOpenBusy=false;this.#failures+=1;if(this.#state==='half-open'||this.#failures>=this.#threshold){this.#state='open';this.#openedAt=this.#now();}}
 release():void{if(this.#state==='half-open')this.#halfOpenBusy=false;}
 snapshot():CircuitSnapshot{return{state:this.#state,consecutiveFailures:this.#failures,...(this.#openedAt!==undefined?{openedAt:this.#openedAt,retryAt:this.#openedAt+this.#openMs}:{}),...(this.#lastSuccessAt!==undefined?{lastSuccessAt:this.#lastSuccessAt}:{}),...(this.#lastFailureAt!==undefined?{lastFailureAt:this.#lastFailureAt}:{}),...(this.#lastFailureKind?{lastFailureKind:this.#lastFailureKind}:{})};}
}
