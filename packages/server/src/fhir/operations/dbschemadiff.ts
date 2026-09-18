// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { allOk, FileBuilder, normalizeErrorString } from '@medplum/core';
import type { FhirRequest, FhirResponse } from '@medplum/fhir-router';
import { requireSuperAdmin } from '../../context';
import { DatabaseMode, getDatabasePool } from '../../database';
import { globalLogger } from '../../logger';
import type { BuildMigrationOptions } from '../../migrations/migrate';
import { generateMigrationActions, writePreDeployActionsToBuilder } from '../../migrations/migrate';
import type { PhasalMigration } from '../../migrations/types';
import { makeOperationDefinition } from './definitions';
import { buildOutputParameters } from './utils/parameters';

/** PostgreSQL SQLSTATE for `undefined_table`. */
const UNDEFINED_TABLE_SQLSTATE = '42P01';

/** Total number of schema diff attempts before the error is surfaced to the caller. */
const SCHEMA_DIFF_MAX_ATTEMPTS = 3;

const operation = makeOperationDefinition(
  { scope: 'system' },
  {
    name: 'db-schema-diff',
    code: 'schema-diff',
    parameter: [
      {
        use: 'out',
        name: 'migrationString',
        type: 'string',
        min: 1,
        max: '1',
      },
    ],
  }
);

/**
 * Determines whether an unknown rejection value is a PostgreSQL `undefined_table` (42P01) error.
 *
 * @param err - The rejection value to inspect. Any value, including `undefined` and non-`Error` objects.
 * @returns True if the value carries the `undefined_table` SQLSTATE, false otherwise.
 */
function isUndefinedTableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNDEFINED_TABLE_SQLSTATE;
}

/**
 * Generates the migration actions that reconcile the live schema with the target schema, re-running the
 * read-only comparison when a relation is dropped while the live schema is being enumerated.
 *
 * @param options - Migration build options. `options.dbClient` must be a read-only queryable.
 * @returns The pre-deploy and post-deploy actions describing the difference between the live and target schemas.
 * @throws The underlying error unchanged when it is not `undefined_table` (42P01), and the error raised by the
 * final attempt once the attempt budget is exhausted.
 */
async function generateMigrationActionsWithRetry(options: BuildMigrationOptions): Promise<PhasalMigration> {
  for (let attempt = 1; attempt < SCHEMA_DIFF_MAX_ATTEMPTS; attempt++) {
    try {
      return await generateMigrationActions(options);
    } catch (err: unknown) {
      if (!isUndefinedTableError(err)) {
        throw err;
      }
      globalLogger.warn('Retrying $db-schema-diff after concurrent schema change', {
        attempt,
        maxAttempts: SCHEMA_DIFF_MAX_ATTEMPTS,
        error: normalizeErrorString(err),
      });
    }
  }

  return generateMigrationActions(options);
}

export async function dbSchemaDiffHandler(_req: FhirRequest): Promise<FhirResponse> {
  requireSuperAdmin();

  const dbClient = getDatabasePool(DatabaseMode.READER);
  const b = new FileBuilder('  ', false);
  b.append('// The schema migration needed to match the expected schema');
  b.append('');

  const actions = await generateMigrationActionsWithRetry({
    dbClient,
    dropUnmatchedIndexes: true,
  });

  writePreDeployActionsToBuilder(b, [...actions.preDeploy, ...actions.postDeploy]);

  return [allOk, buildOutputParameters(operation, { migrationString: b.toString() })];
}
