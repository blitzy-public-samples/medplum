// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { vi } from 'vitest';
import { initApp, shutdownApp } from './app';
import { loadTestConfig } from './config/loader';
import { DatabaseMode, getDatabasePool } from './database';
import * as otel from './otel/otel';

const app = express();

describe('Health check', () => {
  let setGaugeSpy: MockInstance;
  const originalProcessEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalProcessEnv };
    setGaugeSpy = vi.spyOn(otel, 'setGauge');
  });

  afterEach(async () => {
    process.env = originalProcessEnv;
    setGaugeSpy.mockRestore();
    await shutdownApp();
  });

  test('Get /healthcheck', async () => {
    const config = await loadTestConfig();
    await initApp(app, config);

    const res = await request(app).get('/healthcheck');
    expect(res).toHaveStatus(200);
    expect(res.body.redis).toBe(true);
    expect(res.body.redisInstances).toEqual({
      default: true,
      rateLimit: true,
      pubSub: true,
      backgroundJobs: true,
    });
  });

  test('Get /healthcheck with separate Redis instances', async () => {
    const config = await loadTestConfig();
    config.cacheRedis = { ...config.redis, db: 11 };
    await initApp(app, config);

    const res = await request(app).get('/healthcheck');
    expect(res).toHaveStatus(200);
    expect(res.body.redisInstances).toMatchObject({
      default: true,
      cache: true,
      rateLimit: true,
      pubSub: true,
      backgroundJobs: true,
    });
  });

  test('Get /healthcheck reports postgres false and recovers after the reserved connection is lost', async () => {
    const config = await loadTestConfig();
    await initApp(app, config);

    const pool = getDatabasePool(DatabaseMode.WRITER);
    const deadClient = {
      query: vi.fn().mockRejectedValue(new Error('Client has encountered a connection error and is not queryable')),
      release: vi.fn(),
    };
    const connectSpy = vi
      .spyOn(pool as unknown as { connect: () => Promise<PoolClient> }, 'connect')
      .mockResolvedValueOnce(deadClient as unknown as PoolClient);

    const failed = await request(app).get('/healthcheck');
    expect(failed).toHaveStatus(200);
    expect(failed.body.postgres).toBe(false);
    expect(deadClient.query).toHaveBeenCalledTimes(1);
    expect(deadClient.release).toHaveBeenCalledWith(true);

    connectSpy.mockRestore();

    const recovered = await request(app).get('/healthcheck');
    expect(recovered).toHaveStatus(200);
    expect(recovered.body.postgres).toBe(true);
    expect(deadClient.query).toHaveBeenCalledTimes(1);
  });

  test('Get /healthcheck when OTel is enabled', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';

    const config = await loadTestConfig();
    await initApp(app, config);

    const res = await request(app).get('/healthcheck');
    expect(res).toHaveStatus(200);

    expect(setGaugeSpy).toHaveBeenCalledTimes(6);
  });

  test('Get /healthcheck when OTel is enabled and read and write instance are the same', async () => {
    process.env.OTLP_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics';

    const config = await loadTestConfig();
    config.readonlyDatabase = undefined;
    await initApp(app, config);

    const res = await request(app).get('/healthcheck');
    expect(res).toHaveStatus(200);

    expect(setGaugeSpy).toHaveBeenCalledTimes(5);
  });
});
