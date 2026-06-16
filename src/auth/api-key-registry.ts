import crypto from "crypto";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { generateApiKey } from "../config";
import { ApiKeyFile, ApiKeyRecord, ApiKeyTier } from "./types";

export interface ApiKeyAuthContext {
  key: string;
  record: ApiKeyRecord;
}

export interface ApiKeyTierLimits {
  lite: { concurrency: number; maxRequests5h: number };
  pro: { concurrency: number; maxRequests5h: number };
  admin: { concurrency: number; maxRequests5h: number };
}

export interface ApiKeyRegistryOptions {
  bootstrapAdminKey?: string;
  seededKeys?: string[];
  tierLimits: ApiKeyTierLimits;
  flushDebounceMs?: number;
}

const FILE_NAME = "api-keys.json";

function nowIso(): string {
  return new Date().toISOString();
}

function isKeyRecord(value: unknown): value is ApiKeyRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as ApiKeyRecord;
  return (
    typeof v.id === "string" &&
    typeof v.secret === "string" &&
    (v.tier === "lite" || v.tier === "pro" || v.tier === "admin") &&
    typeof v.enabled === "boolean" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

function isFile(value: unknown): value is ApiKeyFile {
  if (!value || typeof value !== "object") return false;
  const file = value as ApiKeyFile;
  return (
    file.version === 1 &&
    Array.isArray(file.keys) &&
    file.keys.every(isKeyRecord)
  );
}

function defaultNameForTier(tier: ApiKeyTier): string {
  return tier === "admin" ? "bootstrap-admin" : tier;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export class ApiKeyRegistry {
  private filePath: string;
  private bootstrapAdminKey?: string;
  private seededKeys: string[];
  private tierLimits: ApiKeyTierLimits;
  private keys: ApiKeyRecord[] = [];
  private secretIndex: Map<string, ApiKeyRecord> = new Map();
  private adminSecret: string | null = null;
  private flushDebounceMs: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushAgain = false;

  constructor(authDir: string, opts: ApiKeyRegistryOptions) {
    this.filePath = path.join(authDir, FILE_NAME);
    this.bootstrapAdminKey = opts.bootstrapAdminKey;
    this.seededKeys = opts.seededKeys ?? [];
    this.tierLimits = opts.tierLimits;
    this.flushDebounceMs = opts.flushDebounceMs ?? 250;
  }

  load(): void {
    const file = this.readFile();
    let changed = false;

    if (this.bootstrapAdminKey) {
      const hasBootstrap = file.keys.some(
        (k) => k.tier === "admin" && k.secret === this.bootstrapAdminKey,
      );
      if (!hasBootstrap) {
        const existingAdmin = file.keys.find(
          (k) => k.tier === "admin" && k.enabled,
        );
        file.keys.push(
          this.makeRecord(
            this.bootstrapAdminKey,
            "admin",
            defaultNameForTier("admin"),
            !existingAdmin,
          ),
        );
        changed = true;
      }
    }

    for (const secret of this.seededKeys) {
      if (file.keys.some((k) => k.secret === secret)) continue;
      const tier =
        this.bootstrapAdminKey && secret === this.bootstrapAdminKey
          ? "admin"
          : "lite";
      file.keys.push(
        this.makeRecord(secret, tier, defaultNameForTier(tier), true),
      );
      changed = true;
    }

    this.keys = file.keys;
    changed = this.reconcileAdminState(this.keys) || changed;
    this.rebuildIndex();
    if (changed || !fs.existsSync(this.filePath)) {
      this.writeFile();
    }
  }

  async reload(): Promise<void> {
    await this.flushPending();
    this.load();
  }

  private readFile(): ApiKeyFile {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, keys: [] };
    }
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as unknown;
      if (isFile(raw)) return raw;
    } catch {}
    return { version: 1, keys: [] };
  }

  private writeFile(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ version: 1, keys: this.keys }, null, 2),
      { mode: 0o600 },
    );
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushToDisk().catch((err) => {
        console.error(
          `[api-keys] failed to flush ${path.basename(this.filePath)}: ${err?.message || String(err)}`,
        );
      });
    }, this.flushDebounceMs);
  }

  async flushPending(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.flushToDisk();
      return;
    }
    if (this.flushPromise) {
      await this.flushPromise;
    }
  }

  private flushToDisk(): Promise<void> {
    if (this.flushPromise) {
      this.flushAgain = true;
      return this.flushPromise;
    }

    this.flushPromise = (async () => {
      do {
        this.flushAgain = false;
        const snapshot = JSON.stringify(
          { version: 1, keys: this.keys },
          null,
          2,
        );
        await fsp.mkdir(path.dirname(this.filePath), {
          recursive: true,
          mode: 0o700,
        });
        await fsp.writeFile(this.filePath, snapshot, {
          mode: 0o600,
        });
      } while (this.flushAgain);
    })().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private rebuildIndex(): void {
    this.secretIndex.clear();
    for (const rec of this.keys) {
      if (rec.enabled) this.secretIndex.set(rec.secret, rec);
    }
  }

  private makeRecord(
    secret: string,
    tier: ApiKeyTier,
    name: string,
    enabled: boolean,
  ): ApiKeyRecord {
    const ts = nowIso();
    return {
      id: newId("ak"),
      secret,
      tier,
      name,
      enabled,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  getAdminSecret(): string | null {
    return this.adminSecret;
  }

  authenticate(secret: string): ApiKeyAuthContext | null {
    const record = this.secretIndex.get(secret);
    if (!record) return null;
    return { key: secret, record };
  }

  resolveLimits(tier: ApiKeyTier): {
    concurrency: number;
    maxRequests5h: number;
  } {
    return this.tierLimits[tier];
  }

  list(): ApiKeyRecord[] {
    return this.keys.map((k) => ({ ...k }));
  }

  createKey(input: { tier?: ApiKeyTier; name?: string; enabled?: boolean }): {
    record: ApiKeyRecord;
    secret: string;
  } {
    const tier = input.tier ?? "lite";
    const secret = generateApiKey();
    const record = this.makeRecord(
      secret,
      tier,
      input.name ?? tier,
      input.enabled ?? true,
    );

    if (tier === "admin") {
      for (const rec of this.keys) {
        if (rec.tier === "admin" && rec.enabled) {
          rec.enabled = false;
          rec.updatedAt = nowIso();
        }
      }
      this.adminSecret = secret;
      this.keys = this.keys.filter((rec) => rec.tier !== "admin");
      this.keys.push(record);
    } else {
      this.keys.push(record);
    }

    this.reconcileAdminState(this.keys);
    this.rebuildIndex();
    this.scheduleFlush();
    return { record: { ...record }, secret };
  }

  updateKeyState(
    id: string,
    enabled: boolean,
  ): { record: ApiKeyRecord; changed: boolean } {
    const record = this.keys.find((rec) => rec.id === id);
    if (!record) {
      throw new Error(`API key not found: ${id}`);
    }

    if (record.tier === "admin" && enabled === false) {
      throw new Error("Admin key cannot be disabled");
    }

    if (record.enabled === enabled) {
      return { record: { ...record }, changed: false };
    }

    record.enabled = enabled;
    record.updatedAt = nowIso();
    if (record.tier === "admin" && enabled) {
      for (const rec of this.keys) {
        if (rec.id !== record.id && rec.tier === "admin" && rec.enabled) {
          rec.enabled = false;
          rec.updatedAt = nowIso();
        }
      }
    }

    this.reconcileAdminState(this.keys);
    this.rebuildIndex();
    this.scheduleFlush();
    return { record: { ...record }, changed: true };
  }

  private reconcileAdminState(records: ApiKeyRecord[] = this.keys): boolean {
    const adminRecords = records.filter((k) => k.tier === "admin" && k.enabled);
    if (adminRecords.length > 1) {
      const [first, ...rest] = adminRecords;
      for (const rec of rest) {
        rec.enabled = false;
        rec.updatedAt = nowIso();
      }
      this.adminSecret = first.secret;
      return true;
    }
    if (adminRecords.length === 1) {
      this.adminSecret = adminRecords[0].secret;
      return false;
    }
    this.adminSecret = null;
    return false;
  }
}
