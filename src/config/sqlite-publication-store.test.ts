import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{afterEach,describe,expect,it}from'vitest';
import{createNullLogger}from'../core/logger.js';import{SqliteStorage}from'../storage/sqlite.js';
import{ConfigPublicationStateMachine}from'./publication-state.js';
import{PUBLICATION_STATE_KEY_PREFIX,SqlitePublicationStateStore}from'./sqlite-publication-store.js';

let root='';afterEach(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});root='';});
async function fileDb(){root=await fs.mkdtemp(path.join(os.tmpdir(),'moho-pub-state-'));const storage=new SqliteStorage({path:path.join(root,'pub.sqlite'),logger:createNullLogger()});await storage.init();return storage;}

describe('SqlitePublicationStateStore',()=>{
 it('recovers records, ACKs, pending rollout and rollback history after restart',async()=>{
  const storage=await fileDb();
  const first=new SqlitePublicationStateStore({storage,logger:createNullLogger()});await first.init();
  const m=new ConfigPublicationStateMachine(first,()=>10);
  await m.publish({expectedRevision:0,payload:{v:1},actor:'admin'});
  const p=await m.publish({expectedRevision:1,payload:{v:2},actor:'admin',rollout:{quorum:2,timeoutMs:1000}});
  expect(p.ok).toBe(true);if(!p.ok)return;
  const digest=p.snapshot.pending!.digest;
  await m.acknowledge({scope:'global',revision:2,nodeId:'n1',digest,outcome:'ack',actor:'n1'});
  await storage.close();

  const storage2=new SqliteStorage({path:path.join(root,'pub.sqlite'),logger:createNullLogger()});await storage2.init();
  const second=new SqlitePublicationStateStore({storage:storage2,logger:createNullLogger()});await second.init();
  const m2=new ConfigPublicationStateMachine(second,()=>10);
  expect((await m2.history()).map(r=>r.revision)).toEqual([2,1]);
  const snap=await m2.get();
  expect(snap.state.pendingRevision).toBe(2);expect(snap.state.activeRevision).toBe(1);
  expect(snap.acknowledgements.map(a=>a.nodeId)).toEqual(['n1']);
  // rollout continues across the restart and reaches activation
  const done=await m2.acknowledge({scope:'global',revision:2,nodeId:'n2',digest,outcome:'ack',actor:'n2'});
  expect(done.ok&&done.snapshot.state.activeRevision).toBe(2);
  // manual rollback creates a new revision and survives another restart
  if(!done.ok)return;
  const rb=await m2.rollback({scope:'global',expectedStateVersion:done.snapshot.state.stateVersion,actor:'admin',reason:'bad config'});
  expect(rb.ok&&rb.snapshot.state.activeRevision).toBe(3);
  await storage2.close();

  const storage3=new SqliteStorage({path:path.join(root,'pub.sqlite'),logger:createNullLogger()});await storage3.init();
  const third=new SqlitePublicationStateStore({storage:storage3,logger:createNullLogger()});await third.init();
  const m3=new ConfigPublicationStateMachine(third,()=>10);
  const restored=await m3.get();
  expect(restored.state.activeRevision).toBe(3);expect(restored.active?.sourceRevision).toBe(1);
  expect((await third.transitions('global')).some(t=>t.kind==='rolled_back'&&t.detail==='bad config')).toBe(true);
  expect(restored.active?.payload).toEqual({v:1});
  await storage3.close();
 });

 it('keeps scopes isolated and lists persisted scopes',async()=>{
  const storage=await fileDb();
  const store=new SqlitePublicationStateStore({storage,logger:createNullLogger()});await store.init();
  const m=new ConfigPublicationStateMachine(store,()=>5);
  await m.publish({scope:'bots-alpha',expectedRevision:0,payload:{a:1},actor:'x'});
  await m.publish({scope:'bots-beta',expectedRevision:0,payload:{b:1},actor:'x'});
  expect((await store.scopes()).sort()).toEqual(['bots-alpha','bots-beta']);
  expect((await m.get('bots-alpha')).state.activeRevision).toBe(1);
  expect((await m.get('bots-beta')).state.activeRevision).toBe(1);
  await storage.close();
 });

 it('skips corrupt persisted scope rows instead of failing boot',async()=>{
  const storage=await fileDb();
  await storage.save(PUBLICATION_STATE_KEY_PREFIX+'global','not-an-object');
  const store=new SqlitePublicationStateStore({storage,logger:createNullLogger()});
  await expect(store.init()).resolves.toBeUndefined();
  expect(await store.scopes()).toEqual([]);
  await storage.close();
 });
});
