import { Storage } from "@google-cloud/storage";

const BUCKET = "sanofi-gtm-reference-data";
const CACHE_TTL_MS = 600_000; // 10 minutes

declare global {
  // eslint-disable-next-line no-var
  var __referenceDataCache: Map<string, { data: unknown; expiresAt: number }> | undefined;
}

function getCache(): Map<string, { data: unknown; expiresAt: number }> {
  if (!global.__referenceDataCache) global.__referenceDataCache = new Map();
  return global.__referenceDataCache;
}

declare global {
  // eslint-disable-next-line no-var
  var __gcsStorage: Storage | undefined;
}

function gcs(): Storage {
  if (!global.__gcsStorage) global.__gcsStorage = new Storage();
  return global.__gcsStorage;
}

async function fetchJson<T>(fileName: string): Promise<T> {
  const cache = getCache();
  const cached = cache.get(fileName);
  if (cached && cached.expiresAt > Date.now()) return cached.data as T;

  const [contents] = await gcs().bucket(BUCKET).file(fileName).download();
  const data = JSON.parse(contents.toString("utf-8")) as T;
  cache.set(fileName, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

export interface TaxonomyGtm {
  naming_taxonomy?: {
    tag?: { pattern?: string; example?: string };
    trigger?: { pattern?: string; example?: string };
    variable?: { pattern?: string; example?: string };
  };
  platforms?: Record<
    string,
    {
      tag_types?: string[];
      consent_rules?: Array<{
        tag_type?: string;
        required_blocking_trigger?: string;
      }>;
      implementation_rules?: Array<{
        rule?: string;
        condition?: string;
        action?: string;
        config_tag_type?: string;
        config_source?: string;
      }>;
    }
  >;
  [key: string]: unknown;
}

export interface TaxonomyEvents {
  platforms?: Record<
    string,
    {
      events?: Record<
        string,
        {
          description?: string;
          parameters?: Record<string, { type?: string; required?: boolean; description?: string }>;
        }
      >;
    }
  >;
  [key: string]: unknown;
}

export interface ReferenceConfig {
  triggers?: Array<{
    name: string;
    type: string;
    filter?: unknown[];
    [key: string]: unknown;
  }>;
  variables?: Array<{
    name: string;
    type: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export function fetchTaxonomyGtm(): Promise<TaxonomyGtm> {
  return fetchJson<TaxonomyGtm>("taxonomy-gtm.json");
}

export function fetchTaxonomyEvents(): Promise<TaxonomyEvents> {
  return fetchJson<TaxonomyEvents>("taxonomy-events.json");
}

export function fetchReferenceConfig(): Promise<ReferenceConfig> {
  return fetchJson<ReferenceConfig>("reference-config.json");
}
