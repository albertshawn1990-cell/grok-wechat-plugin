# Rollout for installed base 5c02e41

Use only `deploy/longpoll-repair-5c02e41.patch`. It was generated from pristine `5c02e41b8126d6ae323dbb30565014fc16752763` and `git apply --check` succeeds on a clean archive of that commit. The earlier `deploy/longpoll-repair.patch` applied to later fork commit `f1d893fd` and does not apply here. It has been removed so it is not used by mistake.

The installed tree has `wakeAgent` posting with `fetch(cfg.url, ...)` inside `server/index.js`. It does not contain `sendWake` or `lookupWakeAddress`. This patch does not add those, and it does not change uninstall, webhook delivery, or credential-file permissions.

No production process was restarted to produce this artifact.

## Security

Nothing that `5c02e41` already enforces is removed.

This patch does not add the later webhook SSRF checks (`sendWake`, DNS pinning, the public-address block list). Those exist only on commits after `5c02e41`. Shipping them would replace the installed wake path and is out of this long-poll repair. If that hardening is wanted, it is a separate review, not this apply.

Also unchanged, and still the installed behavior:

- inbound media is still written with `path.join(paths().media, timestamp-label)` and is not passed through the later basename sanitizer
- `monitorRunning()` is still “pid is alive”, not the later argv check
- `connectorAbandoned()` still auto-uninstalls after the connector has been gone for 30 seconds
- wake errors are still logged with `err.message`

New file `monitor-health.json` is created mode `0600`. Poll outcome logs omit token, cursor, webhook key, and message text. That is the only logging change.

## Gate before touching the installed tree

Run this on the coordinator with `/exec-daemon/node` (v22.23.4). Do not use the system Node 24.22.1. This uses a temp copy and does not edit `/home/box/grok-wechat-plugin`.

```sh
PLUGIN=/home/box/grok-wechat-plugin
PATCH=/absolute/path/to/longpoll-repair-5c02e41.patch
NODE=/exec-daemon/node
test "$("$NODE" -p process.version)" = "v22.23.4"
test "$(git -C "$PLUGIN" rev-parse HEAD)" = "5c02e41b8126d6ae323dbb30565014fc16752763"
test -z "$(git -C "$PLUGIN" status --porcelain)"
WORK=$(mktemp -d)
git -C "$PLUGIN" archive HEAD | tar -C "$WORK" -x
(
  cd "$WORK"
  git apply --check "$PATCH"
  git apply "$PATCH"
  "$NODE" --test server/test/longpoll.test.js
)
rm -rf "$WORK"
```

`git apply --check` must print nothing and exit 0. The test file reports 13 passing tests. Stop if either fails. Do not edit the patch by hand.

From a clone of this fork that still contains commit `5c02e41`, the same gate is `sh deploy/check-5c02e41.sh`.

## Apply

```sh
PLUGIN=/home/box/grok-wechat-plugin
PATCH=/absolute/path/to/longpoll-repair-5c02e41.patch
STATE=${GROK_WECHAT_HOME:-$HOME/.grok-wechat}
cd "$PLUGIN"
git apply --check "$PATCH"
mkdir -p /tmp/grok-wechat-pre-longpoll
cp -a server/ilink.js server/index.js server/store.js /tmp/grok-wechat-pre-longpoll/
cp -a "$STATE/account.json" "$STATE/inbox.jsonl" "$STATE/wake.json" /tmp/grok-wechat-pre-longpoll/ 2>/dev/null || true
git apply "$PATCH"
```

`git apply` changes only:

- `server/bounded-request.js` (new)
- `server/ilink.js`
- `server/index.js`
- `server/store.js`
- `server/test/longpoll.test.js` (new)

It does not modify `server/uninstall.js`, `wake.json`, `account.json`, `inbox.jsonl`, or `media/`.

## Restart

The running monitor keeps the old code until that process exits. This does not delete state.

```sh
PID=$(cat "$STATE/monitor.pid" 2>/dev/null || true)
if [ -n "$PID" ]; then kill -TERM "$PID"; fi
i=0
while [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then echo "monitor $PID still running"; exit 1; fi
  sleep 1
done
cd "$PLUGIN"
"$NODE" server/index.js --ensure-monitor
```

`--ensure-monitor` starts one poller when the pid file is empty. It does not log in again and does not clear `getUpdatesBuf`.

## After restart

`wechat_status` includes `monitor_health`. Within a minute `stale` should be false. `monitor.log` gains lines like:

```text
poll outcome=empty bot=<id> duration_ms=<n> deadline_ms=<n> msgs=0 consecutive_timeouts=0
```

`outcome=timeout` means the deadline fired and the cursor was not moved. `outcome=error` is a real failure and backs off. A passing test run is not evidence that production delivery is fixed. Compare message create time to inbox time for 30–60 minutes.

Do not set `GROK_WECHAT_POLL_BUDGET_MS`, `GROK_WECHAT_RETRY_MS`, `GROK_WECHAT_BACKOFF_MS`, `GROK_WECHAT_EXPIRED_MS`, `GROK_WECHAT_MEDIA_TIMEOUT_MS`, or `GROK_WECHAT_WATCHDOG_SLACK_MS`.

Do not change `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, or `NODE_USE_ENV_PROXY`. The long poll uses Node's global HTTP agent.

## Rollback

```sh
PID=$(cat "$STATE/monitor.pid" 2>/dev/null || true)
if [ -n "$PID" ]; then kill -TERM "$PID" || true; fi
i=0
while [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then kill -KILL "$PID" || true; break; fi
  sleep 1
done
cd "$PLUGIN"
git apply -R --check "$PATCH"
git apply -R "$PATCH"
rm -f "$STATE/monitor-health.json"
"$NODE" server/index.js --ensure-monitor
```

Leave `account.json`, `inbox.jsonl`, `wake.json`, and `media/` in place. Extra account fields `seenMessageIds` and `longPollTimeoutMs` are ignored by `5c02e41`. Restore the `/tmp/grok-wechat-pre-longpoll` copies of those state files only to undo a cursor move that happened after the new monitor started. That also drops messages saved after the backup.

## Do not

- Apply `git checkout` of the fork branch onto this install. That would replace uninstall and the wake path.
- Run a second `getUpdates` poller against the same account.
- Merge this fork into upstream `little-thing/grok-wechat-plugin` unless that is requested separately.
