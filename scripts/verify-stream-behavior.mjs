const baseUrl = process.env.ZAI_VERIFY_BASE_URL?.trim() || 'http://127.0.0.1:8788';
const requestTimeoutMs = parseInt(process.env.ZAI_VERIFY_TIMEOUT_MS?.trim() || '180000', 10);
const payload = {
  model: process.env.ZAI_VERIFY_MODEL?.trim() || 'glm-5',
  stream: true,
  messages: [
    {
      role: 'user',
      content:
        process.env.ZAI_VERIFY_PROMPT?.trim() || '请先简短思考，再只回答 1+1 的结果。',
    },
  ],
};

const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  signal: AbortSignal.timeout(requestTimeoutMs),
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

if (!response.ok || !response.body) {
  throw new Error(`HTTP ${response.status}: ${await response.text()}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
const startedAt = Date.now();
let buffer = '';
let contentChunkCount = 0;
let reasoningChunkCount = 0;
let firstReasoningAt = -1;
let firstContentAt = -1;
let finishReason = '';
let sawDone = false;

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
  let separatorIndex = buffer.indexOf('\n\n');
  while (separatorIndex !== -1) {
    const block = buffer.slice(0, separatorIndex);
    buffer = buffer.slice(separatorIndex + 2);

    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'));

    for (const line of lines) {
      const rawPayload = line.slice(5).trim();
      const currentMs = Date.now() - startedAt;

      if (!rawPayload) continue;
      if (rawPayload === '[DONE]') {
        sawDone = true;
        console.log(`[${currentMs}ms] [DONE]`);
        continue;
      }

      const parsed = JSON.parse(rawPayload);
      const choice = parsed?.choices?.[0] || {};
      const delta = choice?.delta || {};

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoningChunkCount += 1;
        if (firstReasoningAt === -1) firstReasoningAt = currentMs;
        console.log(`[${currentMs}ms] reasoning: ${JSON.stringify(delta.reasoning_content)}`);
      }

      if (typeof delta.content === 'string' && delta.content) {
        contentChunkCount += 1;
        if (firstContentAt === -1) firstContentAt = currentMs;
        console.log(`[${currentMs}ms] content: ${JSON.stringify(delta.content)}`);
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
        console.log(`[${currentMs}ms] finish_reason: ${finishReason}`);
      }
    }

    separatorIndex = buffer.indexOf('\n\n');
  }
}

console.log('\n=== SUMMARY ===');
console.log(
  JSON.stringify(
    {
      baseUrl,
      firstReasoningAt,
      firstContentAt,
      reasoningChunkCount,
      contentChunkCount,
      finishReason,
      sawDone,
    },
    null,
    2
  )
);

if (firstReasoningAt === -1) throw new Error('未观察到 reasoning_content');
if (firstContentAt === -1) throw new Error('未观察到 content');
if (contentChunkCount < 2) throw new Error(`content 分片过少：${contentChunkCount}`);
if (!sawDone) throw new Error('未观察到 [DONE]');
if (finishReason !== 'stop') throw new Error(`finish_reason 异常：${finishReason}`);
