// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import { createReference, DEFAULT_MAX_SEARCH_COUNT, DEFAULT_SEARCH_COUNT } from '@medplum/core';
import type { ClientApplication } from '@medplum/fhirtypes';
import { randomUUID } from 'crypto';
import express from 'express';
import type { Response } from 'supertest';
import request from 'supertest';
import { initApp, shutdownApp } from '../app';
import type { RegisterResponse } from '../auth/register';
import { registerNew } from '../auth/register';
import { getConfig, loadTestConfig } from '../config/loader';
import type { OAuthClientLintFinding, OAuthClientLintResult, OAuthClientLintRuleId } from '../oauth/clientlint';
import { addTestUser, createTestProject, getSuperAdminAccessToken, withTestContext } from '../test.setup';

const app = express();

/** The first entry configured in `defaultOAuthClients` for this suite, carrying a `redirectUris` list. */
const CONFIGURED_CLIENT_ID = 'oauth-security-default-client';
const CONFIGURED_REDIRECT_URI = 'https://configured.example.com/callback';

/** The second configured entry, carrying only the deprecated singular `redirectUri`. */
const LEGACY_CONFIGURED_CLIENT_ID = 'oauth-security-legacy-default-client';
const LEGACY_CONFIGURED_REDIRECT_URI = 'https://legacy-configured.example.com/callback';

/** The third configured entry, which registers the built-in Medplum CLI redirect URI. */
const SHADOWING_CONFIGURED_CLIENT_ID = 'oauth-security-shadowing-default-client';

const BUILT_IN_CLI_REDIRECT_URI = 'http://localhost:9615';

const EXACT_CALLBACK_URI = 'https://app.example.com/oauth/callback';
const SECOND_EXACT_CALLBACK_URI = 'https://app.example.com/other/callback';
const BARE_ORIGIN_URI = 'https://app.example.com';
const WILDCARD_URI = 'https://app.example.com/*';

/** The callback URL a non-admin project member registers beside an empty second entry. */
const MEMBER_CALLBACK_URI = 'https://member.example.com/cb';

/** A bare origin whose host carries a right-to-left override, which `new URL()` rejects. */
const BIDI_BARE_ORIGIN_URI = 'https://\u202Emoc.live\u202C.example.com';

/** The clean equivalent of {@link BIDI_BARE_ORIGIN_URI}, which parses and is a bare origin. */
const CLEAN_BARE_ORIGIN_URI = 'https://victim.example.com';

const DANGEROUS_REDIRECT_SETTING = 'allow-dangerous-redirect';

const CONFIG_SOURCE_REASON = 'configured default OAuth client list';
const CONFIG_SOURCE_REMEDIATION = 'default OAuth client configuration';
const BUILT_IN_SOURCE_REASON = 'built-in Medplum CLI client';
const BUILT_IN_SOURCE_REMEDIATION = 'The built-in client cannot be removed by configuration.';

const FIXTURE_SECRET = 'redacted-fixture-client-secret';
const FIXTURE_RETIRING_SECRET = 'redacted-fixture-retiring-secret';

/** The maximum number of client applications the endpoint addresses in one request. */
const MAX_REPORT_CLIENTS_PER_REQUEST = 200;

/** One entry of the `results` array, carrying `omittedFindings` when the response ceiling bounded its findings. */
type ClientSecurityResult = OAuthClientLintResult & { readonly omittedFindings?: number };

interface ClientSecurityReport {
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly results: ClientSecurityResult[];
}

interface ValidationCase {
  readonly name: string;
  readonly query: string;
  readonly status: number;
  /** The `OperationOutcome` detail text a refused request must carry. Required of every 400 case. */
  readonly outcome?: string;
  readonly count?: number;
  readonly offset?: number;
  readonly total?: number;
  readonly unfiltered?: boolean;
}

const INVALID_ID_OUTCOME = 'Invalid _id search parameter';
const INVALID_COUNT_OUTCOME = 'Invalid _count search parameter';
const INVALID_OFFSET_OUTCOME = 'Invalid _offset search parameter';
const OVER_LENGTH_ID_OUTCOME =
  '_id search parameter exceeds maximum of ' + MAX_REPORT_CLIENTS_PER_REQUEST + ' client ids';

const REPEATED_COUNT_QUERY = '?_count=5&_count=6';
const REPEATED_OFFSET_QUERY = '?_offset=1&_offset=2';
const REPEATED_ID_QUERY = '?_id=' + randomUUID() + '&_id=' + randomUUID();
const MIXED_ID_QUERY = '?_id=' + [randomUUID(), 'not-a-uuid', randomUUID()].join(',');
const OVER_LENGTH_ID_LIST_QUERY =
  '?_id=' + Array.from({ length: MAX_REPORT_CLIENTS_PER_REQUEST + 1 }, () => 'x').join(',');

/** An `_id` list of exactly the accepted maximum, addressing client ids that match nothing. */
const MAX_LENGTH_ID_LIST_QUERY =
  '?_id=' + Array.from({ length: MAX_REPORT_CLIENTS_PER_REQUEST }, () => randomUUID()).join(',');

/** An `_id` list one value longer than the accepted maximum, carrying only well formed client ids. */
const OVER_LENGTH_UUID_LIST_QUERY =
  '?_id=' + Array.from({ length: MAX_REPORT_CLIENTS_PER_REQUEST + 1 }, () => randomUUID()).join(',');

/** An unsigned integer above `Number.MAX_SAFE_INTEGER`, which `_count` clamps to the maximum search count. */
const ABOVE_SAFE_INTEGER_VALUE = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();

const UNREPRESENTABLE_INTEGER_VALUE = '9'.repeat(310);

const validationCases: ValidationCase[] = [
  { name: 'Absent _count uses the default search count', query: '', status: 200, count: DEFAULT_SEARCH_COUNT },
  { name: 'Empty _count uses the default search count', query: '?_count=', status: 200, count: DEFAULT_SEARCH_COUNT },
  { name: 'Zero _count is rejected', query: '?_count=0', status: 400, outcome: INVALID_COUNT_OUTCOME },
  { name: 'Negative _count is rejected', query: '?_count=-1', status: 400, outcome: INVALID_COUNT_OUTCOME },
  { name: 'Fractional _count is rejected', query: '?_count=1.5', status: 400, outcome: INVALID_COUNT_OUTCOME },
  { name: 'Non-numeric _count is rejected', query: '?_count=abc', status: 400, outcome: INVALID_COUNT_OUTCOME },
  { name: 'Repeated _count is rejected', query: REPEATED_COUNT_QUERY, status: 400, outcome: INVALID_COUNT_OUTCOME },
  {
    name: 'A _count at the maximum clients per request is accepted unchanged',
    query: '?_count=' + MAX_REPORT_CLIENTS_PER_REQUEST,
    status: 200,
    count: MAX_REPORT_CLIENTS_PER_REQUEST,
  },
  {
    name: 'Oversized _count is clamped to the maximum clients per request',
    query: '?_count=' + (MAX_REPORT_CLIENTS_PER_REQUEST + 1),
    status: 200,
    count: MAX_REPORT_CLIENTS_PER_REQUEST,
  },
  {
    name: 'A _count at the maximum search count is clamped to the maximum clients per request',
    query: '?_count=' + DEFAULT_MAX_SEARCH_COUNT,
    status: 200,
    count: MAX_REPORT_CLIENTS_PER_REQUEST,
  },
  {
    name: 'A _count above the safe integer ceiling is clamped to the maximum clients per request',
    query: '?_count=' + ABOVE_SAFE_INTEGER_VALUE,
    status: 200,
    count: MAX_REPORT_CLIENTS_PER_REQUEST,
  },
  { name: 'Absent _offset starts at the first client', query: '', status: 200, offset: 0 },
  { name: 'Empty _offset starts at the first client', query: '?_offset=', status: 200, offset: 0 },
  { name: 'Zero _offset is accepted', query: '?_offset=0', status: 200, offset: 0 },
  {
    name: 'An _offset too large to parse as a finite number is rejected',
    query: '?_offset=' + UNREPRESENTABLE_INTEGER_VALUE,
    status: 400,
    outcome: INVALID_OFFSET_OUTCOME,
  },
  { name: 'Negative _offset is rejected', query: '?_offset=-1', status: 400, outcome: INVALID_OFFSET_OUTCOME },
  { name: 'Fractional _offset is rejected', query: '?_offset=1.5', status: 400, outcome: INVALID_OFFSET_OUTCOME },
  { name: 'Non-numeric _offset is rejected', query: '?_offset=abc', status: 400, outcome: INVALID_OFFSET_OUTCOME },
  { name: 'Repeated _offset is rejected', query: REPEATED_OFFSET_QUERY, status: 400, outcome: INVALID_OFFSET_OUTCOME },
  { name: 'Malformed _id is rejected', query: '?_id=not-a-uuid', status: 400, outcome: INVALID_ID_OUTCOME },
  {
    name: 'One malformed id among valid client ids is rejected',
    query: MIXED_ID_QUERY,
    status: 400,
    outcome: INVALID_ID_OUTCOME,
  },
  { name: 'Repeated _id is rejected', query: REPEATED_ID_QUERY, status: 400, outcome: INVALID_ID_OUTCOME },
  {
    name: 'An _id list longer than the maximum clients per request is rejected',
    query: OVER_LENGTH_ID_LIST_QUERY,
    status: 400,
    outcome: OVER_LENGTH_ID_OUTCOME,
  },
  {
    name: 'An _id list of well formed client ids longer than the maximum clients per request is rejected',
    query: OVER_LENGTH_UUID_LIST_QUERY,
    status: 400,
    outcome: OVER_LENGTH_ID_OUTCOME,
  },
  {
    name: 'An _id list at the maximum clients per request is accepted',
    query: MAX_LENGTH_ID_LIST_QUERY,
    status: 200,
    count: DEFAULT_SEARCH_COUNT,
    offset: 0,
    total: 0,
  },
  { name: 'Separator-only _id returns every client', query: '?_id=,,', status: 200, unfiltered: true },
  {
    name: 'A bracketed _id is rejected',
    query: '?_id[0]=' + randomUUID(),
    status: 400,
    outcome: INVALID_ID_OUTCOME,
  },
  {
    name: 'A percent-encoded bracketed _id is rejected',
    query: '?_id%5B0%5D=' + randomUUID(),
    status: 400,
    outcome: INVALID_ID_OUTCOME,
  },
  { name: 'A bracketed _count is rejected', query: '?_count[]=5', status: 400, outcome: INVALID_COUNT_OUTCOME },
  {
    name: 'A percent-encoded bracketed _count is rejected',
    query: '?_count%5B%5D=5',
    status: 400,
    outcome: INVALID_COUNT_OUTCOME,
  },
  { name: 'A bracketed _offset is rejected', query: '?_offset[0]=5', status: 400, outcome: INVALID_OFFSET_OUTCOME },
  {
    name: 'A percent-encoded bracketed _offset is rejected',
    query: '?_offset%5B0%5D=5',
    status: 400,
    outcome: INVALID_OFFSET_OUTCOME,
  },
  {
    name: 'A parameter whose name begins with a reserved name is ignored',
    query: '?_identifier=' + randomUUID() + '&_counted=5&_offsetting=5',
    status: 200,
    unfiltered: true,
    count: DEFAULT_SEARCH_COUNT,
    offset: 0,
  },
];

function clientFixture(
  name: string,
  redirectUris: string[],
  overrides?: Partial<ClientApplication>
): ClientApplication {
  return { resourceType: 'ClientApplication', name, redirectUris, ...overrides };
}

async function seedClient(accessToken: string, fixture: ClientApplication): Promise<WithId<ClientApplication>> {
  const res = await request(app)
    .post('/fhir/R4/ClientApplication')
    .set('Authorization', 'Bearer ' + accessToken)
    .type('json')
    .send(fixture);
  expect(res).toHaveStatus(201);
  return res.body as WithId<ClientApplication>;
}

async function readReport(projectId: string, accessToken: string, query?: string): Promise<Response> {
  return request(app)
    .get('/admin/projects/' + projectId + '/oauth-security' + (query ?? ''))
    .set('Authorization', 'Bearer ' + accessToken);
}

function reportOf(res: Response): ClientSecurityReport {
  return res.body as ClientSecurityReport;
}

function resultById(report: ClientSecurityReport, clientId: string): ClientSecurityResult {
  const result = report.results.find((candidate) => candidate.id === clientId);
  expect(result).toBeDefined();
  return result as ClientSecurityResult;
}

function ruleIdsOf(result: OAuthClientLintResult): OAuthClientLintRuleId[] {
  return result.findings.map((finding) => finding.ruleId);
}

function findingsOf(result: OAuthClientLintResult, ruleId: OAuthClientLintRuleId): OAuthClientLintFinding[] {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

function sortedResultIds(report: ClientSecurityReport): string[] {
  return report.results.map((result) => result.id).sort((a, b) => a.localeCompare(b));
}

let projectAdmin: RegisterResponse;

describe('OAuth client security endpoint', () => {
  beforeAll(async () => {
    const config = await loadTestConfig();

    config.defaultOAuthClients = [
      {
        resourceType: 'ClientApplication',
        id: CONFIGURED_CLIENT_ID,
        name: 'Configured Default Client',
        redirectUris: [CONFIGURED_REDIRECT_URI],
      },
      {
        resourceType: 'ClientApplication',
        id: LEGACY_CONFIGURED_CLIENT_ID,
        name: 'Legacy Configured Default Client',
        redirectUri: LEGACY_CONFIGURED_REDIRECT_URI,
      },
      {
        resourceType: 'ClientApplication',
        id: SHADOWING_CONFIGURED_CLIENT_ID,
        name: 'Shadowing Configured Default Client',
        redirectUris: [BUILT_IN_CLI_REDIRECT_URI],
      },
    ];
    await withTestContext(() => initApp(app, config));

    projectAdmin = await withTestContext(() =>
      registerNew({
        firstName: 'Alice',
        lastName: 'Smith',
        projectName: 'Alice Project',
        email: `alice${randomUUID()}@example.com`,
        password: 'password!@#',
      })
    );
  });

  afterAll(async () => {
    await shutdownApp();
  });

  describe('Authorization', () => {
    test('Project admin receives a report for their own project', async () => {
      const res = await readReport(projectAdmin.project.id, projectAdmin.accessToken);
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      expect(report.total).toBeGreaterThanOrEqual(1);
      expect(report.offset).toStrictEqual(0);
      expect(report.count).toStrictEqual(DEFAULT_SEARCH_COUNT);
      expect(Array.isArray(report.results)).toBe(true);
    });

    test('Super admin receives a report for another project', async () => {
      const { project } = await createTestProject();
      const superAdminAccessToken = await getSuperAdminAccessToken();

      const res = await request(app)
        .get('/admin/projects/' + project.id + '/oauth-security')
        .set('Authorization', 'Bearer ' + superAdminAccessToken);
      expect(res).toHaveStatus(200);
      expect(Array.isArray(reportOf(res).results)).toBe(true);
    });

    test('Authenticated non-admin member of the same project is forbidden', async () => {
      const member = await addTestUser(projectAdmin.project);

      const res = await readReport(projectAdmin.project.id, member.accessToken);
      expect(res).toHaveStatus(403);
      expect(res.body.resourceType).toStrictEqual('OperationOutcome');
      expect(res.body.issue[0].code).toStrictEqual('forbidden');
    });

    test('Request without an access token is unauthorized', async () => {
      const res = await request(app).get('/admin/projects/' + projectAdmin.project.id + '/oauth-security');
      expect(res).toHaveStatus(401);
    });
  });

  describe('Rule outcomes', () => {
    let exactClientId: string;
    let bareOriginClientId: string;
    let wildcardClientId: string;
    let noRedirectUriClientId: string;
    let requestedIds: string[];
    let report: ClientSecurityReport;

    beforeAll(async () => {
      const outcomes = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });

      const exact = await withTestContext(() =>
        outcomes.repo.createResource(clientFixture('Exact Callback Client', [EXACT_CALLBACK_URI]))
      );
      const bareOrigin = await withTestContext(() =>
        outcomes.repo.createResource(clientFixture('Bare Origin Client', [BARE_ORIGIN_URI]))
      );
      const wildcard = await withTestContext(() =>
        outcomes.repo.createResource(clientFixture('Wildcard Client', [WILDCARD_URI]))
      );
      const noRedirectUri = await withTestContext(() =>
        outcomes.repo.createResource(clientFixture('No Redirect URI Client', []))
      );

      exactClientId = exact.id;
      bareOriginClientId = bareOrigin.id;
      wildcardClientId = wildcard.id;
      noRedirectUriClientId = noRedirectUri.id;
      requestedIds = [exactClientId, bareOriginClientId, wildcardClientId, noRedirectUriClientId];

      const res = await readReport(outcomes.project.id, outcomes.accessToken, '?_id=' + requestedIds.join(','));
      expect(res).toHaveStatus(200);
      report = reportOf(res);
    });

    test('Report covers every requested client', () => {
      expect(report.total).toStrictEqual(requestedIds.length);
      expect(sortedResultIds(report)).toStrictEqual([...requestedIds].sort((a, b) => a.localeCompare(b)));
    });

    test('Client with an exact callback URL has no findings and passes', () => {
      const result = resultById(report, exactClientId);
      expect(result.findings).toStrictEqual([]);
      expect(result.status).toStrictEqual('pass');
      expect(result.redirectUris).toStrictEqual([EXACT_CALLBACK_URI]);
    });

    test('Client registered as a bare origin reports OCS-001 as a warning', () => {
      const result = resultById(report, bareOriginClientId);
      expect(ruleIdsOf(result)).toStrictEqual(['OCS-001']);
      expect(result.status).toStrictEqual('warning');

      const [finding] = findingsOf(result, 'OCS-001');
      expect(finding.status).toStrictEqual('warning');
      expect(finding.redirectUri).toStrictEqual(BARE_ORIGIN_URI);
      expect(finding.reason.length).toBeGreaterThan(0);
      expect(finding.remediation.length).toBeGreaterThan(0);
    });

    test('Client with a wildcard redirect URI reports OCS-002 as a failure', () => {
      const result = resultById(report, wildcardClientId);
      expect(ruleIdsOf(result)).toStrictEqual(['OCS-002']);
      expect(result.status).toStrictEqual('fail');

      const [finding] = findingsOf(result, 'OCS-002');
      expect(finding.status).toStrictEqual('fail');
      expect(finding.redirectUri).toStrictEqual(WILDCARD_URI);
      expect(finding.reason.length).toBeGreaterThan(0);
      expect(finding.remediation.length).toBeGreaterThan(0);
    });

    test('Client with no redirect URI reports OCS-005 and passes', () => {
      const result = resultById(report, noRedirectUriClientId);
      expect(ruleIdsOf(result)).toStrictEqual(['OCS-005']);
      expect(result.status).toStrictEqual('pass');
      expect(result.redirectUris).toStrictEqual([]);

      const [finding] = findingsOf(result, 'OCS-005');
      expect(finding.status).toStrictEqual('pass');
      expect(finding.redirectUri).toBeUndefined();
      expect(finding.reason.length).toBeGreaterThan(0);
      expect(finding.remediation.length).toBeGreaterThan(0);
    });
  });

  describe('Evaluation options', () => {
    let dangerousClientId: string;
    let dangerousReport: ClientSecurityReport;
    let configuredCollisionId: string;
    let configuredCollisionSecret: string | undefined;
    let legacyConfiguredCollisionId: string;
    let builtInCollisionId: string;
    let discoverableReport: ClientSecurityReport;

    beforeAll(async () => {
      const dangerous = await createTestProject({
        project: { setting: [{ name: DANGEROUS_REDIRECT_SETTING, valueBoolean: true }] },
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });

      // One client carrying a bare origin and an exact callback, in that order.
      const dangerousClient = await withTestContext(() =>
        dangerous.repo.createResource(
          clientFixture('Dangerous Redirect Client', [BARE_ORIGIN_URI, SECOND_EXACT_CALLBACK_URI])
        )
      );
      dangerousClientId = dangerousClient.id;

      const dangerousRes = await readReport(dangerous.project.id, dangerous.accessToken, '?_id=' + dangerousClientId);
      expect(dangerousRes).toHaveStatus(200);
      dangerousReport = reportOf(dangerousRes);

      const discoverable = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });

      const configuredCollision = await withTestContext(() =>
        discoverable.repo.createResource(
          clientFixture('Configured Collision Client', [CONFIGURED_REDIRECT_URI], {
            secret: FIXTURE_SECRET,
          })
        )
      );
      const legacyConfiguredCollision = await withTestContext(() =>
        discoverable.repo.createResource(
          clientFixture('Legacy Configured Collision Client', [LEGACY_CONFIGURED_REDIRECT_URI])
        )
      );
      const builtInCollision = await withTestContext(() =>
        discoverable.repo.createResource(clientFixture('Built In Collision Client', [BUILT_IN_CLI_REDIRECT_URI]))
      );
      configuredCollisionId = configuredCollision.id;
      configuredCollisionSecret = configuredCollision.secret;
      legacyConfiguredCollisionId = legacyConfiguredCollision.id;
      builtInCollisionId = builtInCollision.id;

      const discoverableRes = await readReport(
        discoverable.project.id,
        discoverable.accessToken,
        '?_id=' + [configuredCollisionId, legacyConfiguredCollisionId, builtInCollisionId].join(',')
      );
      expect(discoverableRes).toHaveStatus(200);
      discoverableReport = reportOf(discoverableRes);
    });

    test('Project that allows dangerous redirects reports OCS-003 for every registered URI', () => {
      const result = resultById(dangerousReport, dangerousClientId);
      const prefixFindings = findingsOf(result, 'OCS-003');
      expect(prefixFindings.map((finding) => finding.redirectUri)).toStrictEqual([
        BARE_ORIGIN_URI,
        SECOND_EXACT_CALLBACK_URI,
      ]);
      expect(prefixFindings.map((finding) => finding.status)).toStrictEqual(['fail', 'fail']);
      expect(prefixFindings[0].remediation.length).toBeGreaterThan(0);
    });

    test('Project that allows dangerous redirects escalates the bare origin finding to a failure', () => {
      const result = resultById(dangerousReport, dangerousClientId);
      expect(findingsOf(result, 'OCS-001').map((finding) => finding.status)).toStrictEqual(['fail']);
      expect(result.status).toStrictEqual('fail');
    });

    test('Client sharing a redirect URI with a configured default OAuth client reports OCS-004', () => {
      const result = resultById(discoverableReport, configuredCollisionId);
      expect(ruleIdsOf(result)).toStrictEqual(['OCS-004']);

      const [finding] = findingsOf(result, 'OCS-004');
      expect(finding.status).toStrictEqual('warning');
      expect(finding.redirectUri).toStrictEqual(CONFIGURED_REDIRECT_URI);
      expect(finding.reason).toContain(CONFIG_SOURCE_REASON);
      expect(finding.remediation).toContain(CONFIG_SOURCE_REMEDIATION);
    });

    test('Client sharing the deprecated singular redirect URI of a configured default OAuth client reports OCS-004', () => {
      const result = resultById(discoverableReport, legacyConfiguredCollisionId);
      expect(ruleIdsOf(result)).toStrictEqual(['OCS-004']);
      expect(result.status).toStrictEqual('warning');

      const [finding] = findingsOf(result, 'OCS-004');
      expect(finding.status).toStrictEqual('warning');
      expect(finding.redirectUri).toStrictEqual(LEGACY_CONFIGURED_REDIRECT_URI);
      expect(finding.reason).toContain(CONFIG_SOURCE_REASON);
      expect(finding.reason).not.toContain(BUILT_IN_SOURCE_REASON);
      expect(finding.remediation).toContain(CONFIG_SOURCE_REMEDIATION);
    });

    test('Registration discoverable client that carries a secret stays a warning', () => {
      expect(configuredCollisionSecret).toStrictEqual(FIXTURE_SECRET);

      const result = resultById(discoverableReport, configuredCollisionId);
      expect(result.status).toStrictEqual('warning');
      expect(result.findings.map((finding) => finding.status)).toStrictEqual(['warning']);
    });

    test('Client sharing the built-in CLI redirect URI reports OCS-004', () => {
      const result = resultById(discoverableReport, builtInCollisionId);
      expect(ruleIdsOf(result)).toStrictEqual(['OCS-004']);
      expect(result.status).toStrictEqual('warning');

      const [finding] = findingsOf(result, 'OCS-004');
      expect(finding.status).toStrictEqual('warning');
      expect(finding.redirectUri).toStrictEqual(BUILT_IN_CLI_REDIRECT_URI);
      expect(finding.reason).toContain(BUILT_IN_SOURCE_REASON);
    });

    test('URI registered by both the built-in CLI client and a configured default client reports the built-in source', () => {
      expect(getConfig().defaultOAuthClients?.map((configuredClient) => configuredClient.id)).toStrictEqual([
        CONFIGURED_CLIENT_ID,
        LEGACY_CONFIGURED_CLIENT_ID,
        SHADOWING_CONFIGURED_CLIENT_ID,
      ]);

      const result = resultById(discoverableReport, builtInCollisionId);
      const [finding] = findingsOf(result, 'OCS-004');
      expect(finding.redirectUri).toStrictEqual(BUILT_IN_CLI_REDIRECT_URI);
      expect(finding.reason).toContain(BUILT_IN_SOURCE_REASON);
      expect(finding.reason).not.toContain(CONFIG_SOURCE_REASON);
      expect(finding.remediation).toContain(BUILT_IN_SOURCE_REMEDIATION);
      expect(finding.remediation).not.toContain(CONFIG_SOURCE_REMEDIATION);
    });
  });

  describe('Project setting resolution', () => {
    test('Super admin report uses the allow-dangerous-redirect setting of the target project', async () => {
      const caller = await createTestProject({
        superAdmin: true,
        membership: { admin: true },
        withAccessToken: true,
      });
      expect(caller.project.setting).toBeUndefined();

      const target = await createTestProject({
        project: { setting: [{ name: DANGEROUS_REDIRECT_SETTING, valueBoolean: true }] },
        withRepo: true,
      });
      const targetClient = await withTestContext(() =>
        target.repo.createResource(clientFixture('Target Callback Client', [EXACT_CALLBACK_URI]))
      );

      const res = await readReport(target.project.id, caller.accessToken, '?_id=' + targetClient.id);
      expect(res).toHaveStatus(200);

      const result = resultById(reportOf(res), targetClient.id);
      expect(ruleIdsOf(result)).toStrictEqual(['OCS-003']);
      expect(result.status).toStrictEqual('fail');
    });

    test('Super admin report ignores the allow-dangerous-redirect setting of the caller project', async () => {
      const caller = await createTestProject({
        superAdmin: true,
        membership: { admin: true },
        withAccessToken: true,
        project: { setting: [{ name: DANGEROUS_REDIRECT_SETTING, valueBoolean: true }] },
      });
      const target = await createTestProject({ withRepo: true });
      expect(target.project.setting).toBeUndefined();

      const targetClient = await withTestContext(() =>
        target.repo.createResource(clientFixture('Target Callback Client', [EXACT_CALLBACK_URI]))
      );

      const res = await readReport(target.project.id, caller.accessToken, '?_id=' + targetClient.id);
      expect(res).toHaveStatus(200);

      const result = resultById(reportOf(res), targetClient.id);
      expect(ruleIdsOf(result)).toStrictEqual([]);
      expect(result.status).toStrictEqual('pass');
    });
  });

  describe('Project scoping', () => {
    test('Project admin report contains only clients of their own project', async () => {
      const ownClient = await seedClient(
        projectAdmin.accessToken,
        clientFixture('Alice Callback Client', [EXACT_CALLBACK_URI])
      );
      const other = await createTestProject({ withRepo: true });
      const otherClient = await withTestContext(() =>
        other.repo.createResource(clientFixture('Other Project Client', [EXACT_CALLBACK_URI]))
      );

      const res = await readReport(
        projectAdmin.project.id,
        projectAdmin.accessToken,
        '?_count=' + DEFAULT_MAX_SEARCH_COUNT
      );
      expect(res).toHaveStatus(200);

      const search = await request(app)
        .get('/fhir/R4/ClientApplication?_count=' + DEFAULT_MAX_SEARCH_COUNT + '&_project=' + projectAdmin.project.id)
        .set('Authorization', 'Bearer ' + projectAdmin.accessToken);
      expect(search).toHaveStatus(200);

      const ownProjectClientIds = (search.body.entry ?? [])
        .map((entry: { resource: WithId<ClientApplication> }) => entry.resource.id)
        .sort((a: string, b: string) => a.localeCompare(b));

      expect(sortedResultIds(reportOf(res))).toStrictEqual(ownProjectClientIds);
      expect(sortedResultIds(reportOf(res))).toContain(ownClient.id);
      expect(sortedResultIds(reportOf(res))).not.toContain(otherClient.id);
    });

    test('Project admin naming another project is forbidden', async () => {
      const { project } = await createTestProject();

      const res = await readReport(project.id, projectAdmin.accessToken);
      expect(res).toHaveStatus(403);
      expect(res.body.resourceType).toStrictEqual('OperationOutcome');
      expect(res.body.issue[0].code).toStrictEqual('forbidden');
    });

    test('Client of a linked project that exports ClientApplication is excluded', async () => {
      const linked = await createTestProject({
        project: { exportedResourceType: ['ClientApplication'] },
        withRepo: true,
      });
      const linkedClient = await withTestContext(() =>
        linked.repo.createResource(clientFixture('Linked Project Client', [EXACT_CALLBACK_URI]))
      );

      const caller = await createTestProject({
        project: { link: [{ project: createReference(linked.project) }] },
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });
      const readableByCaller = await withTestContext(() =>
        caller.repo.searchResources<ClientApplication>({
          resourceType: 'ClientApplication',
          count: DEFAULT_MAX_SEARCH_COUNT,
        })
      );
      expect(readableByCaller.map((client) => client.id)).toContain(linkedClient.id);

      const res = await readReport(caller.project.id, caller.accessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
      expect(res).toHaveStatus(200);
      expect(sortedResultIds(reportOf(res))).not.toContain(linkedClient.id);
    });

    test('Super admin report contains only clients of the project named in the URL', async () => {
      const target = await createTestProject({ withClient: true, withRepo: true });
      const targetClient = await withTestContext(() =>
        target.repo.createResource(clientFixture('Super Admin Target Client', [EXACT_CALLBACK_URI]))
      );
      const other = await createTestProject({ withRepo: true });
      const otherClient = await withTestContext(() =>
        other.repo.createResource(clientFixture('Super Admin Other Client', [EXACT_CALLBACK_URI]))
      );
      const superAdminAccessToken = await getSuperAdminAccessToken();

      const res = await readReport(target.project.id, superAdminAccessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
      expect(res).toHaveStatus(200);
      expect(sortedResultIds(reportOf(res))).toStrictEqual(
        [target.client.id, targetClient.id].sort((a, b) => a.localeCompare(b))
      );
      expect(sortedResultIds(reportOf(res))).not.toContain(otherClient.id);
    });
  });

  describe('Access policy bounding', () => {
    test('Report contains every client the caller access policy permits', async () => {
      const permittedName = 'PermittedClient' + randomUUID();
      const caller = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        accessPolicy: {
          resource: [{ resourceType: 'ClientApplication', criteria: 'ClientApplication?name=' + permittedName }],
        },
      });
      expect(caller.accessPolicy.resource).toHaveLength(1);

      const seeder = await addTestUser(caller.project);
      const permitted = await seedClient(seeder.accessToken, clientFixture(permittedName, [EXACT_CALLBACK_URI]));
      const outsidePolicy = await seedClient(
        seeder.accessToken,
        clientFixture('ExcludedClient' + randomUUID(), [EXACT_CALLBACK_URI])
      );

      const res = await readReport(caller.project.id, caller.accessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      expect(sortedResultIds(report)).toStrictEqual([permitted.id]);
      expect(sortedResultIds(report)).not.toContain(outsidePolicy.id);
      expect(report.total).toStrictEqual(1);
      expect(report.returned).toStrictEqual(1);
      expect(report.truncated).toBe(false);
    });

    test('Report is empty when the caller access policy permits no client application', async () => {
      const caller = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        accessPolicy: { resource: [{ resourceType: 'Patient' }] },
      });
      expect(caller.accessPolicy.resource).toHaveLength(1);

      const seeder = await addTestUser(caller.project);
      const unreadable = await seedClient(
        seeder.accessToken,
        clientFixture('PolicyHiddenClient' + randomUUID(), [BARE_ORIGIN_URI])
      );

      const search = await request(app)
        .get('/fhir/R4/ClientApplication')
        .set('Authorization', 'Bearer ' + caller.accessToken);
      expect(search).toHaveStatus(403);

      const res = await readReport(caller.project.id, caller.accessToken);
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      expect(report).toStrictEqual({
        total: 0,
        offset: 0,
        count: DEFAULT_SEARCH_COUNT,
        returned: 0,
        truncated: false,
        results: [],
      });

      const named = await readReport(caller.project.id, caller.accessToken, '?_id=' + unreadable.id);
      expect(named).toHaveStatus(200);
      expect(reportOf(named).results).toStrictEqual([]);

      const deep = await readReport(
        caller.project.id,
        caller.accessToken,
        '?_offset=' + (getConfig().maxSearchOffset + 1)
      );
      expect(deep).toHaveStatus(200);
      expect(reportOf(deep).results).toStrictEqual([]);
      expect(reportOf(deep).offset).toStrictEqual(getConfig().maxSearchOffset + 1);
    });

    test('Super admin report of another project is empty when the caller access policy permits no client application', async () => {
      const target = await createTestProject({ withClient: true });
      const caller = await createTestProject({
        superAdmin: true,
        membership: { admin: true },
        withAccessToken: true,
        accessPolicy: { resource: [{ resourceType: 'Patient' }] },
      });

      const clientSearch = await request(app)
        .get('/fhir/R4/ClientApplication?_count=1')
        .set('Authorization', 'Bearer ' + caller.accessToken);
      expect(clientSearch).toHaveStatus(403);

      const res = await readReport(target.project.id, caller.accessToken);
      expect(res).toHaveStatus(200);
      expect(reportOf(res).results).toStrictEqual([]);
      expect(reportOf(res).total).toStrictEqual(0);
      expect(reportOf(res).returned).toStrictEqual(0);
      expect(sortedResultIds(reportOf(res))).not.toContain(target.client.id);
    });
  });

  describe('Paging', () => {
    let pagingProjectId: string;
    let pagingAccessToken: string;
    let fullIds: string[];

    beforeAll(async () => {
      const paging = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });
      pagingProjectId = paging.project.id;
      pagingAccessToken = paging.accessToken;

      for (const label of ['One', 'Two', 'Three', 'Four', 'Five']) {
        await withTestContext(() =>
          paging.repo.createResource(clientFixture('Paging Client ' + label, [EXACT_CALLBACK_URI]))
        );
      }

      const res = await readReport(pagingProjectId, pagingAccessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
      expect(res).toHaveStatus(200);
      fullIds = sortedResultIds(reportOf(res));
    });

    test('Consecutive pages return disjoint clients and the full total', async () => {
      expect(fullIds.length).toBeGreaterThan(2);

      const first = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=0');
      const second = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=2');
      expect(first).toHaveStatus(200);
      expect(second).toHaveStatus(200);

      const firstReport = reportOf(first);
      const secondReport = reportOf(second);
      expect(firstReport.results).toHaveLength(2);
      expect(secondReport.results).toHaveLength(2);
      expect(firstReport.offset).toStrictEqual(0);
      expect(secondReport.offset).toStrictEqual(2);
      expect(firstReport.count).toStrictEqual(2);
      expect(secondReport.count).toStrictEqual(2);

      const firstIds = sortedResultIds(firstReport);
      const secondIds = sortedResultIds(secondReport);
      expect(firstIds.filter((id) => secondIds.includes(id))).toStrictEqual([]);
      expect(firstReport.total).toStrictEqual(fullIds.length);
      expect(secondReport.total).toStrictEqual(fullIds.length);
    });

    test('Offset beyond the result set returns no clients and the full total', async () => {
      const res = await readReport(pagingProjectId, pagingAccessToken, '?_offset=' + (fullIds.length + 10));
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      expect(report.results).toStrictEqual([]);
      expect(report.total).toStrictEqual(fullIds.length);
      expect(report.returned).toStrictEqual(0);
      expect(report.truncated).toBe(false);
    });

    test('Every page reports the number of clients it served', async () => {
      const seen: string[] = [];
      let offset = 0;
      for (let page = 0; page < fullIds.length + 1; page++) {
        const res = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=' + offset);
        expect(res).toHaveStatus(200);

        const report = reportOf(res);
        expect(report.returned).toStrictEqual(report.results.length);
        expect(report.truncated).toBe(false);
        expect(report.total).toStrictEqual(fullIds.length);
        if (report.returned === 0) {
          break;
        }
        seen.push(...report.results.map((result) => result.id));
        offset += report.returned;
      }

      expect(seen.sort((a, b) => a.localeCompare(b))).toStrictEqual(fullIds);
      expect(new Set(seen).size).toStrictEqual(fullIds.length);
    });

    test('A full page of clients can have its statuses requested in one _id list', async () => {
      const page = await readReport(pagingProjectId, pagingAccessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
      expect(page).toHaveStatus(200);

      const pageReport = reportOf(page);
      expect(pageReport.count).toStrictEqual(MAX_REPORT_CLIENTS_PER_REQUEST);
      expect(pageReport.returned).toStrictEqual(fullIds.length);

      const pageIds = pageReport.results.map((result) => result.id);
      const fullPageOfIds = [
        ...pageIds,
        ...Array.from({ length: MAX_REPORT_CLIENTS_PER_REQUEST - pageIds.length }, () => randomUUID()),
      ];
      expect(fullPageOfIds).toHaveLength(MAX_REPORT_CLIENTS_PER_REQUEST);

      const byId = await readReport(pagingProjectId, pagingAccessToken, '?_id=' + fullPageOfIds.join(','));
      expect(byId).toHaveStatus(200);
      expect(sortedResultIds(reportOf(byId))).toStrictEqual(fullIds);
    });

    test('Offset above the configured repository offset ceiling returns no clients and the full total', async () => {
      const maxSearchOffset = getConfig().maxSearchOffset;
      expect(maxSearchOffset).toBeGreaterThan(0);

      const res = await readReport(pagingProjectId, pagingAccessToken, '?_offset=' + (maxSearchOffset + 1));
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      expect(report.results).toStrictEqual([]);
      expect(report.offset).toStrictEqual(maxSearchOffset + 1);
      expect(report.count).toStrictEqual(DEFAULT_SEARCH_COUNT);
      expect(report.total).toStrictEqual(fullIds.length);
    });

    test('Offset above the safe integer ceiling returns no clients and the full total', async () => {
      const res = await readReport(pagingProjectId, pagingAccessToken, '?_offset=' + ABOVE_SAFE_INTEGER_VALUE);
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      expect(report.results).toStrictEqual([]);
      expect(report.offset).toStrictEqual(Number(ABOVE_SAFE_INTEGER_VALUE));
      expect(report.total).toStrictEqual(fullIds.length);
    });

    test('Page at the repository offset ceiling is returned and a page within the result set past it is refused', async () => {
      const previousMaxSearchOffset = getConfig().maxSearchOffset;
      getConfig().maxSearchOffset = 2;
      try {
        const atCeiling = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=2');
        expect(atCeiling).toHaveStatus(200);

        const report = reportOf(atCeiling);
        expect(report.offset).toStrictEqual(2);
        expect(report.count).toStrictEqual(2);
        expect(report.total).toStrictEqual(fullIds.length);
        expect(report.results).toHaveLength(2);

        const withinResultSet = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=3');
        expect(withinResultSet).toHaveStatus(400);
        expect(withinResultSet.body.resourceType).toStrictEqual('OperationOutcome');
        expect(withinResultSet.body.issue[0].code).toStrictEqual('invalid');
        expect(withinResultSet.body.issue[0].details.text).toStrictEqual(
          '_offset search parameter exceeds the maximum supported offset of 2; request an offset of at most 2, or name up to ' +
            MAX_REPORT_CLIENTS_PER_REQUEST +
            ' client ids with _id'
        );
        expect(withinResultSet.body.results).toBeUndefined();

        const namedBeyondCeiling = await readReport(pagingProjectId, pagingAccessToken, '?_id=' + fullIds.join(','));
        expect(namedBeyondCeiling).toHaveStatus(200);
        expect(sortedResultIds(reportOf(namedBeyondCeiling))).toStrictEqual(fullIds);

        const beyondResultSet = await readReport(
          pagingProjectId,
          pagingAccessToken,
          '?_count=2&_offset=' + fullIds.length
        );
        expect(beyondResultSet).toHaveStatus(200);

        const beyondReport = reportOf(beyondResultSet);
        expect(beyondReport.results).toStrictEqual([]);
        expect(beyondReport.offset).toStrictEqual(fullIds.length);
        expect(beyondReport.total).toStrictEqual(fullIds.length);
      } finally {
        getConfig().maxSearchOffset = previousMaxSearchOffset;
      }
    });
  });

  describe('Query parameter validation', () => {
    let validationProjectId: string;
    let validationAccessToken: string;
    let allIds: string[];

    beforeAll(async () => {
      const validation = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });
      validationProjectId = validation.project.id;
      validationAccessToken = validation.accessToken;

      await withTestContext(() =>
        validation.repo.createResource(clientFixture('Validation Client One', [EXACT_CALLBACK_URI]))
      );
      await withTestContext(() =>
        validation.repo.createResource(clientFixture('Validation Client Two', [SECOND_EXACT_CALLBACK_URI]))
      );

      const res = await readReport(validationProjectId, validationAccessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
      expect(res).toHaveStatus(200);
      allIds = sortedResultIds(reportOf(res));
    });

    test.each(validationCases)('$name', async ({ query, status, outcome, count, offset, total, unfiltered }) => {
      const res = await readReport(validationProjectId, validationAccessToken, query);
      expect(res).toHaveStatus(status);

      if (status === 400) {
        expect(res.body.resourceType).toStrictEqual('OperationOutcome');
        expect(res.body.issue[0].code).toStrictEqual('invalid');
        expect(res.body.issue[0].details.text).toStrictEqual(outcome);
        expect(res.body.results).toBeUndefined();
      }
      if (status === 200) {
        const report = reportOf(res);
        expect(report.returned).toStrictEqual(report.results.length);
        expect(report.truncated).toBe(false);
      }
      if (count !== undefined) {
        expect(reportOf(res).count).toStrictEqual(count);
      }
      if (offset !== undefined) {
        expect(reportOf(res).offset).toStrictEqual(offset);
      }
      if (total !== undefined) {
        expect(reportOf(res).total).toStrictEqual(total);
      }
      if (unfiltered) {
        expect(sortedResultIds(reportOf(res))).toStrictEqual(allIds);
      }
    });
  });

  describe('Project id path validation', () => {
    const malformedProjectIds = [
      { shape: 'text', projectId: 'not-a-uuid' },
      { shape: 'a comma separated list', projectId: randomUUID() + ',' + randomUUID() },
      { shape: 'a NUL encoded value', projectId: randomUUID() + '%00' },
      { shape: 'a traversal like value', projectId: '%2e%2e%2fsuper' },
    ];

    let superAdminCallerAccessToken: string;
    let superAdminCallerClientId: string;
    let otherProjectClientId: string;

    beforeAll(async () => {
      const caller = await createTestProject({
        superAdmin: true,
        membership: { admin: true },
        withClient: true,
        withAccessToken: true,
      });
      superAdminCallerAccessToken = caller.accessToken;
      superAdminCallerClientId = caller.client.id;

      const other = await createTestProject({ withRepo: true });
      const otherClient = await withTestContext(() =>
        other.repo.createResource(clientFixture('Path Validation Other Project Client', [EXACT_CALLBACK_URI]))
      );
      otherProjectClientId = otherClient.id;
    });

    test.each(malformedProjectIds)(
      'Super admin naming a project id of $shape receives the report for their own project',
      async ({ projectId }) => {
        const res = await readReport(projectId, superAdminCallerAccessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
        expect(res).toHaveStatus(200);

        const ids = sortedResultIds(reportOf(res));
        expect(ids).toStrictEqual([superAdminCallerClientId]);
        expect(ids).not.toContain(otherProjectClientId);
      }
    );

    test.each(malformedProjectIds)(
      'Project admin naming a project id of $shape is forbidden',
      async ({ projectId }) => {
        const res = await readReport(projectId, projectAdmin.accessToken);
        expect(res).toHaveStatus(403);
        expect(res.body.resourceType).toStrictEqual('OperationOutcome');
        expect(res.body.issue[0].code).toStrictEqual('forbidden');
        expect(res.body.results).toBeUndefined();
      }
    );

    test('Super admin naming a project id that does not exist receives no report', async () => {
      const superAdminAccessToken = await getSuperAdminAccessToken();

      const res = await readReport(randomUUID(), superAdminAccessToken);
      expect(res).toHaveStatus(404);
      expect(res.body.resourceType).toStrictEqual('OperationOutcome');
      expect(res.body.results).toBeUndefined();
    });

    test('Super admin naming a project id that does not exist receives no report above the offset ceiling', async () => {
      const superAdminAccessToken = await getSuperAdminAccessToken();

      const res = await readReport(
        randomUUID(),
        superAdminAccessToken,
        '?_offset=' + (getConfig().maxSearchOffset + 1)
      );
      expect(res).toHaveStatus(404);
      expect(res.body.resourceType).toStrictEqual('OperationOutcome');
      expect(res.body.results).toBeUndefined();
    });
  });

  describe('Query parameter whitelist', () => {
    test('Unsupported query parameters do not change the result set', async () => {
      const caller = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });
      await withTestContext(() => caller.repo.createResource(clientFixture('Whitelist Client', [EXACT_CALLBACK_URI])));
      const other = await createTestProject({ withRepo: true });
      const otherClient = await withTestContext(() =>
        other.repo.createResource(clientFixture('Whitelist Other Project Client', [EXACT_CALLBACK_URI]))
      );

      const plain = await readReport(caller.project.id, caller.accessToken, '?_count=' + DEFAULT_MAX_SEARCH_COUNT);
      const decorated = await readReport(
        caller.project.id,
        caller.accessToken,
        '?_count=' +
          DEFAULT_MAX_SEARCH_COUNT +
          '&_include=ClientApplication:*&_summary=count&_project=' +
          other.project.id +
          '&name=Nonexistent'
      );
      expect(plain).toHaveStatus(200);
      expect(decorated).toHaveStatus(200);

      expect(sortedResultIds(reportOf(decorated))).toStrictEqual(sortedResultIds(reportOf(plain)));
      expect(reportOf(decorated).total).toStrictEqual(reportOf(plain).total);
      expect(sortedResultIds(reportOf(decorated))).not.toContain(otherClient.id);
    });
  });

  describe('Complete evaluation and response ceiling', () => {
    /** The number of redirect URIs the flagged client registers, the last of which is `WILDCARD_URI`. */
    const FLAGGED_URI_COUNT = 25;

    /** The maximum serialized response size the endpoint applies, in UTF-8 bytes. */
    const MAX_REPORT_RESPONSE_BYTES = 4 * 1024 * 1024;

    /** The character length of each redirect URI the large fixtures register. */
    const LARGE_URI_LENGTH = 2400;

    /** The number of redirect URIs a client registers to report under the ceiling on its own but not in pairs. */
    const HALF_CEILING_URI_COUNT = 300;

    /** The number of redirect URIs a client registers to report over the ceiling on its own. */
    const OVER_CEILING_URI_COUNT = 600;

    /** The number of redirect URIs a client registers to exceed the ceiling before any finding is added. */
    const BASE_OVER_CEILING_URI_COUNT = 2000;

    let ceilingProjectId: string;
    let ceilingAccessToken: string;
    let flaggedClientId: string;
    let flaggedUris: string[];
    let firstHalfCeilingClientId: string;
    let secondHalfCeilingClientId: string;
    let overCeilingClientId: string;
    let baseOverCeilingClientId: string;
    let smallClientId: string;

    beforeAll(async () => {
      const ceiling = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });
      ceilingProjectId = ceiling.project.id;
      ceilingAccessToken = ceiling.accessToken;

      flaggedUris = [
        ...Array.from({ length: FLAGGED_URI_COUNT - 1 }, (_, index) => 'https://app' + index + '.example.com'),
        WILDCARD_URI,
      ];
      const largeUris = (count: number): string[] =>
        Array.from({ length: count }, (_, index) => {
          const prefix = 'https://app' + index + '.example.com/?next=';
          return prefix + 'a'.repeat(LARGE_URI_LENGTH - prefix.length - 1) + '*';
        });

      const flagged = await withTestContext(() =>
        ceiling.repo.createResource(clientFixture('Flagged Redirect URI Client', flaggedUris))
      );
      const firstHalfCeiling = await withTestContext(() =>
        ceiling.repo.createResource(clientFixture('First Half Ceiling Client', largeUris(HALF_CEILING_URI_COUNT)))
      );
      const secondHalfCeiling = await withTestContext(() =>
        ceiling.repo.createResource(clientFixture('Second Half Ceiling Client', largeUris(HALF_CEILING_URI_COUNT)))
      );
      const overCeiling = await withTestContext(() =>
        ceiling.repo.createResource(clientFixture('Over Ceiling Client', largeUris(OVER_CEILING_URI_COUNT)))
      );
      const baseOverCeiling = await withTestContext(() =>
        ceiling.repo.createResource(
          clientFixture(
            'Base Over Ceiling Client',
            Array.from({ length: BASE_OVER_CEILING_URI_COUNT }, (_, index) => {
              const prefix = 'https://base' + index + '.example.com/callback/';
              return prefix + 'a'.repeat(LARGE_URI_LENGTH - prefix.length);
            })
          )
        )
      );
      const small = await withTestContext(() =>
        ceiling.repo.createResource(clientFixture('Small Ceiling Client', [EXACT_CALLBACK_URI]))
      );

      flaggedClientId = flagged.id;
      firstHalfCeilingClientId = firstHalfCeiling.id;
      secondHalfCeilingClientId = secondHalfCeiling.id;
      overCeilingClientId = overCeiling.id;
      baseOverCeilingClientId = baseOverCeiling.id;
      smallClientId = small.id;
    });

    test('Client registering twenty-five redirect URIs is evaluated in full', async () => {
      const res = await readReport(ceilingProjectId, ceilingAccessToken, '?_id=' + flaggedClientId);
      expect(res).toHaveStatus(200);

      const result = resultById(reportOf(res), flaggedClientId);
      expect(result.redirectUris).toStrictEqual(flaggedUris);
      expect(findingsOf(result, 'OCS-001')).toHaveLength(FLAGGED_URI_COUNT - 1);
      expect(findingsOf(result, 'OCS-002')).toHaveLength(1);
      expect(findingsOf(result, 'OCS-002')[0].redirectUri).toStrictEqual(WILDCARD_URI);
      expect(ruleIdsOf(result)).toHaveLength(FLAGGED_URI_COUNT);
      expect(result.status).toStrictEqual('fail');
      expect(JSON.stringify(res.body)).not.toContain('OCS-006');
      expect(Object.keys(result).sort((a, b) => a.localeCompare(b))).toStrictEqual([
        'findings',
        'id',
        'name',
        'redirectUris',
        'status',
      ]);
    });

    test('Page stops at the serialized byte ceiling and leaves every client reachable', async () => {
      const res = await readReport(
        ceilingProjectId,
        ceilingAccessToken,
        '?_count=2&_id=' + firstHalfCeilingClientId + ',' + secondHalfCeilingClientId
      );
      expect(res).toHaveStatus(200);
      expect(Buffer.byteLength(JSON.stringify(res.body), 'utf8')).toBeLessThanOrEqual(MAX_REPORT_RESPONSE_BYTES);

      const report = reportOf(res);
      expect(report.total).toStrictEqual(2);
      expect(report.count).toStrictEqual(2);
      expect(report.returned).toStrictEqual(1);
      expect(report.truncated).toBe(true);
      expect(report.results).toHaveLength(1);
      expect([firstHalfCeilingClientId, secondHalfCeilingClientId]).toContain(report.results[0].id);
      expect(report.results[0].redirectUris).toHaveLength(HALF_CEILING_URI_COUNT);
      expect(report.results[0].findings).toHaveLength(HALF_CEILING_URI_COUNT * 2);
      expect(report.results[0].omittedFindings).toBeUndefined();

      const omittedClientId =
        report.results[0].id === firstHalfCeilingClientId ? secondHalfCeilingClientId : firstHalfCeilingClientId;
      const omitted = await readReport(ceilingProjectId, ceilingAccessToken, '?_id=' + omittedClientId);
      expect(omitted).toHaveStatus(200);

      const omittedResult = resultById(reportOf(omitted), omittedClientId);
      expect(omittedResult.redirectUris).toHaveLength(HALF_CEILING_URI_COUNT);
      expect(omittedResult.findings).toHaveLength(HALF_CEILING_URI_COUNT * 2);

      const small = await readReport(ceilingProjectId, ceilingAccessToken, '?_id=' + smallClientId);
      expect(small).toHaveStatus(200);
      expect(resultById(reportOf(small), smallClientId).redirectUris).toStrictEqual([EXACT_CALLBACK_URI]);
    });

    test('Client whose findings exceed the ceiling is reported with the findings that fit', async () => {
      const res = await readReport(ceilingProjectId, ceilingAccessToken, '?_id=' + overCeilingClientId);
      expect(res).toHaveStatus(200);
      expect(Buffer.byteLength(JSON.stringify(res.body), 'utf8')).toBeLessThanOrEqual(MAX_REPORT_RESPONSE_BYTES);

      const report = reportOf(res);
      expect(report.total).toStrictEqual(1);
      expect(report.returned).toStrictEqual(1);
      expect(report.truncated).toBe(true);

      const result = resultById(report, overCeilingClientId);
      expect(result.redirectUris).toHaveLength(OVER_CEILING_URI_COUNT);
      expect(result.status).toStrictEqual('fail');
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings.length).toBeLessThan(OVER_CEILING_URI_COUNT * 2);
      expect(result.omittedFindings).toStrictEqual(OVER_CEILING_URI_COUNT * 2 - result.findings.length);
      expect(Object.keys(result).sort((a, b) => a.localeCompare(b))).toStrictEqual([
        'findings',
        'id',
        'name',
        'omittedFindings',
        'redirectUris',
        'status',
      ]);

      const others = await readReport(
        ceilingProjectId,
        ceilingAccessToken,
        '?_id=' + firstHalfCeilingClientId + ',' + smallClientId
      );
      expect(others).toHaveStatus(200);
      expect(sortedResultIds(reportOf(others))).toStrictEqual(
        [firstHalfCeilingClientId, smallClientId].sort((a, b) => a.localeCompare(b))
      );
    });

    test('Client whose identity fields alone exceed the ceiling is refused with the offset to continue from', async () => {
      const res = await readReport(ceilingProjectId, ceilingAccessToken, '?_id=' + baseOverCeilingClientId);
      expect(res).toHaveStatus(413);
      expect(Buffer.byteLength(JSON.stringify(res.body), 'utf8')).toBeLessThanOrEqual(MAX_REPORT_RESPONSE_BYTES);
      expect(res.body.resourceType).toStrictEqual('OperationOutcome');
      expect(res.body.issue[0].code).toStrictEqual('too-long');
      expect(res.body.issue[0].details.text).toStrictEqual(
        'OAuth client security report for client ' +
          baseOverCeilingClientId +
          ' at offset 0 exceeds the maximum response size of ' +
          MAX_REPORT_RESPONSE_BYTES +
          ' bytes; request the next page from offset 1'
      );
      expect(res.body.results).toBeUndefined();
    });

    test('Paging by the served count reaches every client of the project', async () => {
      const search = await request(app)
        .get('/fhir/R4/ClientApplication?_count=100')
        .set('Authorization', 'Bearer ' + ceilingAccessToken);
      expect(search).toHaveStatus(200);

      const projectClientIds = (search.body.entry ?? [])
        .map((entry: { resource: WithId<ClientApplication> }) => entry.resource.id)
        .filter((id: string) => id !== baseOverCeilingClientId)
        .sort((a: string, b: string) => a.localeCompare(b));
      expect(projectClientIds).toContain(overCeilingClientId);
      expect(projectClientIds).toContain(smallClientId);

      const seen: string[] = [];
      const refusedOffsets: number[] = [];
      let offset = 0;
      for (let page = 0; page < projectClientIds.length + 5; page++) {
        const res = await readReport(ceilingProjectId, ceilingAccessToken, '?_count=3&_offset=' + offset);
        if (res.status === 413) {
          expect(res.body.issue[0].details.text).toContain('at offset ' + offset);
          expect(res.body.issue[0].details.text).toContain('request the next page from offset ' + (offset + 1));
          refusedOffsets.push(offset);
          offset += 1;
          continue;
        }
        expect(res).toHaveStatus(200);
        expect(Buffer.byteLength(JSON.stringify(res.body), 'utf8')).toBeLessThanOrEqual(MAX_REPORT_RESPONSE_BYTES);

        const report = reportOf(res);
        expect(report.returned).toStrictEqual(report.results.length);
        if (report.returned === 0) {
          break;
        }
        seen.push(...report.results.map((result) => result.id));
        offset += report.returned;
      }

      expect(refusedOffsets).toHaveLength(1);
      expect(seen).toHaveLength(new Set(seen).size);
      expect(seen.sort((a, b) => a.localeCompare(b))).toStrictEqual(projectClientIds);
    });
  });

  describe('Unevaluable redirect URI configuration', () => {
    let unevaluableProjectId: string;
    let unevaluableAccessToken: string;
    let poisonedClientId: string;
    let poisonedStoredRedirectUris: unknown;
    let healthyClientId: string;
    let spoofedClientId: string;
    let cleanClientId: string;

    beforeAll(async () => {
      const unevaluable = await createTestProject({
        project: { strictMode: false },
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });
      unevaluableProjectId = unevaluable.project.id;
      unevaluableAccessToken = unevaluable.accessToken;

      const member = await addTestUser(unevaluable.project);
      const poisoned = await seedClient(
        member.accessToken,
        clientFixture('PoisonedClient' + randomUUID(), [MEMBER_CALLBACK_URI, ''])
      );
      const healthy = await seedClient(
        member.accessToken,
        clientFixture('HealthyClient' + randomUUID(), [BARE_ORIGIN_URI])
      );
      const spoofed = await seedClient(
        member.accessToken,
        clientFixture('SpoofedOriginClient' + randomUUID(), [BIDI_BARE_ORIGIN_URI])
      );
      const clean = await seedClient(
        member.accessToken,
        clientFixture('CleanOriginClient' + randomUUID(), [CLEAN_BARE_ORIGIN_URI])
      );

      poisonedClientId = poisoned.id;
      poisonedStoredRedirectUris = poisoned.redirectUris;
      healthyClientId = healthy.id;
      spoofedClientId = spoofed.id;
      cleanClientId = clean.id;
    });

    test('Non-admin member stores a null redirect URI element in a project without strict validation', () => {
      expect(poisonedStoredRedirectUris).toStrictEqual([MEMBER_CALLBACK_URI, null]);
    });

    test('Report of the whole project covers a client whose redirect URI list holds a null element', async () => {
      const res = await readReport(unevaluableProjectId, unevaluableAccessToken);
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      const poisonedResult = resultById(report, poisonedClientId);
      expect(ruleIdsOf(poisonedResult)).toStrictEqual(['OCS-006']);
      expect(poisonedResult.status).toStrictEqual('warning');
      expect(poisonedResult.redirectUris).toStrictEqual([MEMBER_CALLBACK_URI]);

      const [finding] = findingsOf(poisonedResult, 'OCS-006');
      expect(finding.status).toStrictEqual('warning');
      expect(finding.redirectUri).toBeUndefined();
      expect(finding.reason.length).toBeGreaterThan(0);
      expect(finding.remediation.length).toBeGreaterThan(0);

      const healthyResult = resultById(report, healthyClientId);
      expect(ruleIdsOf(healthyResult)).toStrictEqual(['OCS-001']);
      expect(healthyResult.status).toStrictEqual('warning');
      expect(healthyResult.redirectUris).toStrictEqual([BARE_ORIGIN_URI]);
      expect(report.returned).toStrictEqual(report.results.length);
    });

    test('Report warns about a bare origin whose host carries a right-to-left override', async () => {
      const res = await readReport(
        unevaluableProjectId,
        unevaluableAccessToken,
        '?_id=' + [spoofedClientId, cleanClientId].join(',')
      );
      expect(res).toHaveStatus(200);

      const report = reportOf(res);
      const spoofedResult = resultById(report, spoofedClientId);
      expect(ruleIdsOf(spoofedResult)).toStrictEqual(['OCS-006']);
      expect(spoofedResult.status).toStrictEqual('warning');
      expect(spoofedResult.redirectUris).toStrictEqual([BIDI_BARE_ORIGIN_URI]);
      expect(findingsOf(spoofedResult, 'OCS-006')[0].redirectUri).toStrictEqual(BIDI_BARE_ORIGIN_URI);

      const cleanResult = resultById(report, cleanClientId);
      expect(ruleIdsOf(cleanResult)).toStrictEqual(['OCS-001']);
      expect(cleanResult.status).toStrictEqual('warning');
      expect(findingsOf(cleanResult, 'OCS-001')[0].redirectUri).toStrictEqual(CLEAN_BARE_ORIGIN_URI);
    });
  });

  describe('Payload hygiene', () => {
    let hygieneProjectId: string;
    let hygieneAccessToken: string;
    let secretBearingClientId: string;
    let secretBearingVersionId: string | undefined;

    beforeAll(async () => {
      const hygiene = await createTestProject({
        membership: { admin: true },
        withAccessToken: true,
        withRepo: true,
      });
      hygieneProjectId = hygiene.project.id;
      hygieneAccessToken = hygiene.accessToken;

      const secretBearing = await withTestContext(() =>
        hygiene.repo.createResource(
          clientFixture('Secret Bearing Client', [EXACT_CALLBACK_URI], {
            secret: FIXTURE_SECRET,
            retiringSecret: FIXTURE_RETIRING_SECRET,
          })
        )
      );
      secretBearingClientId = secretBearing.id;
      secretBearingVersionId = secretBearing.meta?.versionId;
      expect(secretBearing.secret).toStrictEqual(FIXTURE_SECRET);
      expect(secretBearing.retiringSecret).toStrictEqual(FIXTURE_RETIRING_SECRET);
    });

    test('Report contains no client secret material', async () => {
      const res = await readReport(hygieneProjectId, hygieneAccessToken, '?_id=' + secretBearingClientId);
      expect(res).toHaveStatus(200);

      const result = resultById(reportOf(res), secretBearingClientId);
      expect(result.redirectUris).toStrictEqual([EXACT_CALLBACK_URI]);
      expect(Object.keys(result).sort((a, b) => a.localeCompare(b))).toStrictEqual([
        'findings',
        'id',
        'name',
        'redirectUris',
        'status',
      ]);

      const serializedReport = JSON.stringify(res.body);
      expect(serializedReport).not.toContain(FIXTURE_SECRET);
      expect(serializedReport).not.toContain(FIXTURE_RETIRING_SECRET);
    });

    test('Report leaves the client application unchanged', async () => {
      const res = await readReport(hygieneProjectId, hygieneAccessToken, '?_id=' + secretBearingClientId);
      expect(res).toHaveStatus(200);

      const reread = await request(app)
        .get('/fhir/R4/ClientApplication/' + secretBearingClientId)
        .set('Authorization', 'Bearer ' + hygieneAccessToken);
      expect(reread).toHaveStatus(200);
      expect(reread.body.meta.versionId).toStrictEqual(secretBearingVersionId);
    });
  });
});
