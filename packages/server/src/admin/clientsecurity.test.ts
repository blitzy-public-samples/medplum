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

const DANGEROUS_REDIRECT_SETTING = 'allow-dangerous-redirect';

const CONFIG_SOURCE_REASON = 'configured default OAuth client list';
const CONFIG_SOURCE_REMEDIATION = 'default OAuth client configuration';
const BUILT_IN_SOURCE_REASON = 'built-in Medplum CLI client';
const BUILT_IN_SOURCE_REMEDIATION = 'The built-in client cannot be removed by configuration.';

const FIXTURE_SECRET = 'redacted-fixture-client-secret';
const FIXTURE_RETIRING_SECRET = 'redacted-fixture-retiring-secret';

interface ClientSecurityReport {
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly results: OAuthClientLintResult[];
}

interface ValidationCase {
  readonly name: string;
  readonly query: string;
  readonly status: number;
  /** The `OperationOutcome` detail text a refused request must carry. Required of every 400 case. */
  readonly outcome?: string;
  readonly count?: number;
  readonly offset?: number;
  readonly unfiltered?: boolean;
}

const INVALID_PROJECT_ID_OUTCOME = 'Invalid project id';
const INVALID_ID_OUTCOME = 'Invalid _id search parameter';
const INVALID_COUNT_OUTCOME = 'Invalid _count search parameter';
const INVALID_OFFSET_OUTCOME = 'Invalid _offset search parameter';
const OVER_LENGTH_ID_OUTCOME = '_id search parameter exceeds maximum of ' + DEFAULT_MAX_SEARCH_COUNT + ' client ids';

const REPEATED_COUNT_QUERY = '?_count=5&_count=6';
const REPEATED_OFFSET_QUERY = '?_offset=1&_offset=2';
const REPEATED_ID_QUERY = '?_id=' + randomUUID() + '&_id=' + randomUUID();
const MIXED_ID_QUERY = '?_id=' + [randomUUID(), 'not-a-uuid', randomUUID()].join(',');
const OVER_LENGTH_ID_LIST_QUERY = '?_id=' + Array.from({ length: DEFAULT_MAX_SEARCH_COUNT + 1 }, () => 'x').join(',');

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
    name: 'Oversized _count is clamped to the maximum search count',
    query: '?_count=' + (DEFAULT_MAX_SEARCH_COUNT + 1),
    status: 200,
    count: DEFAULT_MAX_SEARCH_COUNT,
  },
  {
    name: 'A _count above the safe integer ceiling is clamped to the maximum search count',
    query: '?_count=' + ABOVE_SAFE_INTEGER_VALUE,
    status: 200,
    count: DEFAULT_MAX_SEARCH_COUNT,
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
    name: 'An _id list longer than the maximum search count is rejected',
    query: OVER_LENGTH_ID_LIST_QUERY,
    status: 400,
    outcome: OVER_LENGTH_ID_OUTCOME,
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

function resultById(report: ClientSecurityReport, clientId: string): OAuthClientLintResult {
  const result = report.results.find((candidate) => candidate.id === clientId);
  expect(result).toBeDefined();
  return result as OAuthClientLintResult;
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
    });

    test('Offset above the configured repository offset ceiling is refused', async () => {
      const maxSearchOffset = getConfig().maxSearchOffset;
      expect(maxSearchOffset).toBeGreaterThan(0);

      const res = await readReport(pagingProjectId, pagingAccessToken, '?_offset=' + (maxSearchOffset + 1));
      expect(res).toHaveStatus(400);
      expect(res.body.resourceType).toStrictEqual('OperationOutcome');
      expect(res.body.issue[0].code).toStrictEqual('invalid');
      expect(res.body.issue[0].details.text).toStrictEqual(
        'Search offset exceeds maximum (got ' + (maxSearchOffset + 1) + ', max ' + maxSearchOffset + ')'
      );
      expect(res.body.results).toBeUndefined();
    });

    test('Offset above the safe integer ceiling is refused by the repository offset ceiling', async () => {
      const maxSearchOffset = getConfig().maxSearchOffset;

      const res = await readReport(pagingProjectId, pagingAccessToken, '?_offset=' + ABOVE_SAFE_INTEGER_VALUE);
      expect(res).toHaveStatus(400);
      expect(res.body.issue[0].details.text).toStrictEqual(
        'Search offset exceeds maximum (got ' + ABOVE_SAFE_INTEGER_VALUE + ', max ' + maxSearchOffset + ')'
      );
      expect(res.body.results).toBeUndefined();
    });

    test('Page at the repository offset ceiling is returned and the page past it is refused', async () => {
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

        const pastCeiling = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=3');
        expect(pastCeiling).toHaveStatus(400);
        expect(pastCeiling.body.issue[0].details.text).toStrictEqual('Search offset exceeds maximum (got 3, max 2)');
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

    test.each(validationCases)('$name', async ({ query, status, outcome, count, offset, unfiltered }) => {
      const res = await readReport(validationProjectId, validationAccessToken, query);
      expect(res).toHaveStatus(status);

      if (status === 400) {
        expect(res.body.resourceType).toStrictEqual('OperationOutcome');
        expect(res.body.issue[0].code).toStrictEqual('invalid');
        expect(res.body.issue[0].details.text).toStrictEqual(outcome);
        expect(res.body.results).toBeUndefined();
      }
      if (count !== undefined) {
        expect(reportOf(res).count).toStrictEqual(count);
      }
      if (offset !== undefined) {
        expect(reportOf(res).offset).toStrictEqual(offset);
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

    test.each(malformedProjectIds)('Super admin naming a project id of $shape is refused', async ({ projectId }) => {
      const superAdminAccessToken = await getSuperAdminAccessToken();

      const res = await readReport(projectId, superAdminAccessToken);
      expect(res).toHaveStatus(400);
      expect(res.body.resourceType).toStrictEqual('OperationOutcome');
      expect(res.body.issue[0].code).toStrictEqual('invalid');
      expect(res.body.issue[0].details.text).toStrictEqual(INVALID_PROJECT_ID_OUTCOME);
      expect(res.body.results).toBeUndefined();
    });

    test.each(malformedProjectIds)('Project admin naming a project id of $shape is refused', async ({ projectId }) => {
      const res = await readReport(projectId, projectAdmin.accessToken);
      expect(res).toHaveStatus(400);
      expect(res.body.issue[0].code).toStrictEqual('invalid');
      expect(res.body.issue[0].details.text).toStrictEqual(INVALID_PROJECT_ID_OUTCOME);
      expect(res.body.results).toBeUndefined();
    });

    test('Super admin naming a project id that does not exist receives no report', async () => {
      const superAdminAccessToken = await getSuperAdminAccessToken();

      const res = await readReport(randomUUID(), superAdminAccessToken);
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
