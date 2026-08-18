import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createTraexAdapter,
  normalizeTraexCatalog,
} from "../../src/providers/traex.js";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const RESET_TIME = 1_787_500_799;
const options = { allowKeychainPrompt: false };
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("TraeX catalog adapter", () => {
  it("normalizes both captain-named models plus every generic catalog model", async () => {
    const runCatalog = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        catalogModel("openrouter-3o", {
          load: { percent: 77 },
          weeklyQuota: weeklyQuota({ depleted: true }),
        }),
        catalogModel("GPT-5.6-Sol", {
          configName: "gpt-5.6-sol",
          load: { percent: 125 },
        }),
        catalogModel("Generic-New-Model"),
      ]),
      stderr: "",
    });
    const adapter = createTraexAdapter({
      env: {},
      now: () => NOW,
      findCommandPath: async () => "/opt/traex",
      readCachedProvider: () => undefined,
      runCatalog,
    });

    const report = await adapter.fetchQuota(options);

    expect(runCatalog).toHaveBeenCalledOnce();
    expect(runCatalog).toHaveBeenCalledWith(
      "/opt/traex",
      ["models", "--json"],
      8_000,
      256 * 1_024,
    );
    expect(report.state).toMatchObject({ status: "fresh", stale: false });
    expect(report.models).toHaveLength(3);
    expect(report.models?.[0]).toMatchObject({
      catalogId: "openrouter-3o",
      name: "openrouter-3o",
      displayName: "Claude Sonnet 4.8",
      displayNameSource: "captain_mapping",
      load: { status: "known", percent: 77, stale: false },
      quota: {
        status: "authoritative",
        scope: "model:openrouter-3o",
        windowIds: ["model:openrouter-3o:weekly"],
        relationship: "model_scoped",
        sharing: "unknown",
        stale: false,
      },
    });
    expect(report.models?.[1]).toMatchObject({
      catalogId: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      configName: "gpt-5.6-sol",
      load: { status: "known", percent: 125, stale: false },
      quota: { status: "not_reported", windowIds: [] },
    });
    expect(report.models?.[2]).toMatchObject({
      catalogId: "Generic-New-Model",
      name: "Generic-New-Model",
      load: { status: "unknown", reason: "missing", stale: false },
      quota: { status: "not_reported", windowIds: [] },
    });
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "model:openrouter-3o:weekly",
        percentUsed: 100,
        percentRemaining: 0,
        resetsAt: "2026-08-23T15:59:59.000Z",
        windowSeconds: 604_800,
        isDepleted: true,
      }),
    ]);

    const interpreted = withQuotaSemantics(report, "2026-08-18T12:00:00.000Z");
    expect(interpreted.quotaSemantics).toMatchObject({
      status: "partial",
      effectiveAvailability: [
        {
          scope: "model:openrouter-3o",
          status: "known",
          effectivePercentRemaining: 0,
          boundedBy: ["model:openrouter-3o:weekly"],
          runway: {
            status: "exhausted_now",
            usableRunwaySeconds: 0,
            limitingWindowId: "model:openrouter-3o:weekly",
          },
        },
      ],
    });
  });

  it("keeps equal weekly objects model-scoped and marks cross-model sharing unknown", () => {
    const quota = weeklyQuota({ used: 40, remaining: 60 });
    const normalized = normalizeTraexCatalog([
      catalogModel("model-a", { weeklyQuota: quota }),
      catalogModel("model-b", { weeklyQuota: { ...quota } }),
    ]);

    expect(normalized.windows.map(({ id }) => id)).toEqual([
      "model:model-a:weekly",
      "model:model-b:weekly",
    ]);
    expect(normalized.models.map(({ quota }) => quota)).toEqual([
      expect.objectContaining({
        scope: "model:model-a",
        windowIds: ["model:model-a:weekly"],
        relationship: "model_scoped",
        sharing: "unknown",
      }),
      expect.objectContaining({
        scope: "model:model-b",
        windowIds: ["model:model-b:weekly"],
        relationship: "model_scoped",
        sharing: "unknown",
      }),
    ]);
  });

  it("represents missing and invalid telemetry without inventing quota or load", () => {
    const normalized = normalizeTraexCatalog([
      catalogModel("missing"),
      catalogModel("invalid", {
        load: { percent: "busy" },
        weeklyQuota: {
          applies: true,
          isDepleted: false,
          usedPercent: 20,
          remainingPercent: 80,
          resetTime: "tomorrow",
        },
      }),
      catalogModel("not-applicable", {
        weeklyQuota: { applies: false },
      }),
    ]);

    expect(normalized.windows).toEqual([]);
    expect(normalized.models[0]).toMatchObject({
      load: { status: "unknown", reason: "missing" },
      quota: { status: "not_reported" },
    });
    expect(normalized.models[1]).toMatchObject({
      load: { status: "unknown", reason: "invalid" },
      quota: { status: "invalid" },
    });
    expect(normalized.models[2]?.quota).toMatchObject({
      status: "not_applicable",
      relationship: "model_scoped",
    });
    expect(normalized.untrustedWindowIds).toEqual(["model:invalid:weekly"]);
  });

  it("distinguishes missing and unsafe executable overrides without running anything", async () => {
    const runCatalog = vi.fn();
    const missing = createTraexAdapter({
      env: {},
      findCommandPath: async () => undefined,
      runCatalog,
    });
    const relative = createTraexAdapter({
      env: { QUOTA_AXI_TRAEX_BINARY: "relative/traex" },
      findCommandPath: async () => "/should/not/run",
      runCatalog,
    });
    const absentOverride = createTraexAdapter({
      env: { QUOTA_AXI_TRAEX_BINARY: "/missing/traex" },
      findCommandPath: async () => undefined,
      runCatalog,
    });

    await expect(missing.fetchQuota(options)).resolves.toMatchObject({
      state: { status: "unavailable", error: "traex_binary_missing" },
    });
    await expect(relative.fetchQuota(options)).resolves.toMatchObject({
      state: {
        status: "unavailable",
        error: "traex_binary_override_not_absolute",
      },
    });
    await expect(absentOverride.inspectAuth(options)).resolves.toEqual({
      provider: "traex",
      sources: [
        {
          source: "model-catalog",
          path: "/missing/traex",
          status: "missing",
          error: "traex_binary_override_not_executable",
        },
      ],
    });
    expect(runCatalog).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed output",
      body: 'process.stdout.write("not-json")',
      timeoutMs: 500,
      maxOutputBytes: 1_024,
      error: "traex_catalog_malformed_json",
      authStatus: "invalid",
    },
    {
      name: "oversized output",
      body: 'process.stdout.write("x".repeat(4096))',
      timeoutMs: 500,
      maxOutputBytes: 128,
      error: "traex_catalog_output_oversized",
      authStatus: "error",
    },
    {
      name: "timeout",
      body: "setInterval(() => {}, 1000)",
      timeoutMs: 25,
      maxOutputBytes: 1_024,
      error: "traex_catalog_timeout",
      authStatus: "error",
    },
    {
      name: "nonzero transient failure",
      body: 'process.stderr.write("TRANSIENT-RAW-SENTINEL"); process.exit(7)',
      timeoutMs: 500,
      maxOutputBytes: 1_024,
      error: "traex_catalog_execution_failed",
      authStatus: "error",
    },
    {
      name: "unauthenticated refusal",
      body: 'process.stderr.write("401 sign in required CREDENTIAL-SENTINEL"); process.exit(1)',
      timeoutMs: 500,
      maxOutputBytes: 1_024,
      error: "traex_catalog_unauthenticated",
      authStatus: "invalid",
    },
  ])(
    "classifies $name without leaking raw command output",
    async ({ body, timeoutMs, maxOutputBytes, error, authStatus }) => {
      const executable = fakeExecutable(body);
      const adapter = createTraexAdapter({
        env: { QUOTA_AXI_TRAEX_BINARY: executable },
        timeoutMs,
        maxOutputBytes,
        readCachedProvider: () => undefined,
      });

      const report = await adapter.fetchQuota(options);
      const auth = await adapter.inspectAuth(options);
      expect(report.state.error).toBe(error);
      expect(auth.sources[0]).toMatchObject({
        status: authStatus,
        error,
      });
      expect(JSON.stringify({ report, auth })).not.toMatch(
        /RAW-SENTINEL|CREDENTIAL-SENTINEL/,
      );
    },
  );

  it("distinguishes a valid but unsupported catalog shape", async () => {
    const adapter = adapterWithOutput(JSON.stringify({ models: [] }));

    await expect(adapter.fetchQuota(options)).resolves.toMatchObject({
      state: { status: "error", error: "traex_catalog_unsupported_shape" },
    });
    await expect(adapter.inspectAuth(options)).resolves.toMatchObject({
      sources: [
        { status: "invalid", error: "traex_catalog_unsupported_shape" },
      ],
    });
  });

  it("uses a short, explicitly stale fallback and expires it at the provider bound", async () => {
    const fresh = await adapterWithOutput(
      JSON.stringify([
        catalogModel("openrouter-3o", {
          load: { percent: 42 },
          weeklyQuota: weeklyQuota({ used: 20, remaining: 80 }),
        }),
      ]),
      NOW,
    ).fetchQuota(options);
    const failing = (now: number) =>
      createTraexAdapter({
        env: {},
        now: () => now,
        findCommandPath: async () => "/opt/traex",
        runCatalog: async () => {
          throw new Error("raw transient details must not escape");
        },
        readCachedProvider: () => fresh,
      });

    const stale = await failing(NOW + 60_000).fetchQuota(options);
    expect(stale).toMatchObject({
      source: "cache",
      state: {
        status: "stale",
        stale: true,
        error: "traex_catalog_execution_failed",
      },
      models: [
        {
          load: { status: "known", percent: 42, stale: true },
          quota: { status: "authoritative", stale: true },
        },
      ],
    });
    const interpreted = withQuotaSemantics(
      stale,
      new Date(NOW + 60_000).toISOString(),
    );
    expect(interpreted.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
      status: "unknown",
      runway: { status: "unknown" },
      selection: { status: "unknown" },
    });

    const expired = await failing(NOW + 5 * 60_000).fetchQuota(options);
    expect(expired).toMatchObject({
      source: "unavailable",
      state: { status: "error", stale: false },
    });
  });
});

function catalogModel(
  name: string,
  options: {
    configName?: string;
    load?: unknown;
    weeklyQuota?: unknown;
  } = {},
) {
  const trae: Record<string, unknown> = {};
  if (options.load !== undefined) trae.load = options.load;
  if (options.weeklyQuota !== undefined) {
    trae.weeklyQuota = options.weeklyQuota;
  }
  return {
    name,
    ...(options.configName ? { config_name: options.configName } : {}),
    backend_model: `${options.configName ?? name}__dev`,
    provider: "trae",
    context_window: 200_000,
    ...(Object.keys(trae).length > 0 ? { _meta: { trae } } : {}),
  };
}

function weeklyQuota(
  options: {
    used?: number;
    remaining?: number;
    depleted?: boolean;
  } = {},
) {
  return {
    applies: true,
    isDepleted: options.depleted ?? false,
    usedPercent: options.used ?? 100,
    remainingPercent: options.remaining ?? 0,
    resetTime: RESET_TIME,
  };
}

function adapterWithOutput(stdout: string, now = NOW) {
  return createTraexAdapter({
    env: {},
    now: () => now,
    findCommandPath: async () => "/opt/traex",
    runCatalog: async () => ({ stdout, stderr: "" }),
    readCachedProvider: () => undefined,
  });
}

function fakeExecutable(body: string): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "quota-axi-traex-"));
  const file = join(
    tempDir,
    `traex-${Math.random().toString(16).slice(2)}.mjs`,
  );
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}
