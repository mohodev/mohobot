import { z } from 'zod';

export const RemoteStorageConfigSchema = z.object({
  mode: z.enum(['local-only','async-mirror','remote-authoritative']).default('local-only'),
  mysql: z.object({ enabled:z.boolean().default(false), urlEnv:z.string().min(1).default('MOHO_MYSQL_URL'), tls:z.boolean().default(true), syncIntervalSeconds:z.number().int().min(5).max(86400).default(60) }).default({}),
  redis: z.object({ enabled:z.boolean().default(false), urlEnv:z.string().min(1).default('MOHO_REDIS_URL'), namespace:z.string().regex(/^[a-zA-Z0-9:_-]+$/).default('mohobot') }).default({}),
  kafka: z.object({ enabled:z.boolean().default(false), brokersEnv:z.string().min(1).default('MOHO_KAFKA_BROKERS') }).default({}),
  worker: z.object({
    pollIntervalMs:z.number().int().positive().default(1000),
    batchSize:z.number().int().positive().max(1000).default(20),
    concurrency:z.number().int().positive().max(100).default(4),
    leaseMs:z.number().int().positive().default(30000),
    retryDelayMs:z.number().int().nonnegative().default(5000),
  }).default({}),
});
export type RemoteStorageConfig=z.infer<typeof RemoteStorageConfigSchema>;

export function remoteReadiness(config:RemoteStorageConfig,env:NodeJS.ProcessEnv=process.env):{ready:boolean;missing:string[]}{
  const missing:string[]=[];
  if(config.mysql.enabled&&!env[config.mysql.urlEnv])missing.push(config.mysql.urlEnv);
  if(config.redis.enabled&&!env[config.redis.urlEnv])missing.push(config.redis.urlEnv);
  if(config.kafka.enabled&&!env[config.kafka.brokersEnv])missing.push(config.kafka.brokersEnv);
  return{ready:missing.length===0,missing};
}
