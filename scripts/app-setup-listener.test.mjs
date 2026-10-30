#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startSetupListener } from "./lib/app-setup-listener.mjs";
import { EXIT } from "./lib/exit.mjs";
import { isMain } from "./lib/proc.mjs";

function fixture() {
  const server = new EventEmitter();
  const observed = {
    listen: [],
    close: 0,
    connectionsClosed: 0,
    cleared: 0,
    stops: [],
    errors: [],
  };
  server.listen = (...args) => {
    observed.listen.push(args);
  };
  server.close = () => {
    observed.close++;
    server.emit("close");
  };
  server.closeAllConnections = () => {
    observed.connectionsClosed++;
  };
  const clock = {
    setTimeout: (callback, duration) => {
      observed.expire = callback;
      observed.duration = duration;
      return { unref() {} };
    },
    clearTimeout: () => {
      observed.cleared++;
    },
  };
  const controller = new AbortController();
  const options = {
    port: 8721,
    signal: controller.signal,
    onStop: (reason, error) => {
      observed.stops.push(reason);
      observed.errors.push(error);
    },
  };
  return { server, observed, clock, controller, options };
}

function checkLifecycle() {
  const normal = fixture();
  const onListening = () => {};
  startSetupListener(
    normal.server,
    { ...normal.options, onListening },
    normal.clock,
  );
  assert.deepEqual(normal.observed.listen, [[8721, "127.0.0.1", onListening]]);
  assert.equal(normal.observed.duration, 300_000);
  normal.server.emit("close");
  normal.controller.abort();
  assert.equal(normal.observed.cleared, 1);
  assert.deepEqual(normal.observed.stops, []);
  assert.equal(normal.observed.close, 0);
  for (const cause of ["timeout", "aborted", "listen-failed"]) {
    const f = fixture();
    const error = Object.assign(new Error("not printed"), {
      code: "EADDRINUSE",
    });
    startSetupListener(f.server, f.options, f.clock);
    if (cause === "timeout") f.observed.expire();
    if (cause === "aborted") f.controller.abort();
    if (cause === "listen-failed") f.server.emit("error", error);
    assert.deepEqual(f.observed.stops, [cause]);
    assert.equal(
      f.observed.errors[0],
      cause === "listen-failed" ? error : undefined,
    );
    assert.equal(f.observed.close, 1);
    assert.equal(f.observed.connectionsClosed, 1);
    f.observed.expire();
    assert.equal(f.observed.close, 1, "late timeout cannot close twice");
  }
  const cancelled = fixture();
  cancelled.controller.abort();
  startSetupListener(cancelled.server, cancelled.options, cancelled.clock);
  assert.deepEqual(cancelled.observed.listen, []);
  assert.deepEqual(cancelled.observed.stops, ["aborted"]);
  const thrown = fixture();
  const thrownError = Object.assign(new Error("not printed"), {
    code: "EACCES",
  });
  thrown.server.listen = () => {
    throw thrownError;
  };
  startSetupListener(thrown.server, thrown.options, thrown.clock);
  assert.deepEqual(thrown.observed.stops, ["listen-failed"]);
  assert.equal(thrown.observed.errors[0], thrownError);
  for (const limits of [
    { port: 0 },
    { port: 65536 },
    { port: 1.5 },
    { timeoutMs: 0 },
    { timeoutMs: 3_600_001 },
  ]) {
    const f = fixture();
    assert.throws(
      () => startSetupListener(f.server, { ...f.options, ...limits }, f.clock),
      /invalid setup listener limits/,
    );
    assert.deepEqual(f.observed.listen, []);
  }
}

export function runTest() {
  try {
    checkLifecycle();
    process.stdout.write(
      "app-setup-listener: fake lifecycle fixtures passed\n",
    );
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`app-setup-listener: ${error.message}\n`);
    return EXIT.FAIL;
  }
}
if (isMain(import.meta.url)) process.exit(runTest());
