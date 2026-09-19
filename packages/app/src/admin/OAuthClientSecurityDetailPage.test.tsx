// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { notifications } from '@mantine/notifications';
import { MockClient } from '@medplum/mock';
import type { RenderResult } from '../test-utils/render';
import { act, renderAppRoutes, screen, waitFor } from '../test-utils/render';

type OAuthClientLintStatus = 'pass' | 'warning' | 'fail';

interface OAuthClientLintFinding {
  readonly ruleId: string;
  readonly status: OAuthClientLintStatus;
  readonly redirectUri?: string;
  readonly reason: string;
  readonly remediation: string;
}

interface OAuthClientLintResult {
  readonly id: string;
  readonly name?: string;
  readonly redirectUris: string[];
  readonly status: OAuthClientLintStatus;
  readonly findings: OAuthClientLintFinding[];
}

interface OAuthClientLintReport {
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly results: OAuthClientLintResult[];
}

const OCS_001_REASON =
  "Registered as an origin with no callback path, so the authorization response is delivered to this host's root page. Any open redirect, third-party script or user-controlled content on that root page can forward the authorization code onwards, and a root page is rarely written with that responsibility in mind.";

const OCS_001_REMEDIATION =
  'Register the exact callback URL the application uses, including its path — for example https://app.example.com/oauth/callback — and remove the origin-only entry.';

const OCS_002_REASON =
  'Contains a wildcard. Redirect URIs are compared by exact string, so this entry never matches a real authorization request; where the same value is used on a server that does expand patterns, it authorises hosts or paths that were never intended.';

const OCS_002_REMEDIATION =
  'Replace the wildcard entry with one exact, fully qualified URL for each callback the application actually uses.';

const OCS_004_REASON =
  "A value belonging to this client also matches the server's built-in Medplum CLI client, which POST /oauth2/register serves without authentication: a caller presenting a matching redirect URI receives that built-in client's id and redirect URI list rather than this client's. No client secret is returned by that endpoint.";

const OCS_004_REMEDIATION =
  'The built-in client cannot be removed by configuration. Register a redirect URI that does not collide with it — the built-in client uses the loopback URI http://localhost:9615 — and give this client an id of its own.';

const OCS_005_REASON =
  'No redirect URI is configured, so this client cannot take part in a redirect-based authorization flow and no redirect risk applies.';

const OCS_005_REMEDIATION = 'None required.';

const BADGE_SELECTOR = '.mantine-Badge-root';
const BADGE_VARIANT = 'filled';
const SEVERITY_TEXT_COLOR = 'var(--mantine-color-black)';

const BADGE_FILLS: Record<OAuthClientLintStatus, string> = {
  pass: 'var(--mantine-color-green-6)',
  warning: 'var(--mantine-color-orange-6)',
  fail: 'var(--mantine-color-red-6)',
};

const ALERT_TINTS: Record<OAuthClientLintStatus, string> = {
  pass: 'var(--mantine-color-green-light)',
  warning: 'var(--mantine-color-yellow-light)',
  fail: 'var(--mantine-color-red-light)',
};

const CLIENT_ID = '9f8c1d4e-3b2a-4c5d-8e7f-1a2b3c4d5e6f';
const OTHER_CLIENT_ID = '5f6f9b2e-4a1c-4d5b-9e2f-0a1b2c3d4e5f';
const BARE_ORIGIN_URI = 'https://app.example.com';
const WILDCARD_URI = 'https://app.example.com/*';
const EXACT_URI = 'https://app.example.com/oauth/callback';
const LONG_BARE_ORIGIN_URI = 'https://' + 'b'.repeat(250) + '.example.com';
const LONG_NAME = 'qa-long-name-' + 'x'.repeat(107);
const RIGHT_TO_LEFT_OVERRIDE = '\u202E';
const POP_DIRECTIONAL_FORMATTING = '\u202C';
const BIDI_NAME = 'Bidi Detail Client ' + RIGHT_TO_LEFT_OVERRIDE + 'evil.moc' + POP_DIRECTIONAL_FORMATTING;
const ESCAPED_BIDI_NAME = 'Bidi Detail Client <U+202E>evil.moc<U+202C>';
const BIDI_URI = 'https://gpj.' + RIGHT_TO_LEFT_OVERRIDE + 'moc.kcatta' + POP_DIRECTIONAL_FORMATTING + '/cb*';
const ESCAPED_BIDI_URI = 'https://gpj.<U+202E>moc.kcatta<U+202C>/cb*';
const ERROR_MESSAGE = 'OAuth security report unavailable';
const NOT_VISIBLE_MESSAGE = 'This OAuth client is not visible in this project.';
const MALFORMED_REPORT_MESSAGE = 'The OAuth client security report could not be read.';
const INVALID_CLIENT_ID_MESSAGE = 'Invalid OAuth client id.';
const PAGE_TITLE = 'OAuth Client Security Details | Medplum';
const SENTINEL_TITLE = 'Medplum';

const medplum = new MockClient();
const originalGet = medplum.get.bind(medplum);

let lintReport: () => Promise<OAuthClientLintReport>;

function report(...results: OAuthClientLintResult[]): OAuthClientLintReport {
  return { total: results.length, offset: 0, count: 20, results };
}

function getLintRequestUrls(): string[] {
  return vi
    .mocked(medplum.get)
    .mock.calls.map(([url]) => url.toString())
    .filter((url) => url.includes('/oauth-security'));
}

/**
 * Asserts that the aggregate status badge renders the given status with the severity colour and label colour
 * of that status.
 * @param status - The aggregate status the badge must render.
 */
function expectAggregateBadge(status: OAuthClientLintStatus): void {
  const badge = screen.getByText(status).closest(BADGE_SELECTOR);
  expect(badge).toHaveAttribute('data-variant', BADGE_VARIANT);
  expect(badge).toHaveStyle({ '--badge-bg': BADGE_FILLS[status], color: SEVERITY_TEXT_COLOR });
}

/**
 * Asserts that one finding's alert renders the severity tint of the finding's own status, and its rule id in
 * the colour the alert body already uses.
 * @param ruleId - The rule id the alert is titled with.
 * @param status - The status of that finding.
 */
function expectFindingAlert(ruleId: string, status: OAuthClientLintStatus): void {
  const alert = screen.getByText(ruleId).closest('[role="region"]');
  expect(alert).toHaveStyle({ '--alert-bg': ALERT_TINTS[status], color: SEVERITY_TEXT_COLOR });
}

/**
 * Renders the application routes at the detail view for one OAuth client.
 * @param url - The URL to render.
 */
async function setup(url = '/admin/oauth-security/' + CLIENT_ID): Promise<void> {
  await act(async () => {
    renderAppRoutes(medplum, url);
  });
}

const DEEP_LINK_CLIENT_ID = '2d3e4f50-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

const REJECTED_ROUTE_PARAMS: { readonly name: string; readonly routeParam: string }[] = [
  { name: 'is not a UUID', routeParam: 'partner-portal' },
  { name: 'names two client ids', routeParam: CLIENT_ID + ',' + OTHER_CLIENT_ID },
  { name: 'carries an encoded query delimiter', routeParam: CLIENT_ID + '%26_offset%3D1' },
];

const MALFORMED_REPORTS: { readonly name: string; readonly payload: unknown }[] = [
  { name: 'the report carries no result list', payload: { total: 1, offset: 0, count: 20 } },
  {
    name: 'the aggregate status is not a known status',
    payload: {
      total: 1,
      offset: 0,
      count: 20,
      results: [
        { id: CLIENT_ID, name: 'Partner Portal', redirectUris: [EXACT_URI], status: 'completed', findings: [] },
      ],
    },
  },
  {
    name: 'a finding status is not a known status',
    payload: {
      total: 1,
      offset: 0,
      count: 20,
      results: [
        {
          id: CLIENT_ID,
          name: 'Partner Portal',
          redirectUris: [WILDCARD_URI],
          status: 'fail',
          findings: [
            {
              ruleId: 'OCS-002',
              status: 'completed',
              redirectUri: WILDCARD_URI,
              reason: OCS_002_REASON,
              remediation: OCS_002_REMEDIATION,
            },
          ],
        },
      ],
    },
  },
  {
    name: 'the finding list is not a list of findings',
    payload: {
      total: 1,
      offset: 0,
      count: 20,
      results: [{ id: CLIENT_ID, name: 'Partner Portal', redirectUris: [EXACT_URI], status: 'pass', findings: '' }],
    },
  },
];

describe('OAuthClientSecurityDetailPage', () => {
  beforeAll(() => {
    medplum.setActiveLoginOverride({
      accessToken: '123',
      refreshToken: '456',
      profile: {
        reference: 'Practitioner/124',
      },
      project: {
        reference: 'Project/123',
      },
    });
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(medplum, 'isProjectAdmin').mockImplementation(() => true);
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        name: 'Partner Portal',
        redirectUris: [WILDCARD_URI, BARE_ORIGIN_URI],
        status: 'fail',
        findings: [
          {
            ruleId: 'OCS-002',
            status: 'fail',
            redirectUri: WILDCARD_URI,
            reason: OCS_002_REASON,
            remediation: OCS_002_REMEDIATION,
          },
          {
            ruleId: 'OCS-001',
            status: 'warning',
            redirectUri: BARE_ORIGIN_URI,
            reason: OCS_001_REASON,
            remediation: OCS_001_REMEDIATION,
          },
        ],
      });
    vi.spyOn(medplum, 'get').mockImplementation((url, options) =>
      url.toString().includes('/oauth-security') ? (lintReport() as any) : originalGet(url, options)
    );
  });

  afterEach(async () => {
    await act(async () => notifications.clean());
    vi.clearAllMocks();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    vi.useRealTimers();
  });

  test('Shows the offending redirect URI, reason and suggested fix for each finding', async () => {
    await setup();

    expect(await screen.findByText('Partner Portal')).toBeInTheDocument();
    expect(screen.getByText('fail')).toBeInTheDocument();

    expect(screen.getByText('OCS-001')).toBeInTheDocument();
    expect(screen.getByText(BARE_ORIGIN_URI)).toBeInTheDocument();
    expect(screen.getByText(OCS_001_REASON)).toBeInTheDocument();
    expect(screen.getByText(OCS_001_REMEDIATION)).toBeInTheDocument();

    expect(screen.getByText('OCS-002')).toBeInTheDocument();
    expect(screen.getByText(WILDCARD_URI)).toBeInTheDocument();
    expect(screen.getByText(OCS_002_REASON)).toBeInTheDocument();
    expect(screen.getByText(OCS_002_REMEDIATION)).toBeInTheDocument();

    expect(screen.getAllByText('Suggested fix:')).toHaveLength(2);
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(screen.getByLabelText('Security status: fail')).toHaveTextContent('fail');
    expect(medplum.get).toHaveBeenCalledWith('admin/projects/123/oauth-security?_id=' + CLIENT_ID, {
      cache: 'no-cache',
    });
  });

  test('Renders the fail severity colour on the aggregate badge and the severity tint of each finding', async () => {
    await setup();

    expect(await screen.findByText('OCS-001')).toBeInTheDocument();

    expectAggregateBadge('fail');
    expectFindingAlert('OCS-002', 'fail');
    expectFindingAlert('OCS-001', 'warning');
  });

  test('Renders the pass and warning severity colours of a client whose findings carry both', async () => {
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        name: 'Unconfigured Client',
        redirectUris: [],
        status: 'warning',
        findings: [
          {
            ruleId: 'OCS-004',
            status: 'warning',
            reason: OCS_004_REASON,
            remediation: OCS_004_REMEDIATION,
          },
          {
            ruleId: 'OCS-005',
            status: 'pass',
            reason: OCS_005_REASON,
            remediation: OCS_005_REMEDIATION,
          },
        ],
      });

    await setup();

    expect(await screen.findByText('OCS-005')).toBeInTheDocument();

    expectAggregateBadge('warning');
    expectFindingAlert('OCS-004', 'warning');
    expectFindingAlert('OCS-005', 'pass');
  });

  test('Wraps an unbreakable redirect URI and client name inside the finding alert and the header', async () => {
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        name: LONG_NAME,
        redirectUris: [LONG_BARE_ORIGIN_URI],
        status: 'warning',
        findings: [
          {
            ruleId: 'OCS-001',
            status: 'warning',
            redirectUri: LONG_BARE_ORIGIN_URI,
            reason: OCS_001_REASON,
            remediation: OCS_001_REMEDIATION,
          },
        ],
      });

    await setup();

    const heading = await screen.findByRole('heading', { name: LONG_NAME });
    expect(heading.style.overflowWrap).toBe('anywhere');
    expect(heading.style.minWidth).toBe('0px');

    const uriText = screen.getByText(LONG_BARE_ORIGIN_URI);
    expect(uriText.style.overflowWrap).toBe('anywhere');

    const region = screen.getByRole('region', { name: 'OCS-001' });
    expect(region.querySelector('.mantine-Alert-body')).toHaveStyle({ minWidth: '0px' });
    expect(region.querySelector('.mantine-Alert-message')).toHaveStyle({ minWidth: '0px' });
    expect(screen.getByText(OCS_001_REASON)).toBeInTheDocument();
    expect(screen.getByText(OCS_001_REMEDIATION)).toBeInTheDocument();
  });

  test('Escapes bidirectional control characters in the heading and the finding URI line', async () => {
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        name: BIDI_NAME,
        redirectUris: [BIDI_URI],
        status: 'fail',
        findings: [
          {
            ruleId: 'OCS-002',
            status: 'fail',
            redirectUri: BIDI_URI,
            reason: OCS_002_REASON,
            remediation: OCS_002_REMEDIATION,
          },
        ],
      });

    await setup();

    const heading = await screen.findByRole('heading', { name: ESCAPED_BIDI_NAME });
    expect(heading.tagName).toBe('H4');
    expect(heading.textContent).toBe(ESCAPED_BIDI_NAME);

    const uriLine = screen.getByText(ESCAPED_BIDI_URI);
    expect(screen.getByRole('region', { name: 'OCS-002' })).toContainElement(uriLine);
    expect(screen.queryByText(BIDI_NAME)).not.toBeInTheDocument();
    expect(screen.queryByText(BIDI_URI)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
    expect(document.body.textContent).not.toContain(POP_DIRECTIONAL_FORMATTING);
    expect(screen.getByText(OCS_002_REASON)).toBeInTheDocument();
    expect(screen.getByText(OCS_002_REMEDIATION)).toBeInTheDocument();
  });

  test('Orders the findings by rule id rather than by the order the report returned them', async () => {
    await setup();

    expect(await screen.findByText('OCS-001')).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(2);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'OCS-001' })).toHaveTextContent(OCS_001_REASON);
    expect(screen.getByRole('region', { name: 'OCS-002' })).toHaveTextContent(OCS_002_REASON);
    expect(screen.getAllByText(/^OCS-\d{3}$/).map((title) => title.textContent)).toStrictEqual(['OCS-001', 'OCS-002']);
  });

  test('Renders two findings that share a rule and a redirect URI without a duplicate key error', async () => {
    const duplicateFinding: OAuthClientLintFinding = {
      ruleId: 'OCS-001',
      status: 'warning',
      redirectUri: BARE_ORIGIN_URI,
      reason: OCS_001_REASON,
      remediation: OCS_001_REMEDIATION,
    };
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        name: 'Duplicate Redirect URI Client',
        redirectUris: [BARE_ORIGIN_URI, BARE_ORIGIN_URI],
        status: 'warning',
        findings: [duplicateFinding, duplicateFinding],
      });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await setup();

      expect(await screen.findByText('Duplicate Redirect URI Client')).toBeInTheDocument();
      expect(screen.getAllByRole('region', { name: 'OCS-001' })).toHaveLength(2);
      expect(consoleError.mock.calls.map((args) => args.join(' '))).toStrictEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('Falls back to the client id when the report carries no client name', async () => {
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        redirectUris: [EXACT_URI],
        status: 'pass',
        findings: [],
      });

    await setup();

    expect(await screen.findByRole('heading', { name: CLIENT_ID })).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
    expect(screen.getByText('No risky patterns detected.')).toBeInTheDocument();
  });

  test('Renders a finding that names no redirect URI', async () => {
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        name: 'Collision Client',
        redirectUris: [EXACT_URI],
        status: 'warning',
        findings: [
          {
            ruleId: 'OCS-004',
            status: 'warning',
            reason: OCS_004_REASON,
            remediation: OCS_004_REMEDIATION,
          },
        ],
      });

    await setup();

    expect(await screen.findByText('OCS-004')).toBeInTheDocument();
    expect(screen.getByText(OCS_004_REASON)).toBeInTheDocument();
    expect(screen.getByText(OCS_004_REMEDIATION)).toBeInTheDocument();
    expect(screen.getByText('Suggested fix:')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
    expect(screen.getByLabelText('Security status: warning')).toHaveTextContent('warning');
    expect(screen.queryByText(EXACT_URI)).not.toBeInTheDocument();
    expect(screen.getByRole('region').textContent).toBe(
      'OCS-004' + OCS_004_REASON + 'Suggested fix: ' + OCS_004_REMEDIATION
    );
  });

  test('Shows no risky patterns detected for a client with no findings', async () => {
    lintReport = async () =>
      report({
        id: CLIENT_ID,
        name: 'Exact Callback Client',
        redirectUris: [EXACT_URI],
        status: 'pass',
        findings: [],
      });

    await setup();

    expect(await screen.findByText('No risky patterns detected.')).toHaveAttribute('data-size', 'sm');
    expect(screen.getByText('Exact Callback Client')).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
    expect(screen.getByLabelText('Security status: pass')).toHaveTextContent('pass');
    expect(screen.queryByText('Suggested fix:')).not.toBeInTheDocument();
  });

  test('Shows the not visible message for a client outside the project', async () => {
    lintReport = async () => report();

    await setup();

    expect(await screen.findByText(NOT_VISIBLE_MESSAGE)).toHaveAttribute('data-size', 'sm');
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(document.querySelector('.mantine-Loader-root')).toBeNull();
  });

  test('Shows the operation outcome when the report request fails', async () => {
    lintReport = () => Promise.reject(new Error(ERROR_MESSAGE));

    await setup();

    expect(await screen.findByText(ERROR_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(ERROR_MESSAGE);
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(document.querySelector('.mantine-Loader-root')).toBeNull();
  });

  test.each(REJECTED_ROUTE_PARAMS)(
    'Requests no report and shows the invalid client id outcome when the route parameter $name',
    async ({ routeParam }) => {
      await setup('/admin/oauth-security/' + routeParam);

      expect(await screen.findByText(INVALID_CLIENT_ID_MESSAGE)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(INVALID_CLIENT_ID_MESSAGE);
      expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
      expect(screen.queryByText(NOT_VISIBLE_MESSAGE)).not.toBeInTheDocument();
      expect(screen.queryByText(routeParam)).not.toBeInTheDocument();
      expect(getLintRequestUrls()).toStrictEqual([]);
      expect(document.querySelector('.mantine-Loader-root')).toBeNull();
    }
  );

  test('Shows the not visible message when the report names a different client', async () => {
    lintReport = async () =>
      report({
        id: OTHER_CLIENT_ID,
        name: 'Another Project Client',
        redirectUris: [BARE_ORIGIN_URI],
        status: 'warning',
        findings: [
          {
            ruleId: 'OCS-001',
            status: 'warning',
            redirectUri: BARE_ORIGIN_URI,
            reason: OCS_001_REASON,
            remediation: OCS_001_REMEDIATION,
          },
        ],
      });

    await setup();

    expect(await screen.findByText(NOT_VISIBLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('Another Project Client')).not.toBeInTheDocument();
    expect(screen.queryByText(OCS_001_REASON)).not.toBeInTheDocument();
    expect(getLintRequestUrls()).toStrictEqual(['admin/projects/123/oauth-security?_id=' + CLIENT_ID]);
  });

  test('Shows the not visible message when the report names more than one client', async () => {
    lintReport = async () =>
      report(
        {
          id: CLIENT_ID,
          name: 'Routed Client',
          redirectUris: [EXACT_URI],
          status: 'pass',
          findings: [],
        },
        {
          id: OTHER_CLIENT_ID,
          name: 'Another Project Client',
          redirectUris: [WILDCARD_URI],
          status: 'fail',
          findings: [],
        }
      );

    await setup();

    expect(await screen.findByText(NOT_VISIBLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('Routed Client')).not.toBeInTheDocument();
    expect(screen.queryByText('Another Project Client')).not.toBeInTheDocument();
  });

  test.each(MALFORMED_REPORTS)('Shows an error outcome when $name', async ({ payload }) => {
    lintReport = async () => payload as OAuthClientLintReport;

    await setup();

    expect(await screen.findByText(MALFORMED_REPORT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(screen.queryByText('Partner Portal')).not.toBeInTheDocument();
    expect(screen.queryByText('completed')).not.toBeInTheDocument();
    expect(document.querySelector(BADGE_SELECTOR)).toBeNull();
    expect(screen.queryAllByRole('region')).toStrictEqual([]);
    expect(document.querySelector('.mantine-Loader-root')).toBeNull();
  });

  test('Ignores a report that settles after the detail view is closed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      let resolvePending!: (value: OAuthClientLintReport) => void;
      lintReport = () =>
        new Promise<OAuthClientLintReport>((resolve) => {
          resolvePending = resolve;
        });

      const resolvedVisit = renderAppRoutes(medplum, '/admin/oauth-security/' + CLIENT_ID);
      await waitFor(() => {
        expect(document.querySelector('.mantine-Loader-root')).not.toBeNull();
      });
      resolvedVisit.unmount();

      await act(async () => {
        resolvePending(
          report({
            id: CLIENT_ID,
            name: 'Partner Portal',
            redirectUris: [EXACT_URI],
            status: 'pass',
            findings: [],
          })
        );
      });

      expect(screen.queryByText('Partner Portal')).not.toBeInTheDocument();
      expect(screen.queryByText('pass')).not.toBeInTheDocument();

      let rejectPending!: (reason: unknown) => void;
      lintReport = () =>
        new Promise<OAuthClientLintReport>((_resolve, reject) => {
          rejectPending = reject;
        });

      const rejectedVisit = renderAppRoutes(medplum, '/admin/oauth-security/' + CLIENT_ID);
      await waitFor(() => {
        expect(document.querySelector('.mantine-Loader-root')).not.toBeNull();
      });
      rejectedVisit.unmount();

      await act(async () => {
        rejectPending(new Error(ERROR_MESSAGE));
      });

      expect(screen.queryByText(ERROR_MESSAGE)).not.toBeInTheDocument();
      expect(screen.queryByText('Back to OAuth Security')).not.toBeInTheDocument();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  describe('Document title', () => {
    test('Names the detail view in the document title while it is open, and restores the previous title on close', async () => {
      const titleBeforeTest = document.title;
      document.title = SENTINEL_TITLE;

      try {
        let visit!: RenderResult;
        await act(async () => {
          visit = renderAppRoutes(medplum, '/admin/oauth-security/' + CLIENT_ID);
        });

        expect(await screen.findByText('Partner Portal')).toBeInTheDocument();
        expect(document.title).toBe(PAGE_TITLE);

        await act(async () => {
          visit.unmount();
        });

        expect(document.title).toBe(SENTINEL_TITLE);
      } finally {
        document.title = titleBeforeTest;
      }
    });

    test('Names the detail view in the document title for a route parameter that is not a client id', async () => {
      const titleBeforeTest = document.title;
      document.title = SENTINEL_TITLE;

      try {
        let visit!: RenderResult;
        await act(async () => {
          visit = renderAppRoutes(medplum, '/admin/oauth-security/partner-portal');
        });

        expect(await screen.findByText(INVALID_CLIENT_ID_MESSAGE)).toBeInTheDocument();
        expect(document.title).toBe(PAGE_TITLE);

        await act(async () => {
          visit.unmount();
        });

        expect(document.title).toBe(SENTINEL_TITLE);
      } finally {
        document.title = titleBeforeTest;
      }
    });
  });

  test('Renders the detail view and the admin OAuth Security tab link on a direct deep link', async () => {
    lintReport = async () =>
      report({
        id: DEEP_LINK_CLIENT_ID,
        name: 'Deep Link Client',
        redirectUris: [WILDCARD_URI],
        status: 'fail',
        findings: [
          {
            ruleId: 'OCS-002',
            status: 'fail',
            redirectUri: WILDCARD_URI,
            reason: OCS_002_REASON,
            remediation: OCS_002_REMEDIATION,
          },
        ],
      });

    const deepLinkUrl = '/admin/oauth-security/' + DEEP_LINK_CLIENT_ID;
    const previousUrl = window.location.href;
    window.history.replaceState({}, '', deepLinkUrl);

    try {
      await setup(deepLinkUrl);

      expect(await screen.findByText('Deep Link Client')).toBeInTheDocument();
      expect(screen.getByText('OCS-002')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'OAuth Security' })).toHaveAttribute('href', '/admin/oauth-security');
      expect(screen.getByRole('tab', { name: 'OAuth Security' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      window.history.replaceState({}, '', previousUrl);
    }
  });
});
