import { config } from '../server/config.js';
import { database, migrate } from '../server/db.js';
const db = await database(config());
try {
  await migrate(db);
  console.log('Migração aditiva do banco concluída. Nenhuma planilha foi alterada.');
} finally {
  await db.close();
}
