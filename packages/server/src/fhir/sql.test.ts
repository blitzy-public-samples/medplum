// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { badRequest, getStatus, OperationOutcomeError } from '@medplum/core';
import type { Client, PoolClient } from 'pg';
import type { MockInstance } from 'vitest';
import { globalLogger } from '../logger';
import type { CTE, Operator, PgQueryable } from './sql';
import {
  Column,
  Condition,
  Constant,
  Disjunction,
  InsertQuery,
  isDatabaseConnectionError,
  IsNull,
  isPoolClient,
  isRetryableTransactionError,
  isValidPostgresIdentifier,
  MAX_INDEX_DATA_BYTES,
  Negation,
  normalizeDatabaseError,
  periodToRangeString,
  PostgresError,
  resetSqlDebug,
  SelectQuery,
  setSqlDebug,
  SqlBuilder,
  Subquery,
  truncateTextColumn,
  UnionAllBuilder,
  UpdateQuery,
  ValuesQuery,
} from './sql';

describe('SqlBuilder', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('SelectQuery', () => {
    test('Select', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').column('name').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id", "MyTable"."name" FROM "MyTable"');
    });

    test('Select where', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', '=', 'x').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" = $1');
    });

    test('Select where expression', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .whereExpr(new Condition('name', '=', 'x'))
        .buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "name" = $1');
    });

    test('Select where negation', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .whereExpr(new Negation(new Condition('name', '=', 'x')))
        .buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE NOT ("name" = $1)');
    });

    describe('array contains', () => {
      test('single value', () => {
        const sql = new SqlBuilder();
        new SelectQuery('MyTable').column('id').where('name', 'ARRAY_OVERLAPS', 'x', 'TEXT[]').buildSql(sql);
        expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" @> ARRAY[$1]::TEXT[]');
      });

      test('multiple values', () => {
        const sql = new SqlBuilder();
        new SelectQuery('MyTable').column('id').where('name', 'ARRAY_OVERLAPS', ['x', 'y'], 'TEXT[]').buildSql(sql);
        expect(sql.toString()).toBe(
          'SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" && ARRAY[$1,$2]::TEXT[]'
        );
      });

      test('missing param type', () => {
        const sql = new SqlBuilder();
        expect(() =>
          new SelectQuery('MyTable').column('id').where('name', 'ARRAY_OVERLAPS', 'x').buildSql(sql)
        ).toThrow('ARRAY_OVERLAPS requires paramType');
      });
    });

    describe('array contains and is not null', () => {
      test('single value', () => {
        const sql = new SqlBuilder();
        new SelectQuery('MyTable')
          .column('id')
          .where('name', 'ARRAY_OVERLAPS_AND_IS_NOT_NULL', 'x', 'TEXT[]')
          .buildSql(sql);
        expect(sql.toString()).toBe(
          'SELECT "MyTable"."id" FROM "MyTable" WHERE ("MyTable"."name" IS NOT NULL AND "MyTable"."name" @> ARRAY[$1]::TEXT[])'
        );
      });

      test('multiple values', () => {
        const sql = new SqlBuilder();
        new SelectQuery('MyTable')
          .column('id')
          .where('name', 'ARRAY_OVERLAPS_AND_IS_NOT_NULL', new Set(['x', 'y']), 'TEXT[]')
          .buildSql(sql);
        expect(sql.toString()).toBe(
          'SELECT "MyTable"."id" FROM "MyTable" WHERE ("MyTable"."name" IS NOT NULL AND "MyTable"."name" && ARRAY[$1,$2]::TEXT[])'
        );
      });

      test('missing param type', () => {
        const sql = new SqlBuilder();
        expect(() =>
          new SelectQuery('MyTable').column('id').where('name', 'ARRAY_OVERLAPS_AND_IS_NOT_NULL', 'x').buildSql(sql)
        ).toThrow('ARRAY_OVERLAPS_AND_IS_NOT_NULL requires paramType');
      });
    });

    test('Select where is null', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', '=', null).buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" IS NULL');
    });

    test('Select where is not null', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', '!=', null).buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" IS NOT NULL');
    });

    test('Select where is null expression', () => {
      const sql = new SqlBuilder();
      const maxSubquery = new SelectQuery('MyTable').raw('MAX(name)');
      new SelectQuery('MyOtherTable')
        .column('id')
        .whereExpr(new IsNull(new Subquery(maxSubquery)))
        .buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT "MyOtherTable"."id" FROM "MyOtherTable" WHERE (SELECT MAX(name) FROM "MyTable") IS NULL'
      );
    });

    test('Select where is not null expression', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .whereExpr(new Condition(new Column('MyTable', 'name'), '!=', null))
        .buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" IS NOT NULL');
    });

    test('Select where is null expression in disjunction', () => {
      const sql = new SqlBuilder();
      const maxSubquery = new SelectQuery('MyTable').raw('MAX(ts)');
      new SelectQuery('MyOtherTable')
        .column('id')
        .whereExpr(new Disjunction([new IsNull(new Subquery(maxSubquery)), new Condition('ts', '>', 'x')]))
        .buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT "MyOtherTable"."id" FROM "MyOtherTable" WHERE ((SELECT MAX(ts) FROM "MyTable") IS NULL OR "ts" > $1)'
      );
    });

    test('Select where greater than subquery', () => {
      const sql = new SqlBuilder();
      const maxSubquery = new SelectQuery('MyTable').raw('MAX(name)');
      new SelectQuery('MyOtherTable').column('id').where('name', '>', new Subquery(maxSubquery)).buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT "MyOtherTable"."id" FROM "MyOtherTable" WHERE "MyOtherTable"."name" > (SELECT MAX(name) FROM "MyTable")'
      );
    });

    test('Select where greater than subquery expression', () => {
      const sql = new SqlBuilder();
      const maxSubquery = new SelectQuery('MyTable').raw('MAX(name)');
      new SelectQuery('MyOtherTable')
        .column('id')
        .whereExpr(new Condition('name', '>', new Subquery(maxSubquery)))
        .buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT "MyOtherTable"."id" FROM "MyOtherTable" WHERE "name" > (SELECT MAX(name) FROM "MyTable")'
      );
    });

    test('Select value in subquery with type', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .where('name', 'IN_SUBQUERY', new SelectQuery('MyLookup').column('values'), 'TEXT[]')
        .buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name"=ANY((SELECT "MyLookup"."values" FROM "MyLookup")::TEXT[])'
      );
    });

    test('Select value in subquery without type', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .where('name', 'IN_SUBQUERY', new SelectQuery('MyLookup').column('values'))
        .buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name"=ANY(SELECT "MyLookup"."values" FROM "MyLookup")'
      );
    });

    test('Select group by', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').groupBy('name').groupBy(new Column('MyTable', 'email')).buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" GROUP BY "MyTable"."name", "MyTable"."email"');
    });

    test('Select distinct on', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .column('name')
        .distinctOn('id')
        .distinctOn(new Column('MyTable', 'name'))
        .buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT DISTINCT ON ("MyTable"."id", "MyTable"."name") "MyTable"."id", "MyTable"."name" FROM "MyTable"'
      );
    });

    test('Select with subquery', () => {
      const sql = new SqlBuilder();

      const joinName = 'T1';
      const joinOnExpression = new Condition(new Column(joinName, 'id'), '=', new Column('MyJoinTable', 'id'));

      new SelectQuery('MyTable')
        .column('id')
        .join('INNER JOIN', new SelectQuery('MyJoinTable').column('id'), joinName, joinOnExpression)
        .buildSql(sql);

      expect(sql.toString()).toBe(
        'SELECT "MyTable"."id" FROM "MyTable" INNER JOIN (SELECT "MyJoinTable"."id" FROM "MyJoinTable") AS "T1" ON "T1"."id" = "MyJoinTable"."id"'
      );
    });

    test('Select with simple lateral join', () => {
      const sql = new SqlBuilder();

      const joinName = 'T1';
      const joinOnExpression = new Constant('true');

      new SelectQuery('MyTable')
        .column('id')
        .join('LEFT JOIN LATERAL', new SelectQuery('MyJoinTable').column('id'), joinName, joinOnExpression)
        .buildSql(sql);

      expect(sql.toString()).toBe(
        'SELECT "MyTable"."id" FROM "MyTable" LEFT JOIN LATERAL (SELECT "MyJoinTable"."id" FROM "MyJoinTable") AS "T1" ON true'
      );
    });

    test('Select with realistic lateral join', () => {
      const sql = new SqlBuilder();

      const joinName = 'T1';
      const joinOnExpression = new Constant('true');

      new SelectQuery('Patient')
        .column('id')
        .join(
          'LEFT JOIN LATERAL',
          new SelectQuery('HumanName')
            .column('resourceId')
            .column('name')
            .where(new Column('HumanName', 'resourceId'), '=', new Column('Patient', 'id'))
            .orderBy(new Column('HumanName', 'resourceId'), false)
            .limit(1),
          joinName,
          joinOnExpression
        )
        .orderBy(new Column('T1', 'name'), false)
        .buildSql(sql);

      expect(sql.toString()).toBe(
        'SELECT "Patient"."id" FROM "Patient" LEFT JOIN LATERAL (SELECT "HumanName"."resourceId", "HumanName"."name" FROM "HumanName" WHERE "HumanName"."resourceId" = "Patient"."id" ORDER BY "HumanName"."resourceId" LIMIT 1) AS "T1" ON true ORDER BY "T1"."name"'
      );
    });

    test('Select distinct on sorting', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .column('name')
        .column('email')
        .distinctOn('id')
        .distinctOn(new Column('MyTable', 'name'))
        .orderBy('email')
        .buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT DISTINCT ON ("MyTable"."id", "MyTable"."name") "MyTable"."id", "MyTable"."name", "MyTable"."email" FROM "MyTable" ORDER BY "MyTable"."id", "MyTable"."name", "MyTable"."email"'
      );
    });

    test('Select where not equals', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', '!=', 'x').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" <> $1');
    });

    test('Select where not equals empty string', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', '!=', '').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" <> $1');
      expect(sql.getValues()).toStrictEqual(['']);
    });

    test('Select where not equals empty string w/ typed column', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where(new Column('MyTable', 'name'), '!=', '').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" <> $1');
      expect(sql.getValues()).toStrictEqual(['']);
    });

    test('Select where lower like', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', 'LOWER_LIKE', 'x').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE LOWER("MyTable"."name") LIKE $1');
    });

    test('Select where ilike', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', 'ILIKE', 'x').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable" WHERE "MyTable"."name" ILIKE $1');
    });

    test('Select where unaccent ilike', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').column('id').where('name', 'UNACCENT_ILIKE', '%x%').buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT "MyTable"."id" FROM "MyTable" WHERE medplum_unaccent("MyTable"."name") ILIKE medplum_unaccent($1)'
      );
      expect(sql.getValues()).toStrictEqual(['%x%']);
    });

    test('Select missing columns', () => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable').buildSql(sql);
      expect(sql.toString()).toEqual(`SELECT 1 FROM "MyTable"`);
    });

    test('periodToRangeString', () => {
      expect(periodToRangeString({})).toBeUndefined();
      expect(periodToRangeString({ start: '2020-01-01' })).toBe('[2020-01-01,]');
      expect(periodToRangeString({ end: '2020-01-01' })).toBe('[,2020-01-01]');
      expect(periodToRangeString({ start: '2020-01-01', end: '2020-01-02' })).toBe('[2020-01-01,2020-01-02]');
    });

    test('Debug mode', async () => {
      const writeSpy = vi.spyOn(globalLogger, 'write' as any).mockImplementation(() => undefined);

      const sql = new SqlBuilder();
      sql.debug = 'true';
      new SelectQuery('MyTable').column('id').buildSql(sql);
      expect(sql.toString()).toBe('SELECT "MyTable"."id" FROM "MyTable"');

      const conn = {
        query: vi.fn(() => ({ rows: [] })),
      } as unknown as Client;

      await sql.execute(conn);
      expect(writeSpy).toHaveBeenCalledWith('sql SELECT "MyTable"."id" FROM "MyTable"');
      writeSpy.mockRestore();
    });

    test('Empty insert is no-op', async () => {
      const db = { query: vi.fn() } as unknown as PoolClient;
      await expect(new InsertQuery('Patient', []).execute(db)).resolves.toStrictEqual([]);
      expect(db.query).not.toHaveBeenCalled();
    });

    test('Insert into select', () => {
      const sql = new SqlBuilder();
      new InsertQuery('MyTable', new SelectQuery('MyOtherTable').column('id').where('active', '=', true)).buildSql(sql);
      expect(sql.toString()).toBe(
        'INSERT INTO "MyTable" SELECT "MyOtherTable"."id" FROM "MyOtherTable" WHERE "MyOtherTable"."active" = $1'
      );
      expect(sql.getValues()).toStrictEqual([true]);
    });

    test('Insert into select with target columns', () => {
      const sql = new SqlBuilder();
      new InsertQuery('MyTable', new SelectQuery('MyOtherTable').column('sourceId').column('sourceName'), [
        'id',
        'name',
      ]).buildSql(sql);
      expect(sql.toString()).toBe(
        'INSERT INTO "MyTable" ("id", "name") SELECT "MyOtherTable"."sourceId", "MyOtherTable"."sourceName" FROM "MyOtherTable"'
      );
    });

    test('Insert query columns throw for values insert', () => {
      expect(() => new InsertQuery('MyTable', [{ id: '1' }], ['id'])).toThrow(
        'InsertQuery queryColumns are only valid for INSERT ... SELECT'
      );
    });

    test.each(['simple', 'english'])('Text search with tsquery', (type) => {
      const sql = new SqlBuilder();
      new SelectQuery('MyTable')
        .column('id')
        .where('name', ('TSVECTOR_' + type.toUpperCase()) as keyof typeof Operator, 'Jimmy (James) Dean')
        .buildSql(sql);
      expect(sql.toString()).toBe(
        `SELECT "MyTable"."id" FROM "MyTable" WHERE to_tsvector('${type}',"MyTable"."name") @@ to_tsquery('${type}',$1)`
      );
      expect(sql.getValues()).toStrictEqual(['Jimmy:* & James:* & Dean:*']);
    });
  });

  describe('ValuesQuery', () => {
    test('one row, one value', () => {
      const sql = new SqlBuilder();
      new ValuesQuery('MyValues', ['firstCol'], [['firstVal']]).buildSql(sql);
      expect(sql.toString()).toBe('SELECT * FROM (VALUES($1)) AS "MyValues"("firstCol")');
    });

    test('multiple rows, multiple values', () => {
      const sql = new SqlBuilder();
      new ValuesQuery(
        'MyValues',
        ['firstCol', 'secondCol', 'thirdCol'],
        [
          ['one', 'two', 3],
          ['four', 'five', 6],
        ]
      ).buildSql(sql);
      expect(sql.toString()).toBe(
        'SELECT * FROM (VALUES($1,$2,$3),($4,$5,$6)) AS "MyValues"("firstCol","secondCol","thirdCol")'
      );
    });
  });

  describe('UnionAllBuilder', () => {
    test('multiple queries', () => {
      const unionAllBuilder = new UnionAllBuilder();
      unionAllBuilder.add(new SelectQuery('MyTable').column('id').column('my_table_col'));
      expect(unionAllBuilder.sql.toString()).toBe('(SELECT "MyTable"."id", "MyTable"."my_table_col" FROM "MyTable")');

      unionAllBuilder.add(new SelectQuery('MyOtherTable').column('id').column('my_other_table_col'));
      expect(unionAllBuilder.sql.toString()).toBe(
        '(SELECT "MyTable"."id", "MyTable"."my_table_col" FROM "MyTable") UNION ALL (SELECT "MyOtherTable"."id", "MyOtherTable"."my_other_table_col" FROM "MyOtherTable")'
      );

      unionAllBuilder.add(new SelectQuery('MyThirdTable').column('id').column('my_third_table_col'));
      expect(unionAllBuilder.sql.toString()).toBe(
        '(SELECT "MyTable"."id", "MyTable"."my_table_col" FROM "MyTable") UNION ALL (SELECT "MyOtherTable"."id", "MyOtherTable"."my_other_table_col" FROM "MyOtherTable") UNION ALL (SELECT "MyThirdTable"."id", "MyThirdTable"."my_third_table_col" FROM "MyThirdTable")'
      );
    });
  });

  describe('UpdateQuery', () => {
    test('Simple Update', () => {
      const sql = new SqlBuilder();
      const update = new UpdateQuery('MyTable', ['id', 'name']);
      update.set('id', 123);
      update.buildSql(sql);
      expect(sql.toString()).toBe('UPDATE "MyTable" SET "id" = $1 RETURNING "MyTable"."id", "MyTable"."name"');
      expect(sql.getValues()).toStrictEqual([123]);
    });

    test('with CTE and RETURNING', () => {
      const cteQuery = new SelectQuery('MyTable').column('id').column('name').where('projectId', '=', null).limit(10);
      const cte: CTE = {
        name: 'MyCTE',
        expr: cteQuery,
      };

      const sql = new SqlBuilder();
      const update = new UpdateQuery('MyTable', ['id']);
      update.from(cte);
      update.set('id', 123);
      update.set('name', 'new-name');
      update.where(new Column('MyCTE', 'id'), '=', new Column('MyTable', 'id'));
      update.buildSql(sql);
      expect(sql.toString()).toBe(
        'WITH "MyCTE" AS (SELECT "MyTable"."id", "MyTable"."name" FROM "MyTable" WHERE "MyTable"."projectId" IS NULL LIMIT 10) UPDATE "MyTable" SET "id" = $1, "name" = $2 FROM "MyCTE" WHERE "MyCTE"."id" = "MyTable"."id" RETURNING "MyTable"."id"'
      );
      expect(sql.getValues()).toStrictEqual([123, 'new-name']);
    });
  });
});

test('isValidPostgresIdentifier', () => {
  expect(isValidPostgresIdentifier('Observation')).toStrictEqual(true);
  expect(isValidPostgresIdentifier('Observation_History')).toStrictEqual(true);
  expect(isValidPostgresIdentifier('Observation_Token_text_idx_tsv')).toStrictEqual(true);
  expect(isValidPostgresIdentifier('id')).toStrictEqual(true);
  expect(isValidPostgresIdentifier('ID')).toStrictEqual(true);
  expect(isValidPostgresIdentifier('lastUpdated')).toStrictEqual(true);
  expect(isValidPostgresIdentifier('__version')).toStrictEqual(true);

  expect(isValidPostgresIdentifier('Robert"; DROP TABLE Students;')).toStrictEqual(false);
  expect(isValidPostgresIdentifier('Observation History')).toStrictEqual(false);
  expect(isValidPostgresIdentifier('last-updated')).toStrictEqual(false);
  expect(isValidPostgresIdentifier('')).toStrictEqual(false);
});

test('debug', async () => {
  const writeSpy = vi.spyOn(globalLogger, 'write' as any).mockImplementation(() => undefined);

  const conn = {
    query: vi.fn(() => ({ rows: [] })),
  } as unknown as Client;

  const query = new SelectQuery('MyTable').column('id');

  async function executeQuery(): Promise<void> {
    const sql = new SqlBuilder();
    query.buildSql(sql);
    await sql.execute(conn);
  }

  setSqlDebug('literally anything');

  writeSpy.mockClear();
  await executeQuery();
  expect(writeSpy).toHaveBeenCalledWith('sql SELECT "MyTable"."id" FROM "MyTable"');

  setSqlDebug(undefined);

  writeSpy.mockClear();
  await executeQuery();
  expect(writeSpy).not.toHaveBeenCalled();

  resetSqlDebug();
  writeSpy.mockRestore();
});

describe('truncateTextColumn', () => {
  test('returns undefined for undefined', () => {
    expect(truncateTextColumn(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(truncateTextColumn('')).toBeUndefined();
  });

  test('returns short string unchanged', () => {
    expect(truncateTextColumn('hello')).toBe('hello');
  });

  test('returns string at exactly MAX_INDEX_DATA_BYTES unchanged', () => {
    const value = 'a'.repeat(MAX_INDEX_DATA_BYTES);
    expect(truncateTextColumn(value)).toBe(value);
  });

  test('truncates ASCII string to maximum bytes, not a fixed character count', () => {
    const value = 'a'.repeat(MAX_INDEX_DATA_BYTES + 1);
    const result = truncateTextColumn(value) as string;
    expect(result).toBeDefined();
    expect(result.length).toBe(MAX_INDEX_DATA_BYTES);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_INDEX_DATA_BYTES);
  });

  test('truncates very long string', () => {
    const value = 'a'.repeat(MAX_INDEX_DATA_BYTES * 2);
    const result = truncateTextColumn(value) as string;
    expect(result).toBeDefined();
    expect(result.length).toBe(MAX_INDEX_DATA_BYTES);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_INDEX_DATA_BYTES);
  });

  test('handles multi-byte UTF-8 characters', () => {
    const maxChars = MAX_INDEX_DATA_BYTES / 4; // 4 bytes per emoji
    const fitting = '\u{1F600}'.repeat(maxChars);
    expect(truncateTextColumn(fitting)).toBe(fitting);

    const exceeding = '\u{1F600}'.repeat(maxChars + 1);
    const result = truncateTextColumn(exceeding) as string;
    expect(result).toBeDefined();
    expect(result).toBe(fitting);
    expect(Array.from(result).length).toBe(maxChars);
    expect(new TextEncoder().encode(result).length).toBe(MAX_INDEX_DATA_BYTES);
  });

  test('handles mixed ASCII and multi-byte characters', () => {
    const asciiLen = MAX_INDEX_DATA_BYTES - 4; // Leave room for one 4-byte emoji
    const value = 'a'.repeat(asciiLen) + '\u{1F600}\u{1F600}';
    const result = truncateTextColumn(value) as string;
    expect(result).toBeDefined();
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_INDEX_DATA_BYTES);
    // Should keep all ASCII chars + 1 emoji (exactly MAX_INDEX_DATA_BYTES bytes)
    expect(result).toBe('a'.repeat(asciiLen) + '\u{1F600}');
  });
});

describe('normalizeDatabaseError', () => {
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(globalLogger, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(globalLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /**
   * Builds an error with the shape of a `pg` DatabaseError.
   * @param message - The driver message.
   * @param fields - The driver fields, such as `code`, `severity` and `detail`.
   * @returns An Error carrying the given driver fields.
   */
  function driverError(message: string, fields: Record<string, any> = {}): Error {
    return Object.assign(new Error(message), fields);
  }

  test.each([
    {
      name: '23505 unique violation',
      err: driverError('duplicate key value violates unique constraint "Patient_pkey"', {
        code: PostgresError.UniqueViolation,
        severity: 'ERROR',
        detail: 'Key (id)=(abc) already exists.',
      }),
      status: 409,
      issueCode: 'conflict',
      outcomeText: 'Key (id)=(abc) already exists.',
      retryable: false,
      messageContains: 'Key (id)=(abc) already exists.',
      bodyExcludes: [],
    },
    {
      name: '40001 serialization failure',
      err: driverError('could not serialize access due to concurrent update', {
        code: PostgresError.SerializationFailure,
        severity: 'ERROR',
      }),
      status: 409,
      issueCode: 'conflict',
      outcomeText: 'could not serialize access due to concurrent update',
      retryable: true,
      messageContains: 'could not serialize access due to concurrent update',
      bodyExcludes: [],
    },
    {
      name: '57014 query canceled',
      err: driverError('canceling statement due to statement timeout', {
        code: PostgresError.QueryCanceled,
        severity: 'ERROR',
      }),
      status: 504,
      issueCode: 'timeout',
      outcomeText: 'canceling statement due to statement timeout',
      retryable: false,
      messageContains: 'canceling statement due to statement timeout',
      bodyExcludes: [],
    },
    {
      name: '25P02 in failed sql transaction',
      err: driverError('current transaction is aborted, commands ignored until end of transaction block', {
        code: PostgresError.InFailedSqlTransaction,
        severity: 'ERROR',
      }),
      status: 400,
      issueCode: 'invalid',
      outcomeText: 'current transaction is aborted, commands ignored until end of transaction block',
      retryable: false,
      messageContains: 'current transaction is aborted, commands ignored until end of transaction block',
      bodyExcludes: [],
    },
    {
      name: '22008 datetime field overflow',
      err: driverError('date/time field value out of range: "2023-02-29"', {
        code: PostgresError.DatetimeFieldOverflow,
        severity: 'ERROR',
      }),
      status: 400,
      issueCode: 'invalid',
      outcomeText: 'date/time field value out of range: "2023-02-29"',
      retryable: false,
      messageContains: 'date/time field value out of range: "2023-02-29"',
      bodyExcludes: [],
    },
    {
      name: 'FATAL 57P01 admin shutdown',
      err: driverError('terminating connection due to administrator command', {
        code: PostgresError.AdminShutdown,
        severity: 'FATAL',
        routine: 'ProcessInterrupts',
      }),
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'terminating connection due to administrator command',
      bodyExcludes: ['terminating connection', '57P01', 'ProcessInterrupts'],
    },
    {
      name: '08006 connection failure reported at ERROR severity',
      err: driverError('connection to server was lost', {
        code: PostgresError.ConnectionFailure,
        severity: 'ERROR',
      }),
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'connection to server was lost',
      bodyExcludes: ['connection to server was lost', '08006'],
    },
    {
      name: '53300 too many connections',
      err: driverError('sorry, too many clients already', {
        code: PostgresError.TooManyConnections,
        severity: 'FATAL',
      }),
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'sorry, too many clients already',
      bodyExcludes: ['too many clients', '53300'],
    },
    {
      name: 'PANIC severity with an unclassified code',
      err: driverError('database system is shutting down', { code: 'XX000', severity: 'PANIC' }),
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'database system is shutting down',
      bodyExcludes: ['shutting down', 'XX000'],
    },
    {
      name: 'ECONNREFUSED socket error without a message',
      err: { code: 'ECONNREFUSED' } as any,
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'ECONNREFUSED',
      bodyExcludes: ['ECONNREFUSED'],
    },
    {
      name: 'ETIMEDOUT socket error',
      err: driverError('connect ETIMEDOUT 10.0.0.1:5432', { code: 'ETIMEDOUT' }),
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'connect ETIMEDOUT 10.0.0.1:5432',
      bodyExcludes: ['10.0.0.1', 'ETIMEDOUT'],
    },
    {
      name: 'pg-pool connection loss with no code',
      err: new Error('Connection terminated unexpectedly'),
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'Connection terminated unexpectedly',
      bodyExcludes: ['Connection terminated'],
    },
    {
      name: 'pg-pool connect timeout with no code',
      err: new Error('timeout exceeded when trying to connect'),
      status: 503,
      issueCode: 'transient',
      outcomeText: 'Database temporarily unavailable',
      retryable: false,
      messageContains: 'timeout exceeded when trying to connect',
      bodyExcludes: ['timeout exceeded'],
    },
    {
      name: '42P01 undefined table',
      err: driverError('relation "ClientApplication" does not exist', {
        code: '42P01',
        severity: 'ERROR',
        position: '15',
      }),
      status: 500,
      issueCode: 'exception',
      outcomeText: 'Internal server error',
      retryable: false,
      messageContains: 'relation "ClientApplication" does not exist',
      bodyExcludes: ['relation', 'does not exist', 'ClientApplication', '42P01'],
    },
    {
      name: '42703 undefined column',
      err: driverError('column "nope" does not exist', { code: '42703', severity: 'ERROR' }),
      status: 500,
      issueCode: 'exception',
      outcomeText: 'Internal server error',
      retryable: false,
      messageContains: 'column "nope" does not exist',
      bodyExcludes: ['column', 'does not exist', '42703'],
    },
    {
      name: 'application error without a driver code',
      err: new Error('some application bug'),
      status: 400,
      issueCode: 'invalid',
      outcomeText: 'some application bug',
      retryable: false,
      messageContains: 'some application bug',
      bodyExcludes: [],
    },
  ])('$name -> $status', ({ err, status, issueCode, outcomeText, retryable, messageContains, bodyExcludes }) => {
    const result = normalizeDatabaseError(err);
    expect(result).toBeInstanceOf(OperationOutcomeError);
    expect(getStatus(result.outcome)).toStrictEqual(status);
    expect(result.outcome.issue).toHaveLength(1);
    expect(result.outcome.issue[0].code).toStrictEqual(issueCode);
    expect(result.outcome.issue[0].details?.text).toStrictEqual(outcomeText);
    expect(isRetryableTransactionError(result)).toBe(retryable);

    // The driver message must survive for operators and for callers that match on Error.message
    expect(result.message).toContain(messageContains);

    // Nothing database-internal may reach the caller
    const body = JSON.stringify(result.outcome);
    for (const excluded of bodyExcludes) {
      expect(body).not.toContain(excluded);
    }
  });

  test('passes an OperationOutcomeError through unchanged', () => {
    const original = new OperationOutcomeError(badRequest('Missing id'));
    expect(normalizeDatabaseError(original)).toBe(original);
  });

  test('records the driver detail in the log for a transient failure', () => {
    const err = Object.assign(new Error('terminating connection due to administrator command'), {
      code: PostgresError.AdminShutdown,
      severity: 'FATAL',
    });

    const result = normalizeDatabaseError(err);

    expect(result.cause).toBe(err);
    expect(warnSpy).toHaveBeenCalledWith(
      'Database connection unavailable',
      expect.objectContaining({
        error: 'terminating connection due to administrator command',
        code: PostgresError.AdminShutdown,
        severity: 'FATAL',
      })
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('records the driver detail in the log for an unclassified driver failure', () => {
    const err = Object.assign(new Error('relation "ClientApplication" does not exist'), {
      code: '42P01',
      severity: 'ERROR',
    });

    const result = normalizeDatabaseError(err);

    expect(result.cause).toBe(err);
    expect(errorSpy).toHaveBeenCalledWith(
      'Database error',
      expect.objectContaining({
        error: 'relation "ClientApplication" does not exist',
        code: '42P01',
      })
    );
  });
});

describe('isDatabaseConnectionError', () => {
  test.each([
    [
      'pg FATAL 57P01 administrator termination',
      Object.assign(new Error('terminating connection due to administrator command'), {
        severity: 'FATAL',
        code: PostgresError.AdminShutdown,
        routine: 'ProcessInterrupts',
      }),
      true,
    ],
    ['pg PANIC severity', Object.assign(new Error('database system is shutting down'), { severity: 'PANIC' }), true],
    ['pg 08006 connection failure', Object.assign(new Error('connection failure'), { code: '08006' }), true],
    ['pg 53300 too many connections', Object.assign(new Error('too many clients already'), { code: '53300' }), true],
    ['socket reset', { code: 'ECONNRESET' }, true],
    ['connection refused', { code: 'ECONNREFUSED' }, true],
    ['pg-pool connection terminated', new Error('Connection terminated unexpectedly'), true],
    ['pg-pool unqueryable client', new Error('Client has encountered a connection error and is not queryable'), true],
    ['pg-pool connect timeout', new Error('timeout exceeded when trying to connect'), true],
    [
      'pg ERROR 42P01 relation does not exist',
      Object.assign(new Error('relation "ClientApplication" does not exist'), {
        severity: 'ERROR',
        code: '42P01',
        routine: 'parserOpenTable',
      }),
      false,
    ],
    ['unrelated error', new Error('kaboom'), false],
    ['undefined', undefined, false],
    ['null', null, false],
    ['string', 'some string', false],
    ['empty object', {}, false],
  ])('%s', (_name, err, expected) => {
    expect(isDatabaseConnectionError(err)).toBe(expected);
  });
});

describe('isPoolClient', () => {
  test('returns true for a client with a release function', () => {
    const client = { query: vi.fn(), release: vi.fn() } as PgQueryable;
    expect(isPoolClient(client)).toBe(true);
  });

  test('returns false for a pool without a release function', () => {
    const pool = { query: vi.fn() } as PgQueryable;
    expect(isPoolClient(pool)).toBe(false);
  });

  test('returns false when release is not a function', () => {
    const notAClient = { query: vi.fn(), release: true } as PgQueryable;
    expect(isPoolClient(notAClient)).toBe(false);
  });
});
