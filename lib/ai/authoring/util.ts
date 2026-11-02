import type Anthropic from "@anthropic-ai/sdk";
import { getClaude, buildCachedSystem } from "@/lib/ai/claude";
import { callUsage, ModelOutputError, type CallUsage } from "./usage";

export interface ToolCallOpts {
  model: string;
  maxTokens: number;
  cachedSystem: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Anthropic.Messages.Tool["input_schema"];
  temperature?: number;
}

export interface ToolCallResult {
  input: unknown;
  usage: CallUsage;
}

export async function callTool(opts: ToolCallOpts): Promise<ToolCallResult> {
  const claude = getClaude();
  const response = await claude.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    system: buildCachedSystem(opts.cachedSystem),
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.inputSchema,
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
    messages: [{ role: "user", content: opts.userMessage }],
  });
  const usage = callUsage(response.model || opts.model, response.usage);

  if (response.stop_reason === "max_tokens") {
    throw new ModelOutputError(`Tool call to '${opts.toolName}' hit max_tokens (${opts.maxTokens}).`, usage);
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === opts.toolName,
  );
  if (!toolUse) {
    throw new ModelOutputError(
      `Model did not call tool '${opts.toolName}'. Stop reason: ${response.stop_reason}. Content: ${JSON.stringify(response.content).slice(0, 400)}`,
      usage,
    );
  }
  return { input: toolUse.input, usage };
}
