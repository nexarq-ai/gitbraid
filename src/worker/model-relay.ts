import { DurableObject } from 'cloudflare:workers';
import { performModelCall, type ModelCall, type ModelCallOutcome, type ModelTransportAi } from './model-transport';

export class ModelRelay extends DurableObject<{ AI?: ModelTransportAi }> {
  async call(call: ModelCall): Promise<ModelCallOutcome> {
    return performModelCall(this.env, call);
  }
}
