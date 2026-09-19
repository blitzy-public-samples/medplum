// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ContentType } from '@medplum/core';
import type { Parameters } from '@medplum/fhirtypes';
import express from 'express';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { vi } from 'vitest';
import { initApp, shutdownApp } from '../../app';
import { loadTestConfig } from '../../config/loader';
import { globalLogger } from '../../logger';
import * as migrateModule from '../../migrations/migrate';
import { getSuperAdminAccessToken, initTestAuth } from '../../test.setup';

function undefinedTableError(tableName: string): Error {
  return Object.assign(new Error(`relation "${tableName}" does not exist`), { code: '42P01' });
}

describe('$db-schema-diff', () => {
  const app = express();

  beforeAll(async () => {
    const config = await loadTestConfig();
    await initApp(app, config);

    // The migration script can log a lot sometimes
    vi.spyOn(globalLogger, 'write' as any).mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await shutdownApp();
  });

  test('Success', async () => {
    const accessToken = await getSuperAdminAccessToken();

    const res1 = await request(app)
      .post('/fhir/R4/$db-schema-diff')
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({});
    expect(res1).toHaveStatus(200);
    const params = res1.body as Parameters;
    const migrationString = params.parameter?.find((p) => p.name === 'migrationString')?.valueString;
    expect(migrationString).toBeDefined();
    expect(migrationString).toContain('The schema migration needed');
  });

  test('Access denied', async () => {
    const accessToken = await initTestAuth({ project: { superAdmin: false } });

    const res1 = await request(app)
      .post('/fhir/R4/$db-schema-diff')
      .set('Authorization', 'Bearer ' + accessToken)
      .set('Content-Type', ContentType.FHIR_JSON)
      .send({});
    expect(res1).toHaveStatus(403);
  });

  describe('Concurrent schema change', () => {
    let generateMigrationActionsSpy: MockInstance<typeof migrateModule.generateMigrationActions>;

    beforeEach(() => {
      generateMigrationActionsSpy = vi.spyOn(migrateModule, 'generateMigrationActions');
    });

    afterEach(() => {
      generateMigrationActionsSpy.mockRestore();
    });

    test('Retries when a relation is dropped mid-diff', async () => {
      const accessToken = await getSuperAdminAccessToken();
      generateMigrationActionsSpy.mockRejectedValueOnce(undefinedTableError('Gin_Index_Test_Table'));

      const res1 = await request(app)
        .post('/fhir/R4/$db-schema-diff')
        .set('Authorization', 'Bearer ' + accessToken)
        .set('Content-Type', ContentType.FHIR_JSON)
        .send({});
      expect(res1).toHaveStatus(200);
      const params = res1.body as Parameters;
      const migrationString = params.parameter?.find((p) => p.name === 'migrationString')?.valueString;
      expect(migrationString).toBeDefined();
      expect(migrationString).toContain('The schema migration needed');
      expect(generateMigrationActionsSpy).toHaveBeenCalledTimes(2);
    });

    test('Stops retrying once the attempt budget is exhausted', async () => {
      const accessToken = await getSuperAdminAccessToken();
      generateMigrationActionsSpy.mockRejectedValue(undefinedTableError('Gin_Index_Test_Table'));

      const res1 = await request(app)
        .post('/fhir/R4/$db-schema-diff')
        .set('Authorization', 'Bearer ' + accessToken)
        .set('Content-Type', ContentType.FHIR_JSON)
        .send({});
      expect(res1).toHaveStatus(400);
      expect(res1.body).toMatchObject({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            details: { text: 'relation "Gin_Index_Test_Table" does not exist' },
          },
        ],
      });
      expect(generateMigrationActionsSpy).toHaveBeenCalledTimes(3);
    });

    test.each([
      ['a different SQLSTATE', Object.assign(new Error('column "xyz" does not exist'), { code: '42703' })],
      ['no SQLSTATE', new Error('Failed to generate migration actions')],
    ])('Does not retry an error with %s', async (_label, error) => {
      const accessToken = await getSuperAdminAccessToken();
      generateMigrationActionsSpy.mockRejectedValue(error);

      const res1 = await request(app)
        .post('/fhir/R4/$db-schema-diff')
        .set('Authorization', 'Bearer ' + accessToken)
        .set('Content-Type', ContentType.FHIR_JSON)
        .send({});
      expect(res1).toHaveStatus(400);
      expect(res1.body).toMatchObject({
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            details: { text: error.message },
          },
        ],
      });
      expect(generateMigrationActionsSpy).toHaveBeenCalledTimes(1);
    });
  });
});
