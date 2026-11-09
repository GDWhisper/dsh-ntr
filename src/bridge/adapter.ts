import type {
  GenerateOptions,
  LlmAdapterLike,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '../protocol.ts'
import type { BridgeManager } from './manager.ts'

export class AcpLlmAdapter implements LlmAdapterLike {
  constructor(private readonly manager: BridgeManager) {}

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ACP' }
  }

  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /**
   * Advertise NOTHING, on purpose (see `AgentCatalogResult` and
   * `BridgeManager.agentCatalog`).
   *
   * DSH's model catalog is per request, not per session (`buildModelCatalog(ctx)`
   * takes no session id), so an `acp` that listed models would list them in
   * every conversation — including the ones with no ACP agent behind them. The
   * catalog is advisory (its own contract: "an adapter may accept unlisted model
   * ids, and consumers must not turn absence into request rejection"), and route
   * liveness is judged by registration, not by this list, so `acp@agent` and
   * `acp@agent@choice` still resolve and stream while being advertised nowhere.
   * An empty list also keeps this hot path (every `session.models` / `llm.models`
   * request) allocation-free: there is no per-session seam to filter with, so
   * nothing may be listed until there is. The ACP seats read the per-agent view
   * through `agent/catalog` instead.
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return []
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.manager.resolveAdapterModel(provider, model)
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.manager.streamPrompt(options)
  }
}
