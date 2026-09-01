import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260901095249_add_session_read_only",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`read_only\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
