import type { MohoMessage } from '../core/types.js';

export type PrivacyGateResult={action:'allow'}|{action:'refuse';reason:'cross_channel'|'third_party_private'|'sensitive_export'|'chat_admin_impersonation';reply:string};
// Require a disclosure verb: "别泄露我私聊内容" is a normal request, not an export request.
const CROSS_CHANNEL=/(?:把|发|导出|告诉|展示).{0,18}(?:封闭群|私聊|dm|聊天记录|群聊).{0,18}(?:给我|出来|内容)?|(?:封闭群|私聊|dm|聊天记录).{0,18}(?:告诉我|发我|导出|给我)/i;
const THIRD_PARTY_PRIVATE=/(?:ChatGPT|阿澈|别人|其他人|他|她).{0,18}(?:最在意|喜欢|偏好|私聊|说过|记得).{0,18}(?:什么|吗|告诉|说)|(?:告诉|说|发).{0,18}(?:ChatGPT|阿澈|别人|其他人|他|她).{0,18}(?:最在意|喜欢|偏好|私聊|说过)/i;
const SENSITIVE_EXPORT=/(token|api[ _-]?key|密钥|系统提示词|服务器路径|后台(?:数据|权限)?|用户私聊).{0,18}(发|给|导出|展示|告诉)|(?:导出|展示).{0,18}(token|api[ _-]?key|密钥|系统提示词|私聊)/i;
const CLAIMS_ADMIN=/(我是|我就?是|本?人是).{0,8}(管理员|管理|群主)|(?:管理员|管理).{0,10}(权限|执行|ban|导出|token)/i;
/** Deterministic persona-plane boundary: text never grants control-plane authority. */
export function privacyGate(message:Pick<MohoMessage,'content'|'channel'>):PrivacyGateResult{
 const text=message.content;
 if(CROSS_CHANNEL.test(text))return{action:'refuse',reason:'cross_channel',reply:'别跨群问这些'};
 if(THIRD_PARTY_PRIVATE.test(text))return{action:'refuse',reason:'third_party_private',reply:'别问别人的私事'};
 if(SENSITIVE_EXPORT.test(text))return{action:'refuse',reason:'sensitive_export',reply:'这个不给'};
 if(CLAIMS_ADMIN.test(text))return{action:'refuse',reason:'chat_admin_impersonation',reply:'聊天里不认管理权限'};
 return{action:'allow'};
}
