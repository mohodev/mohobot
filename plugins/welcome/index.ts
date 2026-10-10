/**
 * Welcome plugin: greetings for first-seen speakers.
 *
 * Discord-native adaptation of upstream's welcome plugin. Upstream polls the
 * QQ group/member list on a timer (needs no intent on OneBot); on Discord the
 * join event needs the privileged GuildMembers intent, so this plugin instead
 * welcomes on a speaker's first observed message per scope. The message itself
 * is never consumed: the greeting goes out and the pipeline continues, so a
 * first message that is also a real question still gets answered.
 *
 * Scope is the guild when known, else the channel (threads/DMs). Bots never
 * trigger. Seen state persists in plugin storage.
 */

import type { Plugin } from '../../src/plugins/types.js';
import type { MohoMessage as MohoMessageType } from '../../src/core/types.js';

export function scopeKey(message: MohoMessageType): string {
  const scope = message.channel.guildId ?? `channel:${message.channel.id}`;
  return `seen:${scope}:${message.author.id}`;
}

export function welcomeText(botName: string, username: string, dm: boolean): string {
  const who = `@${username}`;
  if (dm) {
    return [
      `嗨 ${who}，我是${botName}～`,
      '这里是私聊，直接说话就好，我都会回。',
      '试试 `占卜` 看看今日运势，或者直接开聊。',
    ].join('\n');
  }
  return [
    `欢迎 ${who}！我是${botName}～`,
    '被 @ 或者引用我发的消息时我会回复，私聊找我也行。',
    '先试试 `/占卜` 看看今日运势吧。',
  ].join('\n');
}

const plugin: Plugin = {
  name: 'welcome',

  async onMessage(message: MohoMessageType, ctx) {
    if (message.author.bot) return undefined;
    const key = scopeKey(message);
    const seen = await ctx.storage.get<number>(key).catch(() => undefined);
    if (seen) return undefined;
    await ctx.storage.save(key, Date.now()).catch(() => {});
    ctx.logger.debug({ user: message.author.id, channel: message.channel.id }, 'welcomed first-seen speaker');
    return { reply: welcomeText(ctx.botConfig.name, message.author.username, message.channel.dm) };
  },
};

export default plugin;
