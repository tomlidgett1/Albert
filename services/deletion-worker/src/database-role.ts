import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";

/**
 * Every control-plane operation explicitly activates the deletion group role.
 * The deployment login must be a member of this role only; it receives no
 * direct object grants and cannot silently fall back to service_role.
 */
export function asDeletionControl<T>(
  database: TransactionalPostgres,
  work: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query("set local role albert_deletion_control");
    return work(client);
  });
}
