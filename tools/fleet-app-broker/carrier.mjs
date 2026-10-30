const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_DEADLINE_MS = 5000;
const FRAME_KEYS = ["version", "requestId", "identity", "request"];
const IDENTITY_KEYS = ["userSid", "logonSid", "alias"];
const REQUEST_ID = /^[0-9a-f]{32}$/;
const SID = /^S-1-[0-9]+(-[0-9]+){1,15}$/;
const ALIAS = /^[a-z0-9-]{1,32}$/;
const TIMEOUT = Symbol("timeout");

/** Encode one frame: four-byte big-endian length, then UTF-8 JSON. */
export function encodeFrame(value, maxBytes) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    return { ok: false, reason: "unencodable" };
  }
  if (payload.length > maxBytes)
    return { ok: false, reason: "frame-too-large" };
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return { ok: true, frame };
}

/**
 * Read exactly one frame and then EOF. Any extra byte, short frame, bad
 * encoding, or missed deadline is a failure, never a partial result.
 */
export async function readOneFrame(readable, { maxBytes, deadlineMs }) {
  const iterator = readable[Symbol.asyncIterator]();
  const chunks = [];
  const end = Date.now() + deadlineMs;
  let size = 0;
  let declared = null;
  while (true) {
    const remaining = end - Date.now();
    if (remaining <= 0) return { ok: false, reason: "deadline-exceeded" };
    let next;
    try {
      next = await waitOrTimeout(iterator.next(), remaining);
    } catch {
      return { ok: false, reason: "stream-error" };
    }
    if (next === TIMEOUT) return { ok: false, reason: "deadline-exceeded" };
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value)
      ? next.value
      : Buffer.from(next.value);
    chunks.push(chunk);
    size += chunk.length;
    if (declared === null && size >= 4) {
      declared = Buffer.concat(chunks).readUInt32BE(0);
      if (declared > maxBytes) return { ok: false, reason: "frame-too-large" };
    }
    if (declared !== null && size > 4 + declared)
      return { ok: false, reason: "trailing-bytes" };
  }
  if (declared === null || size < 4 + declared)
    return { ok: false, reason: "truncated-frame" };
  const body = Buffer.concat(chunks).subarray(4, 4 + declared);
  try {
    // ignoreBOM keeps a byte-order mark in the text, where JSON.parse
    // rejects it.
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    });
    return { ok: true, payload: decoder.decode(body) };
  } catch {
    return { ok: false, reason: "invalid-utf8" };
  }
}

/**
 * Validate one request payload. A structural failure (duplicate or unknown
 * key, wrong version, unreadable requestId) yields no requestId, so the
 * carrier writes no response. A readable requestId with a bad identity or
 * request record yields the fixed local denial instead.
 */
export function parseRequest(payload) {
  if (typeof payload !== "string" || hasDuplicateKeys(payload))
    return { ok: false, requestId: null };
  let value;
  try {
    value = JSON.parse(payload);
  } catch {
    return { ok: false, requestId: null };
  }
  if (!isObject(value)) return { ok: false, requestId: null };
  if (value.version !== 1) return { ok: false, requestId: null };
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId))
    return { ok: false, requestId: null };
  if (!ownKeys(value, FRAME_KEYS)) return { ok: false, requestId: null };
  const identity = parseIdentity(value.identity);
  if (!identity) return { ok: false, requestId: value.requestId };
  if (!isObject(value.request))
    return { ok: false, requestId: value.requestId };
  return {
    ok: true,
    requestId: value.requestId,
    identity,
    request: value.request,
  };
}

/**
 * Run one request: read, validate, execute once, write one frame. The
 * executor and the allowed agent account SIDs come from trusted custody; the
 * host-supplied identity must name one of those accounts.
 */
export async function runOne({
  input,
  output,
  executor,
  allowedUserSids,
  deadlineMs = DEFAULT_DEADLINE_MS,
}) {
  if (!validAllowList(allowedUserSids)) {
    input.destroy?.();
    return 1;
  }
  const frame = await readOneFrame(input, {
    maxBytes: MAX_REQUEST_BYTES,
    deadlineMs,
  });
  if (!frame.ok) {
    // Release stdin so a stalled pipe cannot keep the child alive.
    input.destroy?.();
    return 1;
  }
  const parsed = parseRequest(frame.payload);
  if (parsed.ok && !allowedUserSids.includes(parsed.identity.userSid))
    parsed.ok = false;
  if (!parsed.ok) {
    if (parsed.requestId === null) return 1;
    return respond(output, parsed.requestId, {
      status: "denied",
      code: "internal-channel-invalid",
    });
  }
  const result = await executor.execute(parsed.request);
  return respond(output, parsed.requestId, result);
}

/** Trusted custody must supply a non-empty list of SID strings. */
export function validAllowList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((sid) => typeof sid === "string" && SID.test(sid))
  );
}

/** A result that cannot fit the response frame keeps its outcome class. */
export function mapOversizeResult(result) {
  return result?.status === "denied"
    ? { status: "denied", code: "response-too-large" }
    : { status: "outcome-unknown", code: "response-too-large" };
}

async function respond(output, requestId, result) {
  let encoded = encodeFrame(
    { version: 1, requestId, result },
    MAX_RESPONSE_BYTES,
  );
  if (!encoded.ok) {
    encoded = encodeFrame(
      { version: 1, requestId, result: mapOversizeResult(result) },
      MAX_RESPONSE_BYTES,
    );
  }
  if (!encoded.ok) return 1;
  return writeFrame(output, encoded.frame);
}

function writeFrame(output, frame) {
  return new Promise((resolve) => {
    output.write(frame, (error) => resolve(error ? 1 : 0));
  });
}

function waitOrTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value, keys) {
  if (!isObject(value)) return false;
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasExactKeys(value, keys) {
  return ownKeys(value, keys) && keys.length === Object.keys(value).length;
}

function parseIdentity(value) {
  if (!hasExactKeys(value, IDENTITY_KEYS)) return null;
  if (typeof value.userSid !== "string" || !SID.test(value.userSid))
    return null;
  if (typeof value.logonSid !== "string" || !SID.test(value.logonSid))
    return null;
  if (typeof value.alias !== "string" || !ALIAS.test(value.alias)) return null;
  return {
    userSid: value.userSid,
    logonSid: value.logonSid,
    alias: value.alias,
  };
}

// JSON.parse keeps the last of a repeated key, so scan the text first. The
// scan tracks one key set per open object; JSON.parse still validates syntax.
function hasDuplicateKeys(text) {
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = endOfString(text, index);
      if (end === -1) return false;
      const top = stack[stack.length - 1];
      if (top?.expectKey) {
        const key = unescapeKey(text.slice(index + 1, end - 1));
        if (key === null) return false;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      index = end;
      continue;
    }
    if (char === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (char === "[") stack.push({ keys: null });
    else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && stack[stack.length - 1]?.keys)
      stack[stack.length - 1].expectKey = true;
    else if (char === ":" && stack[stack.length - 1]?.keys)
      stack[stack.length - 1].expectKey = false;
    index += 1;
  }
  return false;
}

function endOfString(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === '"') return index + 1;
  }
  return -1;
}

function unescapeKey(raw) {
  if (!raw.includes("\\")) return raw;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return null;
  }
}
