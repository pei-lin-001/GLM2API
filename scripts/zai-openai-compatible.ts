import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

type JsonRecord = Record<string, unknown>;

type OpenAIMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCallRequest[];
};

type OpenAIChatRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
};

type OpenAIToolFunction = {
  name?: string;
  description?: string;
  parameters?: unknown;
};

type OpenAIToolDefinition = {
  type?: string;
  function?: OpenAIToolFunction;
};

type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
      type?: string;
      function?: {
        name?: string;
      };
    };

type OpenAIToolCallRequest = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type NormalizedToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
};

type NormalizedToolChoice =
  | { mode: 'none' }
  | { mode: 'auto' }
  | { mode: 'required' }
  | { mode: 'function'; name: string };

type NormalizedToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type ParsedAssistantResponse =
  | {
      mode: 'assistant';
      content: string;
    }
  | {
      mode: 'tool_calls';
      toolCalls: NormalizedToolCall[];
    };

type ZaiUpstreamMessage = JsonRecord;

type ZaiAuth = {
  id: string;
  name: string;
  token: string;
  fetchedAt: number;
};

type ZaiModelDescriptor = {
  id: string;
  displayName: string;
  provider: string;
  raw: JsonRecord;
};

type ZaiParsedStream = {
  reasoningDeltas: string[];
  reasoningText: string;
  answerDeltas: string[];
  assistantText: string;
  usage?: JsonRecord;
  upstreamModel: string | null;
  created: number | null;
};

type ZaiStreamEvent = {
  phase: string;
  deltaContent: string;
  content: string;
  usage?: JsonRecord;
  done: boolean;
};

const HOST = process.env.ZAI_OPENAI_HOST?.trim() || '127.0.0.1';
const PORT = parseInt(process.env.ZAI_OPENAI_PORT?.trim() || '8788', 10);
const API_KEY = process.env.ZAI_OPENAI_API_KEY?.trim() || '';
const STARTUP_URL = process.env.ZAI_UPSTREAM_BASE_URL?.trim() || 'https://chat.z.ai';
const DEFAULT_MODEL = process.env.ZAI_DEFAULT_MODEL?.trim() || 'glm-5';
const STATIC_FE_VERSION = process.env.ZAI_FE_VERSION?.trim() || '';
const SIGNATURE_SECRET =
  process.env.ZAI_SIGNATURE_SECRET?.trim() || 'key-@@@@)))()((9))-xxxx&&&%%%%%';
const USER_AGENT =
  process.env.ZAI_USER_AGENT?.trim() ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const LOCALE = process.env.ZAI_LOCALE?.trim() || 'zh-CN';
const TIMEZONE = process.env.ZAI_TIMEZONE?.trim() || 'Asia/Shanghai';
const BROWSER_NAME = process.env.ZAI_BROWSER_NAME?.trim() || 'Chrome';
const OS_NAME = process.env.ZAI_OS_NAME?.trim() || 'Linux';
const SCREEN_WIDTH = process.env.ZAI_SCREEN_WIDTH?.trim() || '1440';
const SCREEN_HEIGHT = process.env.ZAI_SCREEN_HEIGHT?.trim() || '960';
const VIEWPORT_WIDTH = process.env.ZAI_VIEWPORT_WIDTH?.trim() || '1440';
const VIEWPORT_HEIGHT = process.env.ZAI_VIEWPORT_HEIGHT?.trim() || '960';
const PIXEL_RATIO = process.env.ZAI_PIXEL_RATIO?.trim() || '1';
const COLOR_DEPTH = process.env.ZAI_COLOR_DEPTH?.trim() || '24';
const MAX_TOUCH_POINTS = process.env.ZAI_MAX_TOUCH_POINTS?.trim() || '0';
const DOCUMENT_TITLE = process.env.ZAI_DOCUMENT_TITLE?.trim() || 'Z.ai';
const REQUEST_TIMEOUT_MS = parseInt(process.env.ZAI_REQUEST_TIMEOUT_MS?.trim() || '120000', 10);
const AUTH_CACHE_TTL_MS = parseInt(process.env.ZAI_AUTH_CACHE_TTL_MS?.trim() || '600000', 10);
const MODELS_CACHE_TTL_MS = parseInt(
  process.env.ZAI_MODELS_CACHE_TTL_MS?.trim() || '300000',
  10
);
const FE_VERSION_CACHE_TTL_MS = parseInt(
  process.env.ZAI_FE_VERSION_CACHE_TTL_MS?.trim() || '1800000',
  10
);
const ENABLE_THINKING = parseBoolean(process.env.ZAI_ENABLE_THINKING, true);
const PREVIEW_MODE = parseBoolean(process.env.ZAI_PREVIEW_MODE, true);
const MIRROR_REASONING_TO_CONTENT = parseBoolean(
  process.env.ZAI_MIRROR_REASONING_TO_CONTENT,
  true
);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const record = item as JsonRecord;
      const type = typeof record.type === 'string' ? record.type : '';
      if ((type === 'text' || type === 'input_text') && typeof record.text === 'string') {
        parts.push(record.text);
        continue;
      }
      if (type === 'output_text' && typeof record.text === 'string') {
        parts.push(record.text);
        continue;
      }
      if (typeof record.content === 'string') {
        parts.push(record.content);
      }
    }
    return parts.join('\n');
  }

  if (content && typeof content === 'object') {
    const record = content as JsonRecord;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }

  return '';
}

function buildAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function getTimezoneOffsetMinutesForZone(timeZone: string, date: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    });
    const zonePart = formatter
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value;
    const match = zonePart?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!match) return date.getTimezoneOffset();
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2] || '0');
    const minutes = Number(match[3] || '0');
    const total = sign * (hours * 60 + minutes);
    return -total;
  } catch {
    return date.getTimezoneOffset();
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function writeSseLine(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  const flush = (res as ServerResponse & { flush?: () => void }).flush;
  if (typeof flush === 'function') flush.call(res);
}

function createEmptyParsedStream(): ZaiParsedStream {
  return {
    reasoningDeltas: [],
    reasoningText: '',
    answerDeltas: [],
    assistantText: '',
    usage: undefined,
    upstreamModel: null,
    created: null,
  };
}

function finalizeParsedStream(parsed: ZaiParsedStream): ZaiParsedStream {
  const reasoningText =
    parsed.reasoningDeltas.length > 0 ? parsed.reasoningDeltas.join('') : parsed.reasoningText;
  const assistantText =
    parsed.answerDeltas.length > 0 ? parsed.answerDeltas.join('') : parsed.assistantText;

  return {
    ...parsed,
    reasoningDeltas: parsed.reasoningDeltas.length > 0 ? parsed.reasoningDeltas : reasoningText ? [reasoningText] : [],
    reasoningText,
    answerDeltas: parsed.answerDeltas.length > 0 ? parsed.answerDeltas : assistantText ? [assistantText] : [],
    assistantText,
  };
}

function drainSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  let normalized = buffer.replace(/\r\n/g, '\n');
  const blocks: string[] = [];

  while (true) {
    const separatorIndex = normalized.indexOf('\n\n');
    if (separatorIndex === -1) break;
    blocks.push(normalized.slice(0, separatorIndex));
    normalized = normalized.slice(separatorIndex + 2);
  }

  return {
    blocks,
    rest: normalized,
  };
}

function applyZaiSsePayload(target: ZaiParsedStream, payload: string): ZaiStreamEvent | null {
  if (!payload || payload === '[DONE]') {
    return {
      phase: 'done',
      deltaContent: '',
      content: '',
      done: true,
    };
  }

  const parsed = JSON.parse(payload) as JsonRecord;
  if (typeof parsed.model === 'string' && !target.upstreamModel) target.upstreamModel = parsed.model;
  if (typeof parsed.created === 'number' && !target.created) target.created = parsed.created;

  if (parsed.data === '[DONE]') {
    return {
      phase: 'done',
      deltaContent: '',
      content: '',
      done: true,
    };
  }

  if (!parsed.data || typeof parsed.data !== 'object') return null;

  const data = parsed.data as JsonRecord;
  const error = data.error;
  if (error && typeof error === 'object') {
    const errorRecord = error as JsonRecord;
    throw new Error(String(errorRecord.detail || errorRecord.message || 'Unknown upstream error'));
  }

  const usage = data.usage && typeof data.usage === 'object' ? (data.usage as JsonRecord) : undefined;
  if (usage) target.usage = usage;

  const phase = typeof data.phase === 'string' ? data.phase : 'other';
  const deltaContent = typeof data.delta_content === 'string' ? data.delta_content : '';
  const content = typeof data.content === 'string' ? data.content : '';
  const done = data.done === true || phase === 'done';

  if (phase === 'thinking') {
    if (deltaContent) target.reasoningDeltas.push(deltaContent);
    if (content) target.reasoningText = content;
  } else if (phase === 'answer') {
    if (deltaContent) target.answerDeltas.push(deltaContent);
    if (content) target.assistantText = content;
  }

  return {
    phase,
    deltaContent,
    content,
    usage,
    done,
  };
}

function applyZaiSseBlock(target: ZaiParsedStream, block: string): ZaiStreamEvent[] {
  const events: ZaiStreamEvent[] = [];
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));

  for (const line of lines) {
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const event = applyZaiSsePayload(target, payload);
      if (event) events.push(event);
    } catch (error) {
      throw error;
    }
  }

  return events;
}

function unauthorized(res: ServerResponse): void {
  writeJson(res, 401, {
    error: {
      message: 'Unauthorized',
      type: 'invalid_request_error',
      code: 'unauthorized',
    },
  });
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_KEY) return true;
  const authorization = req.headers.authorization || '';
  if (authorization === `Bearer ${API_KEY}`) return true;
  unauthorized(res);
  return false;
}

function normalizeTools(tools: OpenAIToolDefinition[] | undefined): NormalizedToolDefinition[] {
  if (!Array.isArray(tools)) return [];

  const normalizedTools: NormalizedToolDefinition[] = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function?.name) continue;
    normalizedTools.push({
      name: normalizeWhitespace(tool.function.name),
      description: normalizeWhitespace(tool.function.description || ''),
      parameters:
        tool.function.parameters && typeof tool.function.parameters === 'object'
          ? tool.function.parameters
          : { type: 'object', properties: {} },
    });
  }

  return normalizedTools;
}

function normalizeToolChoice(
  toolChoice: OpenAIToolChoice | undefined,
  tools: NormalizedToolDefinition[]
): NormalizedToolChoice {
  if (toolChoice == null || toolChoice === 'auto') return { mode: 'auto' };
  if (toolChoice === 'none') return { mode: 'none' };
  if (toolChoice === 'required') return { mode: 'required' };

  if (
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    typeof toolChoice.function?.name === 'string'
  ) {
    const name = normalizeWhitespace(toolChoice.function.name);
    const exists = tools.some((tool) => tool.name === name);
    if (exists) return { mode: 'function', name };
  }

  return { mode: 'auto' };
}

function getRequestedFunctionToolName(toolChoice: OpenAIToolChoice | undefined): string | null {
  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    typeof toolChoice.function?.name === 'string'
  ) {
    return normalizeWhitespace(toolChoice.function.name);
  }

  return null;
}

function hasToolResults(messages: OpenAIMessage[]): boolean {
  return messages.some((message) => (message.role || '').toLowerCase() === 'tool');
}

function buildToolInstructionMessage(
  tools: NormalizedToolDefinition[],
  toolChoice: NormalizedToolChoice,
  allowParallelToolCalls: boolean,
  conversationHasToolResults: boolean
): OpenAIMessage {
  const choiceInstruction =
    toolChoice.mode === 'required'
      ? '你必须返回 tool_calls，不能直接给最终答案。'
      : toolChoice.mode === 'function'
        ? `你必须且只能调用这个函数：${toolChoice.name}。`
        : toolChoice.mode === 'none'
          ? '不要调用任何函数，直接回答。'
          : '如果需要外部信息或执行动作，就返回 tool_calls；否则直接回答。';

  const resultInstruction = conversationHasToolResults
    ? '当前对话里已经包含 tool 结果。优先利用这些结果给出最终答案，除非确实还需要继续调用函数。'
    : '当前对话里还没有 tool 结果。';

  return {
    role: 'developer',
    content: [
      '你正在一个 OpenAI Compatible tools 适配器后面工作。',
      '你必须严格按照下面格式输出，且只能输出一个 XML 风格包裹块，不要输出任何额外文字，不要用 Markdown 代码块。',
      '',
      '<openai_tool_response>{"mode":"final","content":"最终回复文本"}</openai_tool_response>',
      '或',
      '<openai_tool_response>{"mode":"tool_calls","tool_calls":[{"name":"函数名","arguments":{"key":"value"}}]}</openai_tool_response>',
      '如果你实在无法输出上面的 XML 包裹块，至少输出纯 JSON 数组，例如：[{"name":"函数名","arguments":{"key":"value"}}]，不要再加任何解释。',
      '',
      '规则：',
      '1. mode 只能是 final 或 tool_calls。',
      '2. 如果输出 tool_calls，arguments 必须是 JSON 对象，不要把 arguments 写成字符串。',
      '3. 只能调用下方列出的函数。',
      '4. 如果没有必要调用函数，就输出 final。',
      `5. ${choiceInstruction}`,
      `6. ${resultInstruction}`,
      `7. ${allowParallelToolCalls ? '允许一次返回多个 tool_calls。' : '最多只能返回一个 tool_call。'}`,
      '',
      '可用函数列表（JSON）：',
      JSON.stringify(tools),
    ].join('\n'),
  };
}

function buildAssistantToolCallSummary(message: OpenAIMessage): string {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length === 0) return '';

  const normalized = toolCalls.map((toolCall) => ({
    id: normalizeWhitespace(toolCall.id || ''),
    type: toolCall.type || 'function',
    name: normalizeWhitespace(toolCall.function?.name || ''),
    arguments: toolCall.function?.arguments || '{}',
  }));

  return `[assistant_tool_calls]\n${JSON.stringify(normalized)}`;
}

function buildToolFinalizationMessages(messages: OpenAIMessage[]): ZaiUpstreamMessage[] {
  const systemInstructions = messages
    .filter((message) => {
      const role = (message.role || '').toLowerCase();
      return role === 'system' || role === 'developer';
    })
    .map((message) => flattenContent(message.content).trim())
    .filter(Boolean);

  const lastUserMessage =
    [...messages]
      .reverse()
      .find((message) => (message.role || '').toLowerCase() === 'user' && flattenContent(message.content).trim())
      ?.content ?? '';

  const toolResults = messages
    .filter((message) => (message.role || '').toLowerCase() === 'tool')
    .map((message) => flattenContent(message.content).trim() || '{}')
    .filter(Boolean);

  const rawUserQuestion = flattenContent(lastUserMessage).trim();
  const sanitizedUserQuestion =
    rawUserQuestion
      .replace(/请使用[^。！？\\n]*?工具/g, '')
      .replace(/请调用[^。！？\\n]*?工具/g, '')
      .replace(/不要直接回答[。！？]?/g, '')
      .replace(/直接回答[。！？]?/g, '')
      .trim() || rawUserQuestion;

  const sections = [
    systemInstructions.length > 0 ? `额外系统要求：\n${systemInstructions.join('\n\n')}` : '',
    sanitizedUserQuestion ? `用户真正想知道的问题：\n${sanitizedUserQuestion}` : '',
    toolResults.length > 0 ? `你已经拿到的事实数据：\n${JSON.stringify(toolResults, null, 2)}` : '',
  ].filter(Boolean);

  return [
    {
      role: 'system',
      content:
        '[instruction]\n你已经收到工具执行结果。现在只能直接回答用户问题，禁止再次调用任何函数，禁止输出 tool_calls、Tool call、工具调用、工具调用参数、函数名、arguments 等中间过程。',
    },
    {
      role: 'user',
      content: `请直接基于下面事实回答用户，不要重复描述调用工具的过程：\n\n${sections.join('\n\n')}`,
    },
  ];
}

function buildToolRepairMessages(
  messages: OpenAIMessage[],
  tools: NormalizedToolDefinition[],
  assistantDraft: string
): OpenAIMessage[] {
  const originalUserPrompt =
    [...messages]
      .reverse()
      .find((message) => (message.role || '').toLowerCase() === 'user' && flattenContent(message.content).trim())
      ?.content ?? '';

  return [
    {
      role: 'system',
      content: [
        '你现在处于函数调用修复模式。',
        '不要声称“没有工具”或“当前环境没有该工具”。这里给你的工具列表就是唯一真实可用工具。',
        '你的任务不是回答用户，而是把用户意图转换成函数调用。',
        '如果需要调用函数，只能从给定 tools 中选择。',
        '严格输出一个 XML 包裹块或纯 JSON 数组，不要输出解释。',
        '<openai_tool_response>{"mode":"tool_calls","tool_calls":[{"name":"函数名","arguments":{"key":"value"}}]}</openai_tool_response>',
        `可用 tools: ${JSON.stringify(tools)}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `用户原始问题：${flattenContent(originalUserPrompt).trim()}`,
        assistantDraft ? `你上一次错误草稿：${assistantDraft}` : '',
        '请重新输出正确的 tool_calls。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

function normalizeMessages(
  messages: OpenAIMessage[],
  options?: {
    tools?: NormalizedToolDefinition[];
    toolChoice?: NormalizedToolChoice;
    allowParallelToolCalls?: boolean;
  }
): ZaiUpstreamMessage[] {
  const normalized: ZaiUpstreamMessage[] = [];
  const normalizedTools = options?.tools || [];
  const toolChoice = options?.toolChoice || { mode: 'auto' as const };
  const toolCallNameById = new Map<string, string>();
  const conversationHasToolResults = hasToolResults(messages);

  if (conversationHasToolResults && toolChoice.mode !== 'required') {
    return buildToolFinalizationMessages(messages);
  }

  if (
    normalizedTools.length > 0 &&
    toolChoice.mode !== 'none' &&
    (!conversationHasToolResults || toolChoice.mode === 'required')
  ) {
    normalized.push({
      role: 'system',
      content: `[instruction]\n${flattenContent(
        buildToolInstructionMessage(
          normalizedTools,
          toolChoice,
          options?.allowParallelToolCalls !== false,
          conversationHasToolResults
        ).content
      )}`,
    });
  }

  for (const message of messages) {
    const role = (message.role || 'user').toLowerCase();
    const content = flattenContent(message.content).trim();

    if (role === 'assistant') {
      const assistantParts: string[] = [];
      if (content) assistantParts.push(content);

      const toolCallSummary = buildAssistantToolCallSummary(message);
      if (toolCallSummary) {
        assistantParts.push(toolCallSummary);
        for (const toolCall of message.tool_calls || []) {
          const toolCallId = normalizeWhitespace(toolCall.id || '');
          const toolName = normalizeWhitespace(toolCall.function?.name || '');
          if (toolCallId && toolName) toolCallNameById.set(toolCallId, toolName);
        }
      }

      const upstreamToolCalls = (message.tool_calls || [])
        .map((toolCall) => {
          const functionName = normalizeWhitespace(toolCall.function?.name || '');
          if (!functionName) return null;
          return {
            id: normalizeWhitespace(toolCall.id || '') || `call_${randomUUID().replace(/-/g, '')}`,
            type: 'function',
            function: {
              name: functionName,
              arguments: toolCall.function?.arguments || '{}',
            },
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      if (upstreamToolCalls.length > 0) {
        normalized.push({
          role: 'assistant',
          content: content || null,
          tool_calls: upstreamToolCalls,
        });
      } else if (assistantParts.length > 0) {
        normalized.push({ role: 'assistant', content: assistantParts.join('\n\n') });
      }
      continue;
    }

    if (role === 'user') {
      if (!content) continue;
      normalized.push({ role: 'user', content });
      continue;
    }

    if (role === 'system' || role === 'developer') {
      if (!content) continue;
      normalized.push({ role: 'system', content: `[instruction]\n${content}` });
      continue;
    }

    if (role === 'tool') {
      const toolCallId = normalizeWhitespace(message.tool_call_id || '');
      const toolName =
        normalizeWhitespace(message.name || '') || toolCallNameById.get(toolCallId) || 'tool';
      const toolResult = content || '{}';
      normalized.push({ role: 'tool', tool_call_id: toolCallId, name: toolName, content: toolResult });
      continue;
    }

    if (!content) continue;
    normalized.push({ role: 'user', content });
  }

  return normalized;
}

function extractTaggedToolResponse(text: string): string | null {
  const match = text.match(/<openai_tool_response>([\s\S]*?)<\/openai_tool_response>/i);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function extractFirstJsonStructure(text: string): string | null {
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!char) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      if (stack.length === 0) start = index;
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const expectedOpeningChar = char === '}' ? '{' : '[';
      const currentOpeningChar = stack[stack.length - 1];
      if (currentOpeningChar !== expectedOpeningChar) continue;
      stack.pop();
      if (stack.length === 0 && start >= 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function parseToolAdapterPayload(text: string): unknown {
  const candidates = [
    text.trim(),
    text
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim(),
    extractTaggedToolResponse(text),
    extractFirstJsonStructure(text),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 继续尝试其他候选
    }
  }

  return undefined;
}

function extractHeuristicToolCalls(text: string): Array<{ name: string; arguments: unknown }> {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const pattern = /Tool call:\s*([A-Za-z_][\w-]*)\s*([^\n]*)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const name = normalizeWhitespace(match[1] || '');
    const rest = normalizeWhitespace(match[2] || '');
    const args: Record<string, string> = {};
    const argPattern = /([A-Za-z_][\w-]*)\s*:\s*([^,，;；]+)/g;
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argPattern.exec(rest)) !== null) {
      args[argMatch[1]] = normalizeWhitespace(argMatch[2] || '');
    }

    calls.push({
      name,
      arguments: Object.keys(args).length > 0 ? args : {},
    });
  }

  const chineseMatch = text.match(
    /(工具调用|调用工具)[:：]\s*([A-Za-z_][\w-]*)[\s\S]*?参数[:：]\s*([\s\S]*)/i
  );
  if (chineseMatch) {
    const name = normalizeWhitespace(chineseMatch[2] || '');
    const rawArguments = normalizeWhitespace(chineseMatch[3] || '');
    const jsonCandidate = extractFirstJsonStructure(rawArguments);
    if (name) {
      if (jsonCandidate) {
        try {
          calls.push({
            name,
            arguments: JSON.parse(jsonCandidate) as unknown,
          });
        } catch {
          calls.push({ name, arguments: {} });
        }
      } else {
        calls.push({ name, arguments: {} });
      }
    }
  }

  const objectStyleMatch = text.match(
    /tool_call:\s*\{[\s\S]*?['"]name['"]\s*:\s*['"]([^'"]+)['"][\s\S]*?['"]arguments['"]\s*:\s*['"]([^'"]*)['"][\s\S]*?\}/i
  );
  if (objectStyleMatch) {
    const name = normalizeWhitespace(objectStyleMatch[1] || '');
    const rawArguments = objectStyleMatch[2] || '{}';
    try {
      calls.push({
        name,
        arguments: JSON.parse(rawArguments) as unknown,
      });
    } catch {
      calls.push({ name, arguments: {} });
    }
  }

  const namedStyleMatch = text.match(
    /Tool call name:\s*([A-Za-z_][\w-]*)[\s\S]*?Arguments:\s*([\s\S]*)/i
  );
  if (namedStyleMatch) {
    const name = normalizeWhitespace(namedStyleMatch[1] || '');
    const jsonCandidate = extractFirstJsonStructure(namedStyleMatch[2] || '');
    if (name) {
      if (jsonCandidate) {
        try {
          calls.push({
            name,
            arguments: JSON.parse(jsonCandidate) as unknown,
          });
        } catch {
          calls.push({ name, arguments: {} });
        }
      } else {
        calls.push({ name, arguments: {} });
      }
    }
  }

  const listStyleMatch = text.match(
    /Tool calls?:[\s\S]*?name:\s*([A-Za-z_][\w-]*)[\s\S]*?arguments:\s*([\s\S]*)/i
  );
  if (listStyleMatch) {
    const name = normalizeWhitespace(listStyleMatch[1] || '');
    const jsonCandidate = extractFirstJsonStructure(listStyleMatch[2] || '');
    if (name) {
      if (jsonCandidate) {
        try {
          calls.push({
            name,
            arguments: JSON.parse(jsonCandidate) as unknown,
          });
        } catch {
          calls.push({ name, arguments: {} });
        }
      } else {
        calls.push({ name, arguments: {} });
      }
    }
  }

  const functionStyleMatch = text.match(/([A-Za-z_][\w-]*)\(([^)]*)\)/);
  if (functionStyleMatch) {
    const name = normalizeWhitespace(functionStyleMatch[1] || '');
    const rawArguments = functionStyleMatch[2] || '';
    const args: Record<string, string> = {};
    const argPattern = /([A-Za-z_][\w-]*)\s*=\s*['"]([^'"]*)['"]/g;
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argPattern.exec(rawArguments)) !== null) {
      args[argMatch[1]] = argMatch[2];
    }
    if (name) {
      calls.push({
        name,
        arguments: Object.keys(args).length > 0 ? args : {},
      });
    }
  }

  const xmlStyleMatch = text.match(/<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>/);
  if (xmlStyleMatch) {
    const name = normalizeWhitespace(xmlStyleMatch[1] || '');
    const inner = xmlStyleMatch[2] || '';
    const args: Record<string, string> = {};
    const xmlArgPattern = /<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>/g;
    let xmlArgMatch: RegExpExecArray | null;
    while ((xmlArgMatch = xmlArgPattern.exec(inner)) !== null) {
      args[xmlArgMatch[1]] = normalizeWhitespace(xmlArgMatch[2] || '');
    }
    if (name) {
      calls.push({
        name,
        arguments: Object.keys(args).length > 0 ? args : {},
      });
    }
  }

  return calls;
}

function normalizeToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === 'string') {
    try {
      const parsed = JSON.parse(argumentsValue);
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed);
    } catch {
      // 保留原始字符串
    }
    return argumentsValue.trim() || '{}';
  }

  if (argumentsValue && typeof argumentsValue === 'object') {
    return JSON.stringify(argumentsValue);
  }

  return '{}';
}

function interpretAssistantResponse(
  request: OpenAIChatRequest,
  parsed: ZaiParsedStream,
  tools: NormalizedToolDefinition[]
): ParsedAssistantResponse {
  if (tools.length === 0) {
    return {
      mode: 'assistant',
      content: parsed.assistantText,
    };
  }

  const payload = parseToolAdapterPayload(parsed.assistantText);
  const rawToolCalls =
    Array.isArray(payload)
      ? payload
      : payload &&
          typeof payload === 'object' &&
          !Array.isArray(payload) &&
          typeof (payload as JsonRecord).name === 'string'
        ? [payload]
      : payload && typeof payload === 'object' && Array.isArray((payload as JsonRecord).tool_calls)
        ? ((payload as JsonRecord).tool_calls as unknown[])
        : payload && typeof payload === 'object' && Array.isArray((payload as JsonRecord).calls)
          ? ((payload as JsonRecord).calls as unknown[])
          : extractHeuristicToolCalls(parsed.assistantText);

  if (rawToolCalls.length > 0) {
    const allowedToolNames = new Set(tools.map((tool) => tool.name));
    const allowParallelToolCalls = request.parallel_tool_calls !== false;
    const normalizedToolCalls: NormalizedToolCall[] = [];
    const dedupeMap = new Map<string, NormalizedToolCall>();

    const rankArguments = (argumentsText: string): number => {
      if (!argumentsText || argumentsText === '{}') return 0;
      try {
        const parsedArguments = JSON.parse(argumentsText) as JsonRecord;
        if (!parsedArguments || typeof parsedArguments !== 'object') return 0;
        return Object.keys(parsedArguments).length;
      } catch {
        return argumentsText.trim().length > 2 ? 1 : 0;
      }
    };

    for (const rawToolCall of rawToolCalls) {
      if (!rawToolCall || typeof rawToolCall !== 'object') continue;
      const record = rawToolCall as JsonRecord;
      const functionName = normalizeWhitespace(String(record.name || ''));
      if (!functionName || !allowedToolNames.has(functionName)) continue;

      const normalizedToolCall = {
        id: `call_${randomUUID().replace(/-/g, '')}`,
        type: 'function',
        function: {
          name: functionName,
          arguments: normalizeToolArguments(record.arguments),
        },
      } satisfies NormalizedToolCall;

      const existing = dedupeMap.get(functionName);
      if (!existing) {
        dedupeMap.set(functionName, normalizedToolCall);
      } else if (
        rankArguments(normalizedToolCall.function.arguments) >
        rankArguments(existing.function.arguments)
      ) {
        dedupeMap.set(functionName, normalizedToolCall);
      }

      if (!allowParallelToolCalls) break;
    }

    normalizedToolCalls.push(...dedupeMap.values());

    if (normalizedToolCalls.length > 0) {
      return {
        mode: 'tool_calls',
        toolCalls: normalizedToolCalls,
      };
    }
  }

  if (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as JsonRecord).mode === 'final' &&
    typeof (payload as JsonRecord).content === 'string'
  ) {
    return {
      mode: 'assistant',
      content: String((payload as JsonRecord).content),
    };
  }

  return {
    mode: 'assistant',
    content: parsed.assistantText,
  };
}

function parseZaiEventStream(text: string): ZaiParsedStream {
  const parsed = createEmptyParsedStream();
  const { blocks, rest } = drainSseBlocks(text);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    applyZaiSseBlock(parsed, trimmed);
  }

  const remaining = rest.trim();
  if (remaining) {
    applyZaiSseBlock(parsed, remaining);
  }

  return finalizeParsedStream(parsed);
}

function buildModelListPayload(models: ZaiModelDescriptor[]) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.provider,
      display_name: model.displayName,
      proxied_by: 'chat.z.ai',
      raw: model.raw,
    })),
  };
}

function buildUsagePayload(parsed: ZaiParsedStream, promptText: string, completionText: string) {
  const usage = parsed.usage || {};
  const promptTokens =
    typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : approximateTokens(promptText);
  const completionTokens =
    typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : approximateTokens(completionText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : promptTokens + completionTokens,
  };
}

function buildChatCompletionResponse(
  request: OpenAIChatRequest,
  parsed: ZaiParsedStream,
  assistantResponse: ParsedAssistantResponse
) {
  const created = parsed.created ?? Math.floor(Date.now() / 1000);
  const responseModel = request.model || parsed.upstreamModel || DEFAULT_MODEL;
  const promptText = (request.messages || [])
    .map((item) => flattenContent(item.content))
    .join('\n');
  const completionText =
    assistantResponse.mode === 'assistant'
      ? [parsed.reasoningText, assistantResponse.content].filter(Boolean).join('\n')
      : parsed.reasoningText;
  const finishReason = assistantResponse.mode === 'tool_calls' ? 'tool_calls' : 'stop';
  const message =
    assistantResponse.mode === 'tool_calls'
      ? {
          role: 'assistant',
          content: null,
          reasoning_content: parsed.reasoningText || undefined,
          reasoning: parsed.reasoningText || undefined,
          tool_calls: assistantResponse.toolCalls,
        }
      : {
          role: 'assistant',
          content: assistantResponse.content,
          reasoning_content: parsed.reasoningText || undefined,
          reasoning: parsed.reasoningText || undefined,
        };

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created,
    model: responseModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: buildUsagePayload(parsed, promptText, completionText),
    system_fingerprint: 'zai-http-bridge',
  };
}

function buildStreamChunkEnvelope(
  id: string,
  created: number,
  model: string,
  delta: JsonRecord,
  finishReason: string | null
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function buildRoleStreamChunk(id: string, created: number, model: string) {
  return buildStreamChunkEnvelope(id, created, model, { role: 'assistant' }, null);
}

function buildReasoningStreamChunk(id: string, created: number, model: string, reasoningDelta: string) {
  return buildStreamChunkEnvelope(
    id,
    created,
    model,
    {
      reasoning_content: reasoningDelta,
      reasoning: reasoningDelta,
      ...(MIRROR_REASONING_TO_CONTENT ? { content: reasoningDelta } : {}),
    },
    null
  );
}

function buildContentStreamChunk(id: string, created: number, model: string, contentDelta: string) {
  return buildStreamChunkEnvelope(id, created, model, { content: contentDelta }, null);
}

function buildToolCallStreamChunks(
  id: string,
  created: number,
  model: string,
  toolCalls: NormalizedToolCall[]
) {
  return toolCalls.map((toolCall, index) =>
    buildStreamChunkEnvelope(
      id,
      created,
      model,
      {
        tool_calls: [
          {
            index,
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          },
        ],
      },
      null
    )
  );
}

function buildFinishStreamChunk(
  id: string,
  created: number,
  model: string,
  finishReason: 'stop' | 'tool_calls'
) {
  return buildStreamChunkEnvelope(id, created, model, {}, finishReason);
}

function buildStreamChunks(
  request: OpenAIChatRequest,
  parsed: ZaiParsedStream,
  assistantResponse: ParsedAssistantResponse
) {
  const created = parsed.created ?? Math.floor(Date.now() / 1000);
  const responseModel = request.model || parsed.upstreamModel || DEFAULT_MODEL;
  const id = `chatcmpl_${randomUUID().replace(/-/g, '')}`;
  const chunks: unknown[] = [buildRoleStreamChunk(id, created, responseModel)];

  if (assistantResponse.mode === 'tool_calls') {
    for (const delta of parsed.reasoningDeltas) {
      chunks.push(buildReasoningStreamChunk(id, created, responseModel, delta));
    }

    chunks.push(...buildToolCallStreamChunks(id, created, responseModel, assistantResponse.toolCalls));
  } else {
    for (const delta of parsed.reasoningDeltas) {
      chunks.push(buildReasoningStreamChunk(id, created, responseModel, delta));
    }

    for (const delta of parsed.answerDeltas) {
      chunks.push(buildContentStreamChunk(id, created, responseModel, delta));
    }
  }

  chunks.push(buildFinishStreamChunk(id, created, responseModel, assistantResponse.mode === 'tool_calls' ? 'tool_calls' : 'stop'));

  return chunks;
}

async function readResponseText(response: Response): Promise<string> {
  return response.text();
}

async function buildResponseError(response: Response): Promise<Error> {
  const text = await readResponseText(response);
  try {
    const parsed = JSON.parse(text) as JsonRecord;
    const errorRecord =
      parsed.error && typeof parsed.error === 'object' ? (parsed.error as JsonRecord) : parsed;
    return new Error(String(errorRecord.detail || errorRecord.message || text || response.status));
  } catch {
    return new Error(text || `HTTP ${response.status}`);
  }
}

async function relayUpstreamSseToOpenAI(params: {
  res: ServerResponse;
  upstreamResponse: Response;
  request: OpenAIChatRequest;
  allowIncrementalAnswer: boolean;
  streamId: string;
  created: number;
  model: string;
}): Promise<{ parsed: ZaiParsedStream; streamedReasoningCount: number; streamedAnswerCount: number }> {
  const { res, upstreamResponse, request, allowIncrementalAnswer, streamId, created, model } = params;
  const parsed = createEmptyParsedStream();
  const reader = upstreamResponse.body?.getReader();
  if (!reader) throw new Error('上游流响应缺少 body');

  const decoder = new TextDecoder();
  let buffer = '';
  let streamedReasoningCount = 0;
  let streamedAnswerCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const drained = drainSseBlocks(buffer);
    buffer = drained.rest;

    for (const block of drained.blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const events = applyZaiSseBlock(parsed, trimmed);
      for (const event of events) {
        if (event.phase === 'thinking' && event.deltaContent) {
          writeSseLine(res, buildReasoningStreamChunk(streamId, created, model, event.deltaContent));
          streamedReasoningCount += 1;
          continue;
        }

        if (event.phase === 'answer' && event.deltaContent && allowIncrementalAnswer) {
          writeSseLine(res, buildContentStreamChunk(streamId, created, model, event.deltaContent));
          streamedAnswerCount += 1;
        }
      }
    }
  }

  buffer += decoder.decode();
  const remaining = buffer.trim();
  if (remaining) {
    const events = applyZaiSseBlock(parsed, remaining);
    for (const event of events) {
      if (event.phase === 'thinking' && event.deltaContent) {
        writeSseLine(res, buildReasoningStreamChunk(streamId, created, model, event.deltaContent));
        streamedReasoningCount += 1;
        continue;
      }

      if (event.phase === 'answer' && event.deltaContent && allowIncrementalAnswer) {
        writeSseLine(res, buildContentStreamChunk(streamId, created, model, event.deltaContent));
        streamedAnswerCount += 1;
      }
    }
  }

  return {
    parsed: finalizeParsedStream(parsed),
    streamedReasoningCount,
    streamedAnswerCount,
  };
}

class ZaiHttpBridge {
  private authCache?: ZaiAuth;
  private modelsCache?: { fetchedAt: number; models: ZaiModelDescriptor[] };
  private feVersionCache?: { fetchedAt: number; value: string };

  private buildBaseHeaders(feVersion: string): Record<string, string> {
    return {
      'Accept-Language': `${LOCALE},zh;q=0.9,en;q=0.8`,
      'User-Agent': USER_AGENT,
      'X-FE-Version': feVersion,
    };
  }

  private clearAuth(): void {
    this.authCache = undefined;
  }

  private clearFeVersion(): void {
    this.feVersionCache = undefined;
  }

  async getFeVersion(forceRefresh = false): Promise<string> {
    if (STATIC_FE_VERSION) return STATIC_FE_VERSION;

    if (
      !forceRefresh &&
      this.feVersionCache &&
      Date.now() - this.feVersionCache.fetchedAt < FE_VERSION_CACHE_TTL_MS
    ) {
      return this.feVersionCache.value;
    }

    const response = await fetch(STARTUP_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: buildAbortSignal(),
    });
    if (!response.ok) throw await buildResponseError(response);

    const html = await response.text();
    const match = html.match(/z-ai\/frontend\/([^/]+)\/_app\/immutable\/entry\/app\.[^"']+\.js/);
    const value = match?.[1]?.trim();
    if (!value) throw new Error('无法从首页提取 X-FE-Version');

    this.feVersionCache = {
      fetchedAt: Date.now(),
      value,
    };

    return value;
  }

  async ensureAuth(forceRefresh = false): Promise<ZaiAuth> {
    if (!forceRefresh && this.authCache && Date.now() - this.authCache.fetchedAt < AUTH_CACHE_TTL_MS) {
      return this.authCache;
    }

    const feVersion = await this.getFeVersion();
    const response = await fetch(`${STARTUP_URL}/api/v1/auths/`, {
      headers: this.buildBaseHeaders(feVersion),
      signal: buildAbortSignal(),
    });
    if (!response.ok) throw await buildResponseError(response);

    const parsed = (await response.json()) as JsonRecord;
    const id = String(parsed.id || '');
    const name = String(parsed.name || 'Guest');
    const token = String(parsed.token || '');
    if (!id || !token) throw new Error('匿名鉴权返回缺少 id 或 token');

    const auth = {
      id,
      name,
      token,
      fetchedAt: Date.now(),
    } satisfies ZaiAuth;

    this.authCache = auth;
    return auth;
  }

  async listModels(forceRefresh = false): Promise<ZaiModelDescriptor[]> {
    if (
      !forceRefresh &&
      this.modelsCache &&
      Date.now() - this.modelsCache.fetchedAt < MODELS_CACHE_TTL_MS
    ) {
      return this.modelsCache.models;
    }

    const auth = await this.ensureAuth();
    const feVersion = await this.getFeVersion();
    const response = await fetch(`${STARTUP_URL}/api/models`, {
      headers: {
        ...this.buildBaseHeaders(feVersion),
        Authorization: `Bearer ${auth.token}`,
      },
      signal: buildAbortSignal(),
    });

    if (response.status === 401) {
      this.clearAuth();
      return this.listModels(true);
    }

    if (!response.ok) throw await buildResponseError(response);

    const parsed = (await response.json()) as JsonRecord;
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    const models = data
      .filter((item): item is JsonRecord => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: String(item.id || ''),
        displayName: String(item.name || item.id || ''),
        provider: String(item.owned_by || 'chat.z.ai'),
        raw: item,
      }))
      .filter((item) => item.id);

    this.modelsCache = {
      fetchedAt: Date.now(),
      models,
    };

    return models;
  }

  private buildVariables(userName: string): Record<string, string> {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const currentDate = `${year}-${month}-${day}`;
    const currentTime = `${hours}:${minutes}:${seconds}`;
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    return {
      '{{USER_NAME}}': userName,
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': `${currentDate} ${currentTime}`,
      '{{CURRENT_DATE}}': currentDate,
      '{{CURRENT_TIME}}': currentTime,
      '{{CURRENT_WEEKDAY}}': weekdays[now.getDay()] || 'Unknown',
      '{{CURRENT_TIMEZONE}}': TIMEZONE,
      '{{USER_LANGUAGE}}': LOCALE,
    };
  }

  private buildSignatureContext(auth: ZaiAuth) {
    const timestamp = String(Date.now());
    const requestId = randomUUID();
    const sortedPayload = Object.entries({
      timestamp,
      requestId,
      user_id: auth.id,
    })
      .sort((left, right) => left[0].localeCompare(right[0]))
      .join(',');

    const now = new Date();
    const urlParams = new URLSearchParams({
      timestamp,
      requestId,
      user_id: auth.id,
      version: '0.0.1',
      platform: 'web',
      token: auth.token,
      user_agent: USER_AGENT,
      language: LOCALE,
      languages: `${LOCALE},zh,en-US,en`,
      timezone: TIMEZONE,
      cookie_enabled: 'true',
      screen_width: SCREEN_WIDTH,
      screen_height: SCREEN_HEIGHT,
      screen_resolution: `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
      viewport_height: VIEWPORT_HEIGHT,
      viewport_width: VIEWPORT_WIDTH,
      viewport_size: `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
      color_depth: COLOR_DEPTH,
      pixel_ratio: PIXEL_RATIO,
      current_url: `${STARTUP_URL}/`,
      pathname: '/',
      search: '',
      hash: '',
      host: new URL(STARTUP_URL).host,
      hostname: new URL(STARTUP_URL).hostname,
      protocol: new URL(STARTUP_URL).protocol,
      referrer: '',
      title: DOCUMENT_TITLE,
      timezone_offset: String(getTimezoneOffsetMinutesForZone(TIMEZONE, now)),
      local_time: now.toISOString(),
      utc_time: now.toUTCString(),
      is_mobile: 'false',
      is_touch: 'false',
      max_touch_points: MAX_TOUCH_POINTS,
      browser_name: BROWSER_NAME,
      os_name: OS_NAME,
    });

    return {
      timestamp,
      sortedPayload,
      urlParams: urlParams.toString(),
    };
  }

  private sign(sortedPayload: string, prompt: string, timestamp: string) {
    const base64Prompt = Buffer.from(prompt, 'utf8').toString('base64');
    const data = `${sortedPayload}|${base64Prompt}|${timestamp}`;
    const bucket = Math.floor(Number(timestamp) / (5 * 60 * 1000));
    const inner = createHmac('sha256', SIGNATURE_SECRET).update(String(bucket)).digest('hex');
    const signature = createHmac('sha256', inner).update(data).digest('hex');
    return {
      signature,
      timestamp,
    };
  }

  private extractCurrentUserPrompt(messages: OpenAIMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if ((message.role || '').toLowerCase() !== 'user') continue;
      const content = flattenContent(message.content).trim();
      if (content) return content;
    }
    return '';
  }

  private extractCurrentUpstreamPrompt(messages: ZaiUpstreamMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (String(message.role || '').toLowerCase() !== 'user') continue;
      const content = flattenContent(message.content).trim();
      if (content) return content;
    }
    return '';
  }

  private async createChat(model: string, prompt: string, auth: ZaiAuth): Promise<{ chatId: string; currentUserMessageId: string }> {
    const feVersion = await this.getFeVersion();
    const currentUserMessageId = randomUUID();
    const body = {
      chat: {
        id: '',
        title: '新聊天',
        models: [model],
        params: {},
        history: {
          messages: {
            [currentUserMessageId]: {
              id: currentUserMessageId,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: prompt || 'Hello',
              timestamp: Math.floor(Date.now() / 1000),
              models: [model],
            },
          },
          currentId: currentUserMessageId,
        },
        tags: [],
        flags: [],
        features: [{ type: 'tool_selector', server: 'tool_selector_h', status: 'hidden' }],
        mcp_servers: [],
        enable_thinking: ENABLE_THINKING,
        auto_web_search: false,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
      },
    };

    const response = await fetch(`${STARTUP_URL}/api/v1/chats/new`, {
      method: 'POST',
      headers: {
        ...this.buildBaseHeaders(feVersion),
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        Referer: `${STARTUP_URL}/`,
      },
      body: JSON.stringify(body),
      signal: buildAbortSignal(),
    });

    if (response.status === 401) {
      this.clearAuth();
      const refreshedAuth = await this.ensureAuth(true);
      return this.createChat(model, prompt, refreshedAuth);
    }

    if (!response.ok) throw await buildResponseError(response);

    const parsed = (await response.json()) as JsonRecord;
    const chatId = String(parsed.id || parsed.chat_id || '');
    if (!chatId) throw new Error('创建聊天成功但未返回 chat_id');

    return {
      chatId,
      currentUserMessageId,
    };
  }

  async complete(
    request: OpenAIChatRequest,
    normalizedMessages: ZaiUpstreamMessage[]
  ): Promise<ZaiParsedStream> {
    const completionInput = this.buildCompletionInput(request, normalizedMessages);
    const response = await this.openCompletionResponseWithRetry(completionInput);
    const text = await response.text();
    return parseZaiEventStream(text);
  }

  async completeStream(
    request: OpenAIChatRequest,
    normalizedMessages: ZaiUpstreamMessage[],
    signal?: AbortSignal
  ): Promise<Response> {
    const completionInput = this.buildCompletionInput(request, normalizedMessages, signal);
    return this.openCompletionResponseWithRetry(completionInput);
  }

  private buildCompletionInput(
    request: OpenAIChatRequest,
    normalizedMessages: ZaiUpstreamMessage[],
    signal?: AbortSignal
  ) {
    const model = normalizeWhitespace(request.model || '') || DEFAULT_MODEL;
    const originalMessages = Array.isArray(request.messages) ? request.messages : [];
    const currentUserPrompt =
      (hasToolResults(originalMessages)
        ? this.extractCurrentUpstreamPrompt(normalizedMessages)
        : this.extractCurrentUserPrompt(originalMessages)) || 'Hello';

    return {
      request,
      model,
      normalizedMessages,
      currentUserPrompt,
      retryAuth: true,
      retryVersion: true,
      signal,
    };
  }

  private async openCompletionResponseWithRetry(input: {
    request: OpenAIChatRequest;
    model: string;
    normalizedMessages: ZaiUpstreamMessage[];
    currentUserPrompt: string;
    retryAuth: boolean;
    retryVersion: boolean;
    signal?: AbortSignal;
  }): Promise<Response> {
    const auth = await this.ensureAuth();
    const chat = await this.createChat(input.model, input.currentUserPrompt, auth);
    const signatureContext = this.buildSignatureContext(auth);
    const { signature, timestamp } = this.sign(
      signatureContext.sortedPayload,
      input.currentUserPrompt,
      signatureContext.timestamp
    );
    const feVersion = await this.getFeVersion();

    const completionBody = {
      stream: true,
      model: input.model,
      messages: input.normalizedMessages,
      signature_prompt: input.currentUserPrompt,
      params: {},
      extra: {},
      features: {
        image_generation: false,
        web_search: false,
        auto_web_search: false,
        preview_mode: PREVIEW_MODE,
        flags: [],
        enable_thinking: ENABLE_THINKING,
      },
      variables: this.buildVariables(auth.name),
      chat_id: chat.chatId,
      id: randomUUID(),
      current_user_message_id: chat.currentUserMessageId,
      current_user_message_parent_id: null,
    };

    const response = await fetch(
      `${STARTUP_URL}/api/v2/chat/completions?${signatureContext.urlParams}&signature_timestamp=${timestamp}`,
      {
        method: 'POST',
        headers: {
          ...this.buildBaseHeaders(feVersion),
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          'X-Signature': signature,
          Referer: `${STARTUP_URL}/c/${chat.chatId}`,
        },
        body: JSON.stringify(completionBody),
        signal: buildAbortSignal(input.signal),
      }
    );

    if (response.status === 401 && input.retryAuth) {
      this.clearAuth();
      return this.openCompletionResponseWithRetry({ ...input, retryAuth: false });
    }

    if (response.status === 426 && input.retryVersion) {
      this.clearFeVersion();
      return this.openCompletionResponseWithRetry({ ...input, retryVersion: false });
    }

    if (!response.ok) throw await buildResponseError(response);
    return response;
  }
}

const bridge = new ZaiHttpBridge();

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (requestUrl.pathname === '/health' && req.method === 'GET') {
      const feVersion = await bridge.getFeVersion().catch(() => STATIC_FE_VERSION || null);
      writeJson(res, 200, {
        status: 'ok',
        service: 'zai-openai-compatible',
        upstream: STARTUP_URL,
        feVersion,
      });
      return;
    }

    if (!checkAuth(req, res)) return;

    if (requestUrl.pathname === '/v1/models' && req.method === 'GET') {
      const models = await bridge.listModels();
      writeJson(res, 200, buildModelListPayload(models));
      return;
    }

    if (requestUrl.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = (await readJsonBody(req)) as OpenAIChatRequest;
      const normalizedTools = normalizeTools(body.tools);
      if (Array.isArray(body.tools) && body.tools.length > 0 && normalizedTools.length === 0) {
        writeJson(res, 400, {
          error: {
            message: '当前只支持 type=function 的 tools',
            type: 'invalid_request_error',
            code: 'unsupported_tools',
          },
        });
        return;
      }

      const requestedFunctionToolName = getRequestedFunctionToolName(body.tool_choice);
      if (
        requestedFunctionToolName &&
        !normalizedTools.some((tool) => tool.name === requestedFunctionToolName)
      ) {
        writeJson(res, 400, {
          error: {
            message: `tool_choice 指定的函数不存在：${requestedFunctionToolName}`,
            type: 'invalid_request_error',
            code: 'tool_choice_invalid',
          },
        });
        return;
      }

      const originalMessages = Array.isArray(body.messages) ? body.messages : [];
      const toolChoice = normalizeToolChoice(body.tool_choice, normalizedTools);
      const normalizedMessages = normalizeMessages(originalMessages, {
        tools: normalizedTools,
        toolChoice,
        allowParallelToolCalls: body.parallel_tool_calls !== false,
      });

      if (normalizedMessages.length === 0) {
        writeJson(res, 400, {
          error: {
            message: 'messages 不能为空',
            type: 'invalid_request_error',
            code: 'messages_required',
          },
        });
        return;
      }

      const conversationHasToolResults = hasToolResults(originalMessages);
      const mayRequireDeferredToolDecision =
        normalizedTools.length > 0 && toolChoice.mode !== 'none' && !conversationHasToolResults;

      if (body.stream) {
        const abortController = new AbortController();
        const abortUpstream = () => abortController.abort();
        req.once('close', abortUpstream);

        try {
          const upstreamResponse = await bridge.completeStream(body, normalizedMessages, abortController.signal);
          const created = Math.floor(Date.now() / 1000);
          const responseModel = body.model || DEFAULT_MODEL;
          const streamId = `chatcmpl_${randomUUID().replace(/-/g, '')}`;
          const allowIncrementalAnswer = !mayRequireDeferredToolDecision;

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.socket?.setNoDelay(true);
          res.flushHeaders();
          writeSseLine(res, buildRoleStreamChunk(streamId, created, responseModel));

          let parsed: ZaiParsedStream;
          let streamedReasoningCount = 0;
          let streamedAnswerCount = 0;

          const relayed = await relayUpstreamSseToOpenAI({
            res,
            upstreamResponse,
            request: body,
            allowIncrementalAnswer,
            streamId,
            created,
            model: responseModel,
          });

          parsed = relayed.parsed;
          streamedReasoningCount = relayed.streamedReasoningCount;
          streamedAnswerCount = relayed.streamedAnswerCount;

          let assistantResponse = interpretAssistantResponse(body, parsed, normalizedTools);

          if (
            normalizedTools.length > 0 &&
            toolChoice.mode !== 'none' &&
            !conversationHasToolResults &&
            assistantResponse.mode === 'assistant'
          ) {
            const repairMessages = buildToolRepairMessages(originalMessages, normalizedTools, parsed.assistantText);
            const repairedRequest: OpenAIChatRequest = {
              ...body,
              messages: repairMessages,
              stream: false,
            };
            const repairedNormalizedMessages = normalizeMessages(repairMessages, {
              tools: normalizedTools,
              toolChoice,
              allowParallelToolCalls: body.parallel_tool_calls !== false,
            });
            const repairedParsed = await bridge.complete(repairedRequest, repairedNormalizedMessages);
            const repairedAssistantResponse = interpretAssistantResponse(
              repairedRequest,
              repairedParsed,
              normalizedTools
            );
            if (repairedAssistantResponse.mode === 'tool_calls') {
              assistantResponse = repairedAssistantResponse;
            }
          }

          if (streamedReasoningCount === 0 && parsed.reasoningText) {
            writeSseLine(res, buildReasoningStreamChunk(streamId, created, responseModel, parsed.reasoningText));
          }

          if (assistantResponse.mode === 'tool_calls') {
            for (const chunk of buildToolCallStreamChunks(streamId, created, responseModel, assistantResponse.toolCalls)) {
              writeSseLine(res, chunk);
            }
          } else if (!allowIncrementalAnswer) {
            const answerDeltas =
              parsed.answerDeltas.length > 0 ? parsed.answerDeltas : parsed.assistantText ? [parsed.assistantText] : [];
            if (streamedAnswerCount === 0) {
              for (const delta of answerDeltas) {
                writeSseLine(res, buildContentStreamChunk(streamId, created, responseModel, delta));
              }
            }
          } else if (streamedAnswerCount === 0 && assistantResponse.content) {
            writeSseLine(res, buildContentStreamChunk(streamId, created, responseModel, assistantResponse.content));
          }

          writeSseLine(
            res,
            buildFinishStreamChunk(streamId, created, responseModel, assistantResponse.mode === 'tool_calls' ? 'tool_calls' : 'stop')
          );
          writeSseLine(res, '[DONE]');
          res.end();
          return;
        } catch (error) {
          if (res.headersSent) {
            writeSseLine(res, {
              error: {
                message: error instanceof Error ? error.message : String(error),
                type: 'server_error',
                code: 'stream_error',
              },
            });
            writeSseLine(res, '[DONE]');
            res.end();
            return;
          }
          throw error;
        } finally {
          req.off('close', abortUpstream);
        }
      }

      let parsed = await bridge.complete(body, normalizedMessages);
      let assistantResponse = interpretAssistantResponse(body, parsed, normalizedTools);

      if (
        normalizedTools.length > 0 &&
        toolChoice.mode !== 'none' &&
        !hasToolResults(originalMessages) &&
        assistantResponse.mode === 'assistant'
      ) {
        const repairMessages = buildToolRepairMessages(originalMessages, normalizedTools, parsed.assistantText);
        const repairedRequest: OpenAIChatRequest = {
          ...body,
          messages: repairMessages,
          stream: false,
        };
        const repairedNormalizedMessages = normalizeMessages(repairMessages, {
          tools: normalizedTools,
          toolChoice,
          allowParallelToolCalls: body.parallel_tool_calls !== false,
        });
        const repairedParsed = await bridge.complete(repairedRequest, repairedNormalizedMessages);
        const repairedAssistantResponse = interpretAssistantResponse(
          repairedRequest,
          repairedParsed,
          normalizedTools
        );
        if (repairedAssistantResponse.mode === 'tool_calls') {
          parsed = repairedParsed;
          assistantResponse = repairedAssistantResponse;
        }
      }

      writeJson(res, 200, buildChatCompletionResponse(body, parsed, assistantResponse));
      return;
    }

    writeJson(res, 404, {
      error: {
        message: 'Not Found',
        type: 'invalid_request_error',
        code: 'not_found',
      },
    });
  } catch (error) {
    writeJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'server_error',
        code: 'internal_error',
      },
    });
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[zai-openai-compatible] received ${signal}, shutting down...`);
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

server.listen(PORT, HOST, () => {
  console.log(`[zai-openai-compatible] listening on http://${HOST}:${PORT}`);
  console.log('[zai-openai-compatible] endpoints: GET /health, GET /v1/models, POST /v1/chat/completions');
});
