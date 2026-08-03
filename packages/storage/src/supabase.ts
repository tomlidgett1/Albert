import type { RawObjectStore } from "./raw-batch.js";

type StorageUploadResult = Readonly<{
  data: unknown;
  error: null | Readonly<{ message: string; statusCode?: string }>;
}>;

type StorageDownloadResult = Readonly<{
  data: Blob | null;
  error: null | Readonly<{ message: string; statusCode?: string }>;
}>;

export type SupabaseStorageClient = Readonly<{
  storage: Readonly<{
    from(bucket: string): Readonly<{
      upload(
        path: string,
        body: Uint8Array,
        options: Readonly<{
          cacheControl: string;
          contentType: string;
          metadata: Readonly<Record<string, string>>;
          upsert: false;
        }>,
      ): Promise<StorageUploadResult>;
      download(path: string): Promise<StorageDownloadResult>;
    }>;
  }>;
}>;

export class SupabaseRawObjectStore implements RawObjectStore {
  constructor(
    private readonly client: SupabaseStorageClient,
    private readonly bucket = "raw-payloads",
  ) {
    if (bucket !== "raw-payloads") {
      throw new Error("Albert raw payloads must use the migration-managed raw-payloads bucket.");
    }
  }

  async putIfAbsent(
    input: Parameters<RawObjectStore["putIfAbsent"]>[0],
  ): Promise<"created" | "exists"> {
    const { error } = await this.client.storage.from(this.bucket).upload(input.key, input.body, {
      cacheControl: "31536000, immutable",
      contentType: input.contentType,
      metadata: input.metadata,
      upsert: false,
    });
    if (error?.statusCode === "409") return "exists";
    if (error) {
      throw new Error(`Immutable raw upload failed (${error.statusCode ?? "storage_error"}).`);
    }
    return "created";
  }

  async read(key: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error?.statusCode === "404") return null;
    if (error || !data) {
      throw new Error(`Immutable raw download failed (${error?.statusCode ?? "storage_error"}).`);
    }
    return new Uint8Array(await data.arrayBuffer());
  }
}
