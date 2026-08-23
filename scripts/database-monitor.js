#!/usr/bin/env node

/**
 * Database Monitor
 * 
 * Monitors database size and performance, automatically cleaning up when needed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

class DatabaseMonitor {
  constructor() {
    this.dbPath = path.join(process.cwd(), 'data', 'mohobot.db');
    this.maxDbSize = 10 * 1024 * 1024; // 10MB
    this.maxWalSize = 5 * 1024 * 1024; // 5MB
    this.checkInterval = 60000; // 1 minute
  }

  async checkDatabaseSize() {
    try {
      const stats = await fs.stat(this.dbPath);
      const walStats = await fs.stat(this.dbPath + '-wal').catch(() => null);
      
      console.log(`Database size: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
      
      if (walStats && walStats.size > this.maxWalSize) {
        console.log(`WAL file too large: ${(walStats.size / 1024 / 1024).toFixed(2)}MB, cleaning up...`);
        await this.cleanupWAL();
      }
      
      if (stats.size > this.maxDbSize) {
        console.log(`Database too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB, optimizing...`);
        await this.optimizeDatabase();
      }
      
      return { dbSize: stats.size, walSize: walStats?.size || 0 };
    } catch (error) {
      console.error('Error checking database size:', error);
      return { dbSize: 0, walSize: 0 };
    }
  }

  async cleanupWAL() {
    try {
      await execAsync('node -e "import Database from \'better-sqlite3\'; const db = new Database(\'./data/mohobot.db\'); db.pragma(\'wal_checkpoint(FULL)\'); db.close();"');
      console.log('WAL cleanup completed');
    } catch (error) {
      console.error('WAL cleanup failed:', error);
    }
  }

  async optimizeDatabase() {
    try {
      await execAsync('node -e "import Database from \'better-sqlite3\'; const db = new Database(\'./data/mohobot.db\'); db.exec(\'VACUUM\'); db.close();"');
      console.log('Database optimization completed');
    } catch (error) {
      console.error('Database optimization failed:', error);
    }
  }

  async startMonitoring() {
    console.log('Starting database monitoring...');
    
    // Initial check
    await this.checkDatabaseSize();
    
    // Set up periodic checks
    setInterval(() => {
      this.checkDatabaseSize();
    }, this.checkInterval);
    
    console.log(`Monitoring every ${this.checkInterval / 1000} seconds`);
  }
}

// Start monitoring if this script is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const monitor = new DatabaseMonitor();
  monitor.startMonitoring().catch(console.error);
}

export default DatabaseMonitor;