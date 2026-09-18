// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import type { ClientApplication } from '@medplum/fhirtypes';
import type {
  OAuthClientLintFinding,
  OAuthClientLintOptions,
  OAuthClientLintResult,
  OAuthClientLintRuleId,
  OAuthClientLintStatus,
  RegistrationDiscoverableClient,
} from './clientlint';
import { indexRegistrationDiscoverableClients, lintOAuthClient, OAUTH_CLIENT_LINT_BUDGET } from './clientlint';

const TEST_CLIENT_ID = 'test-client';

const BARE_ORIGIN_REASON =
  "Registered as an origin with no callback path, so the authorization response is delivered to this host's root page. Any open redirect, third-party script or user-controlled content on that root page can forward the authorization code onwards, and a root page is rarely written with that responsibility in mind.";
const BARE_ORIGIN_REMEDIATION =
  'Register the exact callback URL the application uses, including its path — for example https://app.example.com/oauth/callback — and remove the origin-only entry.';
const WILDCARD_REASON =
  'Contains a wildcard. Redirect URIs are compared by exact string, so this entry never matches a real authorization request; where the same value is used on a server that does expand patterns, it authorises hosts or paths that were never intended.';
const WILDCARD_REMEDIATION =
  'Replace the wildcard entry with one exact, fully qualified URL for each callback the application actually uses.';
const PREFIX_MATCHING_REASON =
  'This project enables the allow-dangerous-redirect setting, so this URI is accepted as a text prefix rather than an exact string. Every path that merely starts with it on the same origin is accepted — including a sibling such as /callback-evil for a registered /callback — and the query string is not compared at all.';
const PREFIX_MATCHING_REMEDIATION =
  'Register exact callback URLs for every client in this project, then disable the allow-dangerous-redirect project setting.';
const CONFIG_DISCOVERABLE_REASON =
  "A value belonging to this client also identifies a client in this server's configured default OAuth client list, which POST /oauth2/register serves without authentication: a caller presenting a matching redirect URI receives that client's id and its complete redirect URI list. No client secret is returned by that endpoint.";
const CONFIG_DISCOVERABLE_REMEDIATION =
  "Ask the server operator to confirm that this client is meant to be reachable through unauthenticated registration, and to remove the matching entry from the server's default OAuth client configuration if it is not.";
const BUILT_IN_DISCOVERABLE_REASON =
  "A value belonging to this client also matches the server's built-in Medplum CLI client, which POST /oauth2/register serves without authentication: a caller presenting a matching redirect URI receives that built-in client's id and redirect URI list rather than this client's. No client secret is returned by that endpoint.";
const BUILT_IN_DISCOVERABLE_REMEDIATION =
  'The built-in client cannot be removed by configuration. Register a redirect URI that does not collide with it — the built-in client uses the loopback URI http://localhost:9615 — and give this client an id of its own.';
const NO_REDIRECT_URI_REASON =
  'No redirect URI is configured, so this client cannot take part in a redirect-based authorization flow and no redirect risk applies.';
const NO_REDIRECT_URI_REMEDIATION = 'None required.';
const EVALUATION_TRUNCATED_REASON =
  'This review did not read every redirect URI registered for this client, so the result is incomplete: the redirect URIs it did not read were not evaluated, and any risk they carry is not reported here. The redirect URIs listed for this client are the ones that were read.';
const EVALUATION_TRUNCATED_REMEDIATION =
  'Remove the redirect URIs this client no longer uses, and shorten any unusually long entry, so that the whole list can be reviewed — then open this report again.';

function client(props: Partial<ClientApplication> = {}): WithId<ClientApplication> {
  return { ...props, resourceType: 'ClientApplication', id: props.id ?? TEST_CLIENT_ID };
}

function ruleIds(result: OAuthClientLintResult): OAuthClientLintRuleId[] {
  return result.findings.map((finding) => finding.ruleId);
}

function findingsForRule(result: OAuthClientLintResult, ruleId: OAuthClientLintRuleId): OAuthClientLintFinding[] {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

function onlyFindingForRule(result: OAuthClientLintResult, ruleId: OAuthClientLintRuleId): OAuthClientLintFinding {
  const matches = findingsForRule(result, ruleId);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function bareOriginUris(count: number): string[] {
  return Array.from({ length: count }, (_, index) => 'https://app' + index + '.example.com');
}

function callbackUrisOfLength(count: number, length: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const prefix = 'https://app.example.com/cb/' + String(index).padStart(4, '0') + '/';
    return prefix + 'a'.repeat(length - prefix.length);
  });
}

const unparseableCases: {
  redirectUri: string;
  expectedRuleIds: OAuthClientLintRuleId[];
  expectedStatus: OAuthClientLintStatus;
}[] = [
  { redirectUri: 'not a url', expectedRuleIds: [], expectedStatus: 'pass' },
  { redirectUri: 'not a url/*', expectedRuleIds: ['OCS-002'], expectedStatus: 'fail' },
];

const registrationCases: {
  name: string;
  clientId: string;
  redirectUris: string[];
  entries: RegistrationDiscoverableClient[];
  expectedRedirectUri: string | undefined;
  expectedReason: string;
  expectedRemediation: string;
}[] = [
  {
    name: 'the built-in CLI client matched by its loopback redirect URI',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['http://localhost:9615'],
    entries: [{ id: 'medplum-cli', redirectUris: ['http://localhost:9615'], source: 'built-in' }],
    expectedRedirectUri: 'http://localhost:9615',
    expectedReason: BUILT_IN_DISCOVERABLE_REASON,
    expectedRemediation: BUILT_IN_DISCOVERABLE_REMEDIATION,
  },
  {
    name: 'a configured client matched by its redirect URI rather than by its id',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['https://legacy.example.com/callback'],
    entries: [{ id: 'legacy-config-client', redirectUris: ['https://legacy.example.com/callback'], source: 'config' }],
    expectedRedirectUri: 'https://legacy.example.com/callback',
    expectedReason: CONFIG_DISCOVERABLE_REASON,
    expectedRemediation: CONFIG_DISCOVERABLE_REMEDIATION,
  },
  {
    name: 'a configured client with an empty redirect URI list, matched by id alone',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['https://app.example.com/oauth/callback'],
    entries: [{ id: TEST_CLIENT_ID, redirectUris: [], source: 'config' }],
    expectedRedirectUri: undefined,
    expectedReason: CONFIG_DISCOVERABLE_REASON,
    expectedRemediation: CONFIG_DISCOVERABLE_REMEDIATION,
  },
  {
    name: 'the first of two entries that share one redirect URI',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['https://shared.example.com/callback'],
    entries: [
      { id: 'first-entry', redirectUris: ['https://shared.example.com/callback'], source: 'built-in' },
      { id: 'second-entry', redirectUris: ['https://shared.example.com/callback'], source: 'config' },
    ],
    expectedRedirectUri: 'https://shared.example.com/callback',
    expectedReason: BUILT_IN_DISCOVERABLE_REASON,
    expectedRemediation: BUILT_IN_DISCOVERABLE_REMEDIATION,
  },
];

const registrationOrderCases: {
  name: string;
  clientId: string;
  redirectUris: string[];
  entries: RegistrationDiscoverableClient[];
  expectedRedirectUri: string | undefined;
  expectedReason: string;
}[] = [
  {
    name: 'an id match in an earlier entry ahead of a redirect URI match in a later entry',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['https://app.example.com/oauth/callback'],
    entries: [
      { id: TEST_CLIENT_ID, redirectUris: ['https://other.example.com/cb'], source: 'built-in' },
      { id: 'later-entry', redirectUris: ['https://app.example.com/oauth/callback'], source: 'config' },
    ],
    expectedRedirectUri: undefined,
    expectedReason: BUILT_IN_DISCOVERABLE_REASON,
  },
  {
    name: 'a redirect URI match in an earlier entry ahead of an id match in a later entry',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['https://app.example.com/oauth/callback'],
    entries: [
      { id: 'earlier-entry', redirectUris: ['https://app.example.com/oauth/callback'], source: 'config' },
      { id: TEST_CLIENT_ID, redirectUris: [], source: 'built-in' },
    ],
    expectedRedirectUri: 'https://app.example.com/oauth/callback',
    expectedReason: CONFIG_DISCOVERABLE_REASON,
  },
  {
    name: 'the redirect URI match ahead of the id match within one entry',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['https://app.example.com/oauth/callback'],
    entries: [{ id: TEST_CLIENT_ID, redirectUris: ['https://app.example.com/oauth/callback'], source: 'config' }],
    expectedRedirectUri: 'https://app.example.com/oauth/callback',
    expectedReason: CONFIG_DISCOVERABLE_REASON,
  },
  {
    name: 'the first registered redirect URI when one entry carries two of them',
    clientId: TEST_CLIENT_ID,
    redirectUris: ['https://first.example.com/cb', 'https://second.example.com/cb'],
    entries: [
      {
        id: 'unrelated-entry',
        redirectUris: ['https://second.example.com/cb', 'https://first.example.com/cb'],
        source: 'config',
      },
    ],
    expectedRedirectUri: 'https://first.example.com/cb',
    expectedReason: CONFIG_DISCOVERABLE_REASON,
  },
];

const copyCases: {
  name: string;
  ruleId: OAuthClientLintRuleId;
  subject: WithId<ClientApplication>;
  options?: OAuthClientLintOptions;
  expectedReason: string;
  expectedRemediation: string;
}[] = [
  {
    name: 'OCS-001',
    ruleId: 'OCS-001',
    subject: client({ redirectUris: ['https://app.example.com'] }),
    expectedReason: BARE_ORIGIN_REASON,
    expectedRemediation: BARE_ORIGIN_REMEDIATION,
  },
  {
    name: 'OCS-002',
    ruleId: 'OCS-002',
    subject: client({ redirectUris: ['https://app.example.com/*'] }),
    expectedReason: WILDCARD_REASON,
    expectedRemediation: WILDCARD_REMEDIATION,
  },
  {
    name: 'OCS-003',
    ruleId: 'OCS-003',
    subject: client({ redirectUris: ['https://app.example.com/oauth/callback'] }),
    options: { partialRedirectMatchEnabled: true },
    expectedReason: PREFIX_MATCHING_REASON,
    expectedRemediation: PREFIX_MATCHING_REMEDIATION,
  },
  {
    name: 'OCS-004 for a configured client',
    ruleId: 'OCS-004',
    subject: client({ redirectUris: ['https://app.example.com/oauth/callback'] }),
    options: {
      registrationDiscoverableClients: [{ id: TEST_CLIENT_ID, redirectUris: [], source: 'config' }],
    },
    expectedReason: CONFIG_DISCOVERABLE_REASON,
    expectedRemediation: CONFIG_DISCOVERABLE_REMEDIATION,
  },
  {
    name: 'OCS-004 for the built-in client',
    ruleId: 'OCS-004',
    subject: client({ redirectUris: ['http://localhost:9615'] }),
    options: {
      registrationDiscoverableClients: [
        { id: 'medplum-cli', redirectUris: ['http://localhost:9615'], source: 'built-in' },
      ],
    },
    expectedReason: BUILT_IN_DISCOVERABLE_REASON,
    expectedRemediation: BUILT_IN_DISCOVERABLE_REMEDIATION,
  },
  {
    name: 'OCS-005',
    ruleId: 'OCS-005',
    subject: client(),
    expectedReason: NO_REDIRECT_URI_REASON,
    expectedRemediation: NO_REDIRECT_URI_REMEDIATION,
  },
  {
    name: 'OCS-006',
    ruleId: 'OCS-006',
    subject: client({ redirectUris: bareOriginUris(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris + 1) }),
    expectedReason: EVALUATION_TRUNCATED_REASON,
    expectedRemediation: EVALUATION_TRUNCATED_REMEDIATION,
  },
];

describe('lintOAuthClient', () => {
  test.each(['https://app.example.com', 'https://app.example.com/', 'https://app.example.com/?next=x'])(
    'warns that the redirect URI %s is an origin with no callback path',
    (redirectUri) => {
      const result = lintOAuthClient(client({ redirectUris: [redirectUri] }));

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].ruleId).toBe('OCS-001');
      expect(result.findings[0].status).toBe('warning');
      expect(result.findings[0].redirectUri).toBe(redirectUri);
      expect(result.status).toBe('warning');
    }
  );

  test.each(['https://*.example.com/cb', 'https://app.example.com/*', 'https://app.example.com/cb?next=*'])(
    'fails the redirect URI %s because it contains a wildcard',
    (redirectUri) => {
      const result = lintOAuthClient(client({ redirectUris: [redirectUri] }));

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].ruleId).toBe('OCS-002');
      expect(result.findings[0].status).toBe('fail');
      expect(result.findings[0].redirectUri).toBe(redirectUri);
      expect(result.status).toBe('fail');
    }
  );

  test.each(['https://app.example.com/oauth/callback', 'https://app.example.com/cb/'])(
    'passes the exact, fully qualified redirect URI %s',
    (redirectUri) => {
      const result = lintOAuthClient(client({ redirectUris: [redirectUri] }));

      expect(result.findings).toStrictEqual([]);
      expect(result.status).toBe('pass');
    }
  );

  test.each(['http://localhost:9615', 'http://127.0.0.1:3000/callback', 'http://[::1]:8080/cb'])(
    'passes the loopback redirect URI %s',
    (redirectUri) => {
      const result = lintOAuthClient(client({ redirectUris: [redirectUri] }));

      expect(result.findings).toStrictEqual([]);
      expect(result.status).toBe('pass');
    }
  );

  test('fails a wildcard redirect URI on a loopback host', () => {
    const result = lintOAuthClient(client({ redirectUris: ['http://localhost:3000/*'] }));

    expect(ruleIds(result)).toStrictEqual(['OCS-002']);
    expect(result.findings[0].status).toBe('fail');
    expect(result.findings[0].redirectUri).toBe('http://localhost:3000/*');
    expect(result.status).toBe('fail');
  });

  test('passes a client that has configured no redirect URI', () => {
    const result = lintOAuthClient(client());

    expect(result.id).toBe(TEST_CLIENT_ID);
    expect(result.redirectUris).toStrictEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe('OCS-005');
    expect(result.findings[0].status).toBe('pass');
    expect(result.findings[0].redirectUri).toBeUndefined();
    expect(result.status).toBe('pass');
  });

  test('reports both the no-redirect-URI pass and the registration warning for a discoverable client id', () => {
    const result = lintOAuthClient(client(), {
      registrationDiscoverableClients: [{ id: TEST_CLIENT_ID, redirectUris: [], source: 'config' }],
    });

    expect(result.findings).toHaveLength(2);
    expect(ruleIds(result)).toStrictEqual(['OCS-004', 'OCS-005']);
    expect(onlyFindingForRule(result, 'OCS-004').status).toBe('warning');
    expect(onlyFindingForRule(result, 'OCS-005').status).toBe('pass');
    expect(result.status).toBe('warning');
  });

  test('lints the deprecated singular redirectUri field ahead of the redirectUris list', () => {
    const result = lintOAuthClient(client({ redirectUri: 'https://app.example.com' }));

    expect(result.redirectUris).toStrictEqual(['https://app.example.com']);
    expect(ruleIds(result)).toStrictEqual(['OCS-001']);
    expect(result.findings[0].status).toBe('warning');
    expect(result.findings[0].redirectUri).toBe('https://app.example.com');
    expect(result.status).toBe('warning');
  });

  test('reports the worst severity when one client mixes a failing and a warning redirect URI', () => {
    const result = lintOAuthClient(client({ redirectUris: ['https://app.example.com/*', 'https://app.example.com'] }));

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].ruleId).toBe('OCS-002');
    expect(result.findings[0].status).toBe('fail');
    expect(result.findings[0].redirectUri).toBe('https://app.example.com/*');
    expect(result.findings[1].ruleId).toBe('OCS-001');
    expect(result.findings[1].status).toBe('warning');
    expect(result.findings[1].redirectUri).toBe('https://app.example.com');
    expect(result.status).toBe('fail');
  });

  test('flags every parseable redirect URI and escalates the bare origin when prefix matching is enabled', () => {
    const redirectUris = ['https://app.example.com', 'https://app.example.com/oauth/callback'];

    const result = lintOAuthClient(client({ redirectUris }), { partialRedirectMatchEnabled: true });

    const prefixFindings = findingsForRule(result, 'OCS-003');
    expect(prefixFindings).toHaveLength(redirectUris.length);
    expect(prefixFindings.map((finding) => finding.redirectUri)).toStrictEqual(redirectUris);
    expect(prefixFindings.map((finding) => finding.status)).toStrictEqual(['fail', 'fail']);
    expect(onlyFindingForRule(result, 'OCS-001').status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('states that a registered callback path also accepts its siblings when prefix matching is enabled', () => {
    const result = lintOAuthClient(client({ redirectUris: ['https://app.example.com/callback'] }), {
      partialRedirectMatchEnabled: true,
    });

    const finding = onlyFindingForRule(result, 'OCS-003');
    expect(finding.status).toBe('fail');
    expect(finding.redirectUri).toBe('https://app.example.com/callback');
    expect(finding.reason).toBe(PREFIX_MATCHING_REASON);
    expect(finding.remediation).toBe(PREFIX_MATCHING_REMEDIATION);
  });

  test.each(unparseableCases)(
    'does not treat the unparseable registration $redirectUri as an accepted prefix',
    (testCase) => {
      const result = lintOAuthClient(client({ redirectUris: [testCase.redirectUri] }), {
        partialRedirectMatchEnabled: true,
      });

      expect(findingsForRule(result, 'OCS-003')).toStrictEqual([]);
      expect(ruleIds(result)).toStrictEqual(testCase.expectedRuleIds);
      expect(result.status).toBe(testCase.expectedStatus);
    }
  );

  test('warns when the client id identifies a registration discoverable client', () => {
    const result = lintOAuthClient(client({ redirectUris: ['https://app.example.com/oauth/callback'] }), {
      registrationDiscoverableClients: [
        { id: TEST_CLIENT_ID, redirectUris: ['https://other.example.com/cb'], source: 'config' },
      ],
    });

    expect(ruleIds(result)).toStrictEqual(['OCS-004']);
    expect(result.findings[0].status).toBe('warning');
    expect(result.findings[0].redirectUri).toBeUndefined();
    expect(result.status).toBe('warning');
  });

  test('keeps the registration finding at warning for a client that holds a secret', () => {
    const result = lintOAuthClient(
      client({ redirectUris: ['https://app.example.com/oauth/callback'], secret: 'my-secret' }),
      { registrationDiscoverableClients: [{ id: TEST_CLIENT_ID, redirectUris: [], source: 'config' }] }
    );

    expect(ruleIds(result)).toStrictEqual(['OCS-004']);
    expect(result.findings[0].status).toBe('warning');
    expect(result.status).toBe('warning');
  });

  test('warns when a registered redirect URI addresses a registration discoverable client', () => {
    const result = lintOAuthClient(client({ redirectUris: ['https://app.example.com/oauth/callback'] }), {
      registrationDiscoverableClients: [
        { id: 'other-client', redirectUris: ['https://app.example.com/oauth/callback'], source: 'config' },
      ],
    });

    expect(ruleIds(result)).toStrictEqual(['OCS-004']);
    expect(result.findings[0].status).toBe('warning');
    expect(result.findings[0].redirectUri).toBe('https://app.example.com/oauth/callback');
    expect(result.findings[0].reason).toBe(CONFIG_DISCOVERABLE_REASON);
    expect(result.findings[0].remediation).toBe(CONFIG_DISCOVERABLE_REMEDIATION);
    expect(result.status).toBe('warning');
  });

  test.each(registrationCases)('names $name in a single registration finding', (testCase) => {
    const result = lintOAuthClient(client({ id: testCase.clientId, redirectUris: testCase.redirectUris }), {
      registrationDiscoverableClients: testCase.entries,
    });

    expect(ruleIds(result)).toStrictEqual(['OCS-004']);
    expect(result.findings[0].status).toBe('warning');
    expect(result.findings[0].redirectUri).toBe(testCase.expectedRedirectUri);
    expect(result.findings[0].reason).toBe(testCase.expectedReason);
    expect(result.findings[0].remediation).toBe(testCase.expectedRemediation);
    expect(result.status).toBe('warning');
  });

  test('applies the redirect URI rules regardless of the configured grant types', () => {
    const redirectUris = ['https://app.example.com'];

    const withGrantType = lintOAuthClient(client({ grantType: ['client_credentials'], redirectUris }));
    const withoutGrantType = lintOAuthClient(client({ redirectUris }));

    expect(ruleIds(withGrantType)).toStrictEqual(['OCS-001']);
    expect(withGrantType.findings[0].status).toBe('warning');
    expect(withGrantType.findings).toStrictEqual(withoutGrantType.findings);
    expect(withGrantType.status).toBe('warning');
  });

  test('evaluates an unparseable redirect URI deterministically', () => {
    const withoutWildcard = lintOAuthClient(client({ redirectUris: ['not a url'] }));

    expect(findingsForRule(withoutWildcard, 'OCS-001')).toStrictEqual([]);
    expect(withoutWildcard.findings).toStrictEqual([]);
    expect(withoutWildcard.status).toBe('pass');

    const withWildcard = lintOAuthClient(client({ redirectUris: ['not a url/*'] }));

    expect(ruleIds(withWildcard)).toStrictEqual(['OCS-002']);
    expect(withWildcard.findings[0].redirectUri).toBe('not a url/*');
    expect(withWildcard.status).toBe('fail');
  });

  test.each(copyCases)('states the reason and the suggested fix for $name', (testCase) => {
    const finding = onlyFindingForRule(lintOAuthClient(testCase.subject, testCase.options), testCase.ruleId);

    expect(finding.reason).toBe(testCase.expectedReason);
    expect(finding.remediation).toBe(testCase.expectedRemediation);
  });

  test.each(registrationOrderCases)('resolves $name', (testCase) => {
    const result = lintOAuthClient(client({ id: testCase.clientId, redirectUris: testCase.redirectUris }), {
      registrationDiscoverableClients: testCase.entries,
    });

    const finding = onlyFindingForRule(result, 'OCS-004');
    expect(finding.status).toBe('warning');
    expect(finding.redirectUri).toBe(testCase.expectedRedirectUri);
    expect(finding.reason).toBe(testCase.expectedReason);
    expect(result.status).toBe('warning');
  });

  test('omits the truncation fields when every registered redirect URI was read', () => {
    const result = lintOAuthClient(
      client({ redirectUris: ['https://app.example.com/oauth/callback', 'https://app.example.com'] })
    );

    expect(result.redirectUris).toHaveLength(2);
    expect(result.truncated).toBeUndefined();
    expect(result.redirectUriCount).toBeUndefined();
    expect(Object.keys(result)).toStrictEqual(['id', 'redirectUris', 'status', 'findings']);
  });

  test('reads no more redirect URIs than the count ceiling allows and reports the evaluation as truncated', () => {
    const registered = bareOriginUris(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris + 5);

    const result = lintOAuthClient(client({ redirectUris: registered }));

    expect(result.redirectUris).toStrictEqual(registered.slice(0, OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris));
    expect(result.truncated).toBe(true);
    expect(result.redirectUriCount).toBe(registered.length);
    expect(findingsForRule(result, 'OCS-001').map((finding) => finding.redirectUri)).toStrictEqual(result.redirectUris);
    expect(ruleIds(result).at(-1)).toBe('OCS-006');
    expect(result.findings).toHaveLength(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris + 1);
    expect(result.status).toBe('warning');
    expect(lintOAuthClient(client({ redirectUris: registered }))).toStrictEqual(result);
  });

  test('reads a redirect URI list of extreme cardinality without copying all of it', () => {
    const registered = bareOriginUris(200_000);

    const result = lintOAuthClient(client({ redirectUris: registered }));

    expect(result.redirectUris).toStrictEqual(registered.slice(0, OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris));
    expect(result.truncated).toBe(true);
    expect(result.redirectUriCount).toBe(registered.length);
    expect(result.findings).toHaveLength(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris + 1);
    expect(onlyFindingForRule(result, 'OCS-006').status).toBe('warning');
    expect(result.status).toBe('warning');
  });

  test('reads no more redirect URI bytes than the byte ceiling allows', () => {
    const uriLength = 512;
    const expectedRead = Math.floor(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUriBytes / uriLength);
    const registered = callbackUrisOfLength(expectedRead + 3, uriLength);

    const result = lintOAuthClient(client({ redirectUris: registered }));

    expect(result.redirectUris).toStrictEqual(registered.slice(0, expectedRead));
    expect(Buffer.byteLength(result.redirectUris.join(''), 'utf8')).toBeLessThanOrEqual(
      OAUTH_CLIENT_LINT_BUDGET.maxRedirectUriBytes
    );
    expect(result.truncated).toBe(true);
    expect(result.redirectUriCount).toBe(registered.length);
    expect(ruleIds(result)).toStrictEqual(['OCS-006']);
    expect(result.status).toBe('warning');
  });

  test('counts redirect URI bytes rather than UTF-16 code units', () => {
    const multiByteUri = 'https://app.example.com/cb/' + '€'.repeat(700);
    const registered = [multiByteUri, multiByteUri + '/second'];

    const result = lintOAuthClient(client({ redirectUris: registered }));

    expect(registered.join('').length).toBeLessThan(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUriBytes);
    expect(Buffer.byteLength(registered.join(''), 'utf8')).toBeGreaterThan(
      OAUTH_CLIENT_LINT_BUDGET.maxRedirectUriBytes
    );
    expect(result.redirectUris).toStrictEqual([multiByteUri]);
    expect(result.truncated).toBe(true);
    expect(result.redirectUriCount).toBe(2);
  });

  test('reads no redirect URI when the first one exceeds the byte ceiling, and does not call it unconfigured', () => {
    const registered = ['https://app.example.com/cb/' + 'a'.repeat(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUriBytes)];

    const result = lintOAuthClient(client({ redirectUris: registered }));

    expect(result.redirectUris).toStrictEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.redirectUriCount).toBe(1);
    expect(findingsForRule(result, 'OCS-005')).toStrictEqual([]);
    expect(ruleIds(result)).toStrictEqual(['OCS-006']);
    expect(result.status).toBe('warning');
  });

  test('emits no more findings than the finding ceiling allows for one client', () => {
    const registered = Array.from(
      { length: OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris },
      (_, index) => 'https://app' + index + '.example.com/?next=*'
    );

    const result = lintOAuthClient(client({ redirectUris: registered }), { partialRedirectMatchEnabled: true });

    expect(result.findings.length).toBeLessThanOrEqual(OAUTH_CLIENT_LINT_BUDGET.maxFindings);
    expect(result.redirectUris.length).toBeLessThan(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris);
    expect(result.findings.filter((finding) => finding.ruleId !== 'OCS-006')).toHaveLength(
      result.redirectUris.length * 3
    );
    expect(ruleIds(result).slice(0, 3)).toStrictEqual(['OCS-001', 'OCS-002', 'OCS-003']);
    expect(onlyFindingForRule(result, 'OCS-006').status).toBe('warning');
    expect(result.truncated).toBe(true);
    expect(result.redirectUriCount).toBe(registered.length);
    expect(result.status).toBe('fail');
  });

  test('never reports a truncated evaluation as free of risky patterns', () => {
    const registered = [
      ...Array.from(
        { length: OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris },
        (_, index) => 'https://app' + index + '.example.com/oauth/callback'
      ),
      'https://app.example.com/*',
    ];

    const result = lintOAuthClient(client({ redirectUris: registered }));

    expect(result.redirectUris).not.toContain('https://app.example.com/*');
    expect(result.truncated).toBe(true);
    expect(ruleIds(result)).toStrictEqual(['OCS-006']);
    expect(onlyFindingForRule(result, 'OCS-006').reason).toBe(EVALUATION_TRUNCATED_REASON);
    expect(onlyFindingForRule(result, 'OCS-006').remediation).toBe(EVALUATION_TRUNCATED_REMEDIATION);
    expect(result.status).toBe('warning');
  });

  test('evaluates the same against a prepared registration index as against the entry list', () => {
    const entries: RegistrationDiscoverableClient[] = [
      { id: 'first-entry', redirectUris: ['https://first.example.com/cb'], source: 'built-in' },
      { id: TEST_CLIENT_ID, redirectUris: ['https://second.example.com/cb'], source: 'config' },
    ];
    const index = indexRegistrationDiscoverableClients(entries);
    const subjects = [
      client({ id: TEST_CLIENT_ID, redirectUris: ['https://app.example.com/oauth/callback'] }),
      client({ id: 'other-client', redirectUris: ['https://first.example.com/cb'] }),
      client({ id: 'unmatched-client', redirectUris: ['https://app.example.com/oauth/callback'] }),
    ];

    for (const subject of subjects) {
      expect(lintOAuthClient(subject, { registrationDiscoverableClients: index })).toStrictEqual(
        lintOAuthClient(subject, { registrationDiscoverableClients: entries })
      );
    }

    expect(index.entries).toStrictEqual(entries);
    expect(ruleIds(lintOAuthClient(subjects[0], { registrationDiscoverableClients: index }))).toStrictEqual([
      'OCS-004',
    ]);
    expect(ruleIds(lintOAuthClient(subjects[2], { registrationDiscoverableClients: index }))).toStrictEqual([]);
  });

  test('matches registration discoverable clients against the redirect URIs it read', () => {
    const registered = bareOriginUris(OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris + 1);
    const subject = client({ redirectUris: registered });

    const beyondCeiling = lintOAuthClient(subject, {
      registrationDiscoverableClients: [
        { id: 'unrelated-entry', redirectUris: [registered[registered.length - 1]], source: 'config' },
      ],
    });
    const withinCeiling = lintOAuthClient(subject, {
      registrationDiscoverableClients: [{ id: 'unrelated-entry', redirectUris: [registered[0]], source: 'config' }],
    });

    expect(beyondCeiling.truncated).toBe(true);
    expect(findingsForRule(beyondCeiling, 'OCS-004')).toStrictEqual([]);
    expect(withinCeiling.truncated).toBe(true);
    expect(onlyFindingForRule(withinCeiling, 'OCS-004').redirectUri).toBe(registered[0]);
  });

  test('returns the same result twice and leaves both arguments unchanged', () => {
    const subject = client({
      id: 'purity-client',
      name: 'Purity Client',
      redirectUri: 'https://legacy.example.com',
      redirectUris: ['https://app.example.com/*', 'https://app.example.com/oauth/callback'],
    });
    const options: OAuthClientLintOptions = {
      partialRedirectMatchEnabled: true,
      registrationDiscoverableClients: [{ id: 'purity-client', redirectUris: [], source: 'config' }],
    };
    const subjectBefore = structuredClone(subject);
    const optionsBefore = structuredClone(options);

    const first = lintOAuthClient(subject, options);
    const second = lintOAuthClient(subject, options);

    expect(first.id).toBe('purity-client');
    expect(first.name).toBe('Purity Client');
    expect(first.redirectUris).toStrictEqual([
      'https://legacy.example.com',
      'https://app.example.com/*',
      'https://app.example.com/oauth/callback',
    ]);
    expect(ruleIds(first)).toStrictEqual(['OCS-001', 'OCS-003', 'OCS-002', 'OCS-003', 'OCS-003', 'OCS-004']);
    expect(first.status).toBe('fail');
    expect(first).toStrictEqual(second);
    expect(subject).toStrictEqual(subjectBefore);
    expect(options).toStrictEqual(optionsBefore);
  });
});
