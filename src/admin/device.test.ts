import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import { DeviceStore } from './device.js';
let root = ''; afterEach(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});});
describe('DeviceStore',()=>{it('persists bounded state and derives delay conditions',async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'moho-device-'));const store=new DeviceStore(root);const state=await store.transition({battery:-10,charging:true});expect(state.battery).toBe(0);expect(state.activity).toBe('charging');expect(store.shouldDelay(state)).toBe(true);expect((await new DeviceStore(root).get()).charging).toBe(true);});});
