import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  WHOOP_TOKENS: KVNamespace;
}

async function getAccessToken(env: Env): Promise<string> {
  const raw = await env.WHOOP_TOKENS.get("whoop_tokens");

  if (!raw) {
    throw new Error("WHOOP tokens not found in KV");
  }

  const tokens = JSON.parse(raw);

  if (!tokens.access_token) {
    throw new Error("WHOOP access_token not found");
  }

  return tokens.access_token;
}

async function whoopGet(
  env: Env,
  path: string
): Promise<any> {
  const accessToken = await getAccessToken(env);

  const response = await fetch(
    `https://api.prod.whoop.com/developer${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );

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
    version: "1.0.0",
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
  const handler = createMcpHandler(() => createServer(env));
  return handler(request, env, ctx);
}

    return new Response("Not found", {
      status: 404,
    });
  },
};
