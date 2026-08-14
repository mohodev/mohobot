import type{AdminPrincipal}from'../admin/rbac.js';import{ConfigPublicationStateMachine,type PublicationOutcome,type PublicationRollout}from'./publication-state.js';
/** Thin control-plane adapter; actor identity always comes from the authenticated principal. */
export class ConfigPublicationAdminAdapter{
 constructor(readonly machine:ConfigPublicationStateMachine){}
 async get(scope='global'){await this.machine.reconcile(scope);return{snapshot:await this.machine.get(scope),history:await this.machine.history(scope,50),transitions:await this.machine.transitions(scope,100)}}
 publish(input:Record<string,unknown>,principal:AdminPrincipal){return this.machine.publish({scope:typeof input.scope==='string'?input.scope:'global',expectedRevision:Number(input.expectedRevision),expectedStateVersion:input.expectedStateVersion===undefined?undefined:Number(input.expectedStateVersion),payload:input.payload,payloadSchemaVersion:input.payloadSchemaVersion===undefined?undefined:Number(input.payloadSchemaVersion),actor:principal.id,rollout:input.rollout as PublicationRollout|undefined})}
 acknowledge(input:{scope?:string;revision:number;nodeId:string;digest:string;outcome:PublicationOutcome;detail?:string},principal:AdminPrincipal){return this.machine.acknowledge({scope:input.scope??'global',revision:input.revision,nodeId:input.nodeId,digest:input.digest,outcome:input.outcome,detail:input.detail,actor:principal.id})}
 rollback(input:{scope?:string;expectedStateVersion:number;toRevision?:number;reason?:string},principal:AdminPrincipal){return this.machine.rollback({scope:input.scope??'global',expectedStateVersion:input.expectedStateVersion,toRevision:input.toRevision,reason:input.reason,actor:principal.id})}
}
