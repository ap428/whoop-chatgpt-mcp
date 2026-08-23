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

async function getTokens(env: Env): Promise<WhoopTokens> {
  const raw = await env.WHOOP_TOKENS.get("whoop_tokens");

  if (!raw) {
    throw new Error("WHOOP tokens not found in KV");
  }

  const tokens = JSON.parse(raw) as WhoopTokens;

  if (!tokens.access_token) {
    throw new Error("WHOOP access_token not found in KV");
  }

  return tokens;
}

async function refreshAccessToken(env: Env): Promise<WhoopTokens> {
  const oldTokens = await getTokens(env);

  if (!oldTokens.refresh_token) {
    throw new Error(
      "WHOOP refresh_token not found in KV. Reauthorization with offline scope is required."
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oldTokens.refresh_token,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET,
    scope: "offline",
  });

  const response = await fetch(
    "https://api.prod.whoop.com/oauth/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `WHOOP token refresh failed ${response.status}: ${responseText}`
    );
  }

  const newTokens = JSON.parse(responseText) as WhoopTokens;

  if (!newTokens.access_token) {
    throw new Error("WHOOP refresh response has no access_token");
  }

  if (!newTokens.refresh_token) {
    throw new Error("WHOOP refresh response has no refresh_token");
  }

  await env.WHOOP_TOKENS.put(
    "whoop_tokens",
    JSON.stringify(newTokens)
  );

  return newTokens;
}

async function makeWhoopRequest(
  path: string,
  accessToken: string
): Promise<Response> {
  return fetch(
    `https://api.prod.whoop.com/developer${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );
}

async function whoopGet(
  env: Env,
  path: string
): Promise<any> {
  let tokens = await getTokens(env);

  let response = await makeWhoopRequest(
    path,
    tokens.access_token
  );

  // Access token expired or invalid:
  // refresh it once and retry the original request.
  if (response.status === 401) {
    tokens = await refreshAccessToken(env);

    response = await makeWhoopRequest(
      path,
      tokens.access_token
    );
  }

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `WHOOP API error ${response.status}: ${body}`
    );
  }

  return response.json();
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "WHOOP",
    version: "1.1.0",
  });

  server.registerTool(
    "get_recent_sleep",
    {
      description:
        "Get recent WHOOP sleep data including sleep performance and sleep stages.",
      inputSchema: z.object({
        limit: z.number().min(1).max(25).default(5),
      }),
    },
    async ({ limit }) => {
      const data = await whoopGet(
        env,
        `/v2/activity/sleep?limit=${limit}`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
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
        limit: z.number().min(1).max(25).default(10),
      }),
    },
    async ({ limit }) => {
      const data = await whoopGet(
        env,
        `/v2/activity/workout?limit=${limit}`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
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
      inputSchema: z.object({}),
    },
    async () => {
      const cycles = await whoopGet(
        env,
        "/v1/cycle?limit=1"
      );

      const cycle = cycles.records?.[0];

      if (!cycle) {
        throw new Error("No WHOOP cycle found");
      }

      let recovery = null;

      try {
        recovery = await whoopGet(
          env,
          `/v1/cycle/${cycle.id}/recovery`
        );
      } catch (error) {
        recovery = {
          message: "Recovery unavailable",
          error: String(error),
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "WHOOP ChatGPT MCP is running",
        {
          headers: {
            "content-type": "text/plain; charset=UTF-8",
          },
        }
      );
    }

    if (url.pathname === "/mcp") {
      const handler = createMcpHandler(
        () => createServer(env)
      );

      return handler(request, env, ctx);
    }

    return new Response("Not found", {
      status: 404,
    });
  },
};
