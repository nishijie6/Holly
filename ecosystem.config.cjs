// PM2 process supervision for Holly. Bare `node --import tsx main.ts` in a
// terminal has no supervisor: a crash just stops the bot, and stdout/stderr
// go to whatever tty launched it (recovered from that the hard way once —
// see logs/stdout-*.log). PM2 gives it auto-restart on crash and durable logs.
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "holly",
      script: "main.ts",
      interpreter: "node",
      interpreter_args: "--env-file-if-exists=.env --import tsx",
      cwd: __dirname,
      env: {
        NODE_USE_ENV_PROXY: "1",
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 3000,
      // flushContextAndExit (main.ts) writes conversation-context.json on
      // SIGTERM before exiting; give it real headroom over PM2's 1.6s default.
      kill_timeout: 8000,
      out_file: path.join(__dirname, "logs", "pm2-out.log"),
      error_file: path.join(__dirname, "logs", "pm2-error.log"),
      time: true,
      merge_logs: true,
    },
  ],
};
