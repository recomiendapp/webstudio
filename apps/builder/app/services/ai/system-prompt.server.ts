import { publicApiOperationDocumentation } from "@webstudio-is/protocol";

/**
 * System prompt for the in-app AI engine (increment 1).
 *
 * It combines a short behavior spec with the catalog of the enabled tools so
 * the model knows what it can do. The `insert-fragment` tool expects Webstudio
 * JSX (not raw HTML); the guidance below mirrors the format the builder's paste
 * and MCP flows already use.
 */

const behavior = `You are the Webstudio AI assistant, embedded in the Webstudio visual builder.
You help the user build and edit web pages by calling the available tools.

Rules:
- Prefer the "insert-fragment" tool to add content. Its "fragment" is authored
  in Webstudio JSX, NOT raw HTML.
- Use core components via the "$" namespace (e.g. <$.Box>, <$.Heading>,
  <$.Paragraph>, <$.Button>, <$.Image>) or generic elements via
  <ws.element ws:tag="section"> for arbitrary HTML tags.
- Apply local styles with ws:style={css\`padding: 24px; display: flex;\`}.
- Use "class"/"for" attributes (not React "className"/"htmlFor").
- Never invent tool names or arguments. Only call the tools provided.
- Before inserting into a specific place, use read tools (list-pages, get-page,
  list-instances, search-project) to find the correct parentInstanceId.
- Keep changes minimal and explain briefly what you did.
- Respond in the same language the user writes in.`;

const toolCatalog = () => {
  const enabled = new Set([
    "list-pages",
    "get-page",
    "list-instances",
    "search-project",
    "insert-fragment",
    "update-styles",
    "update-text",
    "set-text-content",
  ]);
  const lines = publicApiOperationDocumentation
    .filter((doc) => enabled.has(doc.command))
    .map((doc) => `- ${doc.command}: ${doc.description}`);
  return `Available tools:\n${lines.join("\n")}`;
};

export const getAiSystemPrompt = (context?: {
  selectedInstanceId?: string;
  selectedPageId?: string;
}): string => {
  const parts = [behavior, toolCatalog()];
  if (context?.selectedPageId !== undefined) {
    parts.push(`Currently selected page id: ${context.selectedPageId}`);
  }
  if (context?.selectedInstanceId !== undefined) {
    parts.push(
      `Currently selected instance id: ${context.selectedInstanceId} (a good default parentInstanceId for inserts)`
    );
  }
  return parts.join("\n\n");
};
