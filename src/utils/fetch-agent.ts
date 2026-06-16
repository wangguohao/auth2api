import { Agent, setGlobalDispatcher } from "undici";

let installed = false;

export function installFetchKeepAliveAgent(): void {
  if (installed) return;
  installed = true;

  setGlobalDispatcher(
    new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
      connections: 128,
      pipelining: 1,
    }),
  );
}
