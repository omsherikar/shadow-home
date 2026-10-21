// Fakes shared by the turn's tests.
import type Anthropic from '@anthropic-ai/sdk';

/** A Messages API reply with these blocks. */
export const reply = (content: unknown[], stop = 'end_turn'): Anthropic.Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  }) as Anthropic.Message;
