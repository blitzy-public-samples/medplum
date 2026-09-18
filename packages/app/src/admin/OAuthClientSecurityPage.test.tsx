// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { notifications } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import { DEFAULT_SEARCH_COUNT } from '@medplum/core';
import type { ClientApplication } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { act, fireEvent, renderAppRoutes, screen, waitFor } from '../test-utils/render';

const PROJECT_ID = '123';
const EM_DASH = '—';
const SKELETON_SELECTOR = '.mantine-Skeleton-root';
const NAME_COLUMN_INDEX = 0;
const REDIRECT_URI_COLUMN_INDEX = 1;
const SECURITY_COLUMN_INDEX = 2;

const EXACT_CLIENT_NAME = 'Exact Callback Client';
const WILDCARD_CLIENT_NAME = 'Wildcard Client';
const LEGACY_CLIENT_NAME = 'Legacy Callback Client';
const NO_URI_CLIENT_NAME = 'Unconfigured Client';
const EXACT_REDIRECT_URI = 'https://app.example.com/oauth/callback';
const WILDCARD_REDIRECT_URI = 'https://app.example.com/*';
const LEGACY_REDIRECT_URI = 'https://legacy.example.com/oauth/callback';
const REVIEWED_REDIRECT_URI = 'https://app.example.com/oauth/callback/reviewed';
const LINT_ERROR_MESSAGE = 'Security review is unavailable';
const MALFORMED_REPORT_MESSAGE = 'The OAuth client security review returned an unexpected response.';
const UNRECOGNIZED_STATUS = 'completed';

const DISPLAY_CLIENT_COUNT = 4;
const SECOND_PAGE_CLIENT_COUNT = 2;
const FILLER_CLIENT_COUNT = DEFAULT_SEARCH_COUNT + SECOND_PAGE_CLIENT_COUNT - DISPLAY_CLIENT_COUNT;

type LintStatus = 'pass' | 'warning' | 'fail';

interface LintFinding {
  readonly ruleId: string;
  readonly status: LintStatus;
  readonly redirectUri?: string;
  readonly reason: string;
  readonly remediation: string;
}

interface LintResult {
  readonly id: string;
  readonly name?: string;
  readonly redirectUris: string[];
  readonly status: LintStatus;
  readonly findings: LintFinding[];
}

interface LintReport {
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly results: LintResult[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const medplum = new MockClient();
const originalGet = medplum.get.bind(medplum);

const clients: WithId<ClientApplication>[] = [];
const statusById = new Map<string, LintStatus>();
const idByName = new Map<string, string>();

let lintResponder: (url: string) => Promise<LintReport>;

/**
 * Creates a promise whose settlement is controlled by the caller.
 * @returns The pending promise together with its resolve and reject functions.
 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Creates a `ClientApplication` in the current project and records its expected security status.
 * @param name - The client name, used as the row handle in assertions.
 * @param status - The security status the stubbed report returns for this client.
 * @param config - Additional `ClientApplication` fields, such as the redirect URIs.
 */
async function seedClient(name: string, status: LintStatus, config: Partial<ClientApplication> = {}): Promise<void> {
  const created = await medplum.createResource<ClientApplication>({
    resourceType: 'ClientApplication',
    ...config,
    name,
    meta: { project: PROJECT_ID },
  });
  clients.push(created);
  statusById.set(created.id, status);
  idByName.set(name, created.id);
}

function idFor(name: string): string {
  const id = idByName.get(name);
  if (!id) {
    throw new Error(`No seeded client named "${name}"`);
  }
  return id;
}

function getRequestedIds(url: string): string[] {
  const query = url.slice(url.indexOf('?') + 1);
  return new URLSearchParams(query).get('_id')?.split(',') ?? [];
}

/**
 * Builds a security report for the given client ids.
 * @param ids - The client ids the report covers.
 * @param status - An optional status applied to every id, overriding the seeded status.
 * @returns The report envelope the endpoint returns.
 */
function buildReport(ids: string[], status?: LintStatus): LintReport {
  const results = ids.map((id) => buildResult(id, status ?? statusById.get(id) ?? 'pass'));
  return { total: results.length, offset: 0, count: DEFAULT_SEARCH_COUNT, results };
}

function buildResult(id: string, status: LintStatus): LintResult {
  const client = clients.find((c) => c.id === id);
  const redirectUris = [...(client?.redirectUri ? [client.redirectUri] : []), ...(client?.redirectUris ?? [])];
  return { id, name: client?.name, redirectUris, status, findings: [] };
}

/**
 * Replaces fields of the report results whose client id appears in the overrides.
 * @param report - The report to rewrite.
 * @param overrides - The replacement fields, keyed by client id. Override values may violate the endpoint contract.
 * @returns The report carrying the replaced result fields.
 */
function overrideResults(report: LintReport, overrides: Record<string, Record<string, unknown>>): LintReport {
  return {
    ...report,
    results: report.results.map((result) => {
      const override = overrides[result.id];
      return override ? { ...result, ...override } : result;
    }),
  };
}

function lintCallUrls(client: MockClient = medplum): string[] {
  return vi
    .mocked(client.get)
    .mock.calls.map((call) => String(call[0]))
    .filter((url) => url.includes('/oauth-security'));
}

function getRow(name: string): HTMLTableRowElement {
  const row = screen.getByText(name).closest('tr');
  if (!row) {
    throw new Error(`No table row found for "${name}"`);
  }
  return row;
}

function getCell(name: string, columnIndex: number): HTMLTableCellElement {
  const cell = getRow(name).querySelectorAll('td')[columnIndex];
  if (!cell) {
    throw new Error(`No column ${columnIndex} found for "${name}"`);
  }
  return cell;
}

/**
 * Reads the text of one cell of the table row holding the given client name.
 * @param name - The client name.
 * @param columnIndex - The zero-based column index.
 * @returns The cell text, which is empty while a skeleton placeholder is rendered.
 */
function getCellText(name: string, columnIndex: number): string {
  return getCell(name, columnIndex).textContent ?? '';
}

function getSecurityCellText(name: string): string {
  return getCellText(name, SECURITY_COLUMN_INDEX);
}

function getRedirectUriCellText(name: string): string {
  return getCellText(name, REDIRECT_URI_COLUMN_INDEX);
}

/**
 * Builds the redirect URI cell text expected from the search row alone, with no security evaluation resolved.
 * @param name - The client name.
 * @returns The redirect URIs of the seeded client as one cell string, or the empty placeholder when it has none.
 */
function expectedRowRedirectUriText(name: string): string {
  const client = clients.find((c) => c.id === idFor(name));
  const uris = [...(client?.redirectUri ? [client.redirectUri] : []), ...(client?.redirectUris ?? [])];
  return uris.length > 0 ? uris.join('') : EM_DASH;
}

function renderedClientNames(): string[] {
  return screen
    .getAllByTestId('search-control-row')
    .map((row) => row.querySelectorAll('td')[NAME_COLUMN_INDEX]?.textContent ?? '');
}

function renderedClientIds(): string[] {
  return renderedClientNames().map(idFor);
}

function skeletonCount(): number {
  return document.querySelectorAll(SKELETON_SELECTOR).length;
}

/**
 * Asserts that two collections of client ids hold the same ids, whatever their order.
 * @param actual - The ids to check.
 * @param expected - The ids the collection must hold.
 */
function expectSameIds(actual: string[], expected: string[]): void {
  const sort = (ids: string[]): string[] => [...ids].sort((a, b) => a.localeCompare(b));
  expect(sort(actual)).toStrictEqual(sort(expected));
}

async function setup(url = '/admin/oauth-security'): Promise<void> {
  renderAppRoutes(medplum, url);
}

describe('OAuthClientSecurityPage', () => {
  beforeAll(async () => {
    medplum.setActiveLoginOverride({
      accessToken: '123',
      refreshToken: '456',
      profile: {
        reference: 'Practitioner/124',
      },
      project: {
        reference: `Project/${PROJECT_ID}`,
      },
    });

    await seedClient(EXACT_CLIENT_NAME, 'pass', { redirectUris: [EXACT_REDIRECT_URI] });
    await seedClient(WILDCARD_CLIENT_NAME, 'fail', { redirectUris: [WILDCARD_REDIRECT_URI] });
    await seedClient(LEGACY_CLIENT_NAME, 'warning', { redirectUri: LEGACY_REDIRECT_URI });
    await seedClient(NO_URI_CLIENT_NAME, 'pass');
    for (let i = 0; i < FILLER_CLIENT_COUNT; i++) {
      await seedClient(`Filler Client ${i}`, 'pass', {
        redirectUris: [`https://filler-${i}.example.com/oauth/callback`],
      });
    }
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    lintResponder = (url) => Promise.resolve(buildReport(getRequestedIds(url)));
    vi.spyOn(medplum, 'get').mockImplementation((url, options) =>
      url.toString().includes('/oauth-security') ? (lintResponder(url.toString()) as any) : originalGet(url, options)
    );
    vi.spyOn(medplum, 'isProjectAdmin').mockImplementation(() => true);
    vi.spyOn(medplum, 'isSuperAdmin').mockImplementation(() => false);
  });

  afterEach(async () => {
    await act(async () => notifications.clean());
    vi.clearAllMocks();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    vi.useRealTimers();
  });

  test('Renders the read-only review, both computed columns and the security status of each client', async () => {
    await setup();

    expect(await screen.findByRole('heading', { name: 'OAuth Client Security' })).toBeInTheDocument();
    expect(screen.getByText(/read-only review/i)).toBeInTheDocument();
    expect(screen.getByText(/permission to read/i)).toBeInTheDocument();
    expect(screen.getByText('Redirect URIs')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();

    await waitFor(() => {
      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
    });

    expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
    expect(getSecurityCellText(LEGACY_CLIENT_NAME)).toBe('warning');
    expect(getRedirectUriCellText(LEGACY_CLIENT_NAME)).toBe(LEGACY_REDIRECT_URI);
    expect(getRedirectUriCellText(NO_URI_CLIENT_NAME)).toBe(EM_DASH);
    expectSameIds(getRequestedIds(lintCallUrls()[0]), renderedClientIds());
    expect(medplum.get).toHaveBeenCalledWith(lintCallUrls()[0], { cache: 'no-cache' });
    expect(skeletonCount()).toBe(0);
  });

  test('Renders the redirect URIs of the search row until the security evaluation resolves, then those of the evaluation', async () => {
    const deferred = createDeferred<LintReport>();
    lintResponder = () => deferred.promise;

    await setup();

    await waitFor(() => {
      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
    });

    expect(getRedirectUriCellText(EXACT_CLIENT_NAME)).toBe(EXACT_REDIRECT_URI);
    expect(getCell(EXACT_CLIENT_NAME, REDIRECT_URI_COLUMN_INDEX).querySelector(SKELETON_SELECTOR)).toBeNull();
    expect(getRedirectUriCellText(WILDCARD_CLIENT_NAME)).toBe(WILDCARD_REDIRECT_URI);
    expect(getRedirectUriCellText(LEGACY_CLIENT_NAME)).toBe(LEGACY_REDIRECT_URI);
    expect(getRedirectUriCellText(NO_URI_CLIENT_NAME)).toBe(EM_DASH);

    const requestedIds = getRequestedIds(lintCallUrls()[0]);
    await act(async () => {
      deferred.resolve(
        overrideResults(buildReport(requestedIds), {
          [idFor(EXACT_CLIENT_NAME)]: { redirectUris: [REVIEWED_REDIRECT_URI] },
          [idFor(WILDCARD_CLIENT_NAME)]: { redirectUris: [] },
        })
      );
    });

    await waitFor(() => {
      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
    });

    expect(getRedirectUriCellText(EXACT_CLIENT_NAME)).toBe(REVIEWED_REDIRECT_URI);
    expect(screen.queryByText(EXACT_REDIRECT_URI)).not.toBeInTheDocument();
    expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
    expect(getRedirectUriCellText(WILDCARD_CLIENT_NAME)).toBe(EM_DASH);
    expect(getRedirectUriCellText(LEGACY_CLIENT_NAME)).toBe(LEGACY_REDIRECT_URI);
    expect(getRedirectUriCellText(NO_URI_CLIENT_NAME)).toBe(EM_DASH);
  });

  test('Shows the OAuth Security tab in the admin navigation', async () => {
    await setup('/admin/details');

    expect(await screen.findByRole('tab', { name: 'OAuth Security' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'OAuth Security' })).toHaveAttribute('href', '/admin/oauth-security');
  });

  test('Clicking a row opens the security detail view for that client', async () => {
    await setup();

    await waitFor(() => {
      expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
    });

    await act(async () => {
      fireEvent.click(getRow(WILDCARD_CLIENT_NAME));
    });

    expect(await screen.findByRole('heading', { name: WILDCARD_CLIENT_NAME })).toBeInTheDocument();
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(lintCallUrls()[1]).toContain('_id=' + idFor(WILDCARD_CLIENT_NAME));
  });

  test('Auxiliary-clicking a row opens the security detail view for that client', async () => {
    await setup();

    await waitFor(() => {
      expect(getSecurityCellText(LEGACY_CLIENT_NAME)).toBe('warning');
    });

    await act(async () => {
      fireEvent.click(getRow(LEGACY_CLIENT_NAME), { ctrlKey: true });
    });

    expect(await screen.findByRole('heading', { name: LEGACY_CLIENT_NAME })).toBeInTheDocument();
    expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
    expect(lintCallUrls()[1]).toContain('_id=' + idFor(LEGACY_CLIENT_NAME));
  });

  test('Requests no security report when the project has no OAuth clients', async () => {
    const emptyMedplum = new MockClient();
    emptyMedplum.setActiveLoginOverride({
      accessToken: '123',
      refreshToken: '456',
      profile: {
        reference: 'Practitioner/124',
      },
      project: {
        reference: `Project/${PROJECT_ID}`,
      },
    });
    const emptyOriginalGet = emptyMedplum.get.bind(emptyMedplum);
    vi.spyOn(emptyMedplum, 'get').mockImplementation((url, options) =>
      url.toString().includes('/oauth-security')
        ? (lintResponder(url.toString()) as any)
        : emptyOriginalGet(url, options)
    );
    vi.spyOn(emptyMedplum, 'isProjectAdmin').mockImplementation(() => true);
    vi.spyOn(emptyMedplum, 'isSuperAdmin').mockImplementation(() => false);

    renderAppRoutes(emptyMedplum, '/admin/oauth-security');

    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'OAuth Client Security' })).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(lintCallUrls(emptyMedplum)).toHaveLength(0);
    expect(skeletonCount()).toBe(0);
  });

  test('Advancing the pagination control requests the security status of the next page', async () => {
    await setup();

    await waitFor(() => {
      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
    });
    expect(lintCallUrls()).toHaveLength(1);
    const firstPageRequestIds = getRequestedIds(lintCallUrls()[0]);
    expect(firstPageRequestIds).toHaveLength(DEFAULT_SEARCH_COUNT);
    expectSameIds(firstPageRequestIds, renderedClientIds());

    expect(await screen.findByLabelText('Next page')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Next page'));
    });

    await waitFor(() => {
      expect(lintCallUrls()).toHaveLength(2);
    });
    await waitFor(() => {
      expect(renderedClientNames()).toHaveLength(SECOND_PAGE_CLIENT_COUNT);
    });

    const secondPageRequestIds = getRequestedIds(lintCallUrls()[1]);
    expectSameIds(secondPageRequestIds, renderedClientIds());
    expect(secondPageRequestIds.filter((id) => firstPageRequestIds.includes(id))).toStrictEqual([]);

    const nextPageNames = renderedClientNames();
    await waitFor(() => {
      expect(getSecurityCellText(nextPageNames[0])).toBe('pass');
    });
    for (const name of nextPageNames) {
      expect(getSecurityCellText(name)).toBe('pass');
    }
    expect(skeletonCount()).toBe(0);
    expect(screen.queryByText(EXACT_CLIENT_NAME)).not.toBeInTheDocument();
  });

  describe('Security status settling', () => {
    test('A security response for a previous page does not overwrite the current page', async () => {
      const deferreds: Deferred<LintReport>[] = [];
      lintResponder = () => {
        const deferred = createDeferred<LintReport>();
        deferreds.push(deferred);
        return deferred.promise;
      };

      await setup();

      await waitFor(() => {
        expect(lintCallUrls()).toHaveLength(1);
      });
      const firstPageRequestIds = getRequestedIds(lintCallUrls()[0]);

      expect(await screen.findByLabelText('Next page')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Next page'));
      });

      await waitFor(() => {
        expect(lintCallUrls()).toHaveLength(2);
      });
      await waitFor(() => {
        expect(renderedClientNames()).toHaveLength(SECOND_PAGE_CLIENT_COUNT);
      });

      const nextPageNames = renderedClientNames();
      await act(async () => {
        deferreds[1].resolve(buildReport(getRequestedIds(lintCallUrls()[1]), 'warning'));
      });

      await waitFor(() => {
        expect(getSecurityCellText(nextPageNames[0])).toBe('warning');
      });

      await act(async () => {
        deferreds[0].resolve(buildReport(firstPageRequestIds));
      });

      for (const name of nextPageNames) {
        expect(getSecurityCellText(name)).toBe('warning');
      }
      expect(skeletonCount()).toBe(0);
    });

    test('A delayed response for a superseded request covering the same clients does not overwrite the current one', async () => {
      const deferreds: Deferred<LintReport>[] = [];
      lintResponder = () => {
        const deferred = createDeferred<LintReport>();
        deferreds.push(deferred);
        return deferred.promise;
      };

      await setup();

      await waitFor(() => {
        expect(lintCallUrls()).toHaveLength(1);
      });
      const firstPageRequestIds = getRequestedIds(lintCallUrls()[0]);

      expect(await screen.findByLabelText('Next page')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Next page'));
      });

      await waitFor(() => {
        expect(lintCallUrls()).toHaveLength(2);
      });
      const secondPageRequestIds = getRequestedIds(lintCallUrls()[1]);

      expect(await screen.findByLabelText('Previous page')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Previous page'));
      });

      await waitFor(() => {
        expect(lintCallUrls()).toHaveLength(3);
      });
      expectSameIds(getRequestedIds(lintCallUrls()[2]), firstPageRequestIds);

      await act(async () => {
        deferreds[2].resolve(buildReport(firstPageRequestIds, 'fail'));
      });

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('fail');
      });

      await act(async () => {
        deferreds[0].resolve(buildReport(firstPageRequestIds, 'pass'));
        deferreds[1].resolve(buildReport(secondPageRequestIds, 'warning'));
      });

      for (const name of renderedClientNames()) {
        expect(getSecurityCellText(name)).toBe('fail');
      }
      expect(skeletonCount()).toBe(0);
    });

    test('A security response that omits a client settles that row to the empty status and its own redirect URIs', async () => {
      const omittedId = idFor(EXACT_CLIENT_NAME);
      const deferred = createDeferred<LintReport>();
      lintResponder = () => deferred.promise;

      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
      });

      const requestedIds = getRequestedIds(lintCallUrls()[0]);
      await act(async () => {
        deferred.resolve(buildReport(requestedIds.filter((id) => id !== omittedId)));
      });

      await waitFor(() => {
        expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
      });

      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe(EM_DASH);
      expect(getCell(EXACT_CLIENT_NAME, SECURITY_COLUMN_INDEX).querySelector(SKELETON_SELECTOR)).toBeNull();
      expect(getRedirectUriCellText(EXACT_CLIENT_NAME)).toBe(EXACT_REDIRECT_URI);
      expect(getRedirectUriCellText(WILDCARD_CLIENT_NAME)).toBe(WILDCARD_REDIRECT_URI);
      expect(skeletonCount()).toBe(0);
    });

    test('A failed security request settles every status, keeps the row redirect URIs and raises a notification', async () => {
      const deferred = createDeferred<LintReport>();
      lintResponder = () => deferred.promise;

      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
      });

      const loadingNames = renderedClientNames();
      expect(loadingNames).toHaveLength(DEFAULT_SEARCH_COUNT);
      expect(skeletonCount()).toBe(loadingNames.length);
      expect(getCell(EXACT_CLIENT_NAME, SECURITY_COLUMN_INDEX).querySelector(SKELETON_SELECTOR)).not.toBeNull();
      expect(getCell(EXACT_CLIENT_NAME, REDIRECT_URI_COLUMN_INDEX).querySelector(SKELETON_SELECTOR)).toBeNull();
      expect(getRedirectUriCellText(EXACT_CLIENT_NAME)).toBe(EXACT_REDIRECT_URI);

      await act(async () => {
        deferred.reject(new Error(LINT_ERROR_MESSAGE));
      });

      expect(await screen.findByText(LINT_ERROR_MESSAGE)).toBeInTheDocument();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe(EM_DASH);
      });

      expect(renderedClientNames()).toStrictEqual(loadingNames);
      for (const name of loadingNames) {
        const securityCell = getCell(name, SECURITY_COLUMN_INDEX);
        expect(securityCell.textContent).toBe(EM_DASH);
        expect(securityCell.querySelector(SKELETON_SELECTOR)).toBeNull();
        const redirectUriCell = getCell(name, REDIRECT_URI_COLUMN_INDEX);
        expect(redirectUriCell.textContent).toBe(expectedRowRedirectUriText(name));
        expect(redirectUriCell.querySelector(SKELETON_SELECTOR)).toBeNull();
      }
      expect(getRedirectUriCellText(EXACT_CLIENT_NAME)).toBe(EXACT_REDIRECT_URI);
      expect(getRedirectUriCellText(LEGACY_CLIENT_NAME)).toBe(LEGACY_REDIRECT_URI);
      expect(getRedirectUriCellText(NO_URI_CLIENT_NAME)).toBe(EM_DASH);
      expect(skeletonCount()).toBe(0);
    });
  });

  describe('Malformed security responses', () => {
    const malformedResultCases: [string, Record<string, unknown>][] = [
      ['an unrecognized aggregate status', { status: UNRECOGNIZED_STATUS }],
      ['no aggregate status', { status: undefined }],
      ['no client id', { id: undefined }],
      ['no redirect URI list', { redirectUris: undefined }],
      [
        'a finding with an unrecognized status',
        {
          findings: [
            { ruleId: 'OCS-001', status: UNRECOGNIZED_STATUS, reason: 'Registered as an origin', remediation: 'None' },
          ],
        },
      ],
    ];

    test.each(malformedResultCases)(
      'Settles a client whose security result carries %s and reports the response',
      async (_description, override) => {
        lintResponder = (url) =>
          Promise.resolve(overrideResults(buildReport(getRequestedIds(url)), { [idFor(EXACT_CLIENT_NAME)]: override }));

        await setup();

        await waitFor(() => {
          expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
        });

        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe(EM_DASH);
        expect(getCell(EXACT_CLIENT_NAME, SECURITY_COLUMN_INDEX).querySelector(SKELETON_SELECTOR)).toBeNull();
        expect(screen.queryByText(UNRECOGNIZED_STATUS)).not.toBeInTheDocument();
        expect(getRedirectUriCellText(EXACT_CLIENT_NAME)).toBe(EXACT_REDIRECT_URI);
        expect(await screen.findByText(MALFORMED_REPORT_MESSAGE)).toBeInTheDocument();
        expect(skeletonCount()).toBe(0);
      }
    );

    test('Settles every row when the security response is not a report envelope', async () => {
      lintResponder = () => Promise.resolve({ ok: true } as unknown as LintReport);

      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe(EM_DASH);
      });

      expect(await screen.findByText(MALFORMED_REPORT_MESSAGE)).toBeInTheDocument();
      for (const name of renderedClientNames()) {
        expect(getSecurityCellText(name)).toBe(EM_DASH);
        expect(getRedirectUriCellText(name)).toBe(expectedRowRedirectUriText(name));
      }
      expect(screen.getByText(LEGACY_REDIRECT_URI)).toBeInTheDocument();
      expect(skeletonCount()).toBe(0);
    });
  });

  test('Renders the review for a super administrator who is not a project administrator', async () => {
    vi.spyOn(medplum, 'isProjectAdmin').mockImplementation(() => false);
    vi.spyOn(medplum, 'isSuperAdmin').mockImplementation(() => true);

    await setup();

    expect(await screen.findByRole('heading', { name: 'OAuth Client Security' })).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.queryByText('Forbidden')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
    });

    expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
    expect(lintCallUrls()).toHaveLength(1);
  });

  test('Renders the forbidden alert instead of the table for a non-administrator (UI gating only)', async () => {
    vi.spyOn(medplum, 'isProjectAdmin').mockImplementation(() => false);
    vi.spyOn(medplum, 'isSuperAdmin').mockImplementation(() => false);

    await setup();

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(screen.queryByText('Security')).not.toBeInTheDocument();
    expect(screen.queryByText(EXACT_CLIENT_NAME)).not.toBeInTheDocument();
    expect(lintCallUrls()).toHaveLength(0);
  });
});
