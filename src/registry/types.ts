import { ProviderId } from "../auth/types";
import { AccountSnapshot } from "../accounts/manager";
import { Provider } from "../providers/types";
import { RoutingCacheStats } from "../cache/routing-cache-stats";

/** provider store 的只读内存索引。 */
export interface ProviderStore {
  byId: Record<ProviderId, Provider>;
  ordered: Provider[];
}

/** 管理接口使用的账号层快照。 */
export interface AccountStoreSnapshot {
  accounts: AccountSnapshot[];
  account_count: number;
  routing_cache: RoutingCacheStats;
}

/** 全 provider 账号快照。 */
export type AccountStoreSnapshots = Record<string, AccountStoreSnapshot>;
