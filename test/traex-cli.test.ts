import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { PROVIDERS } from "../src/providers/index.js";
import type {
  ProviderAdapter,
  ProviderModelTelemetry,
  ProviderQuota,
  QuotaAxiResponse,
} from "../src/types.js";

const originalClaude = PROVIDERS.claude;
const originalTraex = PROVIDERS.traex;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  PROVIDERS.claude = originalClaude;
  PROVIDERS.traex = originalTraex;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  process.exitCode = undefined;
  vi.useRealTimers();
});

describe("TraeX CLI reporting", () => {
  it("exposes model load separately from joined quota evidence in TOON and JSON", async () => {
    useTempCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    PROVIDERS.traex = adapterFor(freshTraexQuota());

    const toon = await capture(["--provider", "traex"]);
    expect(toon).toContain('traex,"model:openrouter-3o",40,');
    expect(toon).toContain(
      "modelLoad[3]{provider,catalogId,name,displayName,displayNameSource,loadStatus,loadPercent,loadReason,stale,quotaStatus,quotaScope,quotaWindows,quotaRelationship,quotaSharing}:",
    );
    expect(toon).toContain(
      'traex,openrouter-3o,openrouter-3o,Claude Sonnet 4.8,captain_mapping,known,77,none,false,authoritative,"model:openrouter-3o","model:openrouter-3o:weekly",model_scoped,unknown',
    );
    expect(toon).toContain(
      "traex,gpt-5.6-sol,GPT-5.6-Sol,GPT-5.6-Sol,catalog,known,125,none,false,not_reported,unknown,none,unknown,unknown",
    );
    expect(toon).toContain(
      "traex,generic-model,Generic Model,Generic Model,catalog,unknown,unknown,missing,false,not_reported,unknown,none,unknown,unknown",
    );

    const response = JSON.parse(
      await capture(["--provider", "traex", "--json"]),
    ) as QuotaAxiResponse;
    expect(response.schemaVersion).toBe(5);
    expect(response.providers[0]).toMatchObject({
      provider: "traex",
      windows: [
        {
          id: "model:openrouter-3o:weekly",
          percentRemaining: 40,
          isDepleted: false,
        },
      ],
      models: [
        {
          catalogId: "openrouter-3o",
          name: "openrouter-3o",
          displayName: "Claude Sonnet 4.8",
          load: { status: "known", percent: 77, stale: false },
          quota: {
            status: "authoritative",
            scope: "model:openrouter-3o",
            sharing: "unknown",
          },
        },
        {
          catalogId: "gpt-5.6-sol",
          name: "GPT-5.6-Sol",
          load: { status: "known", percent: 125, stale: false },
          quota: { status: "not_reported" },
        },
        {
          catalogId: "generic-model",
          load: { status: "unknown", reason: "missing", stale: false },
        },
      ],
      quotaSemantics: {
        status: "partial",
        effectiveAvailability: [
          {
            scope: "model:openrouter-3o",
            effectivePercentRemaining: 40,
            boundedBy: ["model:openrouter-3o:weekly"],
          },
        ],
      },
      state: { status: "fresh", stale: false },
    });
    expect(response.providers[0]?.models?.[1]?.quota.scope).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("RAW-CATALOG-SENTINEL");
  });

  it("keeps other providers successful when TraeX is the only failed peer", async () => {
    useTempCache();
    PROVIDERS.claude = adapterFor({
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session",
          percentRemaining: 90,
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });
    PROVIDERS.traex = adapterFor({
      provider: "traex",
      label: "TraeX",
      source: "unavailable",
      windows: [],
      state: {
        status: "error",
        stale: false,
        error: "traex_catalog_execution_failed",
        sourcesTried: ["model-catalog"],
      },
    });

    const output = await capture(["--provider", "claude,traex"]);
    expect(output).toContain("claude,all_models,90,");
    expect(output).toContain(
      "traex,all,error,traex_catalog_execution_failed,none",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("includes TraeX in auth without exposing credentials", async () => {
    PROVIDERS.traex = {
      ...adapterFor(freshTraexQuota()),
      async inspectAuth() {
        return {
          provider: "traex",
          sources: [
            {
              source: "model-catalog",
              path: "/opt/traex",
              status: "available",
            },
          ],
        };
      },
    };

    const output = await capture(["auth", "--provider", "traex"]);
    expect(output).toContain("traex,model-catalog,/opt/traex,available,none");
    expect(output).not.toMatch(/token|cookie|credential bytes/i);
  });
});

function freshTraexQuota(): ProviderQuota {
  return {
    provider: "traex",
    label: "TraeX",
    source: "cli",
    windows: [
      {
        id: "model:openrouter-3o:weekly",
        label: "openrouter-3o week",
        kind: "model",
        percentUsed: 60,
        percentRemaining: 40,
        resetsAt: "2026-08-23T15:59:59.000Z",
        windowSeconds: 604_800,
        isDepleted: false,
      },
    ],
    models: [
      modelTelemetry({
        catalogId: "openrouter-3o",
        name: "openrouter-3o",
        displayName: "Claude Sonnet 4.8",
        displayNameSource: "captain_mapping",
        loadPercent: 77,
        quotaScope: "model:openrouter-3o",
        quotaWindowId: "model:openrouter-3o:weekly",
      }),
      modelTelemetry({
        catalogId: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        displayName: "GPT-5.6-Sol",
        displayNameSource: "catalog",
        loadPercent: 125,
      }),
      modelTelemetry({
        catalogId: "generic-model",
        name: "Generic Model",
        displayName: "Generic Model",
        displayNameSource: "catalog",
      }),
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-08-18T12:00:00.000Z",
      sourcesTried: ["model-catalog"],
    },
    attempts: [{ source: "model-catalog", status: "success" }],
  };
}

function modelTelemetry(args: {
  catalogId: string;
  name: string;
  displayName: string;
  displayNameSource: ProviderModelTelemetry["displayNameSource"];
  loadPercent?: number;
  quotaScope?: string;
  quotaWindowId?: string;
}): ProviderModelTelemetry {
  return {
    catalogId: args.catalogId,
    name: args.name,
    configName: args.catalogId,
    backendModel: `${args.catalogId}__dev`,
    catalogProvider: "trae",
    contextWindow: 200_000,
    displayName: args.displayName,
    displayNameSource: args.displayNameSource,
    load:
      args.loadPercent === undefined
        ? { status: "unknown", reason: "missing", stale: false }
        : { status: "known", percent: args.loadPercent, stale: false },
    quota: args.quotaScope
      ? {
          status: "authoritative",
          scope: args.quotaScope,
          windowIds: [args.quotaWindowId!],
          relationship: "model_scoped",
          sharing: "unknown",
          stale: false,
        }
      : {
          status: "not_reported",
          windowIds: [],
          relationship: "unknown",
          sharing: "unknown",
          stale: false,
        },
  };
}

function adapterFor(quota: ProviderQuota): ProviderAdapter {
  return {
    id: quota.provider,
    label: quota.label ?? quota.provider,
    async fetchQuota() {
      return quota;
    },
    async inspectAuth() {
      return { provider: quota.provider, sources: [] };
    },
  };
}

function useTempCache(): void {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-traex-cli-"));
  process.env.XDG_CACHE_HOME = tempDir;
}

async function capture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath: "quota-axi",
    stdout: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  });
  return chunks.join("");
}
