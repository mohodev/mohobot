/**
 * PM2 process definition for MohoBot (resident Discord gateway).
 *
 * Design notes:
 *  - script points straight at tsx's ESM CLI entry (node_modules/tsx/dist/cli.mjs)
 *    and passes src/index.ts as an argument. node runs .mjs natively, so there is
 *    no "unknown file extension" / shebang guessing involved.
 *  - watch is DISABLED on purpose. MohoBot ships its own HotReloader
 *    (config/global.yaml -> hotReload, paths: config + plugins, debounceMs: 300).
 *    Letting pm2 also watch would kill/respawn the process on every edit and drop
 *    the Discord gateway connection. pm2 here is only an OS-level process guard.
 *  - autorestart stays ON: it is complementary to the in-process Supervisor.
 *    Supervisor handles bot-level faults, pm2 handles a real process death.
 *  - instances: 1 / fork mode: a Discord gateway must never be clustered.
 *  - .env is read by the app's own ConfigLoader (rootDir/.env), so DISCORD_TOKEN
 *    and KILO_API_KEY are NOT duplicated here.
 *  - MOHO_ROOT pins the project root absolutely so config discovery never depends
 *    on the pm2 daemon's cwd (which can differ from this app's cwd after a daemon
 *    restart and would otherwise break bot config loading).
 */
module.exports = {
  apps: [
    {
      name: 'mohobot',
      cwd: '/home/workspace/Projects/mohobot',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/index.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,

      // Framework owns hot reload; pm2 must not fight it.
      watch: false,
      ignore_watch: ['node_modules', 'data', 'logs', '.git'],

      // OS-level crash guard.
      autorestart: true,
      max_restarts: 20,
      min_uptime: '20s',
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,

      // Graceful shutdown: global.yaml shutdownTimeoutMs is 10000.
      kill_timeout: 15000,
      listen_timeout: 30000,

      env: {
        MOHO_ADAPTER: 'discord',
        MOHO_ROOT: '/home/workspace/Projects/mohobot',
      },

      time: true,
      merge_logs: true,
      out_file: '/home/workspace/Projects/mohobot/logs/mohobot-out.log',
      error_file: '/home/workspace/Projects/mohobot/logs/mohobot-err.log',
    },
  ],
};
