/**
 * deploy-test-token.ts — Deploy the test-token contract and record the address.
 *
 * Usage:
 *   npm run deploy:test-token
 *   npx tsx scripts/deploy-test-token.ts
 *
 * Required env vars:
 *   TEST_TOKEN_SEED      BIP-39 mnemonic phrase, or a 64-char (32-byte) or
 *                        128-char (64-byte) hex seed for the deployer wallet
 *   NETWORK_ID           undeployed | preprod | mainnet
 *
 * Optional (defaults are derived from NETWORK_ID):
 *   MIDNIGHT_NODE_URL    WebSocket URL for the Midnight node relay
 *   INDEXER_HTTP_URL     HTTP URL for the indexer GraphQL endpoint
 *   INDEXER_WS_URL       WebSocket URL for the indexer GraphQL subscription endpoint
 *   PROOF_SERVER_URL     HTTP URL for the proof server
 *   TEST_TOKEN_COUNT     Number of token types to compute (default: 2, max: 26)
 *   WALLET_CACHE_DIR     Override wallet sync cache directory
 *
 * A .env file in the repository root is loaded automatically if present (existing
 * process.env values take precedence).
 *
 * Prerequisites: node running, proof server running, compiled contract assets
 * present (npm run compile:test-token).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { Buffer } from "buffer";

import { deployContract } from "@midnight-ntwrk/midnight-js/contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import type { MidnightProvider, MidnightProviders, WalletProvider } from "@midnight-ntwrk/midnight-js/types";

import * as ledger from "@midnight-ntwrk/ledger-v8";
import { rawTokenType } from "@midnight-ntwrk/ledger-v8";

import { CompiledContract, type ProvableCircuitId } from "@midnight-ntwrk/compact-js";

import {
  InMemoryTransactionHistoryStorage,
  TransactionHistoryStorage,
} from "@midnight-ntwrk/wallet-sdk";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk/dust";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk/facade";
import type { DefaultConfiguration, FacadeState } from "@midnight-ntwrk/wallet-sdk/facade";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk/hd";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk/shielded";
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk/unshielded";

import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";

import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { tap, sampleTime } from "rxjs";
import pino from "pino";

import { Contract as TestTokenContract } from "../contracts/test-token/managed/contract/index.js";

// ── Paths ──────────────────────────────────────────────────────────────────────

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ASSET_PATH = path.normalize(path.join(PROJECT_ROOT, "contracts", "test-token", "managed"));

// ── Logging ────────────────────────────────────────────────────────────────────

const logger = pino(
  process.env.NODE_ENV === "production"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      },
);

// ── Env loading ────────────────────────────────────────────────────────────────

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => process.env[k] ?? "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// ── Network URL defaults ───────────────────────────────────────────────────────

interface NetworkUrls {
  nodeUrl: string;
  indexerHttpUrl: string;
  indexerWsUrl: string;
  proofServerUrl: string;
}

const NETWORK_DEFAULTS: Record<string, NetworkUrls> = {
  undeployed: {
    nodeUrl: "ws://localhost:9944",
    indexerHttpUrl: "http://localhost:8088/api/v4/graphql",
    indexerWsUrl: "ws://localhost:8088/api/v4/graphql/ws",
    proofServerUrl: "http://localhost:6300",
  },
  preprod: {
    nodeUrl: "wss://rpc.preprod.midnight.network",
    indexerHttpUrl: "https://indexer.preprod.midnight.network/api/v4/graphql",
    indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
    proofServerUrl: "https://proof.capacity-exchange.preprod.sundae.fi",
  },
  mainnet: {
    nodeUrl: "wss://rpc.mainnet.midnight.network",
    indexerHttpUrl: "https://indexer.mainnet.midnight.network/api/v4/graphql",
    indexerWsUrl: "wss://indexer.mainnet.midnight.network/api/v4/graphql/ws",
    proofServerUrl: "https://proof.capacity-exchange.sundae.fi",
  },
};

function resolveUrl(envVar: string, networkId: string, key: keyof NetworkUrls): string {
  if (process.env[envVar]) return process.env[envVar]!;
  const defaults = NETWORK_DEFAULTS[networkId];
  if (!defaults) {
    throw new Error(`No URL defaults for NETWORK_ID="${networkId}"; set ${envVar} explicitly`);
  }
  return defaults[key];
}

// ── Network config ─────────────────────────────────────────────────────────────

function getWalletConfiguration(): DefaultConfiguration {
  const networkId = requireEnv("NETWORK_ID");
  return {
    networkId,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(resolveUrl("MIDNIGHT_NODE_URL", networkId, "nodeUrl")),
    provingServerUrl: new URL(resolveUrl("PROOF_SERVER_URL", networkId, "proofServerUrl")),
    indexerClientConnection: {
      indexerHttpUrl: resolveUrl("INDEXER_HTTP_URL", networkId, "indexerHttpUrl"),
      indexerWsUrl: resolveUrl("INDEXER_WS_URL", networkId, "indexerWsUrl"),
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(
      TransactionHistoryStorage.TransactionHistoryCommonSchema,
    ),
  };
}

// ── Wallet utilities ───────────────────────────────────────────────────────────

interface WalletKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

interface WalletSyncCache {
  seedSuffix: string;
  networkId: string;
  appliedIndex: string;
  shielded: string;
  unshielded: string;
  dust: string;
  savedAt: string;
}

function walletCacheFilePath(seed: string, networkId: string): string {
  const dir =
    process.env["WALLET_CACHE_DIR"] ??
    path.resolve(PROJECT_ROOT, "data", "wallet-sync-cache");
  return path.join(dir, networkId, `${seed.slice(-8)}.json`);
}

function loadWalletSyncCache(cacheFile: string): WalletSyncCache | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as WalletSyncCache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[wallet-sync-cache] cache unreadable — cold sync: ${cacheFile}`);
    }
    return null;
  }
}

async function writeCacheFromState(
  state: FacadeState,
  cacheFile: string,
  meta: { seed: string; networkId: string },
): Promise<void> {
  try {
    const { appliedIndex, highestRelevantWalletIndex, isConnected } = state.dust.progress;
    const pct = highestRelevantWalletIndex > 0n ? Math.round(Number((appliedIndex * 100n) / highestRelevantWalletIndex)) : 0;
    logger.info(
      `[deploy-test-token] sync progress: block ${appliedIndex}/${highestRelevantWalletIndex} (${pct}%)` +
        (isConnected ? "" : " [disconnected]"),
    );
    const cache: WalletSyncCache = {
      seedSuffix: meta.seed.slice(-8),
      networkId: meta.networkId,
      appliedIndex: appliedIndex.toString(),
      shielded: state.shielded.serialize(),
      unshielded: state.unshielded.serialize(),
      dust: state.dust.serialize(),
      savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    await fs.promises.writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.warn("[wallet-sync-cache] failed to save cache:", err);
  }
}

function persistWalletSyncCache(
  wallet: WalletFacade,
  cacheFile: string,
  meta: { seed: string; networkId: string },
  intervalMs = 10_000,
): { shutdown(): Promise<void> } {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  let lastState: FacadeState | undefined;
  let writePromise: Promise<void> = Promise.resolve();

  const sub = wallet
    .state()
    .pipe(
      tap((state) => { lastState = state; }),
      sampleTime(intervalMs),
    )
    .subscribe((state) => {
      writePromise = writeCacheFromState(state, cacheFile, meta);
    });

  return {
    async shutdown() {
      sub.unsubscribe();
      await writePromise;
      if (lastState !== undefined) {
        await writeCacheFromState(lastState, cacheFile, meta);
      }
    },
  };
}

function deriveKeys(seed: Buffer): WalletKeys {
  const hdWallet = HDWallet.fromSeed(seed);
  if (hdWallet.type !== "seedOk") throw new Error("Failed to initialize HDWallet");

  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivation.type !== "keysDerived") throw new Error("Failed to derive keys");
  hdWallet.hdWallet.clear();

  const networkId = requireEnv("NETWORK_ID");
  return {
    shieldedSecretKeys: ledger.ZswapSecretKeys.fromSeed(derivation.keys[Roles.Zswap]),
    dustSecretKey: ledger.DustSecretKey.fromSeed(derivation.keys[Roles.Dust]),
    unshieldedKeystore: createKeystore(derivation.keys[Roles.NightExternal], networkId),
  };
}

async function initWalletWithSeed(
  seed: Buffer,
  cache?: WalletSyncCache,
): Promise<WalletKeys & { wallet: WalletFacade }> {
  const keys = deriveKeys(seed);
  const { shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = keys;
  const configuration = getWalletConfiguration();

  const wallet: WalletFacade = await WalletFacade.init({
    configuration,
    shielded: (config) => {
      const sw = ShieldedWallet(config);
      return cache ? sw.restore(cache.shielded) : sw.startWithSecretKeys(shieldedSecretKeys);
    },
    unshielded: (config) => {
      const uw = UnshieldedWallet(config);
      return cache
        ? uw.restore(cache.unshielded)
        : uw.startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore));
    },
    dust: (config) => {
      const dw = DustWallet(config);
      return cache
        ? dw.restore(cache.dust)
        : dw.startWithSecretKey(
            dustSecretKey,
            ledger.LedgerParameters.initialParameters().dust,
          );
    },
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { ...keys, wallet };
}

// ── Contract setup ─────────────────────────────────────────────────────────────

type TestTokenCircuits = ProvableCircuitId<TestTokenContract>;

const compiledContract = CompiledContract.make<TestTokenContract>(
  "test-token",
  TestTokenContract,
).pipe(
  CompiledContract.withWitnesses({
    randomNonce(state) {
      const nonce = new Uint8Array(32);
      crypto.getRandomValues(nonce);
      return [state, nonce];
    },
  }),
  CompiledContract.withCompiledFileAssets(ASSET_PATH),
);

function computeTokenId(index: number, contractAddress: string): string {
  const coin = new Uint8Array(32);
  coin[31] = index;
  return rawTokenType(coin, contractAddress);
}

function buildProviders(
  wallet: WalletFacade,
  keys: WalletKeys,
): MidnightProviders<TestTokenCircuits> {
  const networkId = requireEnv("NETWORK_ID");
  const indexerHttp = resolveUrl("INDEXER_HTTP_URL", networkId, "indexerHttpUrl");
  const indexerWs = resolveUrl("INDEXER_WS_URL", networkId, "indexerWsUrl");
  const proofServer = resolveUrl("PROOF_SERVER_URL", networkId, "proofServerUrl");

  const privateStateProvider = levelPrivateStateProvider({
    midnightDbName: path.normalize(path.join(PROJECT_ROOT, "data", "midnight-level-db")),
    privateStoragePasswordProvider: () => "Secret!Secret!Secret!",
    accountId: keys.shieldedSecretKeys.coinPublicKey,
  });

  const walletProvider: WalletProvider = {
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx, ttl) {
      const recipe = await wallet.balanceUnboundTransaction(tx, keys, {
        ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1_000),
      });
      return wallet.finalizeRecipe(recipe);
    },
  };

  const midnightProvider: MidnightProvider = {
    async submitTx(tx) {
      await wallet.submissionService.submitTransaction(tx, "Finalized");
      return tx.identifiers()[0];
    },
  };

  const zkConfigProvider = new NodeZkConfigProvider<TestTokenCircuits>(ASSET_PATH);

  return {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(indexerHttp, indexerWs),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function parseArgs(): void {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`Unexpected arguments: ${args.join(", ")}`);
    console.error("Usage: tsx scripts/deploy-test-token.ts");
    process.exit(2);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

parseArgs();

loadDotEnv(path.resolve(PROJECT_ROOT, ".env"));

const networkId = requireEnv("NETWORK_ID");
const seedRaw = requireEnv("TEST_TOKEN_SEED");

// Accept either a BIP-39 mnemonic (space-separated words) or a hex seed
// (64 chars = 32 bytes, or 128 chars = 64-byte PBKDF2 seed).
let seedBytes: Buffer;
const HEX = /^[0-9a-f]+$/i;
if (seedRaw.includes(" ")) {
  if (!validateMnemonic(seedRaw, wordlist)) {
    console.error("[deploy-test-token] TEST_TOKEN_SEED is not a valid BIP-39 mnemonic");
    process.exit(1);
  }
  seedBytes = Buffer.from(mnemonicToSeedSync(seedRaw));
} else if (HEX.test(seedRaw) && (seedRaw.length === 64 || seedRaw.length === 128)) {
  seedBytes = Buffer.from(seedRaw, "hex");
} else {
  console.error("[deploy-test-token] TEST_TOKEN_SEED must be a BIP-39 mnemonic or a 64/128-char hex string");
  process.exit(1);
}

// Use the last 8 hex chars of the seed for cache file naming (same as hex case)
const seedHex = seedBytes.toString("hex");

setNetworkId(networkId);

const cacheFile = walletCacheFilePath(seedHex, networkId);
const cache = loadWalletSyncCache(cacheFile);
if (cache) {
  logger.info(`[deploy-test-token] wallet cache found (appliedIndex=${cache.appliedIndex})`);
} else {
  logger.info("[deploy-test-token] no cache — cold sync from genesis");
}

logger.info("[deploy-test-token] initialising wallet…");
const { wallet, ...keys } = await initWalletWithSeed(seedBytes, cache ?? undefined);

const cacheWriter = persistWalletSyncCache(wallet, cacheFile, { seed: seedHex, networkId });

logger.info("[deploy-test-token] waiting for sync…");
const syncedState = await wallet.waitForSyncedState();
logger.info(`[deploy-test-token] synced (appliedIndex=${syncedState.dust.progress.appliedIndex})`);

const providers = buildProviders(wallet, keys);

logger.info("[deploy-test-token] deploying test-token contract (ZK proof ~30–90 s)…");
const deployed = await deployContract(providers, {
  compiledContract,
  privateStateId: "test-token-state",
  initialPrivateState: {},
});

const contractAddress = deployed.deployTxData.public.contractAddress;
logger.info(`[deploy-test-token] contract address: ${contractAddress}`);

const tokenCount = parseInt(process.env["TEST_TOKEN_COUNT"] ?? "10", 10);
if (isNaN(tokenCount) || tokenCount < 1 || tokenCount > 26) {
  console.error("[deploy-test-token] TEST_TOKEN_COUNT must be an integer between 1 and 26");
  process.exit(1);
}

const tokenEnvVars: Record<string, string> = {};
for (let i = 0; i < tokenCount; i++) {
  const label = `TOKEN_${String.fromCharCode(65 + i)}`;
  tokenEnvVars[label] = computeTokenId(i, contractAddress);
}

console.log("");
console.log(`TEST_TOKEN_CONTRACT=${contractAddress}`);
for (const [key, value] of Object.entries(tokenEnvVars)) {
  console.log(`${key}=${value}`);
}

await cacheWriter.shutdown();
await wallet.stop();
logger.info("[deploy-test-token] done ✓");
process.exit(0);
