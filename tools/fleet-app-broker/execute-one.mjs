import { isMain } from "../../scripts/lib/proc.mjs";
import { runOne, validAllowList } from "./carrier.mjs";
import { createOperationExecutor } from "./index.mjs";

/**
 * Run one framed request from stdin and write one framed response to stdout.
 * The trusted bootstrap and allowed agent SIDs come from the caller; this entry
 * loads no key, no credential file, and no environment value.
 */
export async function main({ bootstrap, allowedUserSids } = {}) {
  if (!bootstrap || !validAllowList(allowedUserSids)) {
    // No trusted custody means no operation: fail before reading stdin.
    process.exitCode = 1;
    return 1;
  }
  const code = await runOne({
    input: process.stdin,
    output: process.stdout,
    executor: createOperationExecutor(bootstrap),
    allowedUserSids,
  });
  process.exitCode = code;
  return code;
}

// Run directly, this file has no trusted custody: it exits nonzero, no I/O.
if (isMain(import.meta.url)) await main();
