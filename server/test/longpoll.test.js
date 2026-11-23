import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boundedRequest } from "../bounded-request.js";
import {
  collectInbound,
  commitInboundCursor,
  getUpdates,
  longPollBudget,
  normalizeInbound,
  resetLongPollState,
} from "../ilink.js";
import { assessMonitorHealth, emptyAccount, emptyState, loadState, paths, readPid, saveState, writePid } from "../store.js";

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userMessage(id, text = "hello") {
  return {
    message_type: 1,
    message_state: 2,
    from_user_id: "peer",
    message_id: id,
    create_time_ms: 1,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return server.address().port;
}

function useHome(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "grok-wechat-longpoll-"));
  const previous = process.env.GROK_WECHAT_HOME;
  const previousBudget = process.env.GROK_WECHAT_POLL_BUDGET_MS;
  process.env.GROK_WECHAT_HOME = home;
  process.env.GROK_WECHAT_POLL_BUDGET_MS = "400";
  resetLongPollState();
  t.after(() => {
    if (previous === undefined) delete process.env.GROK_WECHAT_HOME;
    else process.env.GROK_WECHAT_HOME = previous;
    if (previousBudget === undefined) delete process.env.GROK_WECHAT_POLL_BUDGET_MS;
    else process.env.GROK_WECHAT_POLL_BUDGET_MS = previousBudget;
    resetLongPollState();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      }
    }
  });
  return home;
}

function saveAccount(port, extra = {}) {
  const account = {
    ...emptyAccount(),
    token: "test-token",
    baseUrl: `http://127.0.0.1:${port}`,
    ilinkBotId: "bot1",
    ilinkUserId: "owner",
    getUpdatesBuf: "cursor-1",
    ...extra,
  };
  saveState({ ...emptyState(), accounts: [account] });
  return account;
}

function trackGetUpdates(handler) {
  let active = 0;
  let maxActive = 0;
  let overlapMs = 0;
  let overlapAt = 0;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    if (!req.url.includes("getupdates")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    active += 1;
    if (active === 2) overlapAt = Date.now();
    maxActive = Math.max(maxActive, active);
    sockets.add(req.socket);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      if (active >= 2 && overlapAt) {
        overlapMs += Date.now() - overlapAt;
        overlapAt = 0;
      }
      active = Math.max(0, active - 1);
    };
    req.on("close", leave);
    res.on("close", leave);
    handler(req, res, leave);
  });
  return {
    server,
    stats: () => ({
      active,
      maxActive,
      overlapMs,
      open: [...sockets].filter((socket) => !socket.destroyed).length,
    }),
  };
}

test("long-poll budget clamps an oversized server hint", () => {
  const previous = process.env.GROK_WECHAT_POLL_BUDGET_MS;
  delete process.env.GROK_WECHAT_POLL_BUDGET_MS;
  try {
    const huge = longPollBudget(600_000);
    assert.equal(huge.holdMs, 120_000);
    assert.ok(huge.deadlineMs <= 130_000);
    assert.ok(huge.deadlineMs >= huge.holdMs);
    const normal = longPollBudget(35_000);
    assert.equal(normal.holdMs, 35_000);
    assert.ok(normal.deadlineMs > 35_000);
    assert.ok(normal.deadlineMs < 50_000);
    assert.equal(longPollBudget(0).holdMs, 35_000);
    assert.equal(longPollBudget(-5).holdMs, 35_000);
  } finally {
    if (previous === undefined) delete process.env.GROK_WECHAT_POLL_BUDGET_MS;
    else process.env.GROK_WECHAT_POLL_BUDGET_MS = previous;
  }
});

test("stalled headers time out, close the socket, and keep the cursor", async (t) => {
  useHome(t);
  const tracked = trackGetUpdates(() => {});
  const port = await listen(tracked.server);
  t.after(() => tracked.server.close());
  saveAccount(port);
  const started = Date.now();
  const result = await getUpdates(loadState().accounts[0]);
  const duration = Date.now() - started;
  assert.equal(result.outcome, "timeout");
  assert.equal(result.commit, false);
  assert.ok(duration < 2_000, `timeout took ${duration}ms`);
  assert.ok(duration >= 400, `timeout returned too soon (${duration}ms)`);
  await sleep(100);
  assert.equal(loadState().accounts[0].getUpdatesBuf, "cursor-1");
  assert.equal(tracked.stats().open, 0);
  assert.equal(tracked.stats().maxActive, 1);
});

test("stalled response body times out after headers and closes the socket", async (t) => {
  useHome(t);
  const tracked = trackGetUpdates((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
    res.write(" ");
  });
  const port = await listen(tracked.server);
  t.after(() => tracked.server.close());
  saveAccount(port);
  const started = Date.now();
  const result = await getUpdates(loadState().accounts[0]);
  assert.equal(result.outcome, "timeout");
  assert.equal(result.commit, false);
  assert.ok(Date.now() - started < 2_000);
  await sleep(100);
  assert.equal(loadState().accounts[0].getUpdatesBuf, "cursor-1");
  assert.equal(tracked.stats().open, 0);
});

test("a second poll waits instead of overlapping the in-flight request", async (t) => {
  useHome(t);
  const tracked = trackGetUpdates(() => {});
  const port = await listen(tracked.server);
  t.after(() => tracked.server.close());
  saveAccount(port);
  const first = getUpdates(loadState().accounts[0]);
  await sleep(40);
  const second = await getUpdates(loadState().accounts[0]);
  assert.equal(second.outcome, "busy");
  assert.equal(second.commit, false);
  assert.equal(tracked.stats().maxActive, 1);
  const finished = await first;
  assert.equal(finished.outcome, "timeout");
  assert.equal(loadState().accounts[0].getUpdatesBuf, "cursor-1");
  assert.ok(tracked.stats().overlapMs < 200, `overlap ${tracked.stats().overlapMs}ms`);
});

test("empty polls stay distinct from transport and API errors", async (t) => {
  useHome(t);
  const script = [
    { status: 200, body: { ret: 0, msgs: [], get_updates_buf: "cursor-1", longpolling_timeout_ms: 600_000 } },
    { status: 500, body: "nope" },
    { status: 200, body: { ret: 7, errcode: 7, msgs: [], get_updates_buf: "cursor-x" } },
    { status: 200, body: "not-json" },
  ];
  const tracked = trackGetUpdates((_req, res) => {
    const next = script.shift();
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(typeof next.body === "string" ? next.body : JSON.stringify(next.body));
  });
  const port = await listen(tracked.server);
  t.after(() => tracked.server.close());
  saveAccount(port);
  const empty = await getUpdates(loadState().accounts[0]);
  assert.equal(empty.outcome, "empty");
  assert.equal(empty.commit, true);
  assert.equal(empty.longPollTimeoutMs, 400);
  assert.equal(loadState().accounts[0].getUpdatesBuf, "cursor-1");
  await assert.rejects(getUpdates(loadState().accounts[0]), /HTTP 500/);
  await assert.rejects(getUpdates(loadState().accounts[0]), (err) => err.code === "ILINK_RET" && err.ret === 7);
  await assert.rejects(getUpdates(loadState().accounts[0]), (err) => err.code === "BAD_RESPONSE");
  assert.equal(loadState().accounts[0].getUpdatesBuf, "cursor-1");
  const held = trackGetUpdates((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "cursor-1" }));
    }, 2_000);
  });
  const heldPort = await listen(held.server);
  t.after(() => held.server.close());
  saveAccount(heldPort, { longPollTimeoutMs: 400 });
  resetLongPollState();
  const started = Date.now();
  const timed = await getUpdates(loadState().accounts[0]);
  assert.equal(timed.outcome, "timeout");
  assert.ok(Date.now() - started < 1_500, "a clamped hint must not wait out the server's raw hold");
});

test("cursor commits after a stored message and duplicates are not collected again", async (t) => {
  useHome(t);
  const account = saveAccount(0);
  account.baseUrl = "http://127.0.0.1:9";
  const cursorBefore = loadState().accounts[0].getUpdatesBuf;
  commitInboundCursor(account, {
    getUpdatesBuf: "cursor-2",
    seenIds: ["m-1"],
    longPollTimeoutMs: 400,
  });
  const stored = loadState().accounts[0];
  assert.equal(stored.getUpdatesBuf, "cursor-2");
  assert.deepEqual(stored.seenMessageIds, ["m-1"]);
  assert.equal(stored.longPollTimeoutMs, 400);
  assert.notEqual(cursorBefore, "cursor-2");
  const collected = await collectInbound([userMessage("m-1", "again"), userMessage("m-2", "next")], stored, stored.seenMessageIds);
  assert.deepEqual(collected.messages.map((message) => message.message_id), ["m-2"]);
});

test("a stalled media download does not block the text already in the message", async (t) => {
  useHome(t);
  const previous = process.env.GROK_WECHAT_MEDIA_TIMEOUT_MS;
  process.env.GROK_WECHAT_MEDIA_TIMEOUT_MS = "400";
  t.after(() => {
    if (previous === undefined) delete process.env.GROK_WECHAT_MEDIA_TIMEOUT_MS;
    else process.env.GROK_WECHAT_MEDIA_TIMEOUT_MS = previous;
  });
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": 100 });
    res.write("x");
  });
  const port = await listen(server);
  t.after(() => server.close());
  const started = Date.now();
  const normalized = await normalizeInbound({
    from_user_id: "peer",
    message_id: "media-1",
    item_list: [
      { type: 1, text_item: { text: "caption" } },
      { type: 2, image_item: { media: { full_url: `http://127.0.0.1:${port}/stall`, aes_key: "aaaa" } } },
    ],
  });
  assert.equal(normalized.text, "caption");
  assert.equal(normalized.items.find((item) => item.type === "image").path, null);
  assert.ok(Date.now() - started < 2_000);
});

test("bounded requests keep using the configured env proxy", async () => {
  const origin = http.createServer((req, res) => {
    if (req.headers["x-test-proxy"] !== "1") {
      res.writeHead(500);
      res.end("direct");
      return;
    }
    res.end("proxied");
  });
  const originPort = await listen(origin);
  let proxySaw = 0;
  const proxy = http.createServer((req, res) => {
    proxySaw += 1;
    const target = new URL(req.url);
    const forwarded = http.request({
      hostname: "127.0.0.1",
      port: target.port || originPort,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, "x-test-proxy": "1", host: `127.0.0.1:${target.port || originPort}` },
    }, (up) => {
      res.writeHead(up.statusCode || 502);
      up.pipe(res);
    });
    forwarded.on("error", () => res.destroy());
    req.pipe(forwarded);
  });
  const proxyPort = await listen(proxy);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { boundedRequest } from ${JSON.stringify(path.join(path.dirname(INDEX), "bounded-request.js"))};
    const result = await boundedRequest(${JSON.stringify(`http://127.0.0.1:${originPort}/ilink/bot/getupdates`)}, {
      method: "POST",
      body: "{}",
      timeoutMs: 2000,
    });
    console.log(JSON.stringify({ status: result.status, body: result.buffer.toString("utf8") }));
  `], {
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      http_proxy: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      https_proxy: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: "",
      no_proxy: "",
    },
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  proxy.close();
  origin.close();
  assert.equal(code, 0, out);
  assert.equal(proxySaw, 1);
  assert.match(out, /proxied/);
});

test("monitor recovers from a stall and HTTP failures without losing or duplicating the cursor", { timeout: 20_000 }, async (t) => {
  const home = useHome(t);
  let updates = 0;
  const tracked = trackGetUpdates((_req, res) => {
    updates += 1;
    if (updates === 1) return;
    if (updates < 4) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("fail");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ret: 0,
      msgs: [userMessage("m-1", "hello")],
      get_updates_buf: "cursor-2",
      longpolling_timeout_ms: 400,
    }));
  });
  const port = await listen(tracked.server);
  t.after(() => tracked.server.close());
  saveAccount(port);
  const child = spawn(process.execPath, [INDEX, "--monitor"], {
    env: {
      ...process.env,
      GROK_WECHAT_HOME: home,
      GROK_WECHAT_POLL_BUDGET_MS: "400",
      GROK_WECHAT_RETRY_MS: "20",
      GROK_WECHAT_BACKOFF_MS: "30",
    },
    stdio: "ignore",
  });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    const pid = readPid();
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
  const inbox = paths().inbox;
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    if (fs.existsSync(inbox) && fs.readFileSync(inbox, "utf8").includes("m-1")) break;
    await sleep(40);
  }
  const body = fs.existsSync(inbox) ? fs.readFileSync(inbox, "utf8") : "";
  const log = fs.existsSync(paths().log) ? fs.readFileSync(paths().log, "utf8") : "";
  assert.match(body, /"message_id":"m-1"/, log);
  assert.equal(body.trim().split("\n").length, 1, log);
  const afterCursor = Date.now();
  while (Date.now() - afterCursor < 4_000) {
    if (loadState().accounts[0].getUpdatesBuf === "cursor-2") break;
    await sleep(40);
  }
  assert.equal(loadState().accounts[0].getUpdatesBuf, "cursor-2", log);
  await sleep(900);
  const reread = fs.readFileSync(inbox, "utf8").trim().split("\n");
  assert.equal(reread.length, 1, fs.readFileSync(paths().log, "utf8"));
  assert.equal(loadState().accounts[0].seenMessageIds.includes("m-1"), true);
  assert.match(fs.readFileSync(paths().log, "utf8"), /outcome=timeout/);
  assert.match(fs.readFileSync(paths().log, "utf8"), /outcome=error/);
  assert.doesNotMatch(fs.readFileSync(paths().log, "utf8"), /test-token|hello|cursor-2/);
  const health = JSON.parse(fs.readFileSync(paths().health, "utf8"));
  assert.equal(health.v, 1);
  assert.equal(health.pid, child.pid);
  assert.equal((fs.statSync(paths().health).mode & 0o777), 0o600);
  assert.equal(assessMonitorHealth(health).stale, false);
  assert.ok(tracked.stats().overlapMs < 200, `overlap ${tracked.stats().overlapMs}ms`);
});

test("a live monitor with an overdue poll is stale and is replaced", () => {
  const fresh = assessMonitorHealth({
    v: 1,
    pid: 10,
    started_at: Date.now() - 5_000,
    accounts: {
      bot1: { in_flight_since: Date.now() - 200, deadline_ms: 1_000, last_completed_at: Date.now() - 200 },
    },
  });
  assert.equal(fresh.stale, false);
  const overdue = assessMonitorHealth({
    v: 1,
    pid: 10,
    started_at: Date.now() - 60_000,
    accounts: {
      bot1: { in_flight_since: Date.now() - 30_000, deadline_ms: 1_000, last_completed_at: Date.now() - 40_000 },
    },
  });
  assert.equal(overdue.stale, true);
  assert.equal(overdue.reason, "poll-overdue");
  const idle = assessMonitorHealth({
    v: 1,
    pid: 10,
    started_at: Date.now() - 400_000,
    accounts: {
      bot1: { in_flight_since: null, deadline_ms: 1_000, last_completed_at: Date.now() - 200_000 },
    },
  });
  assert.equal(idle.stale, true);
  assert.equal(idle.reason, "no-progress");
});

test("ensure-monitor restarts a stopped-alive stale poller", { timeout: 20_000 }, async (t) => {
  const home = useHome(t);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "cursor-1" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  saveAccount(port);
  const child = spawn(process.execPath, [INDEX, "--monitor"], {
    env: { ...process.env, GROK_WECHAT_HOME: home, GROK_WECHAT_POLL_BUDGET_MS: "400" },
    stdio: "ignore",
  });
  const pids = new Set([child.pid]);
  t.after(async () => {
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const alive = [...pids].some((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      if (!alive) break;
      await sleep(20);
    }
  });
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (fs.existsSync(paths().health)) {
      const health = JSON.parse(fs.readFileSync(paths().health, "utf8"));
      if (health.pid === child.pid && health.accounts?.bot1?.last_completed_at) break;
    }
    await sleep(30);
  }
  writePid(child.pid);
  process.kill(child.pid, "SIGSTOP");
  const stale = {
    v: 1,
    pid: child.pid,
    started_at: Date.now() - 400_000,
    updated_at: Date.now(),
    accounts: {
      bot1: {
        in_flight_since: Date.now() - 30_000,
        deadline_ms: 1_000,
        last_completed_at: Date.now() - 200_000,
        last_outcome: "timeout",
        consecutive_timeouts: 4,
        consecutive_errors: 0,
      },
    },
  };
  fs.writeFileSync(paths().health, JSON.stringify(stale), { mode: 0o600 });
  const checker = spawn(process.execPath, [INDEX, "--ensure-monitor"], {
    env: { ...process.env, GROK_WECHAT_HOME: home },
  });
  let out = "";
  checker.stdout.on("data", (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => checker.on("exit", resolve));
  assert.equal(code, 0, out);
  const summary = JSON.parse(out);
  assert.equal(summary.restarted, true);
  assert.equal(summary.previous_pid, child.pid);
  assert.notEqual(summary.pid, child.pid);
  pids.add(summary.pid);
  await sleep(100);
  assert.equal(readPid(), summary.pid);
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
});

test("gzip long-poll bodies decode before the cursor is considered", async (t) => {
  useHome(t);
  const payload = Buffer.from(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "cursor-9", longpolling_timeout_ms: 400 }));
  const gzip = zlib.gzipSync(payload);
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gzip.length),
    });
    res.end(gzip);
  });
  const port = await listen(server);
  t.after(() => server.close());
  saveAccount(port);
  const result = await getUpdates(loadState().accounts[0]);
  assert.equal(result.outcome, "empty");
  assert.equal(result.get_updates_buf, "cursor-9");
  assert.equal(loadState().accounts[0].getUpdatesBuf, "cursor-1");
});

test("direct boundedRequest deadline is independent of the 300s dispatcher default", async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json", "content-length": 20 });
  });
  const port = await listen(server);
  t.after(() => server.close());
  const started = Date.now();
  await assert.rejects(
    boundedRequest(`http://127.0.0.1:${port}/stall`, { method: "POST", body: "{}", timeoutMs: 300 }),
    (err) => err.code === "TIMEOUT",
  );
  const duration = Date.now() - started;
  assert.ok(duration < 1_000, `body stall lasted ${duration}ms`);
});
