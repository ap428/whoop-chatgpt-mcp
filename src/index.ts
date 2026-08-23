import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  WHOOP_TOKENS: KVNamespace;
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
}

interface WhoopTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [key: string]: unknown;
}

const WHOOP_AUTH_URL =
  "https://api.prod.whoop.com/oauth/oauth2/auth";

const WHOOP_TOKEN_URL =
  "https://api.prod.whoop.com/oauth/oauth2/token";

const WHOOP_SCOPES = [
  "offline",
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:workout",
];

function getRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/oauth/callback`;
}

function generateState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/* =========================================================
   TOKEN STORAGE
   ========================================================= */

async function getTokens(env: Env): Promise<WhoopTokens> {
  const raw = await env.WHOOP_TOKENS.get("whoop_tokens");

  if (!raw) {
    throw new Error(
      "WHOOP tokens not found in KV. Open /oauth/start to authorize WHOOP."
    );
  }

  const tokens = JSON.parse(raw) as WhoopTokens;

  if (!tokens.access_token) {
    throw new Error("WHOOP access_token not found in KV");
  }

  return tokens;
}

async function saveTokens(
  env: Env,
  tokens: WhoopTokens
): Promise<void> {
  await env.WHOOP_TOKENS.put(
    "whoop_tokens",
    JSON.stringify(tokens)
  );
}

/* =========================================================
   OAUTH — START
   ========================================================= */

async function startOAuth(
  request: Request,
  env: Env
): Promise<Response> {
  const state = generateState();

  // State is short-lived. It is used only to verify the OAuth callback.
  await env.WHOOP_TOKENS.put(
    `oauth_state:${state}`,
    "valid",
    {
      expirationTtl: 600,
    }
  );

  const redirectUri = getRedirectUri(request);

  const authUrl = new URL(WHOOP_AUTH_URL);

  authUrl.searchParams.set(
    "client_id",
    env.WHOOP_CLIENT_ID
  );

  authUrl.searchParams.set(
    "redirect_uri",
    redirectUri
  );

  authUrl.searchParams.set(
    "response_type",
    "code"
  );

  authUrl.searchParams.set(
    "scope",
    WHOOP_SCOPES.join(" ")
  );

  authUrl.searchParams.set(
    "state",
    state
  );

  return Response.redirect(
    authUrl.toString(),
    302
  );
}

/* =========================================================
   OAUTH — CALLBACK
   ========================================================= */

async function handleOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  const error = url.searchParams.get("error");
  const errorDescription =
    url.searchParams.get("error_description");

  if (error) {
    return new Response(
      `WHOOP authorization failed.\n\n${error}\n${errorDescription ?? ""}`,
      {
        status: 400,
        headers: {
          "content-type":
            "text/plain; charset=UTF-8",
        },
      }
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return new Response(
      "Missing OAuth authorization code.",
      {
        status: 400,
      }
    );
  }

  if (!state) {
    return new Response(
      "Missing OAuth state.",
      {
        status: 400,
      }
    );
  }

  const stateKey = `oauth_state:${state}`;

  const storedState =
    await env.WHOOP_TOKENS.get(stateKey);

  if (!storedState) {
    return new Response(
      "Invalid or expired OAuth state. Please start authorization again at /oauth/start.",
      {
        status: 400,
        headers: {
          "content-type":
            "text/plain; charset=UTF-8",
        },
      }
    );
  }

  // One-time use.
  await env.WHOOP_TOKENS.delete(stateKey);

  const redirectUri = getRedirectUri(request);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET,
  });

  const response = await fetch(
    WHOOP_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    }
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    return new Response(
      `WHOOP token exchange failed (${response.status}).\n\n${responseText}`,
      {
        status: 500,
        headers: {
          "content-type":
            "text/plain; charset=UTF-8",
        },
      }
    );
  }

  let tokens: WhoopTokens;

  try {
    tokens =
      JSON.parse(responseText) as WhoopTokens;
  } catch {
    return new Response(
      `WHOOP returned an invalid token response:\n\n${responseText}`,
      {
        status: 500,
      }
    );
  }

  if (!tokens.access_token) {
    return new Response(
      "WHOOP authorization succeeded, but no access_token was returned.",
      {
        status: 500,
      }
    );
  }

  if (!tokens.refresh_token) {
    return new Response(
      "WHOOP authorization succeeded, but no refresh_token was returned. Make sure the offline scope is enabled.",
      {
        status: 500,
      }
    );
  }

  await saveTokens(
    env,
    tokens
  );

  return new Response(
    [
      "WHOOP authorization successful.",
      "",
      "Fresh access_token and refresh_token have been saved to Cloudflare KV.",
      "",
      "You can close this page and use the WHOOP plugin in ChatGPT.",
    ].join("\n"),
    {
      headers: {
        "content-type":
          "text/plain; charset=UTF-8",
      },
    }
  );
}

/* =========================================================
   REFRESH ACCESS TOKEN
   ========================================================= */

async function refreshAccessToken(
  env: Env
): Promise<WhoopTokens> {
  const oldTokens =
    await getTokens(env);

  if (!oldTokens.refresh_token) {
    throw new Error(
      "WHOOP refresh_token not found in KV. Open /oauth/start to reauthorize WHOOP."
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token:
      oldTokens.refresh_token,
    client_id:
      env.WHOOP_CLIENT_ID,
    client_secret:
      env.WHOOP_CLIENT_SECRET,
    scope: "offline",
  });

  const response = await fetch(
    WHOOP_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    }
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `WHOOP token refresh failed ${response.status}: ${responseText}`
    );
  }

  const newTokens =
    JSON.parse(responseText) as WhoopTokens;

  if (!newTokens.access_token) {
    throw new Error(
      "WHOOP refresh response has no access_token"
    );
  }

  if (!newTokens.refresh_token) {
    throw new Error(
      "WHOOP refresh response has no refresh_token"
    );
  }

  await saveTokens(
    env,
    newTokens
  );

  return newTokens;
}

/* =========================================================
   WHOOP API
   ========================================================= */

async function makeWhoopRequest(
  path: string,
  accessToken: string
): Promise<Response> {
  return fetch(
    `https://api.prod.whoop.com/developer${path}`,
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );
}

async function whoopGet(
  env: Env,
  path: string
): Promise<any> {
  let tokens =
    await getTokens(env);

  let response =
    await makeWhoopRequest(
      path,
      tokens.access_token
    );

  /*
   * If WHOOP rejects the access token,
   * refresh it once and repeat the request.
   */
  if (response.status === 401) {
    tokens =
      await refreshAccessToken(env);

    response =
      await makeWhoopRequest(
        path,
        tokens.access_token
      );
  }

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `WHOOP API error ${response.status}: ${body}`
    );
  }

  return response.json();
}

/* =========================================================
   MCP SERVER
   ========================================================= */

function createServer(env: Env) {
  const server = new McpServer({
    name: "WHOOP",
    version: "1.2.0",
  });

  server.registerTool(
    "get_recent_sleep",
    {
      description:
        "Get recent WHOOP sleep data including sleep performance and sleep stages.",
      inputSchema: z.object({
        limit:
          z.number()
            .min(1)
            .max(25)
            .default(5),
      }),
    },
    async ({ limit }) => {
      const data =
        await whoopGet(
          env,
          `/v2/activity/sleep?limit=${limit}`
        );

      return {
        content: [
          {
            type: "text",
            text:
              JSON.stringify(
                data,
                null,
                2
              ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_recent_workouts",
    {
      description:
        "Get recent WHOOP workouts including strain, heart rate, zones, distance and activity type.",
      inputSchema: z.object({
        limit:
          z.number()
            .min(1)
            .max(25)
            .default(10),
      }),
    },
    async ({ limit }) => {
      const data =
        await whoopGet(
          env,
          `/v2/activity/workout?limit=${limit}`
        );

      return {
        content: [
          {
            type: "text",
            text:
              JSON.stringify(
                data,
                null,
                2
              ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_current_recovery",
    {
      description:
        "Get current WHOOP physiological cycle and recovery data including recovery score, HRV and resting heart rate.",
      inputSchema:
        z.object({}),
    },
    async () => {
      const cycles =
        await whoopGet(
          env,
          "/v1/cycle?limit=1"
        );

      const cycle =
        cycles.records?.[0];

      if (!cycle) {
        throw new Error(
          "No WHOOP cycle found"
        );
      }

      const recovery =
        await whoopGet(
          env,
          `/v1/cycle/${cycle.id}/recovery`
        );

      return {
        content: [
          {
            type: "text",
            text:
              JSON.stringify(
                {
                  cycle,
                  recovery,
                },
                null,
                2
              ),
          },
        ],
      };
    }
  );

  return server;
}

/* =========================================================
   CLOUDFLARE WORKER
   ========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url =
      new URL(request.url);

    /*
     * Simple health check.
     */
    if (url.pathname === "/") {
      return new Response(
        [
          "WHOOP ChatGPT MCP is running",
          "",
          "Authorize WHOOP:",
          `${url.origin}/oauth/start`,
        ].join("\n"),
        {
          headers: {
            "content-type":
              "text/plain; charset=UTF-8",
          },
        }
      );
    }

    /*
     * Start WHOOP authorization.
     */
    if (
      url.pathname ===
      "/oauth/start"
    ) {
      return startOAuth(
        request,
        env
      );
    }

    /*
     * WHOOP redirects here after consent.
     */
    if (
      url.pathname ===
      "/oauth/callback"
    ) {
      return handleOAuthCallback(
        request,
        env
      );
    }

    /*
     * ChatGPT MCP endpoint.
     */
    if (url.pathname === "/mcp") {
      const handler =
        createMcpHandler(
          () =>
            createServer(env)
        );

      return handler(
        request,
        env,
        ctx
      );
    }

    return new Response(
      "Not found",
      {
        status: 404,
      }
    );
  },
};
