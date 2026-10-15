type InternalMsg = { role: 'system' | 'developer' | 'user' | 'assistant'; content: string | { type: 'output_text'; text: string }[] };
type FunctionCall = { type: 'function_call'; call_id: string; name: string; arguments: string };
type FunctionCallOutput = { type: 'function_call_output'; call_id: string; output: string };
type InputRecord = Record<string, unknown>;

const MAX_THINKING_FIELD_LEN = 262144;

function getText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && (c as any).type === 'output_text' ? (c as any).text : '')).join('');
  }
  return '';
}

export function nativeModelId(modelId: string): string {
  return modelId.startsWith('anthropic/') ? modelId.slice('anthropic/'.length) : modelId;
}

export function isSonnet55(modelId: string): boolean {
  return nativeModelId(modelId) === 'claude-sonnet-5-5';
}

function validateAnthropicBlockRecord(record: unknown): void {
  if (!record || typeof record !== 'object' || (record as any).type !== 'anthropic_block') {
    throw new Error('Malformed anthropic_block record');
  }
  const block = (record as any).block;
  if (!block || typeof block !== 'object') throw new Error('Malformed anthropic_block payload');
  const btype = block.type;
  if (btype === 'thinking') {
    if (typeof block.thinking !== 'string' || block.thinking.length > MAX_THINKING_FIELD_LEN) {
      throw new Error('Malformed thinking block');
    }
    if (typeof block.signature !== 'string' || block.signature.length > MAX_THINKING_FIELD_LEN) {
      throw new Error('Malformed thinking signature');
    }
    return;
  }
  if (btype === 'redacted_thinking') {
    if (typeof block.data !== 'string' || block.data.length > MAX_THINKING_FIELD_LEN) {
      throw new Error('Malformed redacted_thinking block');
    }
    return;
  }
  throw new Error('Unknown anthropic_block type: ' + String(btype));
}

export function anthropicInput(input: InputRecord[], tools: InputRecord[], maxTokens: number, modelId?: string): Record<string, unknown> {
  let system = '';
  const messages: { role: string; content: unknown[] }[] = [];

  const pushBlock = (role: string, block: unknown) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      messages.push({ role, content: [block] });
    }
  };

  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('Malformed input record');
    const type = (item as any).type;

    if (type === 'function_call') {
      const fc = item as unknown as FunctionCall;
      if (typeof fc.call_id !== 'string' || typeof fc.name !== 'string' || typeof fc.arguments !== 'string') {
        throw new Error('Malformed function_call');
      }
      let parsedInput: unknown = {};
      try {
        const parsed = JSON.parse(fc.arguments);
        parsedInput = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        parsedInput = {};
      }
      pushBlock('assistant', { type: 'tool_use', id: fc.call_id, name: fc.name, input: parsedInput });
      continue;
    }

    if (type === 'function_call_output') {
      const fco = item as unknown as FunctionCallOutput;
      if (typeof fco.call_id !== 'string' || typeof fco.output !== 'string') {
        throw new Error('Malformed function_call_output');
      }
      pushBlock('user', { type: 'tool_result', tool_use_id: fco.call_id, content: fco.output });
      continue;
    }

    if (type === 'anthropic_block') {
      validateAnthropicBlockRecord(item);
      pushBlock('assistant', (item as any).block);
      continue;
    }

    const msg = item as unknown as InternalMsg;
    if (!msg.role) throw new Error('Malformed message record');
    const text = getText(msg.content);

    if (msg.role === 'system' || msg.role === 'developer') {
      system = system ? system + '\n' + text : text;
      continue;
    }
    if (msg.role === 'user' || msg.role === 'assistant') {
      pushBlock(msg.role, { type: 'text', text });
      continue;
    }
    throw new Error('Unknown role');
  }

  const nativeTools = tools.map((t) => {
    if (!t || typeof t !== 'object' || (t as any).type !== 'function') throw new Error('Malformed tool');
    const name = (t as any).name;
    const description = (t as any).description;
    const parameters = (t as any).parameters;
    if (typeof name !== 'string') throw new Error('Malformed tool name');
    return { name, description: typeof description === 'string' ? description : '', input_schema: parameters ?? { type: 'object', properties: {} } };
  });

  const result: Record<string, unknown> = {
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    messages,
  };

  if (modelId !== undefined && (modelId === 'anthropic/claude-sonnet-5-5' || modelId === 'claude-sonnet-5-5')) {
    result.thinking = { type: 'between_tools' };
    result.output_config = { effort: 'low' };
  }

  if (system) result.system = system;
  if (nativeTools.length) result.tools = nativeTools;
  return result;
}

export type AnthropicIssue = 'max_tokens' | 'pause_turn' | 'refusal' | 'context_window' | 'unknown_stop_reason' | 'overloaded' | 'provider_error' | 'empty_content' | 'incomplete_block' | 'malformed' | 'tool_limit';

export class AnthropicOutputError extends Error {
  constructor(public readonly issue: AnthropicIssue, public readonly stopReason: string | null, message: string) { super(message); this.name = 'AnthropicOutputError'; }
}

const STOP_ISSUES: Record<string, AnthropicIssue> = { max_tokens: 'max_tokens', pause_turn: 'pause_turn', refusal: 'refusal', model_context_window_exceeded: 'context_window' };

function safeToken(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z_]{1,48}$/.test(value) ? value : value === null || value === undefined ? null : 'unrecognized';
}

export function anthropicOutput(raw: Record<string, unknown>): {
  output: Record<string, unknown>[];
  calls: { call_id: string; name: string; arguments: string }[];
  text: string;
} {
  if (!raw || typeof raw !== 'object') throw new AnthropicOutputError('malformed', null, 'response is not an object');
  if (raw.type === 'error') {
    const errorType = safeToken((raw.error as { type?: unknown } | undefined)?.type);
    throw new AnthropicOutputError(errorType === 'overloaded_error' ? 'overloaded' : 'provider_error', null, `provider error ${errorType ?? 'without a type'}`);
  }
  if (raw.type !== 'message') throw new AnthropicOutputError('malformed', null, `response type ${safeToken(raw.type) ?? 'missing'}`);

  const stopReason = raw.stop_reason;
  const stopToken = safeToken(stopReason);
  if (stopReason !== 'end_turn' && stopReason !== 'tool_use') {
    throw new AnthropicOutputError(STOP_ISSUES[String(stopReason)] ?? 'unknown_stop_reason', stopToken, `stop_reason ${stopToken ?? 'missing'}`);
  }

  const content = raw.content;
  if (!Array.isArray(content)) throw new AnthropicOutputError('malformed', stopToken, 'content is not a list');

  const output: Record<string, unknown>[] = [];
  const calls: { call_id: string; name: string; arguments: string }[] = [];
  const seenIds = new Set<string>();
  let text = '';

  for (const block of content) {
    if (!block || typeof block !== 'object') throw new AnthropicOutputError('incomplete_block', stopToken, 'Malformed content block');
    const btype = (block as any).type;

    if (btype === 'text') {
      const t = (block as any).text;
      if (typeof t !== 'string') throw new AnthropicOutputError('incomplete_block', stopToken, 'Malformed text block');
      text += t;
      output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
      continue;
    }

    if (btype === 'tool_use') {
      const id = (block as any).id;
      const name = (block as any).name;
      const toolInput = (block as any).input;

      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) throw new AnthropicOutputError('incomplete_block', stopToken, 'Malformed tool_use block');
      if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) throw new AnthropicOutputError('incomplete_block', stopToken, 'Malformed tool_use input');
      if (id.length > 200) throw new AnthropicOutputError('incomplete_block', stopToken, 'call_id too long');
      if (name.length > 100) throw new AnthropicOutputError('incomplete_block', stopToken, 'name too long');
      if (seenIds.has(id)) throw new AnthropicOutputError('incomplete_block', stopToken, 'Duplicate call id');
      seenIds.add(id);

      const argsStr = JSON.stringify(toolInput);
      if (argsStr.length > 16000) throw new AnthropicOutputError('incomplete_block', stopToken, 'arguments too long');

      calls.push({ call_id: id, name, arguments: argsStr });
      output.push({ type: 'function_call', call_id: id, name, arguments: argsStr });
      continue;
    }

    if (btype === 'thinking') {
      const thinking = (block as any).thinking;
      const signature = (block as any).signature;
      if (typeof thinking !== 'string' || thinking.length > MAX_THINKING_FIELD_LEN) throw new AnthropicOutputError('incomplete_block', stopToken, 'Malformed thinking block');
      if (typeof signature !== 'string' || signature.length > MAX_THINKING_FIELD_LEN) throw new AnthropicOutputError('incomplete_block', stopToken, 'Malformed thinking signature');
      output.push({ type: 'anthropic_block', block: { type: 'thinking', thinking, signature } });
      continue;
    }

    if (btype === 'redacted_thinking') {
      const data = (block as any).data;
      if (typeof data !== 'string' || data.length > MAX_THINKING_FIELD_LEN) throw new AnthropicOutputError('incomplete_block', stopToken, 'Malformed redacted_thinking block');
      output.push({ type: 'anthropic_block', block: { type: 'redacted_thinking', data } });
      continue;
    }

    throw new AnthropicOutputError('incomplete_block', stopToken, `content block type ${safeToken(btype) ?? 'missing'}`);
  }

  if (calls.length > 4) throw new AnthropicOutputError('tool_limit', stopToken, `${calls.length} tool calls in one turn`);
  if ((calls.length > 0) !== (stopReason === 'tool_use')) throw new AnthropicOutputError('incomplete_block', stopToken, 'stop_reason must be tool_use when calls present');

  if (!calls.length && !text.trim()) throw new AnthropicOutputError('empty_content', stopToken, `no text or tool call (${content.length} content blocks)`);
  return { output, calls, text };
}
