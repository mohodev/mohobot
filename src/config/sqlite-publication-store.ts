import type{Logger}from'../core/logger.js';
import type{Storage}from'../storage/types.js';
import{InMemoryPublicationStateStore,type AckInput,type PublicationMutation,type PublicationPersistedScope,type ProposeInput,type PublicationStateStore,type RollbackInput}from'./publication-state.js';

/** KV prefix for one persisted publication state row per scope: `config-publication:<scope>`. */
export const PUBLICATION_STATE_KEY_PREFIX='config-publication:';

export interface SqlitePublicationStateStoreOptions{storage:Storage;logger?:Logger}

/**
 * Persistent publication state store: the full state machine semantics stay in
 * InMemoryPublicationStateStore; this wrapper hydrates from SQLite at init and
 * persists the affected scope after every successful mutation. Restart keeps
 * records, ACKs, pending rollouts and rollback history.
 */
export class SqlitePublicationStateStore implements PublicationStateStore{
 readonly #inner=new InMemoryPublicationStateStore();
 readonly #storage:Storage;readonly #log:Logger|undefined;
 constructor(opts:SqlitePublicationStateStoreOptions){this.#storage=opts.storage;this.#log=opts.logger;}
 async init(){await this.#inner.init();const rows=await this.#storage.query<unknown>({prefix:PUBLICATION_STATE_KEY_PREFIX});for(const row of rows){try{this.#inner.restore(row.value)}catch(error){this.#log?.warn({key:row.key,err:error instanceof Error?error.message:String(error)},'skipping unreadable persisted publication scope')}}}
 async #persist(scope:string){await this.#storage.save(PUBLICATION_STATE_KEY_PREFIX+scope,this.#inner.exportScope(scope) as PublicationPersistedScope)}
 async snapshot<T=unknown>(scope:string){return this.#inner.snapshot<T>(scope)}
 async history<T=unknown>(scope:string,limit?:number){return this.#inner.history<T>(scope,limit)}
 async transitions(scope:string,limit?:number){return this.#inner.transitions(scope,limit)}
 async scopes(){return this.#inner.scopes()}
 async propose<T>(input:ProposeInput<T>):Promise<PublicationMutation<T>>{const result=await this.#inner.propose(input);await this.#persist((result.ok?result.snapshot:result.conflict).state.scope);return result}
 async acknowledge(input:AckInput){const result=await this.#inner.acknowledge(input);await this.#persist((result.ok?result.snapshot:result.conflict).state.scope);return result}
 async expire(scope:string,now:number,actor:string){const result=await this.#inner.expire(scope,now,actor);await this.#persist((result.ok?result.snapshot:result.conflict).state.scope);return result}
 async rollback(input:RollbackInput){const result=await this.#inner.rollback(input);await this.#persist((result.ok?result.snapshot:result.conflict).state.scope);return result}
}
