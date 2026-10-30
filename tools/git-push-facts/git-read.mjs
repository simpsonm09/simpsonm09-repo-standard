import { spawn } from "node:child_process";

export function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
}

function deadlineError() {
  return Object.assign(new Error("Git extraction exceeded its time bound"), {
    code: "TOTAL_TIMEOUT",
  });
}

// Internal collector transport: callers of the public API cannot supply argv.
export function runGit(repositoryRoot, args, limits, state) {
  return new Promise((resolve, reject) => {
    const remainingMs = state.deadlineAt - performance.now();
    if (remainingMs <= 0) {
      reject(deadlineError());
      return;
    }
    const child = spawn(
      "git",
      [
        "--no-pager",
        "-C",
        repositoryRoot,
        "-c",
        "core.pager=cat",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd: repositoryRoot,
        env: sanitizedGitEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => {
        child.kill();
        const error =
          performance.now() >= state.deadlineAt
            ? deadlineError()
            : Object.assign(new Error("Git read exceeded its time bound"), {
                code: "GIT_TIMEOUT",
              });
        finish(reject, error);
      },
      Math.max(
        1,
        Math.min(limits.commandTimeoutMs, state.deadlineAt - performance.now()),
      ),
    );
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      state.outputBytes += chunk.length;
      if (
        bytes > limits.commandOutputBytes ||
        state.outputBytes > limits.totalOutputBytes
      ) {
        child.kill();
        finish(
          reject,
          Object.assign(new Error("Git output exceeded its size bound"), {
            code: "OUTPUT_LIMIT",
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () =>
      finish(
        reject,
        Object.assign(new Error("Unable to run local Git"), {
          code: "GIT_UNAVAILABLE",
        }),
      ),
    );
    child.on("close", (code) => {
      if (settled) return;
      if (performance.now() >= state.deadlineAt) {
        finish(reject, deadlineError());
      } else if (code !== 0) {
        finish(
          reject,
          Object.assign(new Error("A required read-only Git query failed"), {
            code: `GIT_EXIT_${code}`,
          }),
        );
      } else {
        finish(resolve, Buffer.concat(chunks, bytes));
      }
    });
  });
}
