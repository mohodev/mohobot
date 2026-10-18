import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{afterEach,describe,expect,it}from'vitest';
import{createNullLogger}from'../core/logger.js';import{SqliteStorage}from'../storage/sqlite.js';
import{ActivationReceiptLedger}from'./activation-receipt.js';import{ConfigPublicationStateMachine,InMemoryPublicationStateStore}from'./publication-state.js';

let root='';afterEach(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});root='';});

describe('ActivationReceiptLedger',()=>{
 it('requires an active revision and binds the receipt to its digest',async()=>{
  const ledger=new ActivationReceiptLedger();
  const m=new ConfigPublicationStateMachine(new InMemoryPublicationStateStore,()=>10);
  const empty=await m.get();
  await expect(ledger.recordFromSnapshot(empty,{actor:'runtime',now:1})).rejects.toThrow('no active config revision');
  await m.publish({expectedRevision:0,payload:{secret:'never-stored'},actor:'admin'});
  const snapshot=await m.get();
  const receipt=await ledger.recordFromSnapshot(snapshot,{actor:'runtime',now:10,detail:'boot'});
  expect(receipt).toMatchObject({scope:'global',revision:1,actor:'runtime',detail:'boot'});
  expect(receipt.digest).toBe(snapshot.active!.digest);
  expect('payload' in receipt).toBe(false);
  expect(snapshot.active!.payload).toEqual({secret:'never-stored'});
  // idempotent for the same digest, conflicting digest is refused
  await expect(ledger.recordFromSnapshot(snapshot,{actor:'other',now:11})).resolves.toMatchObject({activatedAt:10});
  const conflicting={...snapshot,active:{...snapshot.active!,digest:'deadbeef'}};
  await expect(ledger.recordFromSnapshot(conflicting,{actor:'other',now:12})).rejects.toThrow('digest conflict');
  const status=await ledger.status('global',snapshot);
  expect(status.effective).toBe(true);expect(status.activeRevision).toBe(1);
 });

 it('distinguishes published-but-not-effective from effective after rollback',async()=>{
  const ledger=new ActivationReceiptLedger();
  const m=new ConfigPublicationStateMachine(new InMemoryPublicationStateStore,()=>10);
  await m.publish({expectedRevision:0,payload:{v:1},actor:'admin'});
  await ledger.recordFromSnapshot(await m.get(),{actor:'runtime',now:10});
  await m.publish({expectedRevision:1,payload:{v:2},actor:'admin'});
  const rolledBack=await m.rollback({scope:'global',expectedStateVersion:(await m.get()).state.stateVersion,actor:'admin',reason:'bad'});
  if(!rolledBack.ok)throw new Error('rollback failed');
  const snapshot=await m.get();
  expect(snapshot.state.activeRevision).toBe(3);
  // published (active) but no receipt yet: not actually effective
  expect((await ledger.status('global',snapshot)).effective).toBe(false);
  await ledger.recordFromSnapshot(snapshot,{actor:'runtime',now:20});
  expect((await ledger.status('global',snapshot)).effective).toBe(true);
  expect((await ledger.list('global')).map(r=>r.revision).sort((a,b)=>a-b)).toEqual([1,3]);
  expect((await ledger.forRevision('global',3))?.sourceRevision).toBe(1);
 });

 it('persists receipts in SQLite and survives restart',async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'moho-receipt-'));
  const file=path.join(root,'receipts.sqlite');
  const storage=new SqliteStorage({path:file,logger:createNullLogger()});await storage.init();
  const m=new ConfigPublicationStateMachine(new InMemoryPublicationStateStore,()=>10);
  await m.publish({expectedRevision:0,payload:{v:1},actor:'admin'});
  const snapshot=await m.get();
  const first=new ActivationReceiptLedger({storage,logger:createNullLogger()});await first.init();
  await first.recordFromSnapshot(snapshot,{actor:'runtime-boot',now:10});
  await storage.close();

  const storage2=new SqliteStorage({path:file,logger:createNullLogger()});await storage2.init();
  const second=new ActivationReceiptLedger({storage:storage2,logger:createNullLogger()});await second.init();
  expect((await second.list()).map(r=>r.revision)).toEqual([1]);
  expect((await second.status('global',snapshot)).effective).toBe(true);
  await storage2.close();
 });

 it('skips corrupt persisted receipt rows instead of failing init',async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'moho-receipt-'));
  const storage=new SqliteStorage({path:path.join(root,'r.sqlite'),logger:createNullLogger()});await storage.init();
  await storage.save('config-activation-receipt:global',[{scope:'global',revision:0}]);
  const ledger=new ActivationReceiptLedger({storage,logger:createNullLogger()});
  await expect(ledger.init()).resolves.toBeUndefined();
  expect(await ledger.list()).toEqual([]);
  await storage.close();
 });
});
