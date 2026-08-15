import type { MohoMessage } from '../core/types.js';

export type PrivacyGateResult={action:'allow'}|{action:'refuse';reason:'cross_channel'|'sensitive_export'|'chat_admin_impersonation';reply:string};
const CROSS_CHANNEL=/(封闭群|私聊|dm|聊天记录).{0,18}(告诉|发|导出|给我|内容)|(?:把|发).{0,18}(封闭群|私聊|聊天记录).{0,18}(给我|出来)/i;
const SENSITIVE_EXPORT=/(token|api[ _-]?key|密钥|系统提示词|服务器路径|后台(?:数据|权限)?|用户私聊).{0,18}(发|给|导出|展示|告诉)|(?:导出|展示).{0,18}(token|api[ _-]?key|密钥|系统提示词|私聊)/i;
const CLAIMS_ADMIN=/(我是|我就?是|本?人是).{0,8}(管理员|管理|群主)|(?:管理员|管理).{0,10}(权限|执行|ban|导出|token)/i;
/** Deterministic persona-plane boundary: text never grants control-plane authority. */
export function privacyGate(message:Pick<MohoMessage,'content'|'channel'>):PrivacyGateResult{
 const text=message.content;
 if(CROSS_CHANNEL.test(text))return{action:'refuse',reason:'cross_channel',reply:'别跨群问这些'};
 if(SENSITIVE_EXPORT.test(text))return{action:'refuse',reason:'sensitive_export',reply:'这个不给'};
 if(CLAIMS_ADMIN.test(text))return{action:'refuse',reason:'chat_admin_impersonation',reply:'聊天里不认管理权限'};
 return{action:'allow'};
}
