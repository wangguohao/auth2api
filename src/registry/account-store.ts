import { Provider } from "../providers/types";
import { AccountStoreSnapshots } from "./types";

/** 读取 provider 账号状态快照，不修改账号选择状态。 */
export function snapshotAccountStore(providers: Provider[]): AccountStoreSnapshots {
  const snapshots: AccountStoreSnapshots = {};
  for (const provider of providers) {
    snapshots[provider.id] = {
      accounts: provider.manager.getSnapshots(),
      account_count: provider.manager.accountCount,
      routing_cache: provider.manager.getRoutingCacheStats(),
    };
  }
  return snapshots;
}
