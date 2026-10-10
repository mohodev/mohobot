/**
 * Bilibili link unfurler.
 *
 * Discord-native port of upstream's bilibiliparse plugin: when a message
 * carries a Bilibili video link (or a bare BV/av id), reply once with the
 * title, author, duration and link. Uses the public view API, which needs no
 * key; anything goes wrong the hook stays silent and the pipeline continues.
 *
 * Differences from upstream: no multi-bot dedupe needed here (single bot per
 * runtime), no image card (Discord unfurls the link itself), plain-text card.
 */

import type { Plugin } from '../../src/plugins/types.js';
import type { MohoMessage } from '../../src/core/types.js';

const BVID_PATTERN = /BV[a-zA-Z0-9]{10}/;
const AVID_PATTERN = /av(\d{5,15})/i;
const URL_PATTERN = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]{10}|av\d{5,15})/i;

export interface BilibiliVideo {
  bvid: string;
  aid: number;
  title: string;
  author: string;
  durationSeconds: number;
}

export function extractVideoRef(text: string): { bvid?: string; aid?: number } | null {
  const url = text.match(URL_PATTERN);
  if (url) {
    const ref = url[1]!;
    return ref.toLowerCase().startsWith('bv') ? { bvid: ref } : { aid: Number(ref.slice(2)) };
  }
  const bvid = text.match(BVID_PATTERN);
  if (bvid) return { bvid: bvid[0] };
  const avid = text.match(AVID_PATTERN);
  if (avid) return { aid: Number(avid[1]) };
  return null;
}

export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatVideo(video: BilibiliVideo): string {
  const link = `https://www.bilibili.com/video/${video.bvid}`;
  return [
    '📺 哔哩哔哩视频解析',
    `标题：${video.title}`,
    `作者：${video.author}｜时长：${formatDuration(video.durationSeconds)}`,
    link,
  ].join('\n');
}

export async function fetchVideo(
  ref: { bvid?: string; aid?: number },
  apiUrl = 'https://api.bilibili.com/x/web-interface/view',
  timeoutMs = 8000,
): Promise<BilibiliVideo | null> {
  const params = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${ref.aid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${apiUrl}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MohoBot/1.0)', Referer: 'https://www.bilibili.com/' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { code?: number; data?: { bvid?: string; aid?: number; title?: string; owner?: { name?: string }; duration?: number } };
    if (data?.code !== 0 || !data.data) return null;
    const info = data.data;
    if (!info.bvid || !info.title) return null;
    return {
      bvid: info.bvid,
      aid: info.aid ?? 0,
      title: info.title,
      author: info.owner?.name ?? '未知作者',
      durationSeconds: info.duration ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const plugin: Plugin = {
  name: 'bilibili',
  triggers: [/bilibili\.com\/video\//i, /BV[a-zA-Z0-9]{10}/, /av\d{5,15}/i],

  async onMessage(message: MohoMessage, ctx) {
    if (message.author.bot) return undefined;
    const ref = extractVideoRef(message.content);
    if (!ref) return undefined;
    const apiUrl = typeof ctx.config['apiUrl'] === 'string' && ctx.config['apiUrl'].length > 0
      ? ctx.config['apiUrl']
      : undefined;
    const video = await fetchVideo(ref, apiUrl).catch(() => null);
    if (!video) return undefined;
    return { reply: formatVideo(video) };
  },
};

export default plugin;
