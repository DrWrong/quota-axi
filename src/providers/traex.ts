import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { readCachedProvider as readCachedProviderFromDisk } from "../cache.js";
import { findCommandPath as findCommandPathOnDisk } from "../lib/process.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ModelQuotaTelemetry,
  ProviderAdapter,
  ProviderModelTelemetry,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

const TRAEX_BINARY_ENV = "QUOTA_AXI_TRAEX_BINARY";
const CATALOG_ARGS = ["models", "--json"] as const;
const CATALOG_TIMEOUT_MS = 8_000;
const CATALOG_OUTPUT_LIMIT_BYTES = 256 * 1024;
const STALE_MAX_AGE_MS = 5 * 60 * 1_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const CATALOG_SOURCE = "model-catalog";

type TraexBinaryState =
  | { status: "available"; path: string }
  | { status: "missing"; path?: string; error: string };

type CatalogResult = { stdout: string; stderr: string };

type TraexDependencies = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  timeoutMs: number;
  maxOutputBytes: number;
  findCommandPath: typeof findCommandPathOnDisk;
  readCachedProvider: typeof readCachedProviderFromDisk;
  runCatalog(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<CatalogResult>;
};

type NormalizedCatalog = {
  models: ProviderModelTelemetry[];
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

type TraexFailureOptions = {
  status?: ProviderQuota["state"]["status"];
  authSourceStatus?: AuthSourceReport["status"];
  staleEligible?: boolean;
};

export function createTraexAdapter(
  overrides: Partial<TraexDependencies> = {},
): ProviderAdapter {
  const dependencies: TraexDependencies = {
    env: process.env,
    now: Date.now,
    timeoutMs: CATALOG_TIMEOUT_MS,
    maxOutputBytes: CATALOG_OUTPUT_LIMIT_BYTES,
    // Keep resolution lazy so provider-scoped tests can replace unrelated
    // process helpers without loading or probing TraeX.
    findCommandPath: (command) => findCommandPathOnDisk(command),
    readCachedProvider: readCachedProviderFromDisk,
    runCatalog: executeCatalog,
    ...overrides,
  };

  return {
    id: "traex",
    label: "TraeX",
    fetchQuota(_options: ProviderOptions): Promise<ProviderQuota> {
      return acquireTraexCatalog(dependencies);
    },
    inspectAuth(_options: ProviderOptions): Promise<AuthProviderReport> {
      return inspectTraexCatalog(dependencies);
    },
  };
}

export const traexAdapter = createTraexAdapter();

async function acquireTraexCatalog(
  dependencies: TraexDependencies,
): Promise<ProviderQuota> {
  const binary = await resolveTraexBinary(dependencies);
  const attempts: SourceAttempt[] = [];
  if (binary.status === "missing") {
    attempts.push({
      source: CATALOG_SOURCE,
      status: "skipped",
      error: binary.error,
    });
    return failedProvider({
      provider: "traex",
      label: "TraeX",
      status: "unavailable",
      error: binary.error,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  attempts.push({ source: CATALOG_SOURCE, status: "failed" });
  try {
    const normalized = await probeCatalog(binary.path, dependencies);
    attempts[0] = { source: CATALOG_SOURCE, status: "success" };
    const report = successProvider({
      provider: "traex",
      label: "TraeX",
      source: "cli",
      windows: normalized.windows,
      models: normalized.models,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    if (normalized.untrustedWindowIds.length > 0) {
      report.state.untrustedWindowIds = normalized.untrustedWindowIds;
    }
    return report;
  } catch (error) {
    const failure =
      error instanceof TraexFailure
        ? error
        : new TraexFailure("traex_catalog_execution_failed", {
            staleEligible: true,
          });
    attempts[0] = {
      source: CATALOG_SOURCE,
      status: "failed",
      error: failure.code,
    };
    if (failure.staleEligible) {
      try {
        const cached = dependencies.readCachedProvider("traex");
        const stale = cached
          ? staleTraexReport(cached, failure.code, attempts, dependencies.now())
          : undefined;
        if (stale) return stale;
      } catch {
        // A cache failure cannot replace the bounded current probe failure.
      }
    }
    return failedProvider({
      provider: "traex",
      label: "TraeX",
      status: failure.status,
      error: failure.code,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectTraexCatalog(
  dependencies: TraexDependencies,
): Promise<AuthProviderReport> {
  const binary = await resolveTraexBinary(dependencies);
  if (binary.status === "missing") {
    return {
      provider: "traex",
      sources: [
        {
          source: CATALOG_SOURCE,
          path: binary.path,
          status: "missing",
          error: binary.error,
        },
      ],
    };
  }

  try {
    await probeCatalog(binary.path, dependencies);
    return {
      provider: "traex",
      sources: [
        {
          source: CATALOG_SOURCE,
          path: binary.path,
          status: "available",
        },
      ],
    };
  } catch (error) {
    const failure =
      error instanceof TraexFailure
        ? error
        : new TraexFailure("traex_catalog_execution_failed");
    return {
      provider: "traex",
      sources: [
        {
          source: CATALOG_SOURCE,
          path: binary.path,
          status: failure.authSourceStatus,
          error: failure.code,
        },
      ],
    };
  }
}

async function resolveTraexBinary(
  dependencies: TraexDependencies,
): Promise<TraexBinaryState> {
  const configured = dependencies.env[TRAEX_BINARY_ENV];
  if (configured !== undefined) {
    const path = configured.trim();
    if (!path || !isAbsolute(path)) {
      return {
        status: "missing",
        error: "traex_binary_override_not_absolute",
      };
    }
    const executable = await dependencies.findCommandPath(path);
    if (!executable) {
      return {
        status: "missing",
        path,
        error: "traex_binary_override_not_executable",
      };
    }
    return { status: "available", path: executable };
  }

  const executable = await dependencies.findCommandPath("traex");
  return executable
    ? { status: "available", path: executable }
    : { status: "missing", error: "traex_binary_missing" };
}

async function probeCatalog(
  executable: string,
  dependencies: TraexDependencies,
): Promise<NormalizedCatalog> {
  const result = await dependencies.runCatalog(
    executable,
    CATALOG_ARGS,
    dependencies.timeoutMs,
    dependencies.maxOutputBytes,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new TraexFailure("traex_catalog_malformed_json", {
      authSourceStatus: "invalid",
      staleEligible: true,
    });
  }
  return normalizeTraexCatalog(payload);
}

/** Normalize only documented catalog identity and Trae metadata fields. */
export function normalizeTraexCatalog(payload: unknown): NormalizedCatalog {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new TraexFailure("traex_catalog_unsupported_shape", {
      authSourceStatus: "invalid",
      staleEligible: true,
    });
  }

  const seenCatalogIds = new Set<string>();
  const models: ProviderModelTelemetry[] = [];
  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];

  for (const raw of payload) {
    const record = objectValue(raw);
    const name = stringValue(record?.name);
    const configName = optionalString(record, "config_name");
    const backendModel = optionalString(record, "backend_model");
    const catalogProvider = optionalString(record, "provider");
    const contextWindow = optionalPositiveNumber(record, "context_window");
    if (
      !record ||
      !name ||
      configName === null ||
      backendModel === null ||
      catalogProvider === null ||
      contextWindow === null
    ) {
      throw new TraexFailure("traex_catalog_unsupported_shape", {
        authSourceStatus: "invalid",
        staleEligible: true,
      });
    }

    const catalogId = configName ?? name;
    if (seenCatalogIds.has(catalogId)) {
      throw new TraexFailure("traex_catalog_unsupported_shape", {
        authSourceStatus: "invalid",
        staleEligible: true,
      });
    }
    seenCatalogIds.add(catalogId);

    const displayName =
      catalogId === "openrouter-3o" ? "Claude Sonnet 4.8" : name;
    const displayNameSource =
      catalogId === "openrouter-3o" ? "captain_mapping" : "catalog";
    const traeMeta = objectValue(objectValue(record._meta)?.trae);
    const load = normalizeLoad(record, traeMeta);
    const normalizedQuota = normalizeWeeklyQuota(
      record,
      traeMeta,
      catalogId,
      name,
    );
    if (normalizedQuota.window) windows.push(normalizedQuota.window);
    if (normalizedQuota.quota.status === "invalid") {
      untrustedWindowIds.push(`model:${catalogId}:weekly`);
    }

    models.push({
      catalogId,
      name,
      ...(configName ? { configName } : {}),
      ...(backendModel ? { backendModel } : {}),
      ...(catalogProvider ? { catalogProvider } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      displayName,
      displayNameSource,
      load,
      quota: normalizedQuota.quota,
    });
  }

  return { models, windows, untrustedWindowIds };
}

function normalizeLoad(
  record: Record<string, unknown>,
  traeMeta: Record<string, unknown> | undefined,
): ProviderModelTelemetry["load"] {
  const meta = objectValue(record._meta);
  const rawTrae = meta?.trae;
  if (rawTrae === undefined || !hasOwn(objectValue(rawTrae), "load")) {
    return { status: "unknown", stale: false, reason: "missing" };
  }
  const load = objectValue(traeMeta?.load);
  const percent = numberValue(load?.percent);
  if (percent === undefined || percent < 0) {
    return { status: "unknown", stale: false, reason: "invalid" };
  }
  return { status: "known", percent, stale: false };
}

function normalizeWeeklyQuota(
  record: Record<string, unknown>,
  traeMeta: Record<string, unknown> | undefined,
  catalogId: string,
  name: string,
): { quota: ModelQuotaTelemetry; window?: QuotaWindow } {
  const meta = objectValue(record._meta);
  const rawTrae = meta?.trae;
  if (rawTrae === undefined || !hasOwn(objectValue(rawTrae), "weeklyQuota")) {
    return {
      quota: {
        status: "not_reported",
        windowIds: [],
        relationship: "unknown",
        sharing: "unknown",
        stale: false,
      },
    };
  }

  const raw = objectValue(traeMeta?.weeklyQuota);
  if (!raw || typeof raw.applies !== "boolean") {
    return { quota: invalidQuota() };
  }
  if (!raw.applies) {
    return {
      quota: {
        status: "not_applicable",
        windowIds: [],
        relationship: "model_scoped",
        sharing: "unknown",
        stale: false,
      },
    };
  }

  const isDepleted = booleanValue(raw.isDepleted);
  const percentUsed = boundedPercent(raw.usedPercent);
  const percentRemaining = boundedPercent(raw.remainingPercent);
  const resetTime = unixSecondsValue(raw.resetTime);
  if (
    isDepleted === undefined ||
    percentUsed === undefined ||
    percentRemaining === undefined ||
    resetTime === undefined ||
    Math.abs(percentUsed + percentRemaining - 100) > 0.01 ||
    (isDepleted && percentRemaining !== 0)
  ) {
    return { quota: invalidQuota() };
  }

  const windowId = `model:${catalogId}:weekly`;
  const scope = `model:${catalogId}`;
  return {
    quota: {
      status: "authoritative",
      scope,
      windowIds: [windowId],
      relationship: "model_scoped",
      sharing: "unknown",
      stale: false,
    },
    window: {
      id: windowId,
      label: `${name} week`,
      kind: "model",
      percentUsed,
      percentRemaining,
      resetsAt: new Date(resetTime * 1_000).toISOString(),
      windowSeconds: WEEK_SECONDS,
      isDepleted,
    },
  };
}

function invalidQuota(): ModelQuotaTelemetry {
  return {
    status: "invalid",
    windowIds: [],
    relationship: "model_scoped",
    sharing: "unknown",
    stale: false,
  };
}

function staleTraexReport(
  cached: ProviderQuota,
  error: string,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "traex" ||
    cached.source !== "cli" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt ||
    !cached.models
  ) {
    return undefined;
  }
  const refreshedAt = Date.parse(cached.state.refreshedAt);
  if (
    !Number.isFinite(refreshedAt) ||
    refreshedAt > now ||
    now - refreshedAt >= STALE_MAX_AGE_MS
  ) {
    return undefined;
  }

  const windows = cached.windows.filter((window) => {
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return Number.isFinite(reset) && reset > now;
  });
  if (windows.length === 0) return undefined;
  const retainedWindowIds = new Set(windows.map(({ id }) => id));
  const models = cached.models.map((model) => {
    const windowIds = model.quota.windowIds.filter((id) =>
      retainedWindowIds.has(id),
    );
    const lostQuotaWindow =
      model.quota.status === "authoritative" && windowIds.length === 0;
    return {
      ...model,
      load: { ...model.load, stale: true },
      quota: {
        ...model.quota,
        ...(lostQuotaWindow
          ? { status: "invalid" as const, scope: undefined }
          : {}),
        windowIds,
        stale: true,
      },
    };
  });

  return {
    provider: "traex",
    label: "TraeX",
    source: "cache",
    windows,
    models,
    state: {
      status: "stale",
      stale: true,
      refreshedAt: cached.state.refreshedAt,
      error,
      ...(cached.state.untrustedWindowIds
        ? { untrustedWindowIds: cached.state.untrustedWindowIds }
        : {}),
      sourcesTried: [...sourceNames(attempts), "cache"],
    },
    attempts,
  };
}

function executeCatalog(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<CatalogResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
          /maxBuffer/i.test(error.message)
        ) {
          reject(
            new TraexFailure("traex_catalog_output_oversized", {
              staleEligible: true,
            }),
          );
          return;
        }
        if (error.killed || code === "ETIMEDOUT") {
          reject(
            new TraexFailure("traex_catalog_timeout", {
              staleEligible: true,
            }),
          );
          return;
        }
        if (looksUnauthenticated(`${String(stdout)}\n${String(stderr)}`)) {
          reject(
            new TraexFailure("traex_catalog_unauthenticated", {
              status: "auth_required",
              authSourceStatus: "invalid",
            }),
          );
          return;
        }
        reject(
          new TraexFailure("traex_catalog_execution_failed", {
            staleEligible: true,
          }),
        );
      },
    );
  });
}

function looksUnauthenticated(text: string): boolean {
  return /(?:unauthenticated|unauthorized|forbidden|sign[ -]?in|log[ -]?in|credentials? required|(?:^|\D)(?:401|403)(?:\D|$))/i.test(
    text,
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function optionalString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined | null {
  if (!record || !hasOwn(record, key)) return undefined;
  return stringValue(record[key]) ?? null;
}

function optionalPositiveNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined | null {
  if (!record || !hasOwn(record, key)) return undefined;
  const value = numberValue(record[key]);
  return value !== undefined && value > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function boundedPercent(value: unknown): number | undefined {
  const number = numberValue(value);
  return number !== undefined && number >= 0 && number <= 100
    ? number
    : undefined;
}

function unixSecondsValue(value: unknown): number | undefined {
  const number = numberValue(value);
  if (number === undefined || !Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  const milliseconds = number * 1_000;
  return Number.isNaN(new Date(milliseconds).getTime()) ? undefined : number;
}

function hasOwn(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

class TraexFailure extends Error {
  readonly status: ProviderQuota["state"]["status"];
  readonly authSourceStatus: AuthSourceReport["status"];
  readonly staleEligible: boolean;

  constructor(
    readonly code: string,
    options: TraexFailureOptions = {},
  ) {
    super(code);
    this.status = options.status ?? "error";
    this.authSourceStatus = options.authSourceStatus ?? "error";
    this.staleEligible = options.staleEligible ?? false;
  }
}
