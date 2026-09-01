import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { createContext } from "~/shared/context.server";
import { preventCrossOriginCookie } from "~/services/no-cross-origin-cookie";
import { checkCsrf } from "~/services/csrf-session.server";
import { allowedDestinations } from "~/services/destinations.server";
import { privateNoStoreResponseHeaders } from "~/services/cache-control.server";
import { authorizeProject } from "@webstudio-is/trpc-interface/index.server";
import { loadDevBuildByProjectId } from "@webstudio-is/project-build/server";
import type { CompactBuild } from "@webstudio-is/project-build";
import {
  createBedrockClient,
  converse,
  type Message,
  type ContentBlock,
} from "@webstudio-is/ai/index.server";
import env from "~/env/env.server";
import { getAiTools, executeAiTool } from "~/services/ai/tools.server";
import { getAiSystemPrompt } from "~/services/ai/system-prompt.server";

const RequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })
  ),
  context: z
    .object({
      selectedInstanceId: z.string().optional(),
      selectedPageId: z.string().optional(),
    })
    .optional(),
});

type AiEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; ok: boolean; version?: number; error?: string }
  | { type: "done"; version: number }
  | { type: "error"; error: string };

export const action = async ({ params, request }: ActionFunctionArgs) => {
  preventCrossOriginCookie(request);
  allowedDestinations(request, ["empty"]);
  await checkCsrf(request);

  if (env.AI_ENABLED !== "true") {
    return json({ error: "AI engine is disabled" }, { status: 404 });
  }
  if (env.BEDROCK_REGION === undefined || env.BEDROCK_MODEL_ID === undefined) {
    return json(
      { error: "Bedrock is not configured (BEDROCK_REGION / BEDROCK_MODEL_ID)" },
      { status: 500 }
    );
  }

  const projectId = params.projectId;
  if (projectId === undefined) {
    return json({ error: "Project id undefined" }, { status: 400 });
  }

  const ctx = await createContext(request);

  // Editing requires the "build" permit on the project.
  const canBuild = await authorizeProject.hasProjectPermit(
    { projectId, permit: "build" },
    ctx
  );
  if (canBuild === false) {
    return json({ error: "You don't have access to edit this project" }, {
      status: 403,
    });
  }

  const parsed = RequestSchema.safeParse(await request.json());
  if (parsed.success === false) {
    return json({ error: parsed.error.message }, { status: 400 });
  }

  const bedrock = createBedrockClient({
    region: env.BEDROCK_REGION,
    modelId: env.BEDROCK_MODEL_ID,
  });
  const system = getAiSystemPrompt(parsed.data.context);
  const tools = getAiTools();

  // Build the running conversation for the model.
  const messages: Message[] = parsed.data.messages.map((m) => ({
    role: m.role,
    content: [{ text: m.content }],
  }));

  let build: CompactBuild = await loadDevBuildByProjectId(ctx, projectId);
  const events: AiEvent[] = [];
  const maxTurns = env.AI_MAX_TURNS;

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const result = await converse(bedrock, { system, messages, tools });

      if (result.text.length > 0) {
        events.push({ type: "text", text: result.text });
      }

      // Append the assistant message (with any toolUse blocks) to history.
      messages.push(result.message);

      if (result.stopReason !== "tool_use" || result.toolUses.length === 0) {
        events.push({ type: "done", version: build.version });
        break;
      }

      // Execute each requested tool and feed results back to the model.
      const toolResultBlocks: ContentBlock[] = [];
      for (const toolUse of result.toolUses) {
        const { result: execResult, build: nextBuild } = await executeAiTool({
          command: toolUse.name,
          input: toolUse.input,
          build,
          projectId,
          ctx,
        });
        build = nextBuild;

        events.push({
          type: "tool",
          name: toolUse.name,
          ok: execResult.ok,
          version: execResult.ok ? execResult.version : undefined,
          error: execResult.ok ? undefined : execResult.error,
        });

        toolResultBlocks.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            content: [{ json: execResult as unknown }],
            status: execResult.ok ? "success" : "error",
          },
        } as unknown as ContentBlock);
      }

      messages.push({ role: "user", content: toolResultBlocks });

      if (turn === maxTurns - 1) {
        events.push({ type: "done", version: build.version });
      }
    }
  } catch (error) {
    events.push({
      type: "error",
      error: error instanceof Error ? error.message : "AI request failed",
    });
  }

  return json(
    { events, version: build.version },
    { headers: privateNoStoreResponseHeaders }
  );
};
