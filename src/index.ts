import { promises as fs, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import type { Logger, Plugin, ResolvedConfig, ViteDevServer } from "vite";

interface CapacitorServerSettings {
  url?: string;
  cleartext?: boolean;
  [key: string]: unknown;
}

interface CapacitorConfig {
  server?: CapacitorServerSettings;
  [key: string]: unknown;
}

import type {
  LogLevel,
  ServerUrlContext,
  SupportedPlatform,
  ViteCapacitorPluginOptions,
} from "./definitions.js";

interface TrackedFileState {
  originalContent: string;
}

interface PluginLog {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string, error?: unknown): void;
}

const PLUGIN_NAME = "@capgo/vite-capacitor";
const DEFAULT_IOS_PATH = "ios/App/App/capacitor.config.json";
const DEFAULT_ANDROID_PATH =
  "android/app/src/main/assets/capacitor.config.json";
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGQUIT: 131,
} as const;

export default function viteCapacitor(
  options: ViteCapacitorPluginOptions = {},
): Plugin {
  let viteConfig: ResolvedConfig;
  let rootDir: string;
  let targetFiles: string[] = [];
  let appliedUrl: string | null = null;
  let shuttingDown = false;
  let cleanupRegistered = false;

  const trackedFiles = new Map<string, TrackedFileState>();

  return {
    name: PLUGIN_NAME,
    apply: "serve",
    configResolved(config) {
      viteConfig = config;
      rootDir = resolveRoot(config.root, options.root);
      targetFiles = resolveTargetFiles(rootDir, options);
    },
    configureServer(server) {
      const log = createLoggers(
        server.config.logger,
        options.logLevel ?? "info",
      );

      if (targetFiles.length === 0) {
        log.warn("No target files configured. Nothing to sync.");
        return;
      }

      registerProcessCleanup(log);

      server.httpServer?.once("close", () => {
        restoreConfigs(log);
      });

      waitForServer(server, log).then(
        async (context) => {
          const url = resolveServerUrl(context, options.urlOverride);
          await writeConfigs(url, log);
        },
        (error) => {
          log.warn("Unable to determine dev server URL.", error);
        },
      );
    },
  };

  async function writeConfigs(url: string, log: PluginLog) {
    if (!url) {
      log.warn("Resolved server URL is empty; skipping sync.");
      return;
    }
    if (appliedUrl === url) {
      log.debug(`Server URL already set to ${url}.`);
      return;
    }
    const cleartext = options.cleartext ?? true;

    const results = await Promise.allSettled(
      targetFiles.map(async (file) => {
        const exists = await fileExists(file);
        if (!exists) {
          log.debug(`Skipping missing file: ${shortPath(file)}`);
          return;
        }

        const currentContent = await fs.readFile(file, "utf8");
        if (!trackedFiles.has(file)) {
          trackedFiles.set(file, { originalContent: currentContent });
        }

        const displayPath = shortPath(file);
        const parsed = safeParseConfig(currentContent, displayPath, log);
        if (!parsed) {
          return;
        }

        if (!parsed.server || typeof parsed.server !== "object") {
          parsed.server = {};
        }

        const serverSettings = parsed.server as CapacitorServerSettings;
        serverSettings.url = url;
        if (cleartext !== undefined) {
          serverSettings.cleartext = cleartext;
        }

        const nextContent = JSON.stringify(parsed, null, 2) + "\n";
        if (nextContent === currentContent) {
          log.debug(`No changes required: ${displayPath}`);
          return;
        }

        await fs.writeFile(file, nextContent, "utf8");
        log.info(`Updated ${displayPath} with ${url}`);
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        log.warn("Failed while updating Capacitor config file.", result.reason);
      }
    }

    appliedUrl = url;
  }

  function restoreConfigs(log: PluginLog) {
    if (trackedFiles.size === 0) {
      return;
    }
    for (const [file, state] of Array.from(trackedFiles.entries())) {
      try {
        writeFileSync(file, state.originalContent, "utf8");
        trackedFiles.delete(file);
        if (!shuttingDown) {
          log.info(`Restored ${shortPath(file)}.`);
        }
      } catch (error) {
        log.warn("Failed while restoring Capacitor config file.", error);
      }
    }
    if (trackedFiles.size === 0) {
      appliedUrl = null;
    }
  }

  function safeParseConfig(
    content: string,
    displayPath: string,
    log: PluginLog,
  ): CapacitorConfig | null {
    if (content.trim().length === 0) {
      return {};
    }
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null) {
        log.warn(`Config JSON must be an object: ${displayPath}`);
        return {};
      }
      return parsed as CapacitorConfig;
    } catch (error) {
      log.warn(`File is not valid JSON: ${displayPath}`, error);
      return null;
    }
  }

  function registerProcessCleanup(log: PluginLog) {
    if (cleanupRegistered) {
      return;
    }
    cleanupRegistered = true;

    const handleSignal = (signal: keyof typeof SIGNAL_EXIT_CODES) => {
      if (!shuttingDown) {
        shuttingDown = true;
        restoreConfigs(log);
      }
      if (process.listenerCount(signal) === 0) {
        process.exit(SIGNAL_EXIT_CODES[signal]);
      }
    };

    for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"] as const) {
      process.prependOnceListener(signal, () => handleSignal(signal));
    }

    process.once("exit", () => {
      if (!shuttingDown) {
        shuttingDown = true;
        restoreConfigs(log);
      }
    });
  }

  async function waitForServer(
    server: ViteDevServer,
    log: PluginLog,
  ): Promise<ServerUrlContext> {
    return new Promise<ServerUrlContext>((resolve, reject) => {
      const httpServer = server.httpServer;
      if (!httpServer) {
        reject(new Error("Vite HTTP server is not available."));
        return;
      }

      const onListening = () => {
        httpServer.off("error", onError);

        const addressInfo = httpServer.address();
        if (!addressInfo || typeof addressInfo === "string") {
          reject(new Error("Could not resolve server address."));
          return;
        }

        const protocol = server.config.server.https ? "https" : "http";
        const host = pickHost(server.config.server.host);
        const resolvedHost = resolveReachableHost(
          host,
          options.networkUrl,
          log,
        );
        const context: ServerUrlContext = {
          host: resolvedHost,
          port: addressInfo.port,
          protocol,
        };
        log.debug(
          `Detected dev server at ${context.protocol}://${context.host}:${context.port}`,
        );
        resolve(context);
      };

      const onError = (error: Error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };

      if (httpServer.listening) {
        onListening();
        return;
      }

      httpServer.once("listening", onListening);
      httpServer.once("error", onError);
    });
  }

  function resolveServerUrl(
    context: ServerUrlContext,
    override?: ViteCapacitorPluginOptions["urlOverride"],
  ): string {
    if (typeof override === "string") {
      return override;
    }
    if (typeof override === "function") {
      return override(context);
    }
    return `${context.protocol}://${context.host}:${context.port}`;
  }

  function shortPath(file: string): string {
    return path.relative(viteConfig.root, file) || path.basename(file);
  }

  function resolveRoot(base: string, override?: string): string {
    if (!override) {
      return base;
    }
    return path.isAbsolute(override) ? override : path.resolve(base, override);
  }

  function resolveTargetFiles(
    base: string,
    opts: ViteCapacitorPluginOptions,
  ): string[] {
    const platforms = normalizePlatforms(opts.platforms);
    const paths = new Set<string>();

    if (platforms.includes("ios")) {
      paths.add(opts.iosConfigPath ?? DEFAULT_IOS_PATH);
    }
    if (platforms.includes("android")) {
      paths.add(opts.androidConfigPath ?? DEFAULT_ANDROID_PATH);
    }
    for (const extra of opts.additionalConfigPaths ?? []) {
      if (extra) {
        paths.add(extra);
      }
    }

    return Array.from(paths).map((relativePath) =>
      path.isAbsolute(relativePath)
        ? relativePath
        : path.resolve(base, relativePath),
    );
  }

  function normalizePlatforms(
    input?: SupportedPlatform[],
  ): SupportedPlatform[] {
    if (!input || input.length === 0) {
      return ["ios", "android"];
    }
    const valid = new Set<SupportedPlatform>(["ios", "android"]);
    return Array.from(
      new Set(
        input.filter((platform): platform is SupportedPlatform =>
          valid.has(platform as SupportedPlatform),
        ),
      ),
    );
  }
}

function pickHost(hostOption: ResolvedConfig["server"]["host"]): string {
  if (hostOption === undefined || hostOption === false) {
    return "localhost";
  }
  if (hostOption === true) {
    return "0.0.0.0";
  }
  return hostOption;
}

function resolveReachableHost(
  host: string,
  networkUrl: ViteCapacitorPluginOptions["networkUrl"],
  log: PluginLog,
): string {
  if (!isWildcardHost(host)) {
    return host;
  }

  if (!networkUrl) {
    return "localhost";
  }

  const configuredHost =
    getConfiguredNetworkHost(networkUrl) ??
    normalizeHost(process.env.CAP_SERVER_HOST);
  if (configuredHost) {
    log.debug(`Using configured network host ${configuredHost}.`);
    return configuredHost;
  }

  const localIpv4 = pickLocalIpv4();
  if (localIpv4) {
    log.debug(`Using local network host ${localIpv4}.`);
    return localIpv4;
  }

  log.warn(
    "networkUrl is enabled, but no non-internal IPv4 address was found. Falling back to localhost.",
  );
  return "localhost";
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function getConfiguredNetworkHost(
  networkUrl: ViteCapacitorPluginOptions["networkUrl"],
): string | undefined {
  if (typeof networkUrl !== "object" || networkUrl === null) {
    return undefined;
  }
  return normalizeHost(networkUrl.host);
}

function normalizeHost(host: string | undefined): string | undefined {
  const normalized = host?.trim();
  return normalized ? normalized : undefined;
}

function pickLocalIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        isUsableIpv4(entry.address)
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

function isUsableIpv4(address: string): boolean {
  return address !== "0.0.0.0" && !address.startsWith("169.254.");
}

function createLoggers(logger: Logger, level: LogLevel): PluginLog {
  const allowInfo = level === "info" || level === "debug";
  const allowDebug = level === "debug";

  const prefix = (message: string) => `${PLUGIN_NAME}: ${message}`;

  return {
    info(message) {
      if (allowInfo) {
        logger.info(prefix(message));
      }
    },
    debug(message) {
      if (allowDebug) {
        logger.info(prefix(message));
      }
    },
    warn(message, error) {
      const details =
        error instanceof Error
          ? ` ${error.message}`
          : error
            ? ` ${String(error)}`
            : "";
      logger.warn(prefix(`${message}${details}`));
    },
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}
