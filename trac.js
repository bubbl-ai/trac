#!/usr/bin/env node
// trac — see how much of your Claude subscription you actually use.
// Parses Claude Code transcripts (~/.claude/projects/**/*.jsonl) locally.
// Usage:  trac status | trac report [--days N]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const WINDOW_MS = 5 * 60 * 60 * 1000; // subscription quota window
const RESERVE_NOTE = "estimates based on your own busiest usage — Anthropic doesn't publish exact caps";

// $/MTok — used as quota-weight proxy, not billing. Cache reads are ~10x
// cheaper against quota than fresh input; weighting by price captures that.
const PRICING = {
  fable: { in: 10, out: 50 },
  mythos: { in: 10, out: 50 },
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
};

function priceFor(model) {
  if (!model || model.startsWith("<")) return null; // synthetic
  for (const key of Object.keys(PRICING)) if (model.includes(key)) return PRICING[key];
  return PRICING.sonnet; // unknown Claude model — mid-tier guess
}

function eventCost(model, u) {
  const p = priceFor(model);
  if (!p) return 0;
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens || 0);
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  return (
    (inTok * p.in + outTok * p.out + cacheRead * p.in * 0.1 +
      w5m * p.in * 1.25 + w1h * p.in * 2) / 1e6
  );
}

// ── Ground truth: plan tier + live quota from Claude Code's own credentials ──
function readPlan() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const org = cfg.oauthAccount?.organizationType || "";
    const names = { claude_pro: "Claude Pro", claude_max: "Claude Max" };
    return names[org] || (org.includes("max") ? "Claude Max" : org ? org : null);
  } catch { return null; }
}

function readOAuthToken() {
  try {
    if (process.platform === "darwin") {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
    }
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
    return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

// Same endpoint Claude Code's /usage reads. Unofficial — treat as best-effort
// and fall back to transcript estimates when it fails.
// Cache is ON DISK (~/.trac/quota.json) and shared by every trac process
// (menu bar, dashboard, CLI): at most ~1 request/min across all of them,
// 5-min backoff after a 429, last-good served for up to 15 min.
async function fetchQuota() {
  const now = Date.now();
  const c = loadState("quota.json", { data: null, okAt: 0, nextTryAt: 0 });
  const stale = () => (c.data && now - c.okAt < 900000 ? c.data : null);
  if (c.data && now - c.okAt < 60000) return c.data;
  if (now < c.nextTryAt) return stale();
  const token = readOAuthToken();
  if (!token) return stale();
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 429) {
      saveState("quota.json", { ...c, nextTryAt: now + 300000 });
      return stale();
    }
    if (!res.ok) {
      saveState("quota.json", { ...c, nextTryAt: now + 60000 });
      return stale();
    }
    const d = await res.json();
    if (typeof d?.five_hour?.utilization !== "number") return stale();
    saveState("quota.json", { data: d, okAt: now, nextTryAt: now + 60000 });
    return d;
  } catch {
    saveState("quota.json", { ...c, nextTryAt: now + 60000 });
    return stale();
  }
}

// ── Calibration + warning state (~/.trac) ──────────────────────────────────
const SPARE_DIR = path.join(os.homedir(), ".trac");

function loadState(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(SPARE_DIR, name), "utf8")); } catch { return fallback; }
}
function saveState(name, obj) {
  try {
    fs.mkdirSync(SPARE_DIR, { recursive: true });
    // Atomic: write to a unique temp file then rename, so a reader never sees a
    // half-written file and a crash can't truncate the real one.
    const dest = path.join(SPARE_DIR, name);
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, dest);
  } catch {}
}

function addCalSample(kind, cap) {
  const cal = loadState("calibration.json", {});
  const arr = cal[kind] || [];
  arr.push({ t: Date.now(), cap: +cap.toFixed(2) });
  cal[kind] = arr.slice(-50);
  saveState("calibration.json", cal);
}

// Median of stored samples; null until we have at least 3
function calibratedCap(kind) {
  const arr = (loadState("calibration.json", {})[kind] || []).map((s) => s.cap).sort((a, b) => a - b);
  return arr.length >= 3 ? arr[Math.floor(arr.length / 2)] : null;
}

// Pair live utilization % with transcript-measured spend → implied plan caps
function updateCalibration(quota, events, active) {
  if (!quota) return;
  if (active && quota.five_hour.utilization >= 10 && active.cost > 1) {
    addCalSample("session", (active.cost / quota.five_hour.utilization) * 100);
  }
  const wu = quota.seven_day.utilization;
  if (wu >= 10 && quota.seven_day.resets_at) {
    const weekStart = Date.parse(quota.seven_day.resets_at) - 7 * 86400000;
    const weekCost = sum(events.filter((e) => e.t >= weekStart), (e) => e.cost);
    if (weekCost > 1) addCalSample("week", (weekCost / wu) * 100);
  }
}

// Limit warnings — fired from the json path (sparebar polls it every 60s).
// Each threshold fires once per reset period.
function maybeNotify(quota, active) {
  if (process.platform !== "darwin" || !quota) return;
  const st = loadState("notify.json", {});
  const fire = (msg) => {
    try {
      execSync(`osascript -e 'display notification ${JSON.stringify(msg)} with title "Trac"'`, { stdio: "ignore" });
    } catch {}
  };

  const s = quota.five_hour;
  const sKey = s.resets_at || "session";
  if (st.sessionKey !== sKey) { st.sessionKey = sKey; st.sessionFired = []; }
  st.sessionFired ||= [];
  const resetStr = s.resets_at ? fmtTime(Date.parse(s.resets_at)) : "";
  for (const t of [70, 85, 95]) {
    if (s.utilization >= t && !st.sessionFired.includes(t)) {
      st.sessionFired.push(t);
      let msg = `Session at ${Math.round(s.utilization)}%${resetStr ? " — resets " + resetStr : ""}`;
      const cap = calibratedCap("session");
      if (t >= 85 && cap && active) {
        const burn = active.cost / ((Date.now() - active.start) / 3600000);
        const mins = burn > 0 ? Math.round(((cap - active.cost) / burn) * 60) : -1;
        if (mins > 0) msg = `Session ${Math.round(s.utilization)}% — capping in ~${mins} min at this burn (reset ${resetStr})`;
      }
      fire(msg);
    }
  }

  const w = quota.seven_day;
  const wKey = w.resets_at || "week";
  if (st.weekKey !== wKey) { st.weekKey = wKey; st.weekFired = []; }
  st.weekFired ||= [];
  if (w.utilization >= 90 && !st.weekFired.includes(90)) {
    st.weekFired.push(90);
    fire(`Weekly quota at ${Math.round(w.utilization)}% — resets ${w.resets_at ? fmtDay(Date.parse(w.resets_at)) : "soon"}`);
  }
  saveState("notify.json", st);
}

// ── Collect usage events ────────────────────────────────────────────────────
async function collectEvents() {
  const files = [];
  for (const dir of safeReaddir(CLAUDE_DIR)) {
    const full = path.join(CLAUDE_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of safeReaddir(full)) if (f.endsWith(".jsonl")) files.push(path.join(full, f));
  }

  const events = [];
  const seen = new Set();
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const msg = d.message;
      if (!msg || !msg.usage || !d.timestamp) continue;
      const id = msg.id || d.requestId;
      if (id) {
        if (seen.has(id)) continue; // retries appear twice
        seen.add(id);
      }
      const t = Date.parse(d.timestamp);
      if (Number.isNaN(t)) continue;
      const cost = eventCost(msg.model, msg.usage);
      if (cost <= 0) continue;
      events.push({ t, model: msg.model, cost });
    }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

// ── Window math ─────────────────────────────────────────────────────────────
// A quota window opens (floored to the hour) at the first message after the
// previous window closed, and lasts 5 hours.
function buildWindows(events) {
  const windows = [];
  let cur = null;
  for (const e of events) {
    if (!cur || e.t >= cur.end) {
      const start = Math.floor(e.t / 3600000) * 3600000;
      cur = { start, end: start + WINDOW_MS, cost: 0, count: 0 };
      windows.push(cur);
    }
    cur.cost += e.cost;
    cur.count++;
  }
  return windows;
}

function sum(arr, f) { return arr.reduce((a, x) => a + f(x), 0); }
function fmt$(n) { return "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2)); }
function fmtTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDay(t) {
  return new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function bar(frac, width = 24) {
  const n = Math.round(Math.min(1, Math.max(0, frac)) * width);
  return "█".repeat(n) + "░".repeat(width - n);
}
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  orange: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

// ── Commands ────────────────────────────────────────────────────────────────
async function cmdStatus(events) {
  const now = Date.now();
  const windows = buildWindows(events);
  const cur = windows.at(-1);
  const active = cur && now < cur.end ? cur : null;

  // Personal capacity estimate = busiest window in history
  const peakWindow = Math.max(...windows.map((w) => w.cost), 0.01);

  console.log(C.bold("\n  trac — Claude subscription usage\n"));

  const plan = readPlan();
  const quota = await fetchQuota();
  updateCalibration(quota, events, active);

  if (quota) {
    // Ground truth from the same endpoint Claude Code's /usage reads
    if (plan) console.log(`  Plan             ${C.bold(plan)}`);
    const gauge = (label, pct, resetsAt) => {
      const frac = pct / 100;
      const color = frac > 0.8 ? C.red : frac > 0.5 ? C.orange : C.green;
      const reset = new Date(resetsAt);
      const sameDay = reset.toDateString() === new Date(now).toDateString();
      const when = (sameDay ? "" : fmtDay(reset) + " ") + fmtTime(reset);
      console.log(`  ${label.padEnd(16)} ${color(bar(frac))}  ${C.bold(Math.round(pct) + "%")} ${C.dim("· resets " + when)}`);
    };
    gauge("Session (5h)", quota.five_hour.utilization, quota.five_hour.resets_at);
    gauge("Week", quota.seven_day.utilization, quota.seven_day.resets_at);
    if (active && quota.five_hour.utilization > 0) {
      const burnPerHr = active.cost / ((now - active.start) / 3600000);
      const impliedCap = (active.cost / quota.five_hour.utilization) * 100;
      console.log(C.dim(`  burn ${fmt$(burnPerHr)}/hr API-equiv · implied 5h cap ≈ ${fmt$(impliedCap)}`));
    }
    console.log();
  } else if (active) {
    // Fallback: estimate from transcripts only
    const frac = active.cost / peakWindow;
    const elapsed = now - active.start;
    const burnPerHr = active.cost / (elapsed / 3600000);
    const projected = active.cost + burnPerHr * ((active.end - now) / 3600000);
    const color = frac > 0.8 ? C.red : frac > 0.5 ? C.orange : C.green;
    console.log(`  Current window   ${fmtTime(active.start)} → ${fmtTime(active.end)} ${C.dim("(estimated — live quota unavailable)")}`);
    console.log(`  ${color(bar(frac))}  ${C.bold(Math.round(frac * 100) + "%")} of your peak window`);
    console.log(C.dim(`  on pace for ${Math.round((projected / peakWindow) * 100)}% by window end · ${fmt$(active.cost)} API-equiv so far\n`));
  } else {
    console.log(`  Current window   ${C.dim("idle — no active window")}\n`);
  }

  const weekAgo = now - 7 * 86400000;
  const weekEvents = events.filter((e) => e.t >= weekAgo);
  const weekCost = sum(weekEvents, (e) => e.cost);
  const weekWindows = windows.filter((w) => w.start >= weekAgo);
  const weekPct = Math.round((weekCost / (peakWindow * (7 * 86400000 / WINDOW_MS))) * 100);
  console.log(`  Last 7 days      ${C.bold(weekPct + "%")} of peak-pace capacity · ${weekWindows.length} windows, ${weekEvents.length} messages ${C.dim("(" + fmt$(weekCost) + " API-equiv)")}`);
  console.log(C.dim(`\n  ${RESERVE_NOTE}\n`));
}

function cmdReport(events, days) {
  const now = Date.now();
  const since = now - days * 86400000;
  const recent = events.filter((e) => e.t >= since);
  if (recent.length === 0) {
    console.log(`\n  No usage found in the last ${days} days.\n`);
    return;
  }
  const windows = buildWindows(events).filter((w) => w.start >= since);
  const peakWindow = Math.max(...buildWindows(events).map((w) => w.cost));
  const calCap = calibratedCap("session");
  const capacity = calCap || peakWindow; // prefer live-calibrated plan cap

  console.log(C.bold(`\n  trac report — last ${days} days\n`));

  // Daily bars
  const byDay = new Map();
  for (const e of recent) {
    const day = new Date(e.t); day.setHours(0, 0, 0, 0);
    byDay.set(+day, (byDay.get(+day) || 0) + e.cost);
  }
  const dayMax = Math.max(...byDay.values());
  for (let d = new Date(since); d <= new Date(now); d.setDate(d.getDate() + 1)) {
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const v = byDay.get(+day) || 0;
    const b = v ? bar(v / dayMax, 30) : C.dim("░".repeat(30));
    console.log(`  ${fmtDay(day).padEnd(13)} ${b} ${v ? fmt$(v) : C.dim("—")}`);
  }

  // Totals + model split
  const total = sum(recent, (e) => e.cost);
  const byModel = new Map();
  for (const e of recent) {
    const fam = Object.keys(PRICING).find((k) => e.model.includes(k)) || "other";
    byModel.set(fam, (byModel.get(fam) || 0) + e.cost);
  }
  const modelStr = [...byModel.entries()].sort((a, b) => b[1] - a[1])
    .map(([m, v]) => `${m} ${fmt$(v)}`).join(" · ");
  console.log(`\n  Model mix        ${C.dim(modelStr + " (API-equivalent weights)")}`);

  // The waste estimate, in window units against the calibrated plan cap.
  const slotCount = (days * 86400000) / WINDOW_MS;
  const usedVsCap = total / (capacity * slotCount);
  const avgFill = windows.length ? total / windows.length / capacity : 0;
  const fullWindowEquiv = total / capacity;
  const capSrc = calCap ? "calibrated from live quota" : "your busiest 5h window";
  console.log(`  Window capacity  ${fmt$(capacity)} ${C.dim("API-equiv (" + capSrc + ")")}`);
  const weekCap = calibratedCap("week");
  if (weekCap) {
    console.log(`  Week budget      ≈ ${C.bold((weekCap / capacity).toFixed(1))} full windows ${C.dim("(weekly cap ≈ " + fmt$(weekCap) + " API-equiv)")}`);
  }
  console.log(`  Windows used     ${C.bold(windows.length)} of ~${Math.round(slotCount)} possible 5h slots · average window ${Math.round(avgFill * 100)}% full`);
  console.log(`  Net usage        ${C.bold(fullWindowEquiv.toFixed(1))} full-window equivalents in ${days} days`);
  // Waste is bounded by the plan's weekly budget when we know it — the weekly
  // cap binds long before the physical count of 5h slots does.
  const budgetWindows = weekCap ? (weekCap / capacity) * (days / 7) : slotCount;
  const unusedWindows = Math.max(0, budgetWindows - fullWindowEquiv);
  const unusedPct = Math.round((unusedWindows / budgetWindows) * 100);
  console.log(C.orange(`\n  ≈ ${Math.round(unusedWindows)} of your plan's ~${Math.round(budgetWindows)} budgeted windows went unused (${unusedPct}%)`));
  console.log(C.dim(`  (≈ ${fmt$(capacity * unusedWindows)} at API rates — a yardstick, not a bill; you pay flat)`));
  if (!calCap) console.log(C.dim(`  ${RESERVE_NOTE}`));
  console.log();
}

// Extra-usage (paid overspend) credits from the quota endpoint. Amounts arrive
// in minor units — divide by 10^decimal_places for display. Returns null when
// the object is absent, or when the account hasn't enabled extra usage.
function extraFrom(quota) {
  const e = quota?.extra_usage;
  if (!e || !e.is_enabled) return null;
  const div = 10 ** (typeof e.decimal_places === "number" ? e.decimal_places : 2);
  return {
    enabled: true,
    used: (e.used_credits || 0) / div,
    limit: (e.monthly_limit || 0) / div,
    currency: e.currency || "USD",
  };
}

async function cmdJson(events) {
  const now = Date.now();
  const windows = buildWindows(events);
  const cur = windows.at(-1);
  const active = cur && now < cur.end ? cur : null;
  const peakWindow = Math.max(...windows.map((w) => w.cost), 0.01);
  const quota = await fetchQuota();
  updateCalibration(quota, events, active);
  maybeNotify(quota, active);

  let session, week, source;
  if (quota) {
    source = "live";
    session = { pct: Math.round(quota.five_hour.utilization), resetsAt: quota.five_hour.resets_at };
    week = { pct: Math.round(quota.seven_day.utilization), resetsAt: quota.seven_day.resets_at };
  } else {
    source = "estimate";
    session = active
      ? { pct: Math.round((active.cost / peakWindow) * 100), resetsAt: new Date(active.end).toISOString() }
      : { pct: 0, resetsAt: null };
    const weekCost = sum(events.filter((e) => e.t >= now - 7 * 86400000), (e) => e.cost);
    week = { pct: Math.round((weekCost / (peakWindow * (7 * 86400000 / WINDOW_MS))) * 100), resetsAt: null };
  }
  const burnPerHr = active ? active.cost / ((now - active.start) / 3600000) : 0;
  console.log(JSON.stringify({
    ok: true, source, plan: readPlan(), session, week,
    extra: extraFrom(quota),
    burnPerHr: +burnPerHr.toFixed(2),
    windowCost: active ? +active.cost.toFixed(2) : 0,
    sessionCap: calibratedCap("session"),
    weekCap: calibratedCap("week"),
    tasks: taskCounts(),
  }));
}

function cmdExport(events, days) {
  const now = Date.now();
  const since = now - days * 86400000;
  const recent = events.filter((e) => e.t >= since);
  const byDay = {};
  for (const e of recent) {
    const day = new Date(e.t); day.setHours(0, 0, 0, 0);
    const key = day.toISOString().slice(0, 10);
    const fam = Object.keys(PRICING).find((k) => e.model.includes(k)) || "other";
    byDay[key] ||= { date: key, cost: 0, messages: 0, byModel: {} };
    byDay[key].cost += e.cost;
    byDay[key].messages++;
    byDay[key].byModel[fam] = (byDay[key].byModel[fam] || 0) + e.cost;
  }
  for (const d of Object.values(byDay)) {
    d.cost = +d.cost.toFixed(2);
    for (const k of Object.keys(d.byModel)) d.byModel[k] = +d.byModel[k].toFixed(2);
  }
  const windows = buildWindows(events).filter((w) => w.start >= since).map((w) => ({
    start: new Date(w.start).toISOString(),
    end: new Date(w.end).toISOString(),
    cost: +w.cost.toFixed(2),
    messages: w.count,
  }));
  console.log(JSON.stringify({
    generatedAt: new Date(now).toISOString(),
    days,
    plan: readPlan(),
    unit: "USD API-equivalent",
    calibration: { sessionCap: calibratedCap("session"), weekCap: calibratedCap("week") },
    totals: { cost: +sum(recent, (e) => e.cost).toFixed(2), messages: recent.length, windows: windows.length },
    daily: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    windows,
  }, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// M3 — task backlog, dispatch, scheduler, morning report
// ═══════════════════════════════════════════════════════════════════════════
import { spawn } from "node:child_process";

const WORK_DIR = path.join(SPARE_DIR, "work");
const REPORT_DIR = path.join(SPARE_DIR, "reports");
const SPECS_DIR = path.join(SPARE_DIR, "specs"); // prepared spec folders, one per task id
const RESERVE_PCT = 75;      // never take the session window past this
const WEEK_MAX_PCT = 90;     // stop background work near the weekly cap
const IDLE_MIN = 15;         // human must be idle this long before dispatch
const TASK_TIMEOUT_MIN = 30; // hard wall-clock cap per task
const RESUME_MAX = 3;        // a task paused by quota is resumed at most this many times
// What a `claude -p` run says when the subscription window is exhausted.
const QUOTA_RE = /hit your limit|usage limit|limit reached|rate.?limit|out of (?:extra )?usage|resets (?:at|in) /i;

function loadTasks() { return loadState("tasks.json", { nextId: 1, tasks: [] }); }
function saveTasks(db) { saveState("tasks.json", db); }

function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }

// Cross-process advisory lock (mkdir is atomic on POSIX). Serializes task-store
// mutations across the many short-lived trac processes (daemon tick, detached
// `run`, dashboard actions) so no one clobbers another's write. Best-effort:
// waits up to ~15s, breaks a lock older than 30s (a crashed holder).
function withTasksLock(fn) {
  const lock = path.join(SPARE_DIR, "tasks.lock");
  fs.mkdirSync(SPARE_DIR, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() - start > 15000) break; // give up waiting, proceed rather than deadlock
      sleepSync(40);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

// Read the freshest task DB, apply mutator, persist atomically — all under the
// lock. Mutators must look tasks up by id on the passed-in db (never write back
// a snapshot captured earlier), so concurrent adds/removes are preserved.
function mutateTasks(fn) {
  return withTasksLock(() => {
    const db = loadTasks();
    const r = fn(db);
    saveTasks(db);
    return r;
  });
}

async function cmdTaskAdd(rest) {
  const spec = rest.find((a) => !a.startsWith("--") && !/^-p$/.test(a) && rest[rest.indexOf(a) - 1] !== "--repo" && rest[rest.indexOf(a) - 1] !== "--budget" && rest[rest.indexOf(a) - 1] !== "-p");
  if (!spec) { console.error("usage: trac add \"<task spec>\" [--repo <path>] [-p N] [--budget N] [--analyze] [--push] [--pr] [--prep]"); process.exit(1); }
  const flag = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
  const repo = path.resolve(flag("--repo", process.cwd()));
  if (!fs.existsSync(path.join(repo, ".git"))) { console.error(`not a git repo: ${repo}`); process.exit(1); }
  const task = mutateTasks((db) => {
    const t = {
      id: "t" + db.nextId++,
      spec,
      repo,
      priority: parseInt(flag("-p", "2"), 10) || 2,
      budget: parseInt(flag("--budget", "25"), 10) || 25, // % of a session window
      mode: rest.includes("--analyze") ? "analyze" : "build",
      push: rest.includes("--push") || rest.includes("--pr"),
      pr: rest.includes("--pr"),
      status: "queued",
      createdAt: new Date().toISOString(),
      reported: true, // nothing to report until it runs
    };
    db.tasks.push(t);
    return t;
  });
  console.log(`  queued ${C.bold(task.id)} [${task.mode}, p${task.priority}, ≤${task.budget}% window] ${path.basename(repo)}: ${spec}`);

  if (rest.includes("--prep")) {
    await prepTask(task);
  } else if (/https?:\/\//.test(spec)) {
    console.log(C.dim("  spec contains URLs — consider --prep so the overnight run doesn't depend on them being reachable"));
  }
}

// Prep pass: snapshot everything the queued task will need into ~/.trac/specs/<id>/
// so the later unattended run is self-contained. Synchronous and chatty — the
// user is at the keyboard right after `trac add`. The task stays queued whether
// prep succeeds or not; a loud warning is printed on failure.
async function prepTask(task) {
  const specDir = path.join(SPECS_DIR, task.id);
  const prompt =
    `You are preparing an unattended background task for later execution. ` +
    `Task spec: ${task.spec}\n\n` +
    `Create the directory ${specDir}/ and write SPEC.md there containing everything a ` +
    `fresh, offline agent needs to carry out this task without network access: fetch any ` +
    `URLs in the spec and save their content/assets into that directory, record concrete ` +
    `acceptance criteria, and list anything you could NOT capture as OPEN QUESTIONS at the ` +
    `top of SPEC.md. Do not modify the repo (${task.repo}) — only write inside ${specDir}.`;
  const tools = "Read,Glob,Grep,LS,WebFetch,Write,Bash";

  process.stdout.write(`  prepping ${task.id}… `);
  // manual: user is present, so don't yield to human activity. Budget: 10 min, 25 turns.
  const res = await runClaude(prompt, task.repo, tools, "build", { manual: true, timeoutMin: 10, maxTurns: 25 });
  const ok = res.ok && fs.existsSync(path.join(specDir, "SPEC.md"));
  if (ok) {
    mutateTasks((db) => { const t = db.tasks.find((x) => x.id === task.id); if (t) t.specDir = specDir; });
    console.log(C.green(`ready → ${specDir}`));
  } else {
    console.log(C.red("prep failed"));
    const why = res.error ? res.error.slice(-160) : "SPEC.md was not written";
    console.log(C.red(`  ⚠ prep did not complete (${why}). ${task.id} stays queued, but its overnight run may depend on live URLs.`));
  }
}

// Human-readable one-liner for a task. The full spec is what gets sent to the
// model (with "Read <path> SPEC.md FIRST…" instructions); this strips that
// unattended-run boilerplate for display only.
function titleOf(t) {
  let s = String(t.title || t.spec || "").replace(/\s+/g, " ").trim();
  s = s.split(/\.\s+Read\s+\/?\S+\s+FIRST/i)[0]; // "…. Read <path> FIRST and follow it exactly."
  s = s.replace(/\s*Read\s+\/\S+.*$/i, "");        // any remaining "Read /path…" tail
  s = s.replace(/\s*[.·]\s*$/, "").trim();
  return s || String(t.spec || "").slice(0, 80);
}

function cmdTaskList() {
  const db = loadTasks();
  if (!db.tasks.length) { console.log("\n  no tasks — add one: trac add \"...\" --repo <path>\n"); return; }
  console.log();
  for (const t of db.tasks) {
    const icons = { queued: "○", running: "◐", done: "●", failed: "✗", interrupted: "◑", paused: "◔", skipped: "–" };
    const extra = t.status === "done" ? ` → ${t.branch}${t.commits ? ` (${t.commits} commits)` : ""}` :
                  t.status === "failed" ? ` — ${t.error || "failed"}` :
                  t.status === "paused" ? ` — paused, quota exhausted; resumes when the window resets (attempt ${t.attempts || 1})` : "";
    console.log(`  ${icons[t.status] || "?"} ${C.bold(t.id.padEnd(4))} [${t.mode}, p${t.priority}] ${path.basename(t.repo)}: ${titleOf(t).slice(0, 70)}${extra ? C.dim(extra) : ""}`);
  }
  console.log();
}

function cmdTaskRm(id) {
  const db = loadTasks();
  const t = db.tasks.find((x) => x.id === id);
  if (!t) { console.error(`no task ${id}`); process.exit(1); }
  if (t.worktree && fs.existsSync(t.worktree)) {
    try { execSync(`git -C ${JSON.stringify(t.repo)} worktree remove --force ${JSON.stringify(t.worktree)}`, { stdio: "ignore" }); } catch {}
  }
  const specDir = path.join(SPECS_DIR, id); // prep-created spec folder, if any
  if (fs.existsSync(specDir)) { try { fs.rmSync(specDir, { recursive: true, force: true }); } catch {} }
  mutateTasks((fresh) => { fresh.tasks = fresh.tasks.filter((x) => x.id !== id); });
  console.log(`  removed ${id}`);
}

// ── Idle detection ──────────────────────────────────────────────────────────
function hidIdleSeconds() {
  try {
    return parseFloat(execSync(
      `ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'`,
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()) || 0;
  } catch { return 0; }
}

// Project dirs whose Claude activity should NOT count as the human "working" —
// e.g. the session you use to talk to Trac itself. Matched exactly on dir name
// so "-Users-tonyx" ignores your main chat but still counts "-Users-tonyx-trac".
function ignoredProjects() {
  const cfg = loadState("config.json", {});
  return Array.isArray(cfg.ignoreProjects) ? cfg.ignoreProjects : [];
}

function recentHumanTranscripts(withinMin) {
  const cutoff = Date.now() - withinMin * 60000;
  const ignore = ignoredProjects();
  for (const dir of safeReaddir(CLAUDE_DIR)) {
    if (dir.includes("-trac-work-")) continue; // our own headless runs
    if (ignore.includes(dir)) continue;        // sessions the user marked as non-work
    const full = path.join(CLAUDE_DIR, dir);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of safeReaddir(full)) {
        if (f.endsWith(".jsonl") && fs.statSync(path.join(full, f)).mtimeMs > cutoff) return true;
      }
    } catch {}
  }
  return false;
}

function humanActive() {
  if (process.env.TRAC_FORCE_IDLE === "1") return false; // test override: force the idle gate open
  return hidIdleSeconds() < IDLE_MIN * 60 || recentHumanTranscripts(IDLE_MIN);
}

// ── Dispatch ────────────────────────────────────────────────────────────────
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24); }

function defaultBase(repo) {
  try { execSync(`git -C ${JSON.stringify(repo)} fetch --quiet`, { stdio: "ignore", timeout: 30000 }); } catch {}
  for (const ref of ["origin/main", "origin/master", "main", "master", "HEAD"]) {
    try {
      execSync(`git -C ${JSON.stringify(repo)} rev-parse --verify --quiet ${ref}`, { stdio: "ignore" });
      return ref;
    } catch {}
  }
  return "HEAD";
}

async function dispatch(task, { dry = false, manual = false, fresh = false } = {}) {
  const db = loadTasks();
  const t = db.tasks.find((x) => x.id === task.id);
  const branch = `trac/${t.id}-${slug(t.spec)}`;
  const worktree = path.join(WORK_DIR, t.id);

  // Resume when a prior attempt left a Claude session AND its worktree behind
  // (paused by quota, interrupted by the human, or a failed run being retried):
  // the branch keeps its commits, the agent keeps its conversation. `fresh`
  // (trac run --fresh, or the dashboard's Start over) wipes both.
  const resuming = !fresh && !!t.sessionId && !!t.worktree && fs.existsSync(t.worktree) && !dry;
  const base = resuming && t.base ? t.base : defaultBase(t.repo);
  const priorStatus = t.status;

  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  if (!resuming) {
    try { execSync(`git -C ${JSON.stringify(t.repo)} worktree remove --force ${JSON.stringify(worktree)}`, { stdio: "ignore" }); } catch {}
    execSync(`git -C ${JSON.stringify(t.repo)} worktree add -B ${branch} ${JSON.stringify(worktree)} ${base}`, { stdio: "ignore" });
    // Trac names the session so the id is known even if claude dies before printing.
    t.sessionId = crypto.randomUUID();
    t.attempts = 0;
    delete t.windowPctUsed;
  }
  t.attempts = (t.attempts || 0) + 1;

  t.status = "running"; t.branch = branch; t.worktree = worktree; t.base = base;
  t.startedAt = new Date().toISOString();
  delete t.error; delete t.summary; // clear leftovers from any prior attempt
  mutateTasks((fresh) => {
    const ft = fresh.tasks.find((x) => x.id === task.id);
    if (!ft) return;
    ft.status = "running"; ft.branch = branch; ft.worktree = worktree; ft.base = base;
    ft.startedAt = t.startedAt; ft.sessionId = t.sessionId; ft.attempts = t.attempts;
    if (!resuming) delete ft.windowPctUsed;
    delete ft.error; delete ft.summary;
  });

  // A prepared spec folder (from `trac add --prep`, or detected on disk at the
  // conventional path) is authoritative and offline-complete — point the run at
  // it. Hand-made folders referenced inline in the task text still work as-is.
  let specDir = t.specDir && fs.existsSync(t.specDir) ? t.specDir : null;
  if (!specDir && fs.existsSync(path.join(SPECS_DIR, t.id))) specDir = path.join(SPECS_DIR, t.id);
  if (specDir) t.specDir = specDir;

  const quotaBefore = await fetchQuota();
  const specNote = specDir
    ? `A prepared spec folder exists at ${specDir}. Read SPEC.md there FIRST and treat it ` +
      `as authoritative; asset files referenced by it are in that folder.\n\n`
    : "";
  const resumeNote = resuming
    ? `You are RESUMING this task. A previous attempt was ${priorStatus === "paused" ? "paused because the subscription quota ran out" : priorStatus === "interrupted" ? "interrupted" : "cut short"}. ` +
      `Everything you did so far is on this branch: run git log ${base}..HEAD and git status before anything else, ` +
      `then continue from where you left off. Do not start over and do not redo committed work.\n\n`
    : "";
  const wrapper =
    resumeNote +
    specNote +
    `${t.spec}\n\n` +
    `Rules: you are running unattended in a dedicated git worktree (${worktree}) on branch ${branch}. ` +
    `Work only inside this directory. Commit your work with clear messages as you go. ` +
    (t.mode === "analyze"
      ? `This is an ANALYSIS task: do not modify project code — write your findings to REPORT.md and commit it.`
      : `When done, ensure the work is committed. Do not push.`);

  const tools = t.mode === "analyze"
    ? "Read,Glob,Grep,LS,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Write(REPORT.md),Bash(git add:*),Bash(git commit:*)"
    : "Edit,Write,Read,Glob,Grep,LS,NotebookEdit,Bash";

  let result = { ok: false, summary: "", turns: 0 };
  if (dry) {
    fs.writeFileSync(path.join(worktree, "DRYRUN.md"), `dry run for ${t.id}\n`);
    execSync(`git -C ${JSON.stringify(worktree)} add -A && git -C ${JSON.stringify(worktree)} commit -qm "trac dry run"`, { stdio: "ignore", shell: "/bin/zsh" });
    result = { ok: true, summary: "(dry run — no Claude invocation)", turns: 0 };
  } else {
    result = await runClaude(wrapper, worktree, tools, t.mode, { manual, sessionId: t.sessionId, resume: resuming });
  }

  const commits = parseInt(execSync(
    `git -C ${JSON.stringify(worktree)} rev-list --count ${base}..${branch}`,
    { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), 10) || 0;

  const reportSrc = path.join(worktree, "REPORT.md");
  if (t.mode === "analyze" && fs.existsSync(reportSrc)) {
    fs.copyFileSync(reportSrc, path.join(REPORT_DIR, `${t.id}.md`));
    t.report = path.join(REPORT_DIR, `${t.id}.md`);
  }

  const quotaAfter = await fetchQuota();
  if (quotaBefore && quotaAfter) {
    const used = Math.max(0, Math.round(quotaAfter.five_hour.utilization - quotaBefore.five_hour.utilization));
    t.windowPctUsed = (resuming ? t.windowPctUsed || 0 : 0) + used;
  }

  // Did the run stop because the window ran out? Either claude said so, or the
  // live gauge reads capped right after a failure. Then the task is paused, not
  // failed: the daemon resumes it once the window resets and the reserve fits.
  const finished = result.ok && (commits > 0 || t.mode === "analyze");
  const quotaHit = !dry && !result.interrupted && !finished &&
    (QUOTA_RE.test(`${result.error || ""} ${result.summary || ""}`) ||
     (quotaAfter && quotaAfter.five_hour.utilization >= 99));
  const canResume = quotaHit && t.attempts <= RESUME_MAX;

  t.commits = commits;
  t.summary = (result.summary || "").slice(0, 400);
  t.endedAt = new Date().toISOString();
  t.status = result.interrupted ? "interrupted" : canResume ? "paused" : finished ? "done" : "failed";
  if (!result.ok && result.error) t.error = result.error.slice(0, 200);
  if (quotaHit && !canResume) t.error = `paused ${RESUME_MAX} times by quota and still not done, giving up`;
  if (t.status === "paused") { t.pausedAt = t.endedAt; delete t.error; } else delete t.pausedAt;
  t.reported = t.status === "paused"; // a pause is transient, not a morning item

  // Nothing the agent wrote is lost while it waits: snapshot uncommitted edits
  // onto the branch so a later fresh start or a review sees them.
  if ((t.status === "paused" || t.status === "interrupted") && !dry) {
    try {
      if (execSync(`git -C ${JSON.stringify(worktree)} status --porcelain`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()) {
        execSync(`git -C ${JSON.stringify(worktree)} add -A && git -C ${JSON.stringify(worktree)} -c user.name=trac -c user.email=trac@local commit -q --no-verify -m ${JSON.stringify(`trac: checkpoint, ${t.status} after attempt ${t.attempts}`)}`, { stdio: "ignore", shell: "/bin/zsh" });
        t.commits = commits + 1;
      }
    } catch {}
  }

  if (t.status === "done" && t.push && commits > 0 && !dry) {
    try {
      execSync(`git -C ${JSON.stringify(worktree)} push -u origin ${branch}`, { stdio: "ignore", timeout: 60000 });
      t.pushed = true;
      if (t.pr) {
        const out = execSync(
          `cd ${JSON.stringify(worktree)} && gh pr create --draft --title ${JSON.stringify("[trac] " + t.spec.slice(0, 60))} --body ${JSON.stringify("Generated overnight by Trac.\n\nTask: " + t.spec)}`,
          { stdio: ["ignore", "pipe", "ignore"], shell: "/bin/zsh", timeout: 60000 }).toString().trim();
        t.prUrl = out.split("\n").pop();
      }
    } catch (e) { t.pushError = String(e).slice(0, 120); }
  }
  // Persist completion onto the freshest record — do NOT write back the stale db
  // captured before the (minutes-long) Claude run, or concurrent tasks vanish.
  mutateTasks((fresh) => {
    const ft = fresh.tasks.find((x) => x.id === task.id);
    if (!ft) return;
    ft.commits = t.commits; ft.summary = t.summary; ft.endedAt = t.endedAt;
    ft.status = t.status; ft.reported = t.reported;
    ft.branch = t.branch; ft.worktree = t.worktree; ft.base = t.base;
    ft.sessionId = t.sessionId; ft.attempts = t.attempts;
    if (t.pausedAt) ft.pausedAt = t.pausedAt; else delete ft.pausedAt;
    if (t.error !== undefined) ft.error = t.error; else delete ft.error;
    if (t.report) ft.report = t.report;
    if (t.windowPctUsed != null) ft.windowPctUsed = t.windowPctUsed;
    if (t.specDir) ft.specDir = t.specDir;
    if (t.pushed) ft.pushed = t.pushed;
    if (t.prUrl) ft.prUrl = t.prUrl;
    if (t.pushError) ft.pushError = t.pushError;
    Object.assign(t, ft); // return value reflects the persisted record
  });
  return t;
}

// Resolve the claude binary once — launchd spawns us with a bare PATH
// (/bin:/usr/bin:...), so a bare "claude" ENOENTs even when it's installed.
let _claudeBin = null;
function claudeBin() {
  if (_claudeBin) return _claudeBin;
  try {
    const w = execSync('/bin/zsh -lc "which claude"', { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (w && fs.existsSync(w)) return (_claudeBin = w);
  } catch {}
  for (const c of [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".claude", "local", "claude"),
    path.join(os.homedir(), ".local", "bin", "claude"),
  ]) if (fs.existsSync(c)) return (_claudeBin = c);
  return (_claudeBin = "claude"); // last resort — will ENOENT with a clear error
}

// Headless Claude with wall-clock timeout and stop-on-human-activity
function runClaude(prompt, cwd, tools, mode, { manual = false, timeoutMin = TASK_TIMEOUT_MIN, maxTurns = 60, sessionId = null, resume = false } = {}) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", String(maxTurns), "--allowedTools", tools];
    if (mode === "build") args.push("--permission-mode", "acceptEdits");
    // First attempt names the session; later attempts continue it with full context.
    if (sessionId) args.push(resume ? "--resume" : "--session-id", sessionId);
    const child = spawn(claudeBin(), args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let out = "", err = "", finished = false, interrupted = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // Scheduler-dispatched runs yield to the human; manual runs don't —
    // the user explicitly asked for this one while at the keyboard.
    const killer = manual ? null : setInterval(() => {
      if (hidIdleSeconds() < 60) {
        interrupted = true;
        child.kill("SIGTERM");
      }
    }, 60000);
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMin * 60000);
    child.on("close", () => {
      if (finished) return;
      finished = true;
      if (killer) clearInterval(killer); clearTimeout(timeout);
      try {
        const j = JSON.parse(out);
        resolve({ ok: !j.is_error, summary: j.result || "", turns: j.num_turns || 0, interrupted });
      } catch {
        resolve({ ok: false, error: (err || out).slice(-300) || "no output", interrupted });
      }
    });
    child.on("error", (e) => {
      if (finished) return;
      finished = true;
      if (killer) clearInterval(killer); clearTimeout(timeout);
      resolve({ ok: false, error: `could not start claude: ${e.message}` });
    });
  });
}

function pickTask(sessionPct) {
  const db = loadTasks();
  // A paused task is half done and holds a worktree: finish it before starting new work.
  const rank = (t) => (t.status === "paused" ? 0 : 1);
  return db.tasks
    .filter((t) => (t.status === "queued" || t.status === "paused") && sessionPct + t.budget <= RESERVE_PCT)
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || a.id.localeCompare(b.id))[0];
}

async function cmdRun(rest) {
  const dry = rest.includes("--dry");
  const fresh = rest.includes("--fresh");
  const id = rest.find((a) => /^t\d+$/.test(a));
  const quota = await fetchQuota();
  const sessionPct = quota ? quota.five_hour.utilization : 100;
  let task;
  if (id) {
    task = loadTasks().tasks.find((t) => t.id === id && ["queued", "paused", "interrupted", "failed"].includes(t.status));
    if (!task) { console.error(`no runnable task ${id}`); process.exit(1); }
    if (!dry && sessionPct + task.budget > RESERVE_PCT)
      console.log(C.orange(`  warning: session at ${Math.round(sessionPct)}%, task budget ${task.budget}% breaches the ${RESERVE_PCT}% reserve — running anyway (manual)`));
  } else {
    task = pickTask(dry ? 0 : sessionPct);
    if (!task) { console.log("  nothing runnable (queue empty, or no task fits current headroom)"); return; }
  }
  const willResume = !fresh && task.sessionId && task.worktree && fs.existsSync(task.worktree);
  console.log(`  ${willResume ? "resuming" : "dispatching"} ${C.bold(task.id)}${dry ? " (dry)" : ""}${fresh ? " (fresh)" : ""}: ${titleOf(task).slice(0, 70)}`);
  const t = await dispatch(task, { dry, manual: true, fresh });
  const line = t.status === "done"
    ? `done — ${t.commits} commit(s) on ${t.branch}${t.windowPctUsed != null ? ` · ${t.windowPctUsed}% window used` : ""}${t.prUrl ? ` · ${t.prUrl}` : ""}`
    : t.status === "paused"
    ? `paused — quota exhausted after attempt ${t.attempts}; ${t.commits} commit(s) kept on ${t.branch}, resumes when the window resets`
    : `${t.status}${t.error ? ` — ${t.error}` : ""}`;
  console.log(`  ${t.status === "done" ? C.green(line) : t.status === "paused" ? C.orange(line) : C.red(line)}`);
  if (t.report) console.log(C.dim(`  report: ${t.report}`));
}

// ── Scheduler tick (launchd, every 15 min) ──────────────────────────────────
async function cmdDaemonTick(events) {
  const lock = path.join(SPARE_DIR, "daemon.lock");
  try {
    const pid = parseInt(fs.readFileSync(lock, "utf8"), 10);
    if (pid && !Number.isNaN(pid)) { try { process.kill(pid, 0); return; } catch {} } // stale lock → continue
  } catch {}
  fs.mkdirSync(SPARE_DIR, { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  try {
    // morning report notification (once per day, first tick after 7am)
    const st = loadState("state.json", {});
    const today = new Date().toDateString();
    const unreported = loadTasks().tasks.filter((t) => !t.reported && ["done", "failed", "interrupted"].includes(t.status));
    if (unreported.length && st.lastMorning !== today && new Date().getHours() >= 7) {
      st.lastMorning = today;
      saveState("state.json", st);
      const done = unreported.filter((t) => t.status === "done").length;
      try {
        execSync(`osascript -e 'display notification ${JSON.stringify(`Overnight: ${done} done, ${unreported.length - done} other. Run: trac morning`)} with title "Trac"'`, { stdio: "ignore" });
      } catch {}
    }

    // dispatch gates — every one must pass
    const quota = await fetchQuota();
    if (!quota) return;                                       // no ground truth → don't spend
    if (quota.seven_day.utilization >= WEEK_MAX_PCT) return;  // save the week
    if (humanActive()) return;                                // never compete with the human
    const task = pickTask(quota.five_hour.utilization);       // fits under reserve?
    if (!task) return;
    const t = await dispatch(task);
    try {
      execSync(`osascript -e 'display notification ${JSON.stringify(`${t.id} ${t.status}: ${titleOf(t).slice(0, 60)}`)} with title "Trac"'`, { stdio: "ignore" });
    } catch {}
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}

function cmdDaemon(rest) {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.trac.daemon.plist");
  if (rest.includes("uninstall")) {
    try { execSync(`launchctl bootout gui/$(id -u)/com.trac.daemon`, { stdio: "ignore", shell: "/bin/zsh" }); } catch {}
    try { fs.unlinkSync(plistPath); } catch {}
    console.log("  daemon uninstalled");
    return;
  }
  const self = fileURLToPathSafe();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.trac.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${self}</string>
    <string>daemon-tick</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>ProcessType</key><string>Background</string>
</dict></plist>`;
  fs.writeFileSync(plistPath, plist);
  try { execSync(`launchctl bootout gui/$(id -u)/com.trac.daemon 2>/dev/null; launchctl bootstrap gui/$(id -u) ${JSON.stringify(plistPath)}`, { stdio: "ignore", shell: "/bin/zsh" }); } catch {}
  console.log(`  daemon installed — checks every 15 min (reserve ${RESERVE_PCT}%, idle ${IDLE_MIN}min, week cap ${WEEK_MAX_PCT}%)`);
}

function fileURLToPathSafe() {
  return new URL(import.meta.url).pathname;
}

function cmdMorning() {
  const db = loadTasks();
  const unreported = db.tasks.filter((t) => !t.reported && ["done", "failed", "interrupted"].includes(t.status));
  if (!unreported.length) { console.log("\n  nothing new since last report\n"); return; }
  console.log(C.bold("\n  trac — since you were away\n"));
  for (const t of unreported) {
    if (t.status === "done") {
      console.log(`  ${C.green("●")} ${C.bold(t.id)} ${titleOf(t).slice(0, 60)}`);
      console.log(`     ${t.commits} commit(s) on ${C.bold(t.branch)}${t.windowPctUsed != null ? C.dim(` · ${t.windowPctUsed}% window`) : ""}${t.prUrl ? `\n     PR: ${t.prUrl}` : ""}`);
      if (t.report) console.log(C.dim(`     report: ${t.report}`));
      console.log(C.dim(`     review: git -C ${t.repo} diff ${t.base}..${t.branch}`));
    } else {
      console.log(`  ${C.red(t.status === "failed" ? "✗" : "◑")} ${C.bold(t.id)} ${titleOf(t).slice(0, 60)} — ${t.status}${t.error ? ": " + t.error.slice(0, 80) : ""}`);
    }
  }
  const ids = unreported.map((t) => t.id);
  mutateTasks((fresh) => { for (const ft of fresh.tasks) if (ids.includes(ft.id)) ft.reported = true; });
  console.log();
}

// ── Dashboard: trac ui ──────────────────────────────────────────────────────
import http from "node:http";

const UI_PORT = 7433;

function taskCounts() {
  const ts = loadTasks().tasks;
  return {
    queued: ts.filter((t) => t.status === "queued" || t.status === "paused").length,
    running: ts.filter((t) => t.status === "running").length,
    done: ts.filter((t) => t.status === "done").length,
  };
}

// One-click merge that never gets stuck: preserve any local work, then merge
// the task branch auto-resolving conflicts in its favor. Returns { ok, error }.
function mergeTaskBranch(t, g) {
  const q = JSON.stringify(t.repo);
  const ident = `-c user.name=trac -c user.email=trac@local`;
  // 1. A dirty tree would abort the merge ("local/untracked files would be
  //    overwritten"). Commit it first so the merge is a clean 3-way and the
  //    snapshot is recoverable in history — nothing is ever lost.
  if (g(`git -C ${q} status --porcelain`).trim()) {
    g(`git -C ${q} add -A`);
    g(`git -C ${q} ${ident} commit --no-verify -m ${JSON.stringify("trac: snapshot local work before merging " + t.branch)}`);
  }
  // 2. Merge, resolving textual conflicts in favor of the task branch. Non-
  //    conflicting changes on both sides are still kept by the recursive merge.
  try {
    g(`git -C ${q} merge --no-ff --no-edit -X theirs ${t.branch}`);
  } catch (e) {
    // Rare leftovers -X theirs can't settle (add/add binaries, rename/delete).
    // Take the branch's version of every unmerged path and finish the commit.
    try {
      g(`git -C ${q} checkout --theirs -- . 2>/dev/null || true`);
      g(`git -C ${q} add -A`);
      g(`git -C ${q} ${ident} commit --no-verify --no-edit`);
    } catch (e2) {
      try { g(`git -C ${q} merge --abort`); } catch {}
      return { ok: false, error: "merge could not auto-resolve: " + String(e.stderr || e.message || e).slice(0, 160) };
    }
  }
  return { ok: true };
}

function uiAction(id, action) {
  const g = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], shell: "/bin/zsh" }).toString();

  // 'run' only spawns the detached dispatcher (which persists via its own lock);
  // it mutates nothing here, so read fresh without holding the lock across a spawn.
  if (action === "run") {
    const t = loadTasks().tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: "no such task" };
    if (!["queued", "paused", "deferred", "failed", "interrupted"].includes(t.status))
      return { ok: false, error: `cannot run a ${t.status} task` };
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "run", t.id], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true };
  }

  // Everything else is a read-modify-write on the store — do it under the lock,
  // on the freshest copy, so a concurrent daemon/dispatch write can't clobber it.
  return mutateTasks((db) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: "no such task" };
    try {
      if (action === "defer" && ["queued", "paused", "failed", "interrupted"].includes(t.status)) t.status = "deferred";
      else if (action === "requeue" && ["deferred", "paused", "failed", "interrupted", "discarded"].includes(t.status)) {
        t.status = "queued"; delete t.error; // keeps sessionId + worktree, so the next run resumes
      } else if (action === "restart" && ["deferred", "paused", "failed", "interrupted", "discarded"].includes(t.status)) {
        // Start over: drop the conversation and the branch's partial work.
        if (t.worktree) { try { g(`git -C ${JSON.stringify(t.repo)} worktree remove --force ${JSON.stringify(t.worktree)}`); } catch {} delete t.worktree; }
        delete t.sessionId; delete t.attempts; delete t.error; delete t.pausedAt;
        t.status = "queued";
      } else if (action === "merge" && t.status === "done" && t.branch) {
        const r = mergeTaskBranch(t, g);
        if (!r.ok) return r;
        if (t.worktree) { try { g(`git -C ${JSON.stringify(t.repo)} worktree remove --force ${JSON.stringify(t.worktree)}`); } catch {} delete t.worktree; }
        t.status = "merged";                        // kept in Completed so it can be reverted
        t.mergeCommit = g(`git -C ${JSON.stringify(t.repo)} rev-parse HEAD`).trim();
        t.mergedAt = Date.now();
        return { ok: true };
      } else if (action === "revert" && t.status === "merged" && t.mergeCommit) {
        const q = JSON.stringify(t.repo);
        const ident = `-c user.name=trac -c user.email=trac@local`;
        // Snapshot any local work first so the revert can't be blocked by a dirty tree.
        if (g(`git -C ${q} status --porcelain`).trim()) {
          g(`git -C ${q} add -A`);
          g(`git -C ${q} ${ident} commit --no-verify -m ${JSON.stringify("trac: snapshot local work before reverting " + t.id)}`);
        }
        try {
          // -m 1: undo the branch's changes, keep mainline (the merge was --no-ff, so it's a real merge commit).
          g(`git -C ${q} ${ident} revert -m 1 --no-edit ${t.mergeCommit}`);
        } catch (e) {
          try { g(`git -C ${q} revert --abort`); } catch {}
          return { ok: false, error: "revert hit conflicts, resolve manually: " + String(e.stderr || e.message || e).slice(0, 160) };
        }
        t.status = "reverted";
        t.revertCommit = g(`git -C ${q} rev-parse HEAD`).trim();
        t.revertedAt = Date.now();
        return { ok: true };
      } else if (action === "discard") {
        if (t.worktree) { try { g(`git -C ${JSON.stringify(t.repo)} worktree remove --force ${JSON.stringify(t.worktree)}`); } catch {} }
        if (t.branch) { try { g(`git -C ${JSON.stringify(t.repo)} branch -D ${t.branch}`); } catch {} }
        db.tasks = db.tasks.filter((x) => x.id !== id);
        return { ok: true };
      } else return { ok: false, error: `cannot ${action} a ${t.status} task` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.stderr || e.message || e).slice(0, 300) };
    }
  });
}

async function cmdUi(rest) {
  let evCache = { t: 0, events: [] }; // transcript parse is ~0.7s; refresh at most 1/min
  async function gauges() {
    const now = Date.now();
    const quota = await fetchQuota();
    if (quota) {
      return {
        source: "live",
        session: { pct: Math.round(quota.five_hour.utilization), resetsAt: quota.five_hour.resets_at },
        week: { pct: Math.round(quota.seven_day.utilization), resetsAt: quota.seven_day.resets_at },
        extra: extraFrom(quota),
      };
    }
    if (now - evCache.t > 60000) evCache = { t: now, events: await collectEvents() };
    const events = evCache.events;
    const windows = buildWindows(events);
    const cur = windows.at(-1);
    const active = cur && now < cur.end ? cur : null;
    const cap = calibratedCap("session") || Math.max(...windows.map((w) => w.cost), 0.01);
    const weekCap = calibratedCap("week");
    const weekCost = sum(events.filter((e) => e.t >= now - 7 * 86400000), (e) => e.cost);
    return {
      source: "estimate",
      session: { pct: active ? Math.min(100, Math.round((active.cost / cap) * 100)) : 0, resetsAt: active ? new Date(active.end).toISOString() : null },
      week: weekCap ? { pct: Math.min(100, Math.round((weekCost / weekCap) * 100)), resetsAt: null } : null,
      extra: null, // no live quota → no extra-usage figures
    };
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "Content-Type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/") return send(200, UI_HTML, "text/html");
      if (req.method === "GET" && url.pathname === "/api/state") {
        const g = await gauges();
        const tasks = loadTasks().tasks.map((t) => ({ ...t, title: titleOf(t) }));
        return send(200, { plan: readPlan(), ...g, tasks });
      }
      if (req.method === "GET" && url.pathname === "/api/report") {
        const t = loadTasks().tasks.find((x) => x.id === url.searchParams.get("id"));
        if (!t?.report || !fs.existsSync(t.report)) return send(404, { error: "no report" });
        return send(200, fs.readFileSync(t.report, "utf8"), "text/plain");
      }
      if (req.method === "GET" && url.pathname === "/api/diff") {
        const t = loadTasks().tasks.find((x) => x.id === url.searchParams.get("id"));
        if (!t?.branch) return send(404, { error: "no branch" });
        try {
          const stat = execSync(`git -C ${JSON.stringify(t.repo)} diff --stat ${t.base}..${t.branch}`, { stdio: ["ignore", "pipe", "pipe"] }).toString();
          const patch = execSync(`git -C ${JSON.stringify(t.repo)} diff ${t.base}..${t.branch}`, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4e6 }).toString();
          const lines = patch.split("\n");
          return send(200, stat + "\n" + lines.slice(0, 500).join("\n") + (lines.length > 500 ? "\n… (truncated)" : ""), "text/plain");
        } catch (e) { return send(500, { error: String(e).slice(0, 200) }); }
      }
      if (req.method === "POST" && url.pathname === "/api/action") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { id, action } = JSON.parse(body || "{}");
        return send(200, uiAction(id, action));
      }
      send(404, { error: "not found" });
    } catch (e) { send(500, { error: String(e).slice(0, 200) }); }
  });
  server.listen(UI_PORT, "127.0.0.1", () => {
    console.log(`  trac ui → http://localhost:${UI_PORT}`);
    if (!rest.includes("--no-open")) {
      try { execSync(`open http://localhost:${UI_PORT}`, { stdio: "ignore" }); } catch {}
    }
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.log(`  already running → http://localhost:${UI_PORT}`);
      try { if (!rest.includes("--no-open")) execSync(`open http://localhost:${UI_PORT}`, { stdio: "ignore" }); } catch {}
      process.exit(0);
    } else { console.error(e.message); process.exit(1); }
  });
}

const UI_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Trac</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --orange: #FF6A00; --red: #FF3B30; --green: #34C759;
    --text: #111111; --sub: #999999; --faint: #C7C7CC;
    --font: 'Avenir Next', 'Avenir', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  html { scrollbar-width: none; } html::-webkit-scrollbar { display: none; }
  body { font-family: var(--font); font-size: 14px; line-height: 1.5; background: #FFFFFF; color: var(--text); -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 600px; margin: 0 auto; padding: 0 32px 120px; }
  header { display: flex; align-items: baseline; gap: 14px; padding: 60px 0 6px; }
  h1 { font-size: 28px; font-weight: 400; font-family: 'EB Garamond', Georgia, serif; }
  .plan { color: var(--sub); font-size: 12px; }
  .gauges { display: flex; gap: 20px; margin: 12px 0 28px; font-size: 12px; color: var(--sub); }
  .gauge b { font-size: 12px; color: var(--text); font-weight: 400; }
  .gbar { display: inline-block; width: 96px; height: 4px; border-radius: 2px; background: #EEEEEE; vertical-align: middle; margin: 0 8px 2px; overflow: hidden; }
  .gbar i { display: block; height: 100%; border-radius: 2px; background: var(--green); }
  .gbar i.warn { background: var(--orange); } .gbar i.hot { background: var(--red); }
  .tabs { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
  .tab { border: 1px solid #EEEEEE; background: #fff; border-radius: 20px; padding: 6px 14px; font-size: 12px; cursor: pointer; color: var(--sub); transition: background .12s, color .12s; }
  .tab:hover { background: #EEEEEE; color: var(--text); }
  .tab.on { background: #111111; color: #fff; border-color: #111111; }
  .tab .n { opacity: .5; margin-left: 4px; }
  .card { padding: 17px 0; border-radius: 20px; }
  .card + .card { border-top: 1px solid rgba(0,0,0,.05); }
  .row1 { display: flex; gap: 10px; align-items: baseline; }
  .tid { font-family: ui-monospace, monospace; font-size: 11px; color: var(--faint); }
  .spec { font-size: 16px; letter-spacing: -0.01em; flex: 1; }
  .st { font-size: 12px; padding: 6px 12px; border-radius: 20px; white-space: nowrap; line-height: 1; }
  .st-queued { background: rgba(0,0,0,.05); color: var(--sub); }
  .st-running { background: rgba(255,106,0,.1); color: var(--orange); }
  .st-done { background: rgba(52,199,89,.1); color: var(--green); }
  .st-merged { background: rgba(52,199,89,.1); color: var(--green); }
  .st-reverted { background: rgba(0,0,0,.05); color: var(--sub); }
  .st-deferred { background: rgba(0,0,0,.05); color: var(--faint); }
  .st-failed, .st-interrupted { background: rgba(255,59,48,.1); color: var(--red); }
  .st-paused { background: rgba(255,106,0,.1); color: var(--orange); }
  .st-discarded { background: rgba(0,0,0,.03); color: var(--faint); }
  .meta { font-size: 12px; color: var(--sub); margin-top: 4px; }
  .meta code { font-family: ui-monospace, monospace; font-size: 11px; }
  .meta a { color: var(--orange); text-decoration: none; }
  .err { font-size: 12px; color: var(--red); margin-top: 4px; }
  .acts { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { border: 1px solid #EEEEEE; background: #fff; border-radius: 20px; padding: 7px 16px; font-size: 12px; font-family: var(--font); cursor: pointer; color: var(--sub); transition: background .12s, opacity .12s; line-height: 1; }
  button:hover { background: #EEEEEE; }
  button.primary { background: #111111; color: #fff; border-color: #111111; }
  button.primary:hover { opacity: .82; background: #111111; }
  button.danger { color: var(--red); border-color: rgba(255,59,48,.25); }
  button.danger:hover { background: rgba(255,59,48,.06); }
  pre { background: #FAFAFA; border: 1px solid #EEEEEE; border-radius: 12px; padding: 12px; font-size: 11px; overflow-x: auto; margin-top: 12px; max-height: 420px; overflow-y: auto; white-space: pre-wrap; }
  .empty { color: var(--faint); text-align: center; padding: 60px 0; font-size: 13px; }
  .flash { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #111111; color: #fff; border-radius: 20px; padding: 9px 18px; font-size: 12px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .flash.on { opacity: 1; }
</style></head><body>
<div class="wrap">
  <header><h1>Trac</h1><span class="plan" id="plan"></span></header>
  <div class="gauges" id="gauges"></div>
  <div class="tabs" id="tabs"></div>
  <div id="list"></div>
</div>
<div class="flash" id="flash"></div>
<script>
const TABS = [
  ["active", "Active", t => ["queued","paused","running","deferred"].includes(t.status)],
  ["review", "To review", t => ["done","failed","interrupted"].includes(t.status)],
  ["completed", "Completed", t => ["merged","reverted"].includes(t.status)],
];
let state = { tasks: [] }, tab = "active", open = {};

function flash(msg) {
  const el = document.getElementById("flash");
  el.textContent = msg; el.classList.add("on");
  setTimeout(() => el.classList.remove("on"), 2200);
}
async function act(id, action) {
  if (action === "revert" && !confirm("Revert " + id + "? This undoes the merge with a new revert commit in the repo.")) return;
  const r = await fetch("/api/action", { method: "POST", body: JSON.stringify({ id, action }) }).then(r => r.json());
  flash(r.ok ? action + " \\u2713" : (r.error || "failed"));
  load();
}
async function toggle(id, kind) {
  const key = id + kind;
  if (open[key]) { delete open[key]; render(); return; }
  const r = await fetch("/api/" + kind + "?id=" + id);
  open[key] = r.ok ? await r.text() : "unavailable";
  render();
}
function esc(s) { return (s || "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function gbar(pct) {
  const cls = pct >= 80 ? "hot" : pct >= 50 ? "warn" : "";
  return '<span class="gbar"><i class="' + cls + '" style="width:' + Math.min(100, pct) + '%"></i></span>';
}
function render() {
  document.getElementById("plan").textContent = state.plan || "";
  const g = document.getElementById("gauges");
  g.innerHTML = state.session
    ? '<span class="gauge">Session' + gbar(state.session.pct) + '<b>' + state.session.pct + '%</b></span>' +
      (state.week ? '<span class="gauge">Week' + gbar(state.week.pct) + '<b>' + state.week.pct + '%</b></span>' : '') +
      (state.source === "estimate" ? '<span class="gauge" style="color:var(--faint)">estimated</span>' : '')
    : '<span class="gauge">quota unavailable</span>';
  document.getElementById("tabs").innerHTML = TABS.map(([id, label, f]) =>
    '<div class="tab ' + (tab === id ? "on" : "") + '" onclick="tab=\\'' + id + '\\';render()">' + label +
    '<span class="n">' + state.tasks.filter(f).length + '</span></div>').join("");
  const f = TABS.find(([id]) => id === tab)[2];
  const ts = state.tasks.filter(f).slice().reverse();
  document.getElementById("list").innerHTML = ts.length ? ts.map(card).join("") :
    '<div class="empty">nothing here</div>';
}
function card(t) {
  const b = [];
  if (t.status === "queued") b.push(btn(t, "run", "Run now", "primary"), btn(t, "defer", "Defer"), btn(t, "discard", "Remove", "danger"));
  if (t.status === "paused") b.push(btn(t, "run", "Resume now", "primary"), btn(t, "defer", "Defer"), btn(t, "restart", "Start over"), btn(t, "discard", "Remove", "danger"));
  if (t.status === "deferred") b.push(btn(t, "requeue", "Requeue", "primary"), btn(t, "discard", "Remove", "danger"));
  if (t.status === "done") {
    b.push(btn(t, "merge", "Merge", "primary"));
    b.push('<button onclick="toggle(\\'' + t.id + '\\',\\'diff\\')">Diff</button>');
    if (t.report) b.push('<button onclick="toggle(\\'' + t.id + '\\',\\'report\\')">Report</button>');
    b.push(btn(t, "discard", "Discard", "danger"));
  }
  if (["failed", "interrupted"].includes(t.status)) b.push(btn(t, "requeue", t.sessionId ? "Resume" : "Retry", "primary"), btn(t, "restart", "Start over"), btn(t, "discard", "Discard", "danger"));
  if (t.status === "merged") {
    b.push(btn(t, "revert", "Revert", "danger"));
    b.push(btn(t, "discard", "Dismiss"));
  }
  if (t.status === "reverted") b.push(btn(t, "discard", "Dismiss"));
  const meta = [t.repo.split("/").pop(), t.mode, "p" + t.priority,
    t.commits ? t.commits + " commits" : null,
    t.mergeCommit ? "merged " + t.mergeCommit.slice(0, 7) : null,
    t.revertCommit ? "reverted " + t.revertCommit.slice(0, 7) : null,
    t.windowPctUsed != null ? t.windowPctUsed + "% window" : null,
    t.branch ? "<code>" + esc(t.branch) + "</code>" : null,
    t.prUrl ? '<a href="' + t.prUrl + '" target="_blank">PR</a>' : null,
  ].filter(Boolean).join(" \\u00b7 ");
  return '<div class="card"><div class="row1"><span class="tid">' + t.id + '</span>' +
    '<span class="spec">' + esc(t.title || t.spec) + '</span><span class="st st-' + t.status + '">' + t.status + '</span></div>' +
    '<div class="meta">' + meta + '</div>' +
    (t.summary && ["done","failed"].includes(t.status) ? '<div class="meta">' + esc(t.summary.slice(0, 200)) + '</div>' : '') +
    (t.error ? '<div class="err">' + esc(t.error) + '</div>' : '') +
    (b.length ? '<div class="acts">' + b.join("") + '</div>' : '') +
    (open[t.id + "diff"] ? '<pre>' + esc(open[t.id + "diff"]) + '</pre>' : '') +
    (open[t.id + "report"] ? '<pre>' + esc(open[t.id + "report"]) + '</pre>' : '') +
    '</div>';
}
function btn(t, action, label, cls) {
  return '<button class="' + (cls || "") + '" onclick="act(\\'' + t.id + '\\',\\'' + action + '\\')">' + label + '</button>';
}
async function load() {
  try {
    state = await fetch("/api/state").then(r => r.json());
    render();
  } catch { document.getElementById("gauges").textContent = "server gone \\u2014 restart with: trac ui"; }
}
load();
setInterval(load, 10000);
</script>
</body></html>`;

// ── Main ────────────────────────────────────────────────────────────────────
const [, , cmd = "status", ...rest] = process.argv;
const daysFlag = rest.indexOf("--days");
const days = daysFlag >= 0 ? Math.max(1, parseInt(rest[daysFlag + 1], 10) || 14) : 14;

const needsEvents = ["status", "report", "json", "export", "daemon-tick"].includes(cmd);
const events = needsEvents ? await collectEvents() : [];
if (needsEvents && cmd !== "daemon-tick" && events.length === 0) {
  console.error("No Claude Code usage found in ~/.claude/projects — nothing to report.");
  process.exit(1);
}

if (cmd === "status") await cmdStatus(events);
else if (cmd === "report") cmdReport(events, days);
else if (cmd === "json") await cmdJson(events);
else if (cmd === "export") cmdExport(events, days);
else if (cmd === "add") await cmdTaskAdd(rest);
else if (cmd === "tasks") cmdTaskList();
else if (cmd === "rm") cmdTaskRm(rest[0]);
else if (cmd === "run") await cmdRun(rest);
else if (cmd === "daemon-tick") await cmdDaemonTick(events);
else if (cmd === "daemon") cmdDaemon(rest);
else if (cmd === "morning") cmdMorning();
else if (cmd === "ui") await cmdUi(rest);
else {
  console.log(`usage:
  trac status | report [--days N] | json | export [--days N]
  trac add "<spec>" [--repo <path>] [-p N] [--budget N] [--analyze] [--push] [--pr] [--prep]
  trac tasks | rm <id> | run [id] [--dry] [--fresh] | morning
  trac daemon [uninstall]`);
  process.exit(1);
}
