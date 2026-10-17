#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

const dbPath = process.env.HUB_DB_PATH || path.join(projectRoot, 'data', 'hub.db');
const backupDir = process.env.HUB_BACKUP_DIR || path.join(projectRoot, 'data', 'backups');

// Ensure backup directory exists
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
  console.log(`Created backup directory: ${backupDir}`);
}

// Generate timestamp for backup filename
const now = new Date();
const timestamp = now.getFullYear().toString().padStart(4, '0') +
  (now.getMonth() + 1).toString().padStart(2, '0') +
  now.getDate().toString().padStart(2, '0') + '-' +
  now.getHours().toString().padStart(2, '0') +
  now.getMinutes().toString().padStart(2, '0') +
  now.getSeconds().toString().padStart(2, '0');

const backupPath = path.join(backupDir, `hub-${timestamp}.db`);

(async () => {
  try {
    // Open source database in readonly mode
    const sourceDb = new Database(dbPath, { readonly: true });

    // Use backup API (returns a Promise)
    await sourceDb.backup(backupPath);
    sourceDb.close();

    console.log(`Backup created: ${backupPath}`);

    // Keep only the 14 most recent backups
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('hub-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        time: fs.statSync(path.join(backupDir, f)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 14) {
      const toDelete = files.slice(14);
      for (const file of toDelete) {
        fs.unlinkSync(file.path);
        console.log(`Deleted old backup: ${file.name}`);
      }
    }

    console.log(`Total backups kept: ${Math.min(files.length, 14)}`);
    process.exit(0);
  } catch (error) {
    console.error('Backup failed:', error.message);
    process.exit(1);
  }
})();
