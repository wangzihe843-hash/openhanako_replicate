import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, Credential, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
// Pi 0.87 keeps the file-lock implementation internal. Keep this dependency at
// the adapter boundary: forced rotation and ordinary refresh must share a lock.
import {
  AuthStorage as CredentialStorage,
  FileAuthStorageBackend,
  InMemoryAuthStorageBackend,
  type AuthStorageBackend,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

export { FileAuthStorageBackend, InMemoryAuthStorageBackend };
export type { OAuthLoginCallbacks };

const registryRuntimes = new WeakMap<ModelRegistry, ModelRuntime>();

export function configuredAzureRequestEnv(
  model: Parameters<ModelRuntime["streamSimple"]>[0],
  options?: { env?: Record<string, string>; azureBaseUrl?: string; azureResourceName?: string },
  runtime?: ModelRuntime,
) {
  // Pi's Azure catalog leaves baseUrl empty. A concrete endpoint belongs to
  // Hana's configured model, including provider/model overrides after refresh.
  if (!model.baseUrl?.trim() || !(model.api === "azure-openai-responses"
    || (model.provider === "azure" && model.api === "openai-completions"))) return undefined;
  const extension = runtime?.getRegisteredProviderConfig(model.provider);
  if (runtime?.getRegisteredNativeProvider(model.provider)
    || (extension?.streamSimple && extension.api === model.api)) return undefined;

  // Scope defaults before ModelRuntime merges credential env. Only explicit
  // caller options may override a configured endpoint/deployment, not ambient env.
  const env = options?.env;
  const baseUrl = options?.azureBaseUrl?.trim() || env?.AZURE_OPENAI_BASE_URL?.trim();
  const resourceName = options?.azureResourceName?.trim() || env?.AZURE_OPENAI_RESOURCE_NAME?.trim();
  return {
    ...env,
    AZURE_OPENAI_BASE_URL: baseUrl || (resourceName ? " " : model.baseUrl),
    AZURE_OPENAI_RESOURCE_NAME: resourceName || " ",
    // Pi uses || for env fallback: an empty string would restore process.env.
    // Whitespace is truthy but parses as an empty deployment map/base URL.
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP?.trim() || " ",
  };
}

function preserveConfiguredAzureRequests(runtime: ModelRuntime) {
  const stream = runtime.stream.bind(runtime);
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.stream = (model, context, options) => {
    const env = configuredAzureRequestEnv(model, options, runtime);
    return stream(model, context, env ? { ...options, env } : options);
  };
  runtime.streamSimple = (model, context, options) => {
    const env = configuredAzureRequestEnv(model, options, runtime);
    return streamSimple(model, context, env ? { ...options, env } : options);
  };
}

function abortablePrompt(result: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Login cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function loginInteraction(callbacks: OAuthLoginCallbacks): AuthInteraction {
  return {
    signal: callbacks.signal,
    async prompt(prompt) {
      const result = prompt.type === "select"
        ? callbacks.onSelect({ ...prompt, options: [...prompt.options] }).then(value => {
          if (value === undefined) throw new Error("Login cancelled");
          return value;
        })
        : prompt.type === "manual_code" && callbacks.onManualCodeInput
          ? callbacks.onManualCodeInput()
          : callbacks.onPrompt(prompt);
      return abortablePrompt(result, prompt.signal ?? callbacks.signal);
    },
    notify(event) {
      if (event.type === "auth_url") callbacks.onAuth(event);
      else if (event.type === "device_code") callbacks.onDeviceCode(event);
      else callbacks.onProgress?.(event.message);
    },
  };
}

/** Hana's credential facade; all provider auth is owned by Pi's ModelRuntime. */
export class AuthStorage {
  readonly credentials: CredentialStorage;
  private runtime?: ModelRuntime;
  private runtimePromise?: Promise<ModelRuntime>;
  private readonly runtimeKeys = new Map<string, string>();
  private readonly backend: AuthStorageBackend;

  private constructor(backend: AuthStorageBackend, credentials?: CredentialStorage) {
    this.backend = backend;
    this.credentials = credentials ?? CredentialStorage.fromStorage(backend);
  }

  static create(authPath: string) {
    return new AuthStorage(new FileAuthStorageBackend(authPath), CredentialStorage.create(authPath));
  }

  static fromStorage(backend: AuthStorageBackend) {
    return new AuthStorage(backend);
  }

  static inMemory(data: Record<string, Credential> = {}) {
    const backend = new InMemoryAuthStorageBackend();
    backend.withLock(() => ({ result: undefined, next: JSON.stringify(data) }));
    return new AuthStorage(backend);
  }

  reload() { this.credentials.reload(); }

  get(providerId: string) {
    return this.backend.withLock(current => ({
      result: (current ? JSON.parse(current) : {})[providerId],
    }));
  }

  has(providerId: string) { return this.get(providerId) !== undefined; }

  remove(providerId: string) {
    this.backend.withLock(current => {
      const data = current ? JSON.parse(current) : {};
      delete data[providerId];
      return { result: undefined, next: JSON.stringify(data, null, 2) };
    });
    this.reload();
  }

  async getRuntime(modelsPath: string | null = null): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({
      credentials: this.credentials,
      modelsPath,
      allowModelNetwork: false,
    }).then(async runtime => {
      preserveConfiguredAzureRequests(runtime);
      for (const [providerId, key] of this.runtimeKeys) {
        await runtime.setRuntimeApiKey(providerId, key);
      }
      this.runtime = runtime;
      return runtime;
    }).catch(error => {
      this.runtimePromise = undefined;
      throw error;
    });
    return this.runtimePromise;
  }

  async setRuntimeApiKey(providerId: string, key: string) {
    this.runtimeKeys.set(providerId, key);
    await this.runtime?.setRuntimeApiKey(providerId, key);
  }

  async removeRuntimeApiKey(providerId: string) {
    this.runtimeKeys.delete(providerId);
    await this.runtime?.removeRuntimeApiKey(providerId);
  }

  getOAuthProviders() {
    return (this.runtime?.getProviders() ?? builtinProviders()).flatMap(provider => {
      const oauth = provider.auth?.oauth;
      if (!oauth) return [];
      return [{
        id: provider.id,
        name: oauth.name,
        usesCallbackServer: this.runtime?.getRegisteredProviderConfig(provider.id)?.oauth?.usesCallbackServer
          ?? ["openai-codex", "anthropic"].includes(provider.id),
        refreshToken: (credential: OAuthCredentials, signal = new AbortController().signal) =>
          oauth.refresh({ ...credential, type: "oauth" }, signal),
        getApiKey: async (credential: OAuthCredentials) => (await oauth.toAuth({ ...credential, type: "oauth" })).apiKey,
      }];
    });
  }

  async getApiKey(providerId: string, options?: { includeFallback?: boolean }) {
    if (options?.includeFallback === false && !this.has(providerId) && !this.runtimeKeys.has(providerId)) {
      return undefined;
    }
    return (await (await this.getRuntime()).getAuth(providerId))?.auth.apiKey;
  }

  async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
    await (await this.getRuntime()).login(providerId, "oauth", loginInteraction(callbacks));
    this.reload();
  }

  async logout(providerId: string): Promise<void> {
    await (await this.getRuntime()).logout(providerId);
    this.runtimeKeys.delete(providerId);
    this.reload();
  }
}

export async function createModelRegistry(authStorage: AuthStorage, modelsJsonPath?: string) {
  const runtime = await authStorage.getRuntime(modelsJsonPath ?? null);
  const registry = new ModelRegistry(runtime);
  registryRuntimes.set(registry, runtime);
  return registry;
}

export function getModelRuntime(registry: ModelRegistry): ModelRuntime {
  const runtime = registryRuntimes.get(registry);
  if (!runtime) throw new Error("Model registry was not created by the Hana Pi adapter");
  return runtime;
}

export async function getAvailableModels(registry: ModelRegistry) {
  return registryRuntimes.has(registry)
    ? getModelRuntime(registry).getAvailable()
    : registry.getAvailable();
}
