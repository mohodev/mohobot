import type { SessionConfig } from '../config/schema.js';
import type { MohoMessage, MohoMessageLocation } from '../core/types.js';

export function effectiveSessionChannelId(config: Pick<SessionConfig, 'threadContext' | 'forumContext'>, message: Pick<MohoMessage, 'channel'>): string {
  const location = message.channel.location;
  if (!location?.parentChannelId) return message.channel.id;
  if (location.kind === 'thread' && config.threadContext === 'inherit-parent') return location.parentChannelId;
  if (location.kind === 'forum-post' && config.forumContext === 'inherit-parent') return location.parentChannelId;
  return message.channel.id;
}

export function lifecycleUsesParent(config: Pick<SessionConfig, 'threadContext' | 'forumContext'>, event: { forumPost: boolean }): boolean {
  return event.forumPost ? config.forumContext === 'inherit-parent' : config.threadContext === 'inherit-parent';
}

export function locationAllowed(allowedChannels: readonly string[], location: Pick<MohoMessageLocation, 'channelId' | 'parentChannelId'>): boolean {
  return allowedChannels.length === 0 || allowedChannels.includes(location.channelId) || Boolean(location.parentChannelId && allowedChannels.includes(location.parentChannelId));
}
