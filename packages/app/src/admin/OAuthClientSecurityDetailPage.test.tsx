// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { notifications } from '@mantine/notifications';
import { MockClient } from '@medplum/mock';
import { act, renderAppRoutes, screen } from '../test-utils/render';

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

const CLIENT_ID = 'client-1';
const BARE_ORIGIN_URI = 'https://app.example.com';
const WILDCARD_URI = 'https://app.example.com/*';
const EXACT_URI = 'https://app.example.com/oauth/callback';
const ERROR_MESSAGE = 'OAuth security report unavailable';

const medplum = new MockClient();
const originalGet = medplum.get.bind(medplum);

let lintReport: () => Promise<OAuthClientLintReport>;

/**
 * Builds the OAuth client security endpoint envelope.
 * @param results - The lint results the stubbed endpoint returns.
 * @returns The report envelope the endpoint responds with.
 */
function report(...results: OAuthClientLintResult[]): OAuthClientLintReport {
  return { total: results.length, offset: 0, count: 20, results };
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
    expect(medplum.get).toHaveBeenCalledWith('admin/projects/123/oauth-security?_id=' + CLIENT_ID, {
      cache: 'no-cache',
    });
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

    expect(await screen.findByText('No risky patterns detected.')).toBeInTheDocument();
    expect(screen.getByText('Exact Callback Client')).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
    expect(screen.queryByText('Suggested fix:')).not.toBeInTheDocument();
  });

  test('Shows the not visible message for a client outside the project', async () => {
    lintReport = async () => report();

    await setup();

    expect(await screen.findByText('This OAuth client is not visible in this project.')).toBeInTheDocument();
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(document.querySelector('.mantine-Loader-root')).toBeNull();
  });

  test('Shows the operation outcome when the report request fails', async () => {
    lintReport = () => Promise.reject(new Error(ERROR_MESSAGE));

    await setup();

    expect(await screen.findByText(ERROR_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(document.querySelector('.mantine-Loader-root')).toBeNull();
  });
});
