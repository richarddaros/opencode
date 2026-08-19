import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260819023303_drop_permission_decision_prompt",
  up(tx) {
    return Effect.gen(function* () {
      // Idempotente de proposito: bancos que ja passaram pela linha paralela
      // (20260817140444_open_jackpot) nao tem mais a coluna, e um DROP cru
      // falharia neles.
      if (
        (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`permission_decisions\`)`)).some(
          (column) => column.name === "prompt",
        )
      ) {
        yield* tx.run(`ALTER TABLE \`permission_decisions\` DROP COLUMN \`prompt\`;`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
