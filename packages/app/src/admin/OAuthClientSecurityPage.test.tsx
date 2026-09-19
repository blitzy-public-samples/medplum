// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { rem } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import { DEFAULT_SEARCH_COUNT } from '@medplum/core';
import type { ClientApplication } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { act, fireEvent, renderAppRoutes, screen, waitFor } from '../test-utils/render';

const PROJECT_ID = '123';
const EM_DASH = '—';
const SKELETON_SELECTOR = '.mantine-Skeleton-root';
const STATUS_BADGE_SELECTOR = '.mantine-Badge-root';
const STATUS_BADGE_VARIANT = 'filled';
const STATUS_LABEL_COLOR = 'var(--mantine-color-black)';
const NAME_COLUMN_INDEX = 0;
const SECURITY_COLUMN_INDEX = 1;
const REDIRECT_URI_COLUMN_INDEX = 2;
const DETAILS_COLUMN_INDEX = 3;
const COLUMN_HEADERS = ['Name', 'Security', 'Redirect URIs', 'Details'];
const SECURITY_RESERVATION_SELECTOR = '[data-testid="security-status"]';
const DETAIL_LINK_TEXT = 'Review';
const STATUS_BADGE_HEIGHT = 20;
const WIDEST_STATUS_BADGE_WIDTH = 74;

const EXACT_CLIENT_NAME = 'Exact Callback Client';
const WILDCARD_CLIENT_NAME = 'Wildcard Client';
const LEGACY_CLIENT_NAME = 'Legacy Callback Client';
const NO_URI_CLIENT_NAME = 'Unconfigured Client';
const UNBROKEN_NAME_TOKEN = 'A'.repeat(4096);
const UNBROKEN_NAME_CLIENT_NAME = `Long Unbroken Name Client ${UNBROKEN_NAME_TOKEN}`;
const UNBROKEN_NAME_REDIRECT_URI = 'https://long-name.example.com/oauth/callback';
const EXACT_REDIRECT_URI = 'https://app.example.com/oauth/callback';
const WILDCARD_REDIRECT_URI = 'https://app.example.com/*';
const LEGACY_REDIRECT_URI = 'https://legacy.example.com/oauth/callback';
const REVIEWED_REDIRECT_URI = 'https://app.example.com/oauth/callback/reviewed';
const LINT_ERROR_MESSAGE = 'Security review is unavailable';
const MALFORMED_REPORT_MESSAGE = 'The OAuth client security review returned an unexpected response.';
const REQUEST_FAILED_MESSAGE = 'The OAuth client security review could not be loaded.';
const UNRECOGNIZED_STATUS = 'completed';
const SORT_PARAMETER = '_sort=name';
const FILTER_PARAMETER_PATTERN = /[?&]name/;
const COLUMN_MENU_OPTIONS = ['Contains...', 'Clear filters', 'Sort A to Z'];
const SEEDED_CLIENT_NAME = 'Seeded Callback Client';
const OUT_OF_BAND_CLIENT_NAME = 'Out Of Band Client';
const OUT_OF_BAND_REDIRECT_URI = 'https://out-of-band.example.com/oauth/callback';
const NAMELESS_REDIRECT_URI = 'https://nameless.example.com/oauth/callback';

const RIGHT_TO_LEFT_OVERRIDE = '\u202E';
const POP_DIRECTIONAL_FORMATTING = '\u202C';
const BIDI_CLIENT_NAME = `Bidi Name Client ${RIGHT_TO_LEFT_OVERRIDE}evil.moc${POP_DIRECTIONAL_FORMATTING}`;
const ESCAPED_BIDI_CLIENT_NAME = 'Bidi Name Client <U+202E>evil.moc<U+202C>';
const BIDI_REDIRECT_URI = `https://gpj.${RIGHT_TO_LEFT_OVERRIDE}moc.kcatta${POP_DIRECTIONAL_FORMATTING}/cb*`;
const ESCAPED_BIDI_REDIRECT_URI = 'https://gpj.<U+202E>moc.kcatta<U+202C>/cb*';

const HOSTILE_UPSTREAM_BODY =
  '<h1>Error: ENOENT no such file</h1> at Repository.search (/app/packages/server/dist/fhir/repo.js:1730:15) http://localhost:8291/admin/projects/secret-internal/oauth-security';
const HOSTILE_UPSTREAM_FRAGMENTS = [
  'ENOENT',
  'Repository.search',
  '/app/packages/server/dist/fhir/repo.js:1730:15',
  'localhost:8291',
  '/admin/projects/secret-internal/oauth-security',
];

const DISPLAY_CLIENT_COUNT = 5;
const SECOND_PAGE_CLIENT_COUNT = 2;
const FILLER_CLIENT_COUNT = DEFAULT_SEARCH_COUNT + SECOND_PAGE_CLIENT_COUNT - DISPLAY_CLIENT_COUNT;
const FILLER_CLIENT_NAME_PREFIX = 'Zz Filler Client ';

type LintStatus = 'pass' | 'warning' | 'fail';

const STATUS_BADGE_FILLS: Record<LintStatus, string> = {
  pass: 'var(--mantine-color-green-6)',
  warning: 'var(--mantine-color-orange-6)',
  fail: 'var(--mantine-color-red-6)',
};

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

function searchCallUrls(client: MockClient = medplum): string[] {
  return vi
    .mocked(client.get)
    .mock.calls.map((call) => String(call[0]))
    .filter((url) => url.includes('/ClientApplication?'));
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

/**
 * Reads the status badge rendered in the security cell of the table row holding the given client name.
 * @param name - The client name.
 * @returns The badge element carrying the resolved severity colour.
 */
function getSecurityBadge(name: string): HTMLElement {
  const badge = getCell(name, SECURITY_COLUMN_INDEX).querySelector<HTMLElement>(STATUS_BADGE_SELECTOR);
  if (!badge) {
    throw new Error(`No security badge found for "${name}"`);
  }
  return badge;
}

/**
 * Asserts that one row's security badge renders the given status with the severity colour and label colour
 * of that status.
 * @param name - The client name.
 * @param status - The security status the row must render.
 * @returns The severity fill the badge resolved, so a caller can compare the fills of several rows.
 */
function expectSecurityBadge(name: string, status: LintStatus): string {
  const badge = getSecurityBadge(name);
  expect(badge).toHaveTextContent(status);
  expect(badge).toHaveAttribute('data-variant', STATUS_BADGE_VARIANT);
  expect(badge).toHaveStyle({ '--badge-bg': STATUS_BADGE_FILLS[status], color: STATUS_LABEL_COLOR });
  return badge.style.getPropertyValue('--badge-bg');
}

/**
 * Reads the size the security cell of one row reserves for its status, whatever state that status is in.
 * @param name - The client name.
 * @returns The reserved minimum width and height declared on the security cell container.
 */
function getSecurityReservedSize(name: string): { width: string; height: string } {
  const reservation = getCell(name, SECURITY_COLUMN_INDEX).querySelector<HTMLElement>(SECURITY_RESERVATION_SELECTOR);
  if (!reservation) {
    throw new Error(`No security status container found for "${name}"`);
  }
  return { width: reservation.style.minWidth, height: reservation.style.minHeight };
}

/**
 * Reads the detail-view link of the table row holding the given client name.
 * @param name - The client name.
 * @returns The anchor element the row's Details cell renders.
 */
function getDetailLink(name: string): HTMLAnchorElement {
  const link = getCell(name, DETAILS_COLUMN_INDEX).querySelector('a');
  if (!link) {
    throw new Error(`No detail link found for "${name}"`);
  }
  return link;
}

function getColumnHeaders(): string[] {
  return Array.from(document.querySelectorAll('thead tr:first-child th')).map((th) => th.textContent ?? '');
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

/**
 * Creates a client whose security review is stubbed the same way as the shared client's.
 * @returns A client signed in as a project administrator, holding no OAuth clients yet.
 */
function createReviewerClient(): MockClient {
  const reviewer = new MockClient();
  reviewer.setActiveLoginOverride({
    accessToken: '123',
    refreshToken: '456',
    profile: {
      reference: 'Practitioner/124',
    },
    project: {
      reference: `Project/${PROJECT_ID}`,
    },
  });
  const reviewerOriginalGet = reviewer.get.bind(reviewer);
  vi.spyOn(reviewer, 'get').mockImplementation((url, options) =>
    url.toString().includes('/oauth-security')
      ? (lintResponder(url.toString()) as any)
      : reviewerOriginalGet(url, options)
  );
  vi.spyOn(reviewer, 'isProjectAdmin').mockImplementation(() => true);
  vi.spyOn(reviewer, 'isSuperAdmin').mockImplementation(() => false);
  return reviewer;
}

/**
 * Finds the table header cell carrying the given column name.
 * @param columnName - The column header text.
 * @returns The element holding the header text.
 */
function getColumnHeader(columnName: string): HTMLElement {
  const header = screen.getAllByText(columnName).find((element) => element.closest('th'));
  if (!header) {
    throw new Error(`No column header found for "${columnName}"`);
  }
  return header;
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
    await seedClient(UNBROKEN_NAME_CLIENT_NAME, 'pass', { redirectUris: [UNBROKEN_NAME_REDIRECT_URI] });
    for (let i = 0; i < FILLER_CLIENT_COUNT; i++) {
      await seedClient(`${FILLER_CLIENT_NAME_PREFIX}${i}`, 'pass', {
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

  test('Renders each security status with its own severity colour and a label colour legible on it', async () => {
    await setup();

    await waitFor(() => {
      expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
    });

    const fills = [
      expectSecurityBadge(EXACT_CLIENT_NAME, 'pass'),
      expectSecurityBadge(LEGACY_CLIENT_NAME, 'warning'),
      expectSecurityBadge(WILDCARD_CLIENT_NAME, 'fail'),
    ];

    expect(new Set(fills).size).toBe(fills.length);
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

  describe('Client list search semantics', () => {
    test('Requests the client list in a defined order', async () => {
      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
      });

      const requestedSearches = searchCallUrls();
      expect(requestedSearches.length).toBeGreaterThan(0);
      for (const url of requestedSearches) {
        expect(url).toContain(SORT_PARAMETER);
      }

      const names = renderedClientNames();
      expect(names).toStrictEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    test('Keeps the defined order when the pagination control moves to the next page', async () => {
      await setup();

      await waitFor(() => {
        expect(lintCallUrls()).toHaveLength(1);
      });

      expect(await screen.findByLabelText('Next page')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Next page'));
      });

      await waitFor(() => {
        expect(renderedClientNames()).toHaveLength(SECOND_PAGE_CLIENT_COUNT);
      });

      const nextPageSearch = searchCallUrls().at(-1) as string;
      expect(nextPageSearch).toContain(SORT_PARAMETER);
      expect(nextPageSearch).toContain('_offset=' + DEFAULT_SEARCH_COUNT);
      const names = renderedClientNames();
      expect(names).toStrictEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    test('Fetches the client list again when the review is reopened, so a client created elsewhere is listed', async () => {
      lintResponder = () => Promise.resolve({ total: 0, offset: 0, count: DEFAULT_SEARCH_COUNT, results: [] });
      const reviewer = createReviewerClient();
      await reviewer.createResource<ClientApplication>({
        resourceType: 'ClientApplication',
        name: SEEDED_CLIENT_NAME,
        redirectUris: [EXACT_REDIRECT_URI],
        meta: { project: PROJECT_ID },
      });

      const firstVisit = renderAppRoutes(reviewer, '/admin/oauth-security');
      expect(await screen.findByText(SEEDED_CLIENT_NAME)).toBeInTheDocument();
      const searchesOnFirstVisit = searchCallUrls(reviewer).length;
      expect(searchesOnFirstVisit).toBeGreaterThan(0);
      firstVisit.unmount();

      await reviewer.repo.createResource<ClientApplication>({
        resourceType: 'ClientApplication',
        name: OUT_OF_BAND_CLIENT_NAME,
        redirectUris: [OUT_OF_BAND_REDIRECT_URI],
        meta: { project: PROJECT_ID },
      });

      renderAppRoutes(reviewer, '/admin/oauth-security');

      expect(await screen.findByText(OUT_OF_BAND_CLIENT_NAME)).toBeInTheDocument();
      expect(screen.getByText(OUT_OF_BAND_REDIRECT_URI)).toBeInTheDocument();
      expect(searchCallUrls(reviewer).length).toBeGreaterThan(searchesOnFirstVisit);
    });

    test('Offers no way to narrow the review through the UI, and keeps requesting the defined order', async () => {
      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
      });

      const nameHeader = getColumnHeader('Name');
      expect(nameHeader.closest('button')).toBeNull();
      expect(document.querySelectorAll('thead button')).toHaveLength(0);
      expect(document.querySelector('thead [aria-sort]')).toBeNull();

      await act(async () => {
        fireEvent.click(nameHeader);
      });

      expect(document.querySelector('[role="menu"]')).toBeNull();
      for (const option of COLUMN_MENU_OPTIONS) {
        expect(screen.queryByText(option)).not.toBeInTheDocument();
      }
      expect(renderedClientNames()).toHaveLength(DEFAULT_SEARCH_COUNT);

      const requestedSearches = searchCallUrls();
      expect(requestedSearches.length).toBeGreaterThan(0);
      for (const url of requestedSearches) {
        expect(url).toContain(SORT_PARAMETER);
        expect(url).not.toMatch(FILTER_PARAMETER_PATTERN);
      }
    });
  });

  describe('Table cell layout and row navigation', () => {
    test('Places the security verdict in the column immediately after the client name', async () => {
      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
      });

      expect(getColumnHeaders()).toStrictEqual(COLUMN_HEADERS);
      expect(getCellText(EXACT_CLIENT_NAME, NAME_COLUMN_INDEX)).toBe(EXACT_CLIENT_NAME);
      expect(getRedirectUriCellText(EXACT_CLIENT_NAME)).toBe(EXACT_REDIRECT_URI);
    });

    test('Renders every redirect URI so a long value breaks inside its cell', async () => {
      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
      });

      for (const uri of [EXACT_REDIRECT_URI, WILDCARD_REDIRECT_URI, LEGACY_REDIRECT_URI]) {
        expect(getComputedStyle(screen.getByText(uri)).overflowWrap).toBe('anywhere');
      }
    });

    test('Renders a client name so an unbroken token breaks inside its cell', async () => {
      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(UNBROKEN_NAME_CLIENT_NAME)).toBe('pass');
      });

      const nameText = screen.getByText(UNBROKEN_NAME_CLIENT_NAME);
      expect(getComputedStyle(nameText).overflowWrap).toBe('anywhere');
      expect(getCell(UNBROKEN_NAME_CLIENT_NAME, NAME_COLUMN_INDEX)).toContainElement(nameText);
      expect(getCellText(UNBROKEN_NAME_CLIENT_NAME, NAME_COLUMN_INDEX)).toBe(UNBROKEN_NAME_CLIENT_NAME);
      expect(getComputedStyle(screen.getByText(UNBROKEN_NAME_REDIRECT_URI)).overflowWrap).toBe('anywhere');
      expect(getColumnHeaders()).toStrictEqual(COLUMN_HEADERS);
    });

    test('Marks the name cell empty for a client that carries no name, and names its detail link by id', async () => {
      const reviewer = createReviewerClient();
      const namelessClient = await reviewer.createResource<ClientApplication>({
        resourceType: 'ClientApplication',
        redirectUris: [NAMELESS_REDIRECT_URI],
        meta: { project: PROJECT_ID },
      });
      lintResponder = async () => ({
        total: 1,
        offset: 0,
        count: DEFAULT_SEARCH_COUNT,
        results: [
          {
            id: namelessClient.id,
            redirectUris: [NAMELESS_REDIRECT_URI],
            status: 'pass',
            findings: [],
          },
        ],
      });

      renderAppRoutes(reviewer, '/admin/oauth-security');

      expect(await screen.findByText(NAMELESS_REDIRECT_URI)).toBeInTheDocument();
      await waitFor(() => {
        expect(getSecurityCellText(NAMELESS_REDIRECT_URI)).toBe('pass');
      });

      expect(getCellText(NAMELESS_REDIRECT_URI, NAME_COLUMN_INDEX)).toBe(EM_DASH);
      expect(getDetailLink(NAMELESS_REDIRECT_URI)).toHaveAccessibleName(`${DETAIL_LINK_TEXT} ${namelessClient.id}`);
    });

    test('Escapes bidirectional control characters in the name and redirect URI cells', async () => {
      const reviewer = createReviewerClient();
      const bidiClient = await reviewer.createResource<ClientApplication>({
        resourceType: 'ClientApplication',
        name: BIDI_CLIENT_NAME,
        redirectUris: [BIDI_REDIRECT_URI],
        meta: { project: PROJECT_ID },
      });
      lintResponder = async () => ({
        total: 1,
        offset: 0,
        count: DEFAULT_SEARCH_COUNT,
        results: [
          {
            id: bidiClient.id,
            name: BIDI_CLIENT_NAME,
            redirectUris: [BIDI_REDIRECT_URI],
            status: 'warning',
            findings: [],
          },
        ],
      });

      renderAppRoutes(reviewer, '/admin/oauth-security');

      expect(await screen.findByText(ESCAPED_BIDI_CLIENT_NAME)).toBeInTheDocument();
      await waitFor(() => {
        expect(getSecurityCellText(ESCAPED_BIDI_CLIENT_NAME)).toBe('warning');
      });

      expect(getCellText(ESCAPED_BIDI_CLIENT_NAME, NAME_COLUMN_INDEX)).toBe(ESCAPED_BIDI_CLIENT_NAME);
      expect(getRedirectUriCellText(ESCAPED_BIDI_CLIENT_NAME)).toBe(ESCAPED_BIDI_REDIRECT_URI);
      expect(screen.queryByText(BIDI_CLIENT_NAME)).not.toBeInTheDocument();
      expect(screen.queryByText(BIDI_REDIRECT_URI)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
      expect(document.body.textContent).not.toContain(POP_DIRECTIONAL_FORMATTING);
      expect(getDetailLink(ESCAPED_BIDI_CLIENT_NAME)).toHaveAccessibleName(
        `${DETAIL_LINK_TEXT} ${ESCAPED_BIDI_CLIENT_NAME}`
      );
    });

    test('Reserves the same security column size while a status is loading, resolved and unavailable', async () => {
      const deferred = createDeferred<LintReport>();
      lintResponder = () => deferred.promise;

      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
      });

      const reservedSize = getSecurityReservedSize(EXACT_CLIENT_NAME);
      expect(reservedSize.width).not.toBe('');
      expect(reservedSize.height).not.toBe('');
      expect(getCell(EXACT_CLIENT_NAME, SECURITY_COLUMN_INDEX).querySelector(SKELETON_SELECTOR)).not.toBeNull();

      const requestedIds = getRequestedIds(lintCallUrls()[0]);
      await act(async () => {
        deferred.resolve(buildReport(requestedIds.filter((id) => id !== idFor(NO_URI_CLIENT_NAME))));
      });

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('pass');
      });

      expect(getSecurityReservedSize(EXACT_CLIENT_NAME)).toStrictEqual(reservedSize);
      expect(getSecurityCellText(LEGACY_CLIENT_NAME)).toBe('warning');
      expect(getSecurityReservedSize(LEGACY_CLIENT_NAME)).toStrictEqual(reservedSize);
      expect(getSecurityCellText(NO_URI_CLIENT_NAME)).toBe(EM_DASH);
      expect(getSecurityReservedSize(NO_URI_CLIENT_NAME)).toStrictEqual(reservedSize);
      expect(skeletonCount()).toBe(0);
    });

    test('Sizes the loading placeholder to the widest settled status badge', async () => {
      const deferred = createDeferred<LintReport>();
      lintResponder = () => deferred.promise;

      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
      });

      const placeholder = getCell(EXACT_CLIENT_NAME, SECURITY_COLUMN_INDEX).querySelector<HTMLElement>(
        SKELETON_SELECTOR
      );
      expect(placeholder?.style.getPropertyValue('--skeleton-height')).toBe(rem(STATUS_BADGE_HEIGHT));
      expect(placeholder?.style.getPropertyValue('--skeleton-width')).toBe(rem(WIDEST_STATUS_BADGE_WIDTH));

      await act(async () => {
        deferred.resolve(buildReport(getRequestedIds(lintCallUrls()[0])));
      });

      await waitFor(() => {
        expect(skeletonCount()).toBe(0);
      });
    });

    test('Gives every row a keyboard-focusable link to the security detail view of its client', async () => {
      await setup();

      await waitFor(() => {
        expect(getSecurityCellText(WILDCARD_CLIENT_NAME)).toBe('fail');
      });

      const detailLinks = screen.getAllByRole('link', { name: new RegExp(`^${DETAIL_LINK_TEXT} `) });
      expect(detailLinks).toHaveLength(renderedClientNames().length);

      const link = getDetailLink(WILDCARD_CLIENT_NAME);
      expect(link).toHaveAttribute('href', `/admin/oauth-security/${idFor(WILDCARD_CLIENT_NAME)}`);
      expect(link).toHaveAccessibleName(`${DETAIL_LINK_TEXT} ${WILDCARD_CLIENT_NAME}`);

      link.focus();
      expect(link).toHaveFocus();

      await act(async () => {
        fireEvent.click(link);
      });

      expect(await screen.findByRole('heading', { name: WILDCARD_CLIENT_NAME })).toBeInTheDocument();
      expect(screen.getByText('Back to OAuth Security')).toBeInTheDocument();
      expect(lintCallUrls()[1]).toContain('_id=' + idFor(WILDCARD_CLIENT_NAME));
    });
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
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
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

        const upstreamFailure = new Error(HOSTILE_UPSTREAM_BODY);
        await act(async () => {
          deferred.reject(upstreamFailure);
        });

        expect(await screen.findByText(REQUEST_FAILED_MESSAGE)).toBeInTheDocument();
        expect(screen.queryByText(HOSTILE_UPSTREAM_BODY)).not.toBeInTheDocument();
        for (const fragment of HOSTILE_UPSTREAM_FRAGMENTS) {
          expect(document.body.textContent).not.toContain(fragment);
        }
        expect(consoleError).toHaveBeenCalledWith(upstreamFailure);

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
      } finally {
        consoleError.mockRestore();
      }
    });

    test('The failure notification offers a close button with an accessible name', async () => {
      const deferred = createDeferred<LintReport>();
      lintResponder = () => deferred.promise;
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await setup();

        await waitFor(() => {
          expect(getSecurityCellText(EXACT_CLIENT_NAME)).toBe('');
        });

        await act(async () => {
          deferred.reject(new Error(LINT_ERROR_MESSAGE));
        });

        expect(await screen.findByText(REQUEST_FAILED_MESSAGE)).toBeInTheDocument();
        expect(screen.queryByText(LINT_ERROR_MESSAGE)).not.toBeInTheDocument();
        const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
        expect(dismissButton).toBeInTheDocument();
        expect(dismissButton.closest('.mantine-Notification-root')).not.toBeNull();

        await act(async () => {
          fireEvent.click(dismissButton);
        });

        await waitFor(() => {
          expect(screen.queryByText(REQUEST_FAILED_MESSAGE)).not.toBeInTheDocument();
        });
      } finally {
        consoleError.mockRestore();
      }
    });

    test('A rejected security response for a previous page neither overwrites the current page nor notifies', async () => {
      const deferreds: Deferred<LintReport>[] = [];
      lintResponder = () => {
        const deferred = createDeferred<LintReport>();
        deferreds.push(deferred);
        return deferred.promise;
      };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

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

      try {
        await act(async () => {
          deferreds[0].reject(new Error(LINT_ERROR_MESSAGE));
        });

        for (const name of nextPageNames) {
          expect(getSecurityCellText(name)).toBe('warning');
        }
        expect(screen.queryByText(REQUEST_FAILED_MESSAGE)).not.toBeInTheDocument();
        expect(screen.queryByText(LINT_ERROR_MESSAGE)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
        expect(skeletonCount()).toBe(0);
      } finally {
        consoleError.mockRestore();
      }
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
