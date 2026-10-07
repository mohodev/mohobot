/**
 * ACP server entry point.
 *
 * Reads configuration from environment variables and starts the ACP server.
 * Designed to be spawned by an ACP-compatible editor as a subprocess.
 *
 * Environment variables:
 *   MOHO_ROOT       - Project root (defaults to cwd)
 *   AI_API_KEY      - Provider API key
 *   AI_BASE_URL     - Provider base URL
 *   AI_MODEL        - Provider model name
 *   ACP_AGENT_NAME  - Agent name shown in editors (default: MohoBot)
 *   ACP_AGENT_VERSION - Agent version (default: 1.0.0)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from '../ai/index.js';
import { createLogger } from '../core/logger.js';
import { AcpServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = process.env.MOHO_ROOT ?? process.cwd();

const logger = createLogger({ name: 'mohobot-acp', level: 'info' });

async function main(): Promise<void> {
  // Build a minimal AIConfig from environment
  const aiConfig = {
    provider: process.env.AI_PROVIDER ?? 'openai-compatible',
    model: process.env.AI_MODEL ?? 'deepseek-chat',
    apiKey: process.env.AI_API_KEY ?? '',
    baseUrl: process.env.AI_BASE_URL ?? 'https://api.deepseek.com/v1',
    temperature: 0.7,
    maxTokens: 0,
    timeoutMs: 60_000,
    retries: 2,
    retryBaseDelayMs: 500,
    stream: true,
    fallbackReply: '',
    options: {},
  };

  const provider = createProvider(aiConfig, { logger, botId: 'acp' });

  const server = new AcpServer({
    provider,
    logger,
    agentName: process.env.ACP_AGENT_NAME ?? 'MohoBot',
    agentVersion: process.env.ACP_AGENT_VERSION ?? '1.0.0',
  });

  logger.info({ rootDir, model: aiConfig.model }, 'ACP server starting');
  await server.start();
}

main().catch((error: unknown) => {
  console.error('ACP server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
