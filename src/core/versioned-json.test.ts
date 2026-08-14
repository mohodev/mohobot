import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FutureJsonVersionError, JsonRevisionConflictError, VersionedJsonStore } from './versioned-json.js';

const roots:string[]=[];
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'moho-json-'));roots.push(root);const file=path.join(root,'state.json');const store=new VersionedJsonStore<{count:number}>({file,defaultValue:()=>({count:0}),normalize:(value)=>{if(!value||typeof value!=='object'||typeof(value as {count?:unknown}).count!=='number')throw new Error('invalid data');return{count:(value as {count:number}).count};}});return{root,file,store};}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});

describe('VersionedJsonStore',()=>{
  it('creates defaults only on ENOENT and returns data',async()=>{const{file,store}=await fixture();expect(await store.get()).toEqual({count:0});expect(JSON.parse(await fs.readFile(file,'utf8'))).toMatchObject({format:'mohobot-json',version:1,revision:1,data:{count:0}});});
  it('does not replace non-ENOENT read failures with defaults',async()=>{const{root}=await fixture();const directory=path.join(root,'directory-state');await fs.mkdir(directory);const store=new VersionedJsonStore({file:directory,defaultValue:()=>({count:0})});await expect(store.get()).rejects.toMatchObject({code:'EISDIR'});expect((await fs.stat(directory)).isDirectory()).toBe(true);});
  it('migrates a legacy bare object once',async()=>{const{file,store}=await fixture();await fs.writeFile(file,JSON.stringify({count:7}));expect(await store.get()).toEqual({count:7});const first=JSON.parse(await fs.readFile(file,'utf8'));expect(first.revision).toBe(1);expect(await store.get()).toEqual({count:7});expect(JSON.parse(await fs.readFile(file,'utf8')).revision).toBe(1);});
  it('preserves corrupt JSON and refuses to overwrite it',async()=>{const{file,store}=await fixture();const raw='{ definitely broken';await fs.writeFile(file,raw);await expect(store.get()).rejects.toBeInstanceOf(SyntaxError);await expect(store.save({count:1})).rejects.toBeInstanceOf(SyntaxError);expect(await fs.readFile(file,'utf8')).toBe(raw);});
  it('preserves malformed envelopes instead of treating them as legacy',async()=>{const{file,store}=await fixture();const raw=JSON.stringify({format:'mohobot-json',version:1,data:{count:8}});await fs.writeFile(file,raw);await expect(store.get()).rejects.toThrow('invalid versioned JSON envelope');expect(await fs.readFile(file,'utf8')).toBe(raw);});
  it('rejects future versions on read and write without changing bytes',async()=>{const{file,store}=await fixture();const raw=JSON.stringify({format:'mohobot-json',version:99,revision:4,data:{count:8}});await fs.writeFile(file,raw);await expect(store.get()).rejects.toBeInstanceOf(FutureJsonVersionError);await expect(store.save({count:9})).rejects.toBeInstanceOf(FutureJsonVersionError);expect(await fs.readFile(file,'utf8')).toBe(raw);});
  it('supports revision CAS',async()=>{const{store}=await fixture();const first=await store.read();await store.save({count:1},first.revision);await expect(store.save({count:2},first.revision)).rejects.toBeInstanceOf(JsonRevisionConflictError);expect(await store.get()).toEqual({count:1});});
  it('serializes concurrent updates across instances without lost writes',async()=>{const{file,store}=await fixture();await store.get();const second=new VersionedJsonStore<{count:number}>({file,defaultValue:()=>({count:0})});await Promise.all(Array.from({length:40},(_,i)=>(i%2?store:second).update(value=>({count:value.count+1}))));const envelope=await store.read();expect(envelope.data.count).toBe(40);expect(envelope.revision).toBe(41);expect((await fs.readdir(path.dirname(file))).filter(name=>name.endsWith('.tmp'))).toEqual([]);});
});
