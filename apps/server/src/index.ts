/**
 * @songdeck/server — Song Deck local runtime: credential vault, provider proxy, hardware
 * detection, model manager, render nodes, collaboration hub, plugin host, managed gateway,
 * project storage and static hosting of the studio.
 */
export { createSongDeckServer, type SongDeckServer, type ServerServices } from './server';
export {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_HOST,
  DEFAULT_LIMITS,
  DEFAULT_PORT,
  defaultDataDir,
  isLoopbackHost,
  resolveConfig,
  SERVER_NAME,
  SERVER_VERSION,
  type Limits,
  type ResolvedConfig,
  type ServerOptions,
} from './config';
export { createLogger, type Logger, type LogLevel } from './logger';
export { createVault, EncryptedFileVault, KeychainVault, MemoryVault, type CredentialVault, type VaultBackendName, type VaultEntryMeta } from './vault';
export { detectHardware, type GpuInfo, type HardwareInfo } from './hardware';
export type { ModelEntry, ModelsReport, ModelCategory, Compatibility } from './models';
export type { PluginManifest, PluginRecord, PluginKind } from './plugins';
export type { NodeInfo } from './render/node';
export * from './collab/protocol';
export { PROXY_ERROR_HEADER, type ProxyEnvelope } from './proxy';
