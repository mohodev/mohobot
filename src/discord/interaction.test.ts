import { describe, expect, it } from 'vitest';
import { decideSocially } from '../pipeline/social-decision.js';
import type { MohoMessage } from '../core/types.js';
const m=(content:string,dm=false):MohoMessage=>({id:'1',platform:'discord',botId:'b',channel:{id:'c',dm},author:{id:'u',username:'u',bot:false},content,mentionsBot:dm,attachments:[],createdAt:0});
describe('interaction-era persona behavior',()=>{it('device delay suppresses ordinary group observations but never an explicit direct request',()=>{expect(decideSocially(m('随便聊聊'),{recentReplies:0,energy:.8,stress:.1,deviceDelay:true}).action).toBe('ignore');expect(decideSocially(m('在吗',true),{recentReplies:0,energy:.8,stress:.1,deviceDelay:true}).action).toBe('reply');expect(decideSocially(m('救命怎么办',true),{recentReplies:0,energy:.8,stress:.1,deviceDelay:true}).action).toBe('reply');});});
