import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261015204629_add_permission_decisions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_decisions\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`permission\` text NOT NULL,
          \`patterns\` text NOT NULL,
          \`metadata\` text,
          \`verdict\` text NOT NULL,
          \`reason\` text,
          \`prompt\` text,
          \`model\` text NOT NULL,
          \`latency_ms\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_permission_decisions_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`permission_decisions_session_idx\` ON \`permission_decisions\` (\`session_id\`);`)
    })
  },
}

export default migration
