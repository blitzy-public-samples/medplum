// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MEDPLUM_VERSION, normalizeErrorString } from '@medplum/core';
import type { Request, Response } from 'express';
import os from 'node:os';
import type { PoolClient } from 'pg';
import { DatabaseMode, getDatabasePool } from './database';
import { getLogger } from './logger';
import type { RecordMetricOptions } from './otel/otel';
import { setGauge } from './otel/otel';
import type { RedisWithoutDuplicate } from './redis';
import { getAllRedisInstances } from './redis';

const hostname = os.hostname();
const BASE_METRIC_OPTIONS = { attributes: { hostname } } satisfies RecordMetricOptions;
const METRIC_IN_SECS_OPTIONS = { ...BASE_METRIC_OPTIONS, options: { unit: 's' } } satisfies RecordMetricOptions;

let readerConn: PoolClient | undefined;
let writerConn: PoolClient | undefined;

export async function healthcheckHandler(_req: Request, res: Response): Promise<void> {
  let postgresWriterOk: boolean;
  let startTime = Date.now();
  try {
    writerConn ??= await getReservedDatabaseConnection(DatabaseMode.WRITER);
    postgresWriterOk = await testPostgres(writerConn);
  } catch (err) {
    discardReservedDatabaseConnection(DatabaseMode.WRITER, err);
    postgresWriterOk = false;
  }
  const writerRoundtripMs = Date.now() - startTime;
  setGauge('medplum.db.healthcheckRTT', writerRoundtripMs / 1000, {
    ...METRIC_IN_SECS_OPTIONS,
    attributes: { ...METRIC_IN_SECS_OPTIONS.attributes, dbInstanceType: 'writer' },
  });

  let postgresReaderOk: boolean | undefined;
  if (hasSeparateReaderPool()) {
    try {
      readerConn ??= await getReservedDatabaseConnection(DatabaseMode.READER);
      startTime = Date.now();
      postgresReaderOk = await testPostgres(readerConn);
    } catch (err) {
      discardReservedDatabaseConnection(DatabaseMode.READER, err);
      postgresReaderOk = false;
    }
    const readerRoundtripMs = Date.now() - startTime;
    setGauge('medplum.db.healthcheckRTT', readerRoundtripMs / 1000, {
      ...METRIC_IN_SECS_OPTIONS,
      attributes: { ...METRIC_IN_SECS_OPTIONS.attributes, dbInstanceType: 'reader' },
    });
  }

  const redisChecks = getAllRedisInstances();
  const redisResults = await Promise.all(
    redisChecks.map(async ({ label, instance }) => {
      const t0 = Date.now();
      const ok = await testRedis(instance);
      const roundtripMs = Date.now() - t0;
      setGauge('medplum.redis.healthcheckRTT', roundtripMs / 1000, {
        ...METRIC_IN_SECS_OPTIONS,
        attributes: { ...METRIC_IN_SECS_OPTIONS.attributes, redisInstanceType: label },
      });
      return { label, ok };
    })
  );

  const redisResult: Record<string, boolean> = {};
  for (const { label, ok } of redisResults) {
    redisResult[label] = ok;
  }

  res.json({
    ok: true,
    version: MEDPLUM_VERSION,
    platform: process.platform,
    runtime: process.version,
    postgres: postgresWriterOk,
    postgresReader: postgresReaderOk,
    redis: redisResult.default,
    redisInstances: redisResult,
  });
}

async function getReservedDatabaseConnection(mode: DatabaseMode): Promise<PoolClient> {
  return getDatabasePool(mode).connect();
}

/**
 * Releases the reserved connection for the given mode and forgets it, so the next health check
 * checks out a fresh client from the pool.
 * @param mode - The database mode whose reserved connection is discarded.
 * @param err - The error that made the reserved connection unusable.
 */
function discardReservedDatabaseConnection(mode: DatabaseMode, err: unknown): void {
  const conn = mode === DatabaseMode.WRITER ? writerConn : readerConn;
  if (mode === DatabaseMode.WRITER) {
    writerConn = undefined;
  } else {
    readerConn = undefined;
  }

  getLogger().warn('Health check database connection failed', { mode, err: normalizeErrorString(err) });

  try {
    conn?.release(true);
  } catch (releaseErr) {
    getLogger().warn('Error releasing reserved database connection', {
      mode,
      err: normalizeErrorString(releaseErr),
    });
  }
}

export function cleanupReservedDatabaseConnections(): void {
  writerConn?.release(true);
  writerConn = undefined;
  readerConn?.release(true);
  readerConn = undefined;
}

function hasSeparateReaderPool(): boolean {
  return getDatabasePool(DatabaseMode.WRITER) !== getDatabasePool(DatabaseMode.READER);
}

async function testPostgres(pool: PoolClient): Promise<boolean> {
  return (await pool.query(`SELECT 1 AS "status"`)).rows[0].status === 1;
}

async function testRedis(instance: RedisWithoutDuplicate): Promise<boolean> {
  return (await instance.ping()) === 'PONG';
}
