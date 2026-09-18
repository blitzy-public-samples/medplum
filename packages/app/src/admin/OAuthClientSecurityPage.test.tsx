// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { notifications } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import { DEFAULT_SEARCH_COUNT } from '@medplum/core';
import type { ClientApplication } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import type { MockInstance } from 'vitest';
import { act, fireEvent, renderAppRoutes, screen, waitFor } from '../test-utils/render';

const PROJECT_ID = '123';
const EM_DASH = '—';
const REDIRECT_URI_COLUMN_INDEX = 1;
const SECURITY_COLUMN_INDEX = 2;

const EXACT_CLIENT_NAME = 'Exact Callback Client';
const WILDCARD_CLIENT_NAME = 'Wildcard Client';
const LEGACY_CLIENT_NAME = 'Legacy Callback Client';
const NO_URI_CLIENT_NAME = 'Unconfigured Client';
const LEGACY_REDIRECT_URI = 'https://legacy.example.com/oauth/callback';
const LINT_ERROR_MESSAGE = 'Security review is unavailable';

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
const clientNames: string[] = [];
const statusById = new Map<string, LintStatus>();

let lintResponder: (url: string) => Promise<LintReport>;
let getSpy: MockInstance;

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
  clientNames.push(name);
  statusById.set(created.id, status);
}

/**
 * Reads the `_id` list from a security report request URL.
 * @param url - The request URL.
 * @returns The requested client ids in request order.
 */
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

/**
 * Builds a single security report result.
 * @param id - The client id.
 * @param status - The aggregate security status.
 * @returns The result entry for one client.
 */
function buildResult(id: string, status: LintStatus): LintResult {
  const client = clients.find((c) => c.id === id);
  const redirectUris = [...(client?.redirectUri ? [client.redirectUri] : []), ...(client?.redirectUris ?? [])];
  return { id, name: client?.name, redirectUris, status, findings: [] };
}

/**
 * Returns the security report request URLs issued so far.
 * @returns The request URLs, in call order.
 */
function lintCallUrls(): string[] {
  return getSpy.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/oauth-security'));
}

/**
 * Reads the text of one cell of the table row holding the given client name.
 * @param name - The client name.
 * @param columnIndex - The zero-based column index.
 * @returns The cell text, which is empty while a skeleton placeholder is rendered.
 */
function getCellText(name: string, columnIndex: number): string {
  const row = screen.getByText(name).closest('tr');
  if (!row) {
    throw new Error(`No table row found for "${name}"`);
  }
  return row.querySelectorAll('td')[columnIndex]?.textContent ?? '';
}

function getSecurityCellText(name: string): string {
  return getCellText(name, SECURITY_COLUMN_INDEX);
}

function getRedirectUriCellText(name: string): string {
  return getCellText(name, REDIRECT_URI_COLUMN_INDEX);
}

function firstPageIds(): string[] {
  return clients.slice(0, DEFAULT_SEARCH_COUNT).map((client) => client.id);
}

function secondPageIds(): string[] {
  return clients.slice(DEFAULT_SEARCH_COUNT).map((client) => client.id);
}

function secondPageNames(): string[] {
  return clientNames.slice(DEFAULT_SEARCH_COUNT);
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

    await seedClient(EXACT_CLIENT_NAME, 'pass', { redirectUris: ['https://app.example.com/oauth/callback'] });
    await seedClient(WILDCARD_CLIENT_NAME, 'fail', { redirectUris: ['https://app.example.com/*'] });
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
    getSpy = vi
      .spyOn(medplum, 'get')
      .mockImplementation((url, options) =>
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
    expect(getRequestedIds(lintCallUrls()[0])).toStrictEqual(firstPageIds());
  });

  test('Shows the OAuth Security tab in the admin navigation', async () => {
    await setup('/admin/details');

    expect(await screen.findByRole('tab', { name: 'OAuth Security' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'OAuth Security' })).toHaveAttribute('href', '/admin/oauth-security');
  });

  test('Advancing the pagination control requests the security status of the next page', async () => {
    await setup();

    await waitFor(() => {
      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
    });
    expect(lintCallUrls()).toHaveLength(1);
    expect(getRequestedIds(lintCallUrls()[0])).toStrictEqual(firstPageIds());

    expect(await screen.findByLabelText('Next page')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Next page'));
    });

    await waitFor(() => {
      expect(lintCallUrls()).toHaveLength(2);
    });

    expect(getRequestedIds(lintCallUrls()[1])).toStrictEqual(secondPageIds());
    expect(getRequestedIds(lintCallUrls()[1])).not.toStrictEqual(firstPageIds());

    const nextPageNames = secondPageNames();
    await waitFor(() => {
      expect(getSecurityCellText(nextPageNames[0])).toBe('pass');
    });
    for (const name of nextPageNames) {
      expect(getSecurityCellText(name)).toBe('pass');
    }
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

      expect(await screen.findByLabelText('Next page')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Next page'));
      });

      await waitFor(() => {
        expect(lintCallUrls()).toHaveLength(2);
      });

      const nextPageNames = secondPageNames();
      await act(async () => {
        deferreds[1].resolve(buildReport(secondPageIds(), 'warning'));
      });

      await waitFor(() => {
        expect(getSecurityCellText(nextPageNames[0])).toBe('warning');
      });

      await act(async () => {
        deferreds[0].resolve(buildReport(firstPageIds()));
      });

      for (const name of nextPageNames) {
        expect(getSecurityCellText(name)).toBe('warning');
      }
    });

    test('A security response that omits a client settles that row to the empty placeholder', async () => {
      const omittedId = clients[0].id;
      const deferred = createDeferred<LintReport>();
      lintResponder = () => deferred.promise;

      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
      });

      await act(async () => {
        deferred.resolve(buildReport(firstPageIds().filter((id) => id !== omittedId)));
      });

      await waitFor(() => {
        expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
      });

      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe(EM_DASH);
    });

    test('A failed security request settles every row and raises a notification', async () => {
      const deferred = createDeferred<LintReport>();
      lintResponder = () => deferred.promise;

      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
      });

      await act(async () => {
        deferred.reject(new Error(LINT_ERROR_MESSAGE));
      });

      expect(await screen.findByText(LINT_ERROR_MESSAGE)).toBeInTheDocument();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe(EM_DASH);
      });
      expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe(EM_DASH);
    });
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
