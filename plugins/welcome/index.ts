/**
 * welcome - greet new guild members.
 *
 * Foreign, platform-native replacement for the upstream welcome plugin
 * (QQ 新好友/新入群 welcome): subscribes to the `guild:member:join` Moho event
 * and posts a configurable welcome message to a fixed channel.
 *
 * Placeholders in the message template: {user} (mention), {username},
 * {count} (member count after the join).
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import type { MohoMemberJoin } from '../../src/core/types.js';

let ctx: PluginContext | undefined;
let off: (() => void) | undefined;

export function renderWelcome(template: string, event: MohoMemberJoin): string {
  return template
    .replaceAll('{user}', `<@${event.userId}>`)
    .replaceAll('{username}', event.username)
    .replaceAll('{count}', String(event.memberCount ?? 0));
}

const plugin: Plugin = {
  name: 'welcome',

  onLoad(context) {
    ctx = context;
    const channelId = typeof context.config['channelId'] === 'string' ? context.config['channelId'] : '';
    const message = typeof context.config['message'] === 'string' ? context.config['message'] : '欢迎 {user} 加入！';
    const enabled = context.config['enabled'] !== false;

    off = context.events.on('guild:member:join', (event) => {
      if (!enabled || !channelId || event.botId !== context.botConfig.id) return;
      void context.send({
        channelId,
        content: renderWelcome(message, event),
        suppressMentions: false,
        mentionUserId: event.userId,
      }).catch(() => {});
    });

    context.logger.info({ channelId: channelId || '(unset)' }, 'welcome plugin ready');
  },

  onUnload() {
    off?.();
    off = undefined;
    ctx = undefined;
  },
};

export default plugin;
