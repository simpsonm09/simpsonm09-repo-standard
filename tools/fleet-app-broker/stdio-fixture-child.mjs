import { createHash } from "node:crypto";
import { main } from "./execute-one.mjs";

// Fixture-only entry: a fake bootstrap and a counting fake fetch. It never
// imports a real key, token, or credential file.
const calls = { fetch: 0 };

const readData = {
  full_name: "acme/sample",
  name: "sample",
  private: true,
  default_branch: "main",
};

function pin(value) {
  const bytes = JSON.stringify(value);
  return {
    bytes,
    expectedSHA256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function bootstrap(fetch) {
  return {
    appId: 91,
    registrationOwner: "acme",
    manifestCeiling: { contents: "write", pull_requests: "write" },
    policy: {
      roster: pin({
        org: "acme",
        repos: [{ name: "sample", tier: "S1" }],
        agentAccessDefaults: { S1: "propose" },
      }),
      ownedForks: pin({ forks: [] }),
      ownedRepositories: pin({ repositories: [] }),
      ignore: pin({ ignore: [] }),
    },
    signAppJwt: async () => "synthetic-jwt-marker",
    fetch,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fetch(url) {
  calls.fetch += 1;
  if (url.endsWith("/installation"))
    return json({
      id: 12,
      app_id: 91,
      account: { login: "acme", type: "Organization" },
      permissions: { contents: "write", pull_requests: "write" },
    });
  if (url.endsWith("/access_tokens"))
    return json({
      token: "synthetic-installation-token-marker",
      repositories: [{ full_name: "acme/sample" }],
      permissions: { contents: "read", metadata: "read" },
    });
  return json(readData);
}

await main({
  bootstrap: bootstrap(fetch),
  allowedUserSids: ["S-1-5-21-1004336348-1177238915-682003330-1001"],
});
