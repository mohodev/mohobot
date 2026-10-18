import type{Logger}from'../core/logger.js';
import type{Storage}from'../storage/types.js';
import type{PublicationSnapshot}from'./publication-state.js';
import{validScope}from'./publication-state.js';

/**
 * KV prefix for the persisted activation receipts of one scope:
 * `config-activation-receipt:<scope>`.
 */
export const ACTIVATION_RECEIPT_KEY_PREFIX='config-activation-receipt:';

/**
 * Proof that a published revision was actually applied by the runtime, not
 * merely recorded. Carries only revision/digest metadata — never the payload —
 * so config secrets cannot leak through the receipt plane.
 */
export interface ActivationReceipt{scope:string;revision:number;digest:string;activatedAt:number;actor:string;sourceRevision?:number;detail?:string}

export interface ActivationReceiptOptions{storage?:Storage;logger?:Logger}
export interface ActivationReceiptRecordInput{actor:string;now:number;detail?:string}

export interface ActivationEffectiveStatus{scope:string;activeRevision?:number;receipt?:ActivationReceipt;effective:boolean}

function validate(receipt:unknown,key:string):ActivationReceipt|undefined{
  if(!receipt||typeof receipt!=='object')return undefined;
  const r=receipt as Partial<ActivationReceipt>;
  if(typeof r.revision!=='number'||!Number.isSafeInteger(r.revision)||r.revision<1)throw new Error(`invalid activation receipt under ${key}`);
  const revision=r.revision;
  if(typeof r.scope!=='string'||typeof r.digest!=='string'||!r.digest||typeof r.activatedAt!=='number'||typeof r.actor!=='string'){
    throw new Error(`invalid activation receipt under ${key}`);
  }
  return{scope:r.scope,revision,digest:r.digest,activatedAt:r.activatedAt,actor:r.actor,...(typeof r.sourceRevision==='number'?{sourceRevision:r.sourceRevision}:{}),...(typeof r.detail==='string'?{detail:r.detail}:{})};
}

/**
 * Activation receipts distinguish "published" (a revision became active in the
 * publication state machine) from "actually effective" (the runtime confirmed
 * it applied that exact revision). Receipts are idempotent per
 * scope+revision+digest; a digest conflict is refused instead of overwritten.
 */
export class ActivationReceiptLedger{
  readonly #receipts=new Map<string,ActivationReceipt[]>();
  readonly #storage:Storage|undefined;
  readonly #log:Logger|undefined;
  #tail=Promise.resolve();

  constructor(opts:ActivationReceiptOptions={}){
    this.#storage=opts.storage;
    this.#log=opts.logger;
  }

  async init():Promise<void>{
    if(!this.#storage)return;
    const rows=await this.#storage.query<unknown>({prefix:ACTIVATION_RECEIPT_KEY_PREFIX});
    for(const row of rows){
      try{
        const raw=Array.isArray(row.value)?row.value:[row.value];
        const receipts=raw.map(r=>validate(r,row.key)).filter((r):r is ActivationReceipt=>r!==undefined);
        const scope=validScope(row.key.slice(ACTIVATION_RECEIPT_KEY_PREFIX.length));
        const known=new Map<number,ActivationReceipt>();
        for(const receipt of receipts){
          if(receipt.scope!==scope)throw new Error(`activation receipt scope mismatch under ${row.key}`);
          known.set(receipt.revision,receipt);
        }
        this.#receipts.set(scope,[...known.values()]);
      }catch(error){
        this.#log?.warn({key:row.key,err:error instanceof Error?error.message:String(error)},'skipping unreadable activation receipts');
      }
    }
  }

  /** Record (or return the existing) receipt for the currently active revision of `snapshot`. */
  async recordFromSnapshot<T>(snapshot:PublicationSnapshot<T>,input:ActivationReceiptRecordInput):Promise<ActivationReceipt>{
    const scope=validScope(snapshot.state.scope);
    return this.#serialize(()=>{
      const active=snapshot.active;
      if(!active)throw new Error('no active config revision to acknowledge as effective');
      if(snapshot.state.activeRevision!==active.revision)throw new Error('activation receipt snapshot is inconsistent');
      const existing=this.#find(scope,active.revision);
      if(existing){
        if(existing.digest!==active.digest)throw new Error(`activation receipt digest conflict for ${scope} revision ${active.revision}`);
        return existing;
      }
      const receipt:ActivationReceipt={scope,revision:active.revision,digest:active.digest,activatedAt:input.now,actor:input.actor,...(typeof active.sourceRevision==='number'?{sourceRevision:active.sourceRevision}:{}),...(input.detail!==undefined?{detail:input.detail}:{})};
      this.#receipts.set(scope,[...this.#receipts.get(scope)??[],receipt]);
      return receipt;
    },async()=>{
      await this.#persist(scope);
    });
  }

  async latest(scope:string):Promise<ActivationReceipt|undefined>{
    return this.#serialize(()=>[...this.#receipts.get(validScope(scope))??[]].sort((a,b)=>b.activatedAt-a.activatedAt||b.revision-a.revision)[0]);
  }

  async forRevision(scope:string,revision:number):Promise<ActivationReceipt|undefined>{
    return this.#serialize(()=>this.#find(validScope(scope),revision));
  }

  async list(scope?:string):Promise<ActivationReceipt[]>{
    return this.#serialize(()=>{
      const items=scope===undefined?[...this.#receipts.values()].flat():[...this.#receipts.get(validScope(scope))??[]];
      return items.sort((a,b)=>b.activatedAt-a.activatedAt||b.revision-a.revision||a.scope.localeCompare(b.scope));
    });
  }

  /** Whether the snapshot's active revision has a matching receipt on record. */
  async status<T>(scope:string,snapshot:PublicationSnapshot<T>):Promise<ActivationEffectiveStatus>{
    const active=snapshot.state.activeRevision;
    const receipt=active===undefined?undefined:await this.forRevision(scope,active);
    return{scope:validScope(scope),...(active!==undefined?{activeRevision:active}:{}),...(receipt?{receipt}:{}),effective:active!==undefined&&receipt!==undefined&&receipt.digest===snapshot.active?.digest};
  }

  #find(scope:string,revision:number){return this.#receipts.get(scope)?.find(r=>r.revision===revision)}

  async #serialize<T>(f:()=>T,after?:(value:T)=>Promise<void>):Promise<T>{
    const previous=this.#tail;
    let release!:()=>void;
    this.#tail=new Promise<void>(resolve=>release=resolve);
    await previous;
    try{
      const value=f();
      await after?.(value);
      return value;
    }finally{
      release();
    }
  }

  async #persist(scope:string):Promise<void>{
    if(!this.#storage)return;
    await this.#storage.save(ACTIVATION_RECEIPT_KEY_PREFIX+scope,this.#receipts.get(scope)??[]);
  }
}
