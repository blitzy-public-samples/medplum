// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { SearchRequest, WithId } from '@medplum/core';
import { createReference, DEFAULT_MAX_SEARCH_COUNT, DEFAULT_SEARCH_COUNT, Operator } from '@medplum/core';
import type { Bundle, ClientApplication } from '@medplum/fhirtypes';
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
import type { ClientApplicationSearch } from './clientsecurity';
import { collectPageByCursor, parseClientIdsParam } from './clientsecurity';

const app = express();

/** The first entry configured in `defaultOAuthClients` for this suite, carrying a `redirectUris` list. */
const CONFIGURED_CLIENT_ID = 'oauth-security-default-client';
const CONFIGURED_REDIRECT_URI = 'https://configured.example.com/callback';

/** The second configured entry, carrying only the deprecated singular `redirectUri`. */
const LEGACY_CONFIGURED_CLIENT_ID = 'oauth-security-legacy-default-client';
const LEGACY_CONFIGURED_REDIRECT_URI = 'https://legacy-configured.example.com/callback';

/** The third configured entry, which registers the built-in Medplum CLI redirect URI. */
const SHADOWING_CONFIGURED_CLIENT_ID = 'oauth-security-shadowing-default-client';

/** The redirect URI of the server's built-in Medplum CLI client. */
const BUILT_IN_CLI_REDIRECT_URI = 'http://localhost:9615';

const EXACT_CALLBACK_URI = 'https://app.example.com/oauth/callback';
const SECOND_EXACT_CALLBACK_URI = 'https://app.example.com/other/callback';
const BARE_ORIGIN_URI = 'https://app.example.com';
const WILDCARD_URI = 'https://app.example.com/*';

const DANGEROUS_REDIRECT_SETTING = 'allow-dangerous-redirect';

/** Fragments that distinguish the two OCS-004 copy variants the endpoint returns. */
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
  /** True when the response must carry an empty `results` array. */
  readonly emptyResults?: boolean;
  /** True when the response `total` must equal the number of clients in the project. */
  readonly fullTotal?: boolean;
}

/** The detail text of each refusal the endpoint produces. */
const INVALID_ID_OUTCOME = 'Invalid _id search parameter';
const INVALID_COUNT_OUTCOME = 'Invalid _count search parameter';
const INVALID_OFFSET_OUTCOME = 'Invalid _offset search parameter';

const REPEATED_COUNT_QUERY = '?_count=5&_count=6';
const REPEATED_OFFSET_QUERY = '?_offset=1&_offset=2';
const REPEATED_ID_QUERY = '?_id=' + randomUUID() + '&_id=' + randomUUID();

/** A long `_id` list of malformed values. The list length cap is covered through the parser seam. */
const MALFORMED_ID_LIST_QUERY = '?_id=' + Array.from({ length: DEFAULT_MAX_SEARCH_COUNT + 1 }, () => 'x').join(',');

/** An unsigned integer above `Number.MAX_SAFE_INTEGER`, which the paging contract still accepts. */
const ABOVE_SAFE_INTEGER_VALUE = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();

/** An unsigned integer too large to parse as a finite number. */
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
    name: 'An _offset above the safe integer ceiling returns an empty page and the full total',
    query: '?_offset=' + ABOVE_SAFE_INTEGER_VALUE,
    status: 200,
    offset: Number.parseInt(ABOVE_SAFE_INTEGER_VALUE, 10),
    emptyResults: true,
    fullTotal: true,
  },
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
  { name: 'Repeated _id is rejected', query: REPEATED_ID_QUERY, status: 400, outcome: INVALID_ID_OUTCOME },
  {
    name: 'Long list of malformed _id values is rejected',
    query: MALFORMED_ID_LIST_QUERY,
    status: 400,
    outcome: INVALID_ID_OUTCOME,
  },
  { name: 'Separator-only _id returns every client', query: '?_id=,,', status: 200, unfiltered: true },
];

/**
 * Builds a client application fixture.
 * @param name - The client application name.
 * @param redirectUris - The registered redirect URIs.
 * @param overrides - Additional client application fields.
 * @returns The client application to create.
 */
function clientFixture(
  name: string,
  redirectUris: string[],
  overrides?: Partial<ClientApplication>
): ClientApplication {
  return { resourceType: 'ClientApplication', name, redirectUris, ...overrides };
}

/**
 * Creates a client application in the project of the access token through the FHIR API.
 * @param accessToken - An access token with permission to create client applications.
 * @param fixture - The client application to create.
 * @returns The created client application.
 */
async function seedClient(accessToken: string, fixture: ClientApplication): Promise<WithId<ClientApplication>> {
  const res = await request(app)
    .post('/fhir/R4/ClientApplication')
    .set('Authorization', 'Bearer ' + accessToken)
    .type('json')
    .send(fixture);
  expect(res).toHaveStatus(201);
  return res.body as WithId<ClientApplication>;
}

/**
 * Requests the OAuth client security report.
 * @param projectId - The project id in the request path.
 * @param accessToken - The caller access token.
 * @param query - An optional query string, including the leading question mark.
 * @returns The HTTP response.
 */
async function readReport(projectId: string, accessToken: string, query?: string): Promise<Response> {
  return request(app)
    .get('/admin/projects/' + projectId + '/oauth-security' + (query ?? ''))
    .set('Authorization', 'Bearer ' + accessToken);
}

/**
 * Reads the report envelope from a response.
 * @param res - The HTTP response.
 * @returns The report envelope.
 */
function reportOf(res: Response): ClientSecurityReport {
  return res.body as ClientSecurityReport;
}

/**
 * Finds the result for one client id.
 * @param report - The report envelope.
 * @param clientId - The client application id.
 * @returns The result carrying the client id.
 */
function resultById(report: ClientSecurityReport, clientId: string): OAuthClientLintResult {
  const result = report.results.find((candidate) => candidate.id === clientId);
  expect(result).toBeDefined();
  return result as OAuthClientLintResult;
}

/**
 * Lists the rule ids of a result in emission order.
 * @param result - The result for one client application.
 * @returns The rule ids.
 */
function ruleIdsOf(result: OAuthClientLintResult): OAuthClientLintRuleId[] {
  return result.findings.map((finding) => finding.ruleId);
}

/**
 * Selects the findings of one rule.
 * @param result - The result for one client application.
 * @param ruleId - The rule id to select.
 * @returns The findings carrying the rule id.
 */
function findingsOf(result: OAuthClientLintResult, ruleId: OAuthClientLintRuleId): OAuthClientLintFinding[] {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

/**
 * Lists the client ids of a report in sorted order.
 * @param report - The report envelope.
 * @returns The sorted client ids.
 */
function sortedResultIds(report: ClientSecurityReport): string[] {
  return report.results.map((result) => result.id).sort((a, b) => a.localeCompare(b));
}

/**
 * Lists the client ids one page of the report covers, in sorted order.
 * @param orderedIds - The client ids in the order the endpoint returns them.
 * @param offset - The offset of the page.
 * @param count - The size of the page.
 * @returns The sorted client ids of the page.
 */
function sortedPageIds(orderedIds: string[], offset: number, count: number): string[] {
  return orderedIds.slice(offset, offset + count).sort((a, b) => a.localeCompare(b));
}

/** The base search request the handler builds for one project, before paging is applied. */
const TRAVERSAL_SEARCH: SearchRequest<ClientApplication> = {
  resourceType: 'ClientApplication',
  total: 'accurate',
  count: 2,
  offset: 0,
  filters: [{ code: '_project', operator: Operator.EQUALS, value: randomUUID() }],
  sortRules: [{ code: '_lastUpdated' }],
};

/** The base of a search url, as the repository builds the links of a search bundle. */
const SEARCH_LINK_BASE = 'http://localhost:8103/fhir/R4/ClientApplication?_count=' + DEFAULT_MAX_SEARCH_COUNT;

/** The cursor of the second window of a synthetic traversal. */
const SECOND_WINDOW_CURSOR = '2-2026-09-18T01:02:03.000Z-';

/**
 * Builds a client application of a synthetic cursor window.
 * @param index - The position of the client application in the matching set.
 * @returns The client application.
 */
function traversalClient(index: number): WithId<ClientApplication> {
  return { resourceType: 'ClientApplication', id: randomUUID(), name: 'Traversal Client ' + index };
}

/**
 * Builds one synthetic cursor window.
 * @param clients - The client applications of the window.
 * @param nextUrl - The url of the window "next" link, absent on the last window of the set.
 * @returns The search bundle of the window.
 */
function cursorWindow(clients: WithId<ClientApplication>[], nextUrl?: string): Bundle<WithId<ClientApplication>> {
  const link = [{ relation: 'first', url: SEARCH_LINK_BASE }];
  if (nextUrl !== undefined) {
    link.push({ relation: 'next', url: nextUrl });
  }
  return { resourceType: 'Bundle', type: 'searchset', entry: clients.map((resource) => ({ resource })), link };
}

/**
 * Builds a search that answers with synthetic cursor windows in order and records every request it receives.
 * @param windows - The windows to answer with. A request beyond the last window is answered with an empty window.
 * @returns The search and the requests it received.
 */
function windowedSearch(windows: Bundle<WithId<ClientApplication>>[]): {
  search: ClientApplicationSearch;
  requests: SearchRequest<ClientApplication>[];
} {
  const requests: SearchRequest<ClientApplication>[] = [];
  return {
    search: async (search) => {
      requests.push(search);
      return windows[requests.length - 1] ?? cursorWindow([]);
    },
    requests,
  };
}

let projectAdmin: RegisterResponse;

describe('OAuth client security endpoint', () => {
  beforeAll(async () => {
    const config = await loadTestConfig();

    // One configured entry per discoverability shape: a URI list, the deprecated singular field, and the
    // built-in CLI redirect URI.
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

      // One client per rule outcome: exact callback, bare origin, wildcard, and no redirect URI.
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

      // One client per configured entry: the URI list entry, the deprecated singular entry, and the built-in
      // CLI redirect URI, which the third configured entry registers as well.
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
    let orderedIds: string[];

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
      orderedIds = reportOf(res).results.map((result) => result.id);
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

    test('Page at the repository offset ceiling returns the clients of that page', async () => {
      const previousMaxSearchOffset = getConfig().maxSearchOffset;
      getConfig().maxSearchOffset = 2;
      try {
        const res = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=2');
        expect(res).toHaveStatus(200);

        const report = reportOf(res);
        expect(report.offset).toStrictEqual(2);
        expect(report.count).toStrictEqual(2);
        expect(report.total).toStrictEqual(fullIds.length);
        expect(sortedResultIds(report)).toStrictEqual(sortedPageIds(orderedIds, 2, 2));
      } finally {
        getConfig().maxSearchOffset = previousMaxSearchOffset;
      }
    });

    test('Page above the repository offset ceiling returns the remaining clients and the full total', async () => {
      const previousMaxSearchOffset = getConfig().maxSearchOffset;
      getConfig().maxSearchOffset = 2;
      try {
        const res = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=3');
        expect(res).toHaveStatus(200);

        const report = reportOf(res);
        expect(report.offset).toStrictEqual(3);
        expect(report.count).toStrictEqual(2);
        expect(report.total).toStrictEqual(fullIds.length);
        expect(report.results).toHaveLength(2);
        expect(sortedResultIds(report)).toStrictEqual(sortedPageIds(orderedIds, 3, 2));
        expect(sortedResultIds(report)).not.toContain(orderedIds[0]);
      } finally {
        getConfig().maxSearchOffset = previousMaxSearchOffset;
      }
    });

    test('Page above the repository offset ceiling and beyond the result set returns no clients', async () => {
      const previousMaxSearchOffset = getConfig().maxSearchOffset;
      getConfig().maxSearchOffset = 2;
      try {
        const beyondOffset = fullIds.length + 10;

        const res = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=' + beyondOffset);
        expect(res).toHaveStatus(200);

        const report = reportOf(res);
        expect(report.results).toStrictEqual([]);
        expect(report.offset).toStrictEqual(beyondOffset);
        expect(report.count).toStrictEqual(2);
        expect(report.total).toStrictEqual(fullIds.length);
      } finally {
        getConfig().maxSearchOffset = previousMaxSearchOffset;
      }
    });

    test('Pages walked above the repository offset ceiling cover every client exactly once', async () => {
      const previousMaxSearchOffset = getConfig().maxSearchOffset;
      getConfig().maxSearchOffset = 1;
      try {
        const walkedIds: string[] = [];
        for (let offset = 0; offset < fullIds.length; offset += 2) {
          const res = await readReport(pagingProjectId, pagingAccessToken, '?_count=2&_offset=' + offset);
          expect(res).toHaveStatus(200);

          const report = reportOf(res);
          expect(report.total).toStrictEqual(fullIds.length);
          walkedIds.push(...report.results.map((result) => result.id));
        }

        expect(walkedIds).toHaveLength(fullIds.length);
        expect(new Set(walkedIds).size).toStrictEqual(fullIds.length);
        expect([...walkedIds].sort((a, b) => a.localeCompare(b))).toStrictEqual(fullIds);
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

    test.each(validationCases)(
      '$name',
      async ({ query, status, outcome, count, offset, unfiltered, emptyResults, fullTotal }) => {
        const res = await readReport(validationProjectId, validationAccessToken, query);
        expect(res).toHaveStatus(status);

        if (status === 400) {
          expect(res.body.resourceType).toStrictEqual('OperationOutcome');
          expect(res.body.issue[0].code).toStrictEqual('invalid');
          expect(res.body.issue[0].details.text).toStrictEqual(outcome);
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
        if (emptyResults) {
          expect(reportOf(res).results).toStrictEqual([]);
        }
        if (fullTotal) {
          expect(reportOf(res).total).toStrictEqual(allIds.length);
        }
      }
    );
  });

  describe('Requested client id parsing', () => {
    test('A single client id is accepted', () => {
      const id = randomUUID();
      expect(parseClientIdsParam(id)).toStrictEqual({ ids: [id] });
    });

    test('An absent parameter requests every client', () => {
      expect(parseClientIdsParam(undefined)).toStrictEqual({});
    });

    test('A separator-only value requests every client', () => {
      expect(parseClientIdsParam(',,')).toStrictEqual({});
    });

    test('A repeated parameter is refused', () => {
      expect(parseClientIdsParam([randomUUID(), randomUUID()])).toBeUndefined();
    });

    test('One malformed id among valid client ids is refused', () => {
      expect(parseClientIdsParam([randomUUID(), 'not-a-uuid', randomUUID()].join(','))).toBeUndefined();
    });

    test('A list of the maximum search count of valid client ids is accepted', () => {
      const ids = Array.from({ length: DEFAULT_MAX_SEARCH_COUNT }, () => randomUUID());

      expect(parseClientIdsParam(ids.join(','))).toStrictEqual({ ids });
    });

    test('A list of valid client ids one longer than the maximum search count is refused', () => {
      const ids = Array.from({ length: DEFAULT_MAX_SEARCH_COUNT + 1 }, () => randomUUID());

      expect(parseClientIdsParam(ids.join(','))).toBeUndefined();
    });
  });

  describe('Deep page cursor traversal', () => {
    const traversalClients = [0, 1, 2, 3, 4, 5].map((index) => traversalClient(index));
    const secondWindowUrl = SEARCH_LINK_BASE + '&_cursor=' + encodeURIComponent(SECOND_WINDOW_CURSOR);

    /**
     * Builds the two windows of a six-client set, the first of which links to the second.
     * @returns The windows, in traversal order.
     */
    function twoWindows(): Bundle<WithId<ClientApplication>>[] {
      return [cursorWindow(traversalClients.slice(0, 3), secondWindowUrl), cursorWindow(traversalClients.slice(3))];
    }

    test('Page spanning two windows is collected from the second window', async () => {
      const { search, requests } = windowedSearch(twoWindows());

      const page = await collectPageByCursor(search, TRAVERSAL_SEARCH, 4, 2);

      expect(page.map((client) => client.id)).toStrictEqual([traversalClients[4].id, traversalClients[5].id]);
      expect(requests).toHaveLength(2);
      expect(requests[0].cursor).toBeUndefined();
      expect(requests[1].cursor).toStrictEqual(SECOND_WINDOW_CURSOR);
    });

    test('Page contained in the first window is collected without a second search', async () => {
      const { search, requests } = windowedSearch(twoWindows());

      const page = await collectPageByCursor(search, TRAVERSAL_SEARCH, 1, 2);

      expect(page.map((client) => client.id)).toStrictEqual([traversalClients[1].id, traversalClients[2].id]);
      expect(requests).toHaveLength(1);
    });

    test('Page at the end of the set is short', async () => {
      const { search, requests } = windowedSearch(twoWindows());

      const page = await collectPageByCursor(search, TRAVERSAL_SEARCH, 5, 3);

      expect(page.map((client) => client.id)).toStrictEqual([traversalClients[5].id]);
      expect(requests).toHaveLength(2);
    });

    test('Page beyond the end of the set is empty', async () => {
      const { search, requests } = windowedSearch([cursorWindow(traversalClients.slice(0, 3))]);

      const page = await collectPageByCursor(search, TRAVERSAL_SEARCH, 5, 2);

      expect(page).toStrictEqual([]);
      expect(requests).toHaveLength(1);
    });

    test('Traversal stops at a next link that carries no cursor', async () => {
      const { search, requests } = windowedSearch([
        cursorWindow(traversalClients.slice(0, 3), SEARCH_LINK_BASE),
        cursorWindow(traversalClients.slice(3)),
      ]);

      const page = await collectPageByCursor(search, TRAVERSAL_SEARCH, 0, 5);

      expect(page.map((client) => client.id)).toStrictEqual(traversalClients.slice(0, 3).map((client) => client.id));
      expect(requests).toHaveLength(1);
    });

    test('Every window is read from the start of the set with the forced filters and the sort rule', async () => {
      const { search, requests } = windowedSearch(twoWindows());

      await collectPageByCursor(search, TRAVERSAL_SEARCH, 4, 2);

      expect(requests).toHaveLength(2);
      for (const issued of requests) {
        expect(issued.resourceType).toStrictEqual('ClientApplication');
        expect(issued.filters).toStrictEqual(TRAVERSAL_SEARCH.filters);
        expect(issued.sortRules).toStrictEqual([{ code: '_lastUpdated' }]);
        expect(issued.offset).toStrictEqual(0);
        expect(issued.count).toStrictEqual(DEFAULT_MAX_SEARCH_COUNT);
        expect(issued.total).toBeUndefined();
      }
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
