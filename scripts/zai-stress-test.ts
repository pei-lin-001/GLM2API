import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;

type OpenAIToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIChatChoice = {
  finish_reason?: string | null;
  message?: {
    role?: string;
    content?: unknown;
    tool_calls?: OpenAIToolCall[];
  };
};

type OpenAIChatResponse = {
  choices?: OpenAIChatChoice[];
  data?: unknown[];
};

type RoundResult = {
  ok: boolean;
  latencyMs: number;
  detail: string;
};

type PhaseReport = {
  name: string;
  rounds: number;
  successes: number;
  failures: number;
  successRate: number;
  minLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  maxLatencyMs: number;
  failureSamples: string[];
};

type StressSummary = {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: JsonRecord;
  phases: PhaseReport[];
};

const DEFAULT_PORT = parseInt(process.env.ZAI_STRESS_PORT?.trim() || '8820', 10);
const BASE_URL = process.env.ZAI_STRESS_BASE_URL?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`;
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(CURRENT_FILE_PATH);
const SERVER_WORKDIR = resolve(SCRIPTS_DIR, '..');
const SERVER_PATH = resolve(SERVER_WORKDIR, 'scripts/zai-openai-compatible.ts');
const MODELS_ROUNDS = parseInt(process.env.ZAI_STRESS_MODELS_ROUNDS?.trim() || '10', 10);
const BASIC_ROUNDS = parseInt(process.env.ZAI_STRESS_BASIC_ROUNDS?.trim() || '6', 10);
const TOOL_ROUNDS = parseInt(process.env.ZAI_STRESS_TOOL_ROUNDS?.trim() || '4', 10);
const BURST_WAVES = parseInt(process.env.ZAI_STRESS_BURST_WAVES?.trim() || '2', 10);
const BURST_CONCURRENCY = parseInt(process.env.ZAI_STRESS_BURST_CONCURRENCY?.trim() || '3', 10);
const STARTUP_TIMEOUT_MS = parseInt(process.env.ZAI_STRESS_STARTUP_TIMEOUT_MS?.trim() || '30000', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.ZAI_STRESS_REQUEST_TIMEOUT_MS?.trim() || '180000', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const record = item as JsonRecord;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as JsonRecord;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}

async function fetchJson(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

async function waitForHealth(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    try {
      const response = await fetch(`${BASE_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return;
    } catch {
      // continue polling
    }
    await sleep(500);
  }
  throw new Error(`等待服务启动超时：${STARTUP_TIMEOUT_MS}ms`);
}

function spawnServer(): { child: ChildProcessWithoutNullStreams; logBuffer: string[] } {
  const logBuffer: string[] = [];
  const child = spawn('pnpm', ['exec', 'tsx', SERVER_PATH], {
    cwd: SERVER_WORKDIR,
    env: {
      ...process.env,
      ZAI_OPENAI_PORT: String(DEFAULT_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      logBuffer.push(line);
      if (logBuffer.length > 200) logBuffer.shift();
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  return { child, logBuffer };
}

async function stopServer(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child) return;
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  const startedAt = Date.now();
  while (child.exitCode == null && Date.now() - startedAt < 10000) {
    await sleep(200);
  }
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function runRound(executor: () => Promise<string>): Promise<RoundResult> {
  const startedAt = Date.now();
  try {
    const detail = await executor();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function toPhaseReport(name: string, results: RoundResult[]): PhaseReport {
  const latencies = results.map((item) => item.latencyMs);
  const successes = results.filter((item) => item.ok).length;
  const failures = results.length - successes;
  const failureSamples = results
    .filter((item) => !item.ok)
    .slice(0, 5)
    .map((item) => item.detail);
  return {
    name,
    rounds: results.length,
    successes,
    failures,
    successRate: results.length === 0 ? 0 : successes / results.length,
    minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
    avgLatencyMs:
      latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p90LatencyMs: percentile(latencies, 0.9),
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    failureSamples,
  };
}

async function runModelsRound(): Promise<string> {
  const payload = (await fetchJson('/v1/models', { method: 'GET', headers: {} })) as JsonRecord;
  const models = Array.isArray(payload.data) ? payload.data : [];
  if (models.length === 0) throw new Error('模型列表为空');
  return `models=${models.length}`;
}

async function runBasicRound(): Promise<string> {
  const payload = (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'glm-5',
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly OK' }],
    }),
  })) as OpenAIChatResponse;
  const choice = payload.choices?.[0];
  const finishReason = choice?.finish_reason;
  const content = flattenContent(choice?.message?.content).trim();
  if (finishReason !== 'stop') throw new Error(`finish_reason=${String(finishReason)}`);
  if (content !== 'OK') throw new Error(`unexpected content=${content}`);
  return content;
}

async function runToolCycleRound(): Promise<string> {
  const firstPayload = (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'glm-5',
      stream: false,
      messages: [{ role: 'user', content: '请使用 get_weather 工具查询北京天气，不要直接回答。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询某个城市的天气',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: '城市名' },
              },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'required',
    }),
  })) as OpenAIChatResponse;

  const firstChoice = firstPayload.choices?.[0];
  const firstFinishReason = firstChoice?.finish_reason;
  const firstToolCall = firstChoice?.message?.tool_calls?.[0];
  if (firstFinishReason !== 'tool_calls' || !firstToolCall) {
    throw new Error(`首轮未返回 tool_calls: ${JSON.stringify(firstChoice?.message || null)}`);
  }

  const secondPayload = (await fetchJson('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'glm-5',
      stream: false,
      messages: [
        { role: 'user', content: '请使用 get_weather 工具查询北京天气，不要直接回答。' },
        { role: 'assistant', content: null, tool_calls: [firstToolCall] },
        {
          role: 'tool',
          tool_call_id: firstToolCall.id,
          name: 'get_weather',
          content: '{"temperature":"22C","condition":"晴"}',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询某个城市的天气',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: '城市名' },
              },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    }),
  })) as OpenAIChatResponse;

  const secondChoice = secondPayload.choices?.[0];
  const secondFinishReason = secondChoice?.finish_reason;
  const secondContent = flattenContent(secondChoice?.message?.content).trim();
  if (secondFinishReason !== 'stop') {
    throw new Error(`二轮未返回 stop: ${JSON.stringify(secondChoice?.message || null)}`);
  }
  if (!/22|晴/.test(secondContent)) {
    throw new Error(`二轮内容异常: ${secondContent}`);
  }
  return secondContent;
}

async function runBurstBasicRound(concurrency: number): Promise<string> {
  const tasks = Array.from({ length: concurrency }, () => runBasicRound());
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((item) => item.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(
      `并发 basic 失败 ${failures.length}/${concurrency}: ${failures
        .map((item) => (item.status === 'rejected' ? String(item.reason) : ''))
        .join(' | ')}`
    );
  }
  return `concurrency=${concurrency}`;
}

async function runSequentialPhase(
  name: string,
  rounds: number,
  executor: () => Promise<string>
): Promise<PhaseReport> {
  const results: RoundResult[] = [];
  for (let index = 0; index < rounds; index += 1) {
    const result = await runRound(executor);
    results.push(result);
    console.log(`[${name}] round ${index + 1}/${rounds}: ${result.ok ? 'OK' : 'FAIL'} (${result.latencyMs}ms) ${result.detail}`);
  }
  return toPhaseReport(name, results);
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const useExistingServer = Boolean(process.env.ZAI_STRESS_BASE_URL?.trim());
  let child: ChildProcessWithoutNullStreams | undefined;
  let logBuffer: string[] = [];

  try {
    if (!useExistingServer) {
      const spawned = spawnServer();
      child = spawned.child;
      logBuffer = spawned.logBuffer;
    }

    await waitForHealth();

    const phases: PhaseReport[] = [];
    phases.push(await runSequentialPhase('models', MODELS_ROUNDS, runModelsRound));
    phases.push(await runSequentialPhase('basic', BASIC_ROUNDS, runBasicRound));
    phases.push(await runSequentialPhase('tool_cycle', TOOL_ROUNDS, runToolCycleRound));
    phases.push(
      await runSequentialPhase('basic_burst', BURST_WAVES, () => runBurstBasicRound(BURST_CONCURRENCY))
    );

    const finishedAt = new Date();
    const summary: StressSummary = {
      baseUrl: BASE_URL,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      config: {
        useExistingServer,
        modelsRounds: MODELS_ROUNDS,
        basicRounds: BASIC_ROUNDS,
        toolRounds: TOOL_ROUNDS,
        burstWaves: BURST_WAVES,
        burstConcurrency: BURST_CONCURRENCY,
      },
      phases,
    };

    console.log('=== ZAI STRESS SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[zai-stress-test] failed:', error instanceof Error ? error.message : String(error));
    if (logBuffer.length > 0) {
      console.error('--- recent server logs ---');
      for (const line of logBuffer) console.error(line);
    }
    process.exitCode = 1;
  } finally {
    await stopServer(child);
  }
}

await main();
