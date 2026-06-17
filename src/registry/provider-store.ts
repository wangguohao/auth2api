import { ProviderId } from "../auth/types";
import { buildAnthropicProvider } from "../providers/anthropic";
import { buildCodexProvider } from "../providers/codex";
import { buildCursorProvider } from "../providers/cursor";
import { Provider } from "../providers/types";
import { ProviderStore } from "./types";

/** 构建 provider 内存索引，启动时加载一次 provider 对象。 */
export function buildProviderStore(authDir: string): ProviderStore {
  const anthropic = buildAnthropicProvider(authDir);
  const codex = buildCodexProvider(authDir);
  const cursor = buildCursorProvider(authDir);
  const byId: Record<ProviderId, Provider> = { anthropic, codex, cursor };
  const ordered: Provider[] = [anthropic, codex, cursor];
  return { byId, ordered };
}
