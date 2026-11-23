# Long-poll repair rollout

This change is for the installed plugin on the coordinator computer. It does not touch WeChat credentials, the inbox, or the saved cursor by itself. Deploy it only after the files below are reviewed. A green test run does not mean production is fixed; watch a real quiet period of 30–60 minutes after restart.

## What is safe to keep

Leave these in place:

- `~/.grok-wechat/account.json` (tokens, `getUpdatesBuf`, context tokens)
- `~/.grok-wechat/inbox.jsonl`
- `~/.grok-wechat/wake.json` and any per-account wake copied into `account.json`
- `~/.grok-wechat/media/`
- the webhook SSRF checks in `sendWake` (`lookupWakeAddress`, the public-address block list, `AbortSignal.timeout` on the webhook). Do not replace `server/ilink.js` with a copy that drops those functions.

Do not set `GROK_WECHAT_POLL_BUDGET_MS`, `GROK_WECHAT_RETRY_MS`, `GROK_WECHAT_BACKOFF_MS`, `GROK_WECHAT_EXPIRED_MS`, `GROK_WECHAT_MEDIA_TIMEOUT_MS`, or `GROK_WECHAT_WATCHDOG_SLACK_MS` in production. Those exist so tests can shorten timers.

Do not change proxy environment variables, `NODE_USE_ENV_PROXY`, or `NO_PROXY`. The long poll uses Node's global HTTP agent, which follows the same managed-egress flag as `fetch`.

## Before editing

On the coordinator, from the installed plugin directory:

```sh
PLUGIN=/home/box/grok-wechat-plugin
STATE=${GROK_WECHAT_HOME:-$HOME/.grok-wechat}
mkdir -p /tmp/grok-wechat-pre-longpoll
cp -a "$PLUGIN/server/ilink.js" "$PLUGIN/server/index.js" "$PLUGIN/server/store.js" "$PLUGIN/server/uninstall.js" /tmp/grok-wechat-pre-longpoll/
cp -a "$STATE/account.json" "$STATE/inbox.jsonl" "$STATE/wake.json" /tmp/grok-wechat-pre-longpoll/ 2>/dev/null || true
shasum "$PLUGIN/server/ilink.js" "$PLUGIN/server/index.js"
```

Record the running monitor pid from `$STATE/monitor.pid`. The new code does not load until that process exits.

## Which tree you have

- Fork parent `f1d893fd9bf5bd256f05fac0ef5228539acf4ede` already contains `lookupWakeAddress` and does not auto-uninstall when the connector disappears. Apply this branch's `server/` diff onto that tree.
- An install still based on `5c02e41` plus a local webhook SSRF edit will not take that diff cleanly. `getUpdates` in that base matches the pre-change function, but `runMonitor` and the wake call do not. Do not overwrite `ilink.js` or `index.js`. Copy in `server/bounded-request.js`, then move only the long-poll helpers, `getUpdates`, the monitor loop, health helpers, and the `monitor-health.json` uninstall entry across by hand. Leave the local `sendWake` implementation untouched.

## Apply on the matching fork tree

```sh
cd /home/box/grok-wechat-plugin
# review the diff first; do not apply if sendWake differs from the backup
git diff --check f1d893fd9bf5bd256f05fac0ef5228539acf4ede cursor/wechat-longpoll-repair-c88f -- server
git checkout cursor/wechat-longpoll-repair-c88f -- server/bounded-request.js server/ilink.js server/index.js server/store.js server/uninstall.js server/test/longpoll.test.js
node --test server/test/*.test.js
```

Node on the box should be 22.23.4, the version these tests ran on.

## Restart without dropping state

Stop only the monitor process. Do not delete the state directory.

```sh
PID=$(cat "$STATE/monitor.pid" 2>/dev/null || true)
if [ -n "$PID" ]; then kill -TERM "$PID"; fi
# wait until the pid is gone; SIGTERM runs notifyStop and clears the pid only if it still names that process
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
cd "$PLUGIN"
node server/index.js --ensure-monitor
```

`--ensure-monitor` starts one poller when the old pid is gone. It does not log in again and does not clear `getUpdatesBuf`.

## What to look at after restart

`wechat_status` now includes `monitor_health`. In the first minute `stale` should be false. `monitor.log` should show lines like:

```text
poll outcome=empty bot=<id> duration_ms=<n> deadline_ms=<n> msgs=0 consecutive_timeouts=0
```

or `outcome=messages` / `outcome=timeout`. It must not contain the bot token, webhook key, cursor, or message text. A timeout is an expected empty hold that ran past the deadline; it does not move the cursor. `outcome=error` is a real failure and backs off.

`stale: true` with `stale_reason: poll-overdue` means a poll exceeded its deadline and the process was still alive. The next `wechat_start_monitor` / `--ensure-monitor` replaces that process. `degraded: true` with a fresh `last_completed_at` means the loop is alive but timeouts or errors are repeating; that does not by itself kill the process.

## Rollback

```sh
PID=$(cat "$STATE/monitor.pid" 2>/dev/null || true)
if [ -n "$PID" ]; then kill -TERM "$PID" || kill -KILL "$PID"; fi
cp -a /tmp/grok-wechat-pre-longpoll/ilink.js "$PLUGIN/server/ilink.js"
cp -a /tmp/grok-wechat-pre-longpoll/index.js "$PLUGIN/server/index.js"
cp -a /tmp/grok-wechat-pre-longpoll/store.js "$PLUGIN/server/store.js"
cp -a /tmp/grok-wechat-pre-longpoll/uninstall.js "$PLUGIN/server/uninstall.js"
rm -f "$PLUGIN/server/bounded-request.js"
cd "$PLUGIN" && node server/index.js --ensure-monitor
```

Leave `account.json`, `inbox.jsonl`, `wake.json`, and `media/` as they are. Extra fields written by this build (`seenMessageIds`, `longPollTimeoutMs`, `monitor-health.json`) are ignored by the previous code. Restoring the state backup is only needed if you want to undo a cursor movement that happened after the new monitor started; that also drops messages received after the backup.

## Do not

- Run a second manual `getUpdates` or another monitor against the same account while the installed monitor is up.
- Point this plugin at a proxy other than the one the host already injects.
- Merge this into the upstream `little-thing/grok-wechat-plugin` from this fork unless that is requested separately.
