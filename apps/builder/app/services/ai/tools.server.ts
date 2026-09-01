import type { Tool } from "@webstudio-is/ai/index.server";
import {
  runtimeOperationContracts,
  type RuntimeOperationId,
} from "@webstudio-is/project-build/contracts";
import { publicApiOperationDocumentation } from "@webstudio-is/protocol";
import type { CompactBuild } from "@webstudio-is/project-build";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { BuilderRuntimeError } from "@webstudio-is/project-build/runtime";
import { loadDevBuildByProjectId } from "@webstudio-is/project-build/server";
import { executeApiRuntimeMutation } from "~/services/api-runtime.server";
import { commitBuildPatch } from "~/services/api-build.server";

/**
 * Subset of runtime operations exposed to the LLM in increment 1. Keep this
 * intentionally small: a few content mutations plus read operations for
 * context. Expand as the feature matures.
 */
const enabledCommands = new Set<string>([
  // reads (context)
  "list-pages",
  "get-page",
  "list-instances",
  "search-project",
  // mutations (content)
  "insert-fragment",
  "update-styles",
  "update-text",
  "set-text-content",
]);

const descriptionByCommand = new Map(
  publicApiOperationDocumentation.map((doc) => [doc.command, doc])
);

type EnabledContract = (typeof runtimeOperationContracts)[number];

const enabledContracts: EnabledContract[] = runtimeOperationContracts.filter(
  (contract) => enabledCommands.has(contract.command)
);

const contractByCommand = new Map(
  enabledContracts.map((contract) => [contract.command, contract])
);

/**
 * Build the Bedrock tool list from the enabled runtime operation contracts.
 * Each contract already exposes a JSON-Schema `inputSchema`, so no zod->JSON
 * conversion is needed.
 */
export const getAiTools = (): Tool[] =>
  enabledContracts.map((contract) => {
    const doc = descriptionByCommand.get(contract.command);
    const exampleText =
      doc && doc.examples.length > 0
        ? `\n\nExamples:\n${doc.examples.join("\n")}`
        : "";
    return {
      toolSpec: {
        name: contract.command,
        description: `${doc?.description ?? contract.command}${exampleText}`,
        inputSchema: {
          // JSON Schema object from the generated contract. Bedrock types this
          // as its internal DocumentType, so cast through unknown.
          json: contract.inputSchema as unknown,
        },
      },
    } as Tool;
  });

export type ToolExecutionResult =
  | { ok: true; version: number; result: Record<string, unknown> }
  | { ok: false; error: string; issues?: unknown };

/**
 * Execute a single tool call requested by the LLM:
 * - reads run the operation and return its result (no commit),
 * - mutations run the operation, commit the resulting patch, and report the
 *   new build version.
 * Errors are returned (not thrown) so the caller can feed them back to the LLM
 * for self-correction.
 */
export const executeAiTool = async ({
  command,
  input,
  build,
  projectId,
  ctx,
}: {
  command: string;
  input: unknown;
  build: CompactBuild;
  projectId: string;
  ctx: AppContext;
}): Promise<{ result: ToolExecutionResult; build: CompactBuild }> => {
  const contract = contractByCommand.get(command);
  if (contract === undefined) {
    return {
      result: { ok: false, error: `Unknown or disabled tool "${command}"` },
      build,
    };
  }

  // Ensure the operation input carries the projectId (runtime ops expect it).
  const operationInput =
    typeof input === "object" && input !== null
      ? { projectId, ...(input as Record<string, unknown>) }
      : { projectId };

  try {
    const mutation = await executeApiRuntimeMutation({
      id: contract.id as RuntimeOperationId,
      build,
      input: operationInput,
    });

    // Read operation or no-op: nothing to commit.
    if (contract.kind === "read" || mutation.noop || mutation.payload.length === 0) {
      return {
        result: { ok: true, version: build.version, result: mutation.result },
        build,
      };
    }

    const { version } = await commitBuildPatch({
      build,
      ctx,
      projectId,
      payload: mutation.payload,
    });

    // Reload the build so subsequent tool calls operate on fresh state.
    const reloaded = await loadDevBuildByProjectId(ctx, projectId);

    return {
      result: { ok: true, version, result: mutation.result },
      build: reloaded,
    };
  } catch (error) {
    if (error instanceof BuilderRuntimeError) {
      return {
        result: { ok: false, error: error.message, issues: error.issues },
        build,
      };
    }
    return {
      result: {
        ok: false,
        error: error instanceof Error ? error.message : "Tool execution failed",
      },
      build,
    };
  }
};
