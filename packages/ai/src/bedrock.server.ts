import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
  type ToolConfiguration,
  type ContentBlock,
  type SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

export type {
  Message,
  Tool,
  ToolConfiguration,
  ContentBlock,
  SystemContentBlock,
};

export type BedrockConfig = {
  region: string;
  modelId: string;
  /**
   * Optional explicit credentials. When omitted the AWS SDK default provider
   * chain is used (IAM role of the container, env vars, etc.).
   */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export const createBedrockClient = (config: BedrockConfig) => {
  const credentials =
    config.accessKeyId !== undefined && config.secretAccessKey !== undefined
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          sessionToken: config.sessionToken,
        }
      : undefined;

  const client = new BedrockRuntimeClient({
    region: config.region,
    ...(credentials ? { credentials } : {}),
  });

  return { client, modelId: config.modelId };
};

export type BedrockClient = ReturnType<typeof createBedrockClient>;

export type ConverseParams = {
  system?: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
  temperature?: number;
};

export type ConverseResult = {
  /** Reason the model stopped: "end_turn" | "tool_use" | "max_tokens" | ... */
  stopReason: string;
  /** The assistant message returned by the model (to append to history). */
  message: Message;
  /** Text content blocks concatenated for convenience. */
  text: string;
  /** Tool-use requests the model made, if any. */
  toolUses: Array<{
    toolUseId: string;
    name: string;
    input: unknown;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

/**
 * Single-turn Converse call. The caller runs the tool-use loop (see
 * apps/builder AI route): inspect `toolUses`, execute them, append tool
 * results to `messages`, and call `converse` again until `stopReason` is not
 * "tool_use".
 */
export const converse = async (
  { client, modelId }: BedrockClient,
  { system, messages, tools, maxTokens = 4096, temperature = 0 }: ConverseParams
): Promise<ConverseResult> => {
  const toolConfig: ToolConfiguration | undefined =
    tools && tools.length > 0 ? { tools } : undefined;

  const systemBlocks: SystemContentBlock[] | undefined =
    system !== undefined ? [{ text: system }] : undefined;

  const response = await client.send(
    new ConverseCommand({
      modelId,
      messages,
      system: systemBlocks,
      toolConfig,
      inferenceConfig: { maxTokens, temperature },
    })
  );

  const message = response.output?.message ?? { role: "assistant", content: [] };
  const content = message.content ?? [];

  const text = content
    .flatMap((block) => (block.text !== undefined ? [block.text] : []))
    .join("");

  const toolUses = content.flatMap((block) =>
    block.toolUse !== undefined
      ? [
          {
            toolUseId: block.toolUse.toolUseId ?? "",
            name: block.toolUse.name ?? "",
            input: block.toolUse.input,
          },
        ]
      : []
  );

  return {
    stopReason: response.stopReason ?? "end_turn",
    message,
    text,
    toolUses,
    usage: response.usage
      ? {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
        }
      : undefined,
  };
};
