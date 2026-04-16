/**
 * Migri appointment slot monitor — single-file poller.
 * Reads APPOINTMENT1, APPOINTMENT2, ... as key:pin:type[:minDate] (see .env.example).
 * AUTHCHECK for management APIs comes from POST .../allocations/key/<key>/pintest (Set-Cookie).
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const BASE = "https://migri.vihta.com/public/migri/api";

const DEFAULT_OFFICE_ID = "438cd01e-9d81-40d9-b31d-5681c11bd974";
const LOG_TIME_ZONE = "Europe/Helsinki";

/** Finnish permanent residence permit */
const SERVICE_ID_PRP = "3e03034d-a44b-4771-b1e5-2c4a6f581b7d";
/** Finnish residence permit on basis of work */
const SERVICE_ID_WORK = "2906a690-4c8c-4276-bf2b-19b8cf2253f3";

const SERVICE_ID_BY_TYPE = {
  prp: SERVICE_ID_PRP,
  work: SERVICE_ID_WORK,
};

function isValidYyyyMmDd(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}

function parseAppointments() {
  const list = [];
  const defaultMinDate = helsinkiDateYyyyMmDd(new Date());
  for (let i = 1; ; i++) {
    const raw = process.env[`APPOINTMENT${i}`];
    if (raw === undefined || String(raw).trim() === "") break;

    const parts = String(raw).split(":");
    if (parts.length < 3) {
      console.error(`APPOINTMENT${i} must be key:pin:type[:minDate] (type is prp or work)`);
      process.exit(1);
    }

    let typePartIndex = parts.length - 1;
    let minDate = null;
    if (parts.length >= 4) {
      const maybeType = parts[parts.length - 2].trim().toLowerCase();
      const maybeMinDate = parts[parts.length - 1].trim();
      if (SERVICE_ID_BY_TYPE[maybeType]) {
        if (!isValidYyyyMmDd(maybeMinDate)) {
          console.error(`APPOINTMENT${i}: minDate must be YYYY-MM-DD when provided`);
          process.exit(1);
        }
        minDate = maybeMinDate;
        typePartIndex = parts.length - 2;
      }
    }

    if (typePartIndex < 2) {
      console.error(`APPOINTMENT${i} must be key:pin:type[:minDate]`);
      process.exit(1);
    }

    const type = parts[typePartIndex].trim().toLowerCase();
    const key = parts[0].trim();
    const pin = parts.slice(1, typePartIndex).join(":");
    const serviceId = SERVICE_ID_BY_TYPE[type];
    if (!serviceId) {
      console.error(`APPOINTMENT${i}: unknown type "${parts[typePartIndex].trim()}", use prp or work`);
      process.exit(1);
    }
    if (!key || !pin) {
      console.error(`APPOINTMENT${i}: key and pin must be non-empty`);
      process.exit(1);
    }

    list.push({ key, pin, serviceId, type, minDate: minDate || defaultMinDate });
  }

  if (list.length === 0) {
    console.error("No APPOINTMENT1, APPOINTMENT2, ... in .env (stop at first missing index)");
    process.exit(1);
  }
  return list;
}

const appointments = parseAppointments();
const officeId = process.env.MIGRI_OFFICE_ID || DEFAULT_OFFICE_ID;
const appointmentPollMs = Number(process.env.APPOINTMENT_POLL_MS) || 5 * 60 * 1000;
const slotsPollMs = Number(process.env.SLOTS_POLL_MS) || 60 * 1000;
const bestMode = process.argv.includes("--best");

/** @type {Map<string, string>} key -> ISO start time of booked appointment */
const appointmentStartByKey = new Map();
/** @type {Map<string, number>} serviceId -> ms of earliest slot seen last run */
const lastEarliestSlotMsByService = new Map();

/** stdout is building a line of "." until a non-dot line is printed */
let dotLinePending = false;
/** dots on the current line (wrap after DOT_LINE_WRAP to avoid huge lines) */
let dotCountOnLine = 0;
const DOT_LINE_WRAP = 80;

const CHANGES_LOG = path.join(__dirname, "changes.txt");
const STATUS_JSON = path.join(__dirname, "status.json");

/** @type {Map<string, string | null>} type -> latest known earliest slot ISO */
const latestEarliestSlotByType = new Map();

/** Append when this service's open-slot earliest changes vs last seen (earlier or worse), Helsinki times */
function appendEarliestChangeLog(type, oldMs, newIso) {
  const line = `${nowLogStamp()}\t${type}\t${formatApptTime(new Date(oldMs).toISOString())}\t${formatApptTime(newIso)}\n`;
  try {
    fs.appendFileSync(CHANGES_LOG, line, "utf8");
  } catch (e) {
    console.error(`[${nowLogStamp()}] changes.txt append failed:`, e.message);
  }
}

function updateEarliestByType(map, type, isoOrNull) {
  if (isoOrNull == null) {
    if (!map.has(type)) map.set(type, null);
    return;
  }
  const prev = map.get(type);
  if (prev == null || new Date(isoOrNull).getTime() < new Date(prev).getTime()) {
    map.set(type, isoOrNull);
  }
}

function buildStatusSnapshot() {
  const types = [...new Set(appointments.map((a) => a.type))];
  const earliestSlotsByType = {};
  for (const type of types) {
    const iso = latestEarliestSlotByType.has(type) ? latestEarliestSlotByType.get(type) : null;
    earliestSlotsByType[type] = {
      iso: iso || null,
      helsinki: iso ? formatApptTime(iso) : null,
    };
  }

  return {
    updatedAtHelsinki: nowLogStamp(),
    officeId,
    bestMode,
    earliestSlotsByType,
    appointments: appointments.map((a) => {
      const start = appointmentStartByKey.get(a.key) || null;
      return {
        key: a.key,
        type: a.type,
        serviceId: a.serviceId,
        minDate: a.minDate,
        startIso: start,
        startHelsinki: start ? formatApptTime(start) : null,
      };
    }),
  };
}

function writeStatusFile() {
  try {
    fs.writeFileSync(STATUS_JSON, JSON.stringify(buildStatusSnapshot(), null, 2) + "\n", "utf8");
  } catch (e) {
    console.error(`[${nowLogStamp()}] status.json write failed:`, e.message);
  }
}

let appointmentPollRunning = false;
let slotsPollRunning = false;
let firstSlotsPoll = true;

function flushDotLine() {
  if (dotLinePending) {
    process.stdout.write("\n");
    dotLinePending = false;
  }
  dotCountOnLine = 0;
}

function writeDot() {
  process.stdout.write(".");
  dotLinePending = true;
  dotCountOnLine += 1;
  if (dotCountOnLine >= DOT_LINE_WRAP) {
    process.stdout.write("\n");
    dotCountOnLine = 0;
  }
}

function formatHelsinkiTime(value, withSeconds = false) {
  const d = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOG_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  let s = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  if (withSeconds) s += `:${get("second")}`;
  return s;
}

function helsinkiDateYyyyMmDd(value) {
  const d = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOG_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** @param {string} iso ISO 8601 — display in Helsinki local time */
function formatApptTime(iso) {
  return formatHelsinkiTime(iso, false);
}

function nowLogStamp() {
  return formatHelsinkiTime(new Date(), true);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printRescheduleBanner(key, type, toIso) {
  const t = formatApptTime(toIso);
  const bar = "=".repeat(64);
  console.log(bar);
  console.log("  RESCHEDULED");
  console.log(`  ${key}  (${type})  →  ${t}`);
  console.log(bar);
}

function printMissedOpportunityBanner(key, type, toIso, minDate) {
  const t = formatApptTime(toIso);
  const bar = "!".repeat(64);
  console.log(bar);
  console.log("  MISSED OPPORTUNITY");
  console.log(`  ${key}  (${type})  →  ${t}`);
  console.log(`  Earlier slot found, but skipped because it is before min-date ${minDate}.`);
  console.log(bar);
}

function printAppointmentBestBanner(key, type, fromIso, toIso) {
  const from = formatApptTime(fromIso);
  const to = formatApptTime(toIso);
  const bar = "=".repeat(64);
  console.log(bar);
  console.log("  APPOINTMENT IMPROVED");
  console.log(`  ${key}  (${type})  ${from}  →  ${to}`);
  console.log(bar);
}

/** GET /sessions — fresh id every call (no caching). */
async function fetchSession() {
  const res = await fetch(`${BASE}/sessions`);
  if (!res.ok) throw new Error(`sessions ${res.status}`);
  const data = await res.json();
  if (!data.id) throw new Error("sessions response missing id");
  return data.id;
}

/** GET /sessions then POST pintest for this key+pin (no caching). */
async function getAuthCheck(key, pin) {
  const sessionId = await fetchSession();
  const body = new URLSearchParams({ allocation_pin: pin });
  const res = await fetch(`${BASE}/allocations/key/${encodeURIComponent(key)}/pintest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "vihta-session": sessionId,
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`pintest ${res.status}: ${text.slice(0, 200)}`);
  }
  const authcheck = authCheckFromResponse(res);
  if (!authcheck) {
    throw new Error("pintest succeeded but no Set-Cookie AUTHCHECK in response");
  }
  return { sessionId, authcheck };
}

function cookieHeader(authcheck) {
  return `AUTHCHECK=${authcheck}`;
}

/** Parse AUTHCHECK value from Set-Cookie header(s). */
function authCheckFromResponse(res) {
  const headers = res.headers;
  let cookies = [];
  if (typeof headers.getSetCookie === "function") {
    cookies = headers.getSetCookie();
  } else {
    const one = headers.get("set-cookie");
    if (one) cookies = [one];
  }
  for (const c of cookies) {
    const m = /^AUTHCHECK=([^;]+)/i.exec(String(c).trim());
    if (m) return m[1];
  }
  return null;
}

async function getAllocation(sessionId, key, authcheck) {
  const res = await fetch(`${BASE}/allocations/key/${encodeURIComponent(key)}`, {
    headers: {
      "vihta-session": sessionId,
      Cookie: cookieHeader(authcheck),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`get allocation ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json;
}

async function getUpcomingSlots(sessionId, serviceId, startDate) {
  const qs = new URLSearchParams({
    end_hours: "24",
    max_amount: "24",
    mode: "SINGLE",
    office_id: officeId,
    start_date: startDate,
    start_hours: "0",
  });
  const res = await fetch(`${BASE}/upcoming/services?${qs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "vihta-session": sessionId,
    },
    body: JSON.stringify({
      serviceSelections: [{ values: [serviceId] }],
      extraServices: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upcoming slots ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const list = Array.isArray(data.availabilities) ? data.availabilities : [];
  return list;
}

/** Calendar day in UTC (for API start_date) */
function todayYyyyMmDd() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function runAppointmentPollTick() {
  if (appointmentPollRunning) {
    return;
  }

  appointmentPollRunning = true;
  try {
    await pollAppointments();
  } catch (e) {
    console.error(`[${nowLogStamp()}] appointment tick failed:`, e.message);
  } finally {
    writeStatusFile();
    appointmentPollRunning = false;
  }
}

async function runSlotsPollTick() {
  if (slotsPollRunning) {
    return;
  }

  slotsPollRunning = true;
  try {
    await pollSlotsAndMaybeReschedule();
  } catch (e) {
    console.error(`[${nowLogStamp()}] slots tick failed:`, e.message);
  } finally {
    writeStatusFile();
    slotsPollRunning = false;
  }
}

async function modifyAllocation(
  sessionId,
  allocationId,
  resourceId,
  startTimestampIso,
  pin,
  authcheck
) {
  const qs = new URLSearchParams({
    office_id: officeId,
    resource_id: resourceId,
    start_timestamp: startTimestampIso,
  });
  const body = new URLSearchParams({ allocation_pin: pin });
  const res = await fetch(`${BASE}/allocations/modify/${encodeURIComponent(allocationId)}?${qs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "vihta-session": sessionId,
      Cookie: cookieHeader(authcheck),
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`modify ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

function earliestTimestamp(availabilities) {
  if (!availabilities.length) return null;
  let best = availabilities[0].startTimestamp;
  let bestMs = new Date(best).getTime();
  for (let i = 1; i < availabilities.length; i++) {
    const t = availabilities[i].startTimestamp;
    const ms = new Date(t).getTime();
    if (ms < bestMs) {
      best = t;
      bestMs = ms;
    }
  }
  return best;
}

function sortedUniqueTimestamps(availabilities) {
  return [...new Set(availabilities.map((x) => x && x.startTimestamp).filter(Boolean))].sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  );
}

function canRescheduleToTimestamp(iso, minDate, bestModeEnabled) {
  const date = helsinkiDateYyyyMmDd(iso);
  if (!bestModeEnabled && date < minDate) return false;
  return true;
}

async function pollAppointments() {
  /** @type {{ key: string, type: string, fromIso: string, toIso: string }[]} */
  const improvedAppointments = [];
  for (const a of appointments) {
    try {
      const { sessionId, authcheck } = await getAuthCheck(a.key, a.pin);
      const alloc = await getAllocation(sessionId, a.key, authcheck);
      if (alloc.start) {
        const prevStart = appointmentStartByKey.get(a.key);
        appointmentStartByKey.set(a.key, alloc.start);
        if (prevStart && new Date(alloc.start).getTime() < new Date(prevStart).getTime()) {
          improvedAppointments.push({
            key: a.key,
            type: a.type,
            fromIso: prevStart,
            toIso: alloc.start,
          });
        }
      }
    } catch (e) {
      console.error(`[${nowLogStamp()}] appointment poll key ${a.key}:`, e.message);
    }
  }
  if (improvedAppointments.length > 0) {
    flushDotLine();
    for (const a of improvedAppointments) {
      printAppointmentBestBanner(a.key, a.type, a.fromIso, a.toIso);
    }
  }
}

async function pollSlotsAndMaybeReschedule() {
  let sessionId;
  try {
    sessionId = await fetchSession();
  } catch (e) {
    console.error(`[${nowLogStamp()}] slots poll: session failed:`, e.message);
    return;
  }

  const startDate = todayYyyyMmDd();

  /** @type {{ key: string, type: string, toIso: string }[]} */
  const rescheduleEvents = [];
  /** @type {{ key: string, type: string, toIso: string, minDate: string }[]} */
  const missedOpportunityEvents = [];
  /** @type {{ key: string, type: string, oldMs: number, newIso: string }[]} */
  const poolEarlierNotBetter = [];
  /** @type {Map<string, string>} */
  const firstPollEarliestByType = new Map();
  /** @type {Map<string, string | null>} */
  const polledEarliestByType = new Map();
  /** @type {Set<string>} */
  const fetchedTypes = new Set();

  for (const a of appointments) {
    let availabilities;
    try {
      availabilities = await getUpcomingSlots(sessionId, a.serviceId, startDate);
      fetchedTypes.add(a.type);
    } catch (e) {
      console.error(`[${nowLogStamp()}] slots key ${a.key}:`, e.message);
      continue;
    }

    const sortedStarts = sortedUniqueTimestamps(availabilities);
    const earliest = sortedStarts[0] || null;
    if (!earliest) {
      if (firstSlotsPoll && !firstPollEarliestByType.has(a.type)) {
        firstPollEarliestByType.set(a.type, "");
      }
      updateEarliestByType(polledEarliestByType, a.type, null);
      continue;
    }

    updateEarliestByType(polledEarliestByType, a.type, earliest);

    if (
      firstSlotsPoll &&
      (!firstPollEarliestByType.get(a.type) ||
        new Date(earliest).getTime() < new Date(firstPollEarliestByType.get(a.type)).getTime())
    ) {
      firstPollEarliestByType.set(a.type, earliest);
    }

    const myStart = appointmentStartByKey.get(a.key);
    if (!myStart) {
      console.warn(
        `[${nowLogStamp()}] slots: no cached start for key ${a.key}; run appointment poll first or check credentials`
      );
      continue;
    }

    const earliestMs = new Date(earliest).getTime();
    const myMs = new Date(myStart).getTime();
    const earlierCandidates = sortedStarts.filter((iso) => new Date(iso).getTime() < myMs);
    const prevEarliest = lastEarliestSlotMsByService.get(a.serviceId);
    if (prevEarliest !== undefined && earliestMs !== prevEarliest) {
      appendEarliestChangeLog(a.type, prevEarliest, earliest);
    }
    if (prevEarliest !== undefined && earliestMs < prevEarliest && earliestMs >= myMs) {
      poolEarlierNotBetter.push({
        key: a.key,
        type: a.type,
        oldMs: prevEarliest,
        newIso: earliest,
      });
    }
    lastEarliestSlotMsByService.set(a.serviceId, earliestMs);
    if (earlierCandidates.length === 0) {
      continue;
    }

    if (!bestMode && helsinkiDateYyyyMmDd(earlierCandidates[0]) < a.minDate) {
      missedOpportunityEvents.push({
        key: a.key,
        type: a.type,
        toIso: earlierCandidates[0],
        minDate: a.minDate,
      });
    }

    const validCandidatesFromCache = earlierCandidates.filter((iso) =>
      canRescheduleToTimestamp(iso, a.minDate, bestMode)
    );
    if (validCandidatesFromCache.length === 0) {
      continue;
    }

    let authcheck;
    let alloc;
    let authSessionId;
    try {
      ({ sessionId: authSessionId, authcheck } = await getAuthCheck(a.key, a.pin));
      alloc = await getAllocation(authSessionId, a.key, authcheck);
    } catch (e) {
      console.error(`[${nowLogStamp()}] reschedule prep key ${a.key}:`, e.message);
      continue;
    }

    if (!alloc.id || !alloc.resourceId) {
      console.error(`[${nowLogStamp()}] reschedule: missing id/resourceId for key ${a.key}`);
      continue;
    }

    if (!alloc.start) {
      console.error(`[${nowLogStamp()}] reschedule: missing start for key ${a.key}`);
      continue;
    }

    if (alloc.customerPermissions && alloc.customerPermissions.isMovable === false) {
      console.warn(`[${nowLogStamp()}] appointment ${a.key} not movable; skip reschedule`);
      continue;
    }

    const liveMyMs = new Date(alloc.start).getTime();
    appointmentStartByKey.set(a.key, alloc.start);
    const attemptCandidates = sortedStarts
      .filter((iso) => {
        const ms = new Date(iso).getTime();
        return ms < liveMyMs && canRescheduleToTimestamp(iso, a.minDate, bestMode);
      })
      .slice(0, 2);
    if (attemptCandidates.length === 0) {
      continue;
    }

    let rescheduled = false;
    for (let i = 0; i < attemptCandidates.length; i++) {
      const candidate = attemptCandidates[i];
      try {
        await modifyAllocation(
          authSessionId,
          alloc.id,
          alloc.resourceId,
          candidate,
          a.pin,
          authcheck
        );
        rescheduleEvents.push({ key: a.key, type: a.type, toIso: candidate });
        appointmentStartByKey.set(a.key, candidate);
        await sleep(3000);
        rescheduled = true;
        break;
      } catch (e) {
        console.error(
          `[${nowLogStamp()}] reschedule key ${a.key} failed${i === 0 ? "" : " (second choice)"} slot ${formatApptTime(candidate)} (${candidate}):`,
          e.message
        );
      }
    }
  }

  for (const type of fetchedTypes) {
    latestEarliestSlotByType.set(
      type,
      polledEarliestByType.has(type) ? polledEarliestByType.get(type) : null
    );
  }

  if (firstSlotsPoll) {
    flushDotLine();
    for (const type of [...new Set(appointments.map((a) => a.type))]) {
      const earliest = firstPollEarliestByType.get(type);
      console.log(
        earliest
          ? `Earliest open slot (${type}): ${formatApptTime(earliest)}`
          : `Earliest open slot (${type}): none in current UTC window`
      );
    }
    firstSlotsPoll = false;
  }

  let printedSomething = false;

  if (missedOpportunityEvents.length > 0) {
    flushDotLine();
    printedSomething = true;
    for (const m of missedOpportunityEvents) {
      printMissedOpportunityBanner(m.key, m.type, m.toIso, m.minDate);
    }
  }

  if (rescheduleEvents.length > 0) {
    if (!printedSomething) flushDotLine();
    printedSomething = true;
    for (const r of rescheduleEvents) {
      printRescheduleBanner(r.key, r.type, r.toIso);
    }
  }

  if (poolEarlierNotBetter.length > 0) {
    if (!printedSomething) flushDotLine();
    printedSomething = true;
    for (const n of poolEarlierNotBetter) {
      const oldStr = formatApptTime(new Date(n.oldMs).toISOString());
      const newStr = formatApptTime(n.newIso);
      console.log(
        `Open slots earliest: ${oldStr} → ${newStr}  (${n.key} ${n.type}; still not before your booking)`
      );
    }
  }

  if (!printedSomething) {
    writeDot();
  }
}

console.log(
  bestMode
    ? `Migri tracker: ${appointments.length} appointment(s), office ${officeId}, mode --best (one-shot, bypass same-day reschedule gate)`
    : `Migri tracker: ${appointments.length} appointment(s), office ${officeId}, appointment poll every ${appointmentPollMs}ms, slots every ${slotsPollMs}ms`
);

(async function start() {
  await runAppointmentPollTick();
  await runSlotsPollTick();
  if (!bestMode) {
    setInterval(runAppointmentPollTick, appointmentPollMs);
    setInterval(runSlotsPollTick, slotsPollMs);
  } else {
    process.exit(0);
  }
})();

