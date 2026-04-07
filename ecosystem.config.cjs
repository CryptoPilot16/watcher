module.exports = {
  apps: [
    {
      name: 'clawnux-watcher-web',
      cwd: '/opt/watcher',
      env_file: '/opt/watcher/.env.local',
      script: 'npm',
      args: 'run start -- --hostname 127.0.0.1 --port 3012',
      env: {
        NODE_ENV: 'production',
        PORT: '3012',
      },
    },
    {
      name: 'clawnux-watcher-telegram',
      cwd: '/opt/watcher',
      env_file: '/opt/watcher/.env.local',
      script: 'npm',
      args: 'run telegram:loop',
      env: {
        NODE_ENV: 'production',
        WATCH_URL: 'http://127.0.0.1:3012',
        WATCH_TELEGRAM_INTERVAL_MS: '60000',
      },
    },
  ],
};
